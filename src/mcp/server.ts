/**
 * MCP server exposing Foundry game state via StreamableHTTP transport.
 *
 * Each MCP session gets its own StreamableHTTPServerTransport plus its own
 * McpServer instance. The underlying SDK Server only supports a single
 * transport per instance, so concurrent clients (Claude.ai + Discord bot)
 * each need a fresh server. activeServers tracks them for live-event
 * broadcasts via McpServerRegistry.
 */

import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';
import type { GameStateStore } from '../foundry/game-state-store.js';
import type { FoundryWsServer } from '../foundry/ws-server.js';
import type { RecordingStateStore } from '../foundry/recording-state.js';
import type { VideoCaptureCoordinator } from '../video/capture.js';

const MCP_HOST = '127.0.0.1';
const MCP_PATH = '/mcp';

let httpServer: http.Server | null = null;
let activeSocketPath: string | null = null;

interface Session {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
}

const sessions = new Map<string, Session>();
/** Set of all active McpServer instances, used for live-event broadcasts. */
const activeServers = new Set<McpServer>();

/** Registry of broadcast hooks. Returned by startMcpServer for live-event wiring. */
export interface McpServerRegistry {
  /**
   * Run `fn` on every currently-connected McpServer instance. Errors per
   * instance are isolated and logged.
   */
  broadcast(fn: (server: McpServer) => Promise<void>): Promise<void>;
}

const registry: McpServerRegistry = {
  async broadcast(fn) {
    for (const server of activeServers) {
      try {
        await fn(server);
      } catch (err) {
        logger.debug('MCP broadcast error:', err);
      }
    }
  },
};

export function getMcpServerRegistry(): McpServerRegistry | null {
  return httpServer ? registry : null;
}

/** Check if a Unix Domain Socket has a live listener. */
function checkSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: socketPath }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function startMcpServer(store: GameStateStore, wsServer: FoundryWsServer, videoCapture?: VideoCaptureCoordinator, recordingState?: RecordingStateStore): Promise<void> {
  const config = getConfig();
  if (!config.mcpAuthToken) {
    logger.info('MCP server: disabled (no MCP_AUTH_TOKEN set)');
    return;
  }

  const mcpPort = config.mcpPort;

  /** Build a fresh McpServer per session. The underlying Server only supports
   *  a single transport, so each client must get its own instance. */
  function createServerInstance(): McpServer {
    const instance = new McpServer(
      {
        name: 'magi-assistant-foundry',
        version: '0.1.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );
    registerResources(instance, store, videoCapture);
    registerTools(instance, store, wsServer, recordingState);
    return instance;
  }

  httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname !== MCP_PATH) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const expectedToken = config.mcpAuthToken;
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = typeof sessionIdHeader === 'string' ? sessionIdHeader : undefined;

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown session' }));
        return;
      }
      try {
        await session.transport.handleRequest(req, res);
      } catch (err) {
        logger.warn('MCP transport handleRequest error:', err);
      }
      return;
    }

    // No session header — only POST /mcp can initialize a new session.
    if (req.method !== 'POST') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing Mcp-Session-Id header' }));
      return;
    }

    const instance = createServerInstance();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, mcpServer: instance });
        activeServers.add(instance);
        logger.debug(`MCP session initialized: ${sid}`);
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
        activeServers.delete(instance);
        logger.debug(`MCP session closed: ${sid}`);
      },
    });

    transport.onclose = (): void => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
      activeServers.delete(instance);
    };

    try {
      await instance.server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      logger.warn('MCP initialize failed:', err);
      activeServers.delete(instance);
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Initialization failed' }));
      }
    }
  });

  // UDS support on Linux
  const socketPath = config.mcpSocketPath;
  if (socketPath && process.platform !== 'win32') {
    if (fs.existsSync(socketPath)) {
      const isAlive = await checkSocketAlive(socketPath);
      if (isAlive) {
        logger.error(`MCP server: another instance is already listening on ${socketPath} — aborting`);
        httpServer.close();
        httpServer = null;
        return;
      }
      try { fs.unlinkSync(socketPath); } catch { /* may have been removed */ }
    }

    httpServer.listen(socketPath, () => {
      try { fs.chmodSync(socketPath, 0o600); } catch (err) {
        logger.warn('Could not set socket permissions:', err);
      }
      activeSocketPath = socketPath;
      logger.info(`MCP server listening on UDS ${socketPath} (mode 0600), path ${MCP_PATH}`);
    });
  } else {
    httpServer.listen(mcpPort, MCP_HOST, () => {
      logger.info(`MCP server listening on ${MCP_HOST}:${mcpPort}${MCP_PATH}`);
    });
  }

  httpServer.on('error', (err) => {
    logger.error('MCP server error:', err);
  });
}

export function stopMcpServer(): void {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
    logger.info('MCP server stopped');
  }

  if (activeSocketPath) {
    try {
      if (fs.existsSync(activeSocketPath)) {
        fs.unlinkSync(activeSocketPath);
      }
    } catch { /* best effort */ }
    activeSocketPath = null;
  }

  for (const [, session] of sessions) {
    session.transport.close?.();
  }
  sessions.clear();
  activeServers.clear();
}
