/**
 * MCP server exposing Foundry game state via SSE transport.
 * Same pattern as magi-assistant-discord/src/mcp/server.ts.
 */

import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';
import type { GameStateStore } from '../foundry/game-state-store.js';
import type { FoundryWsServer } from '../foundry/ws-server.js';
import type { VideoCaptureCoordinator } from '../video/capture.js';

const MCP_HOST = '127.0.0.1';

let httpServer: http.Server | null = null;
let mcpServer: McpServer | null = null;
let activeSocketPath: string | null = null;

const transports = new Map<string, SSEServerTransport>();

export function getMcpServer(): McpServer | null {
  return mcpServer;
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

export async function startMcpServer(store: GameStateStore, wsServer: FoundryWsServer, videoCapture?: VideoCaptureCoordinator): Promise<void> {
  const config = getConfig();
  if (!config.mcpAuthToken) {
    logger.info('MCP server: disabled (no MCP_AUTH_TOKEN set)');
    return;
  }

  mcpServer = new McpServer(
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

  registerResources(mcpServer, store, videoCapture);
  registerTools(mcpServer, store, wsServer);

  const mcpPort = config.mcpPort;

  httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    const expectedToken = config.mcpAuthToken;
    const authHeader = req.headers.authorization;
    const headerOk = authHeader === `Bearer ${expectedToken}`;
    // Query token only accepted on GET /sse (EventSource can't send headers).
    // POST /messages requires Authorization header to avoid token exposure in URLs.
    const isGetSse = url.pathname === '/sse' && req.method === 'GET';
    const queryTokenOk = isGetSse && url.searchParams.get('token') === expectedToken;
    const authenticated = headerOk || queryTokenOk;

    if (!authenticated) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (isGetSse) {
      const transport = new SSEServerTransport('/messages', res);
      transports.set(transport.sessionId, transport);

      res.on('close', () => {
        transports.delete(transport.sessionId);
      });

      await mcpServer!.server.connect(transport);
    } else if (url.pathname === '/messages' && req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid session' }));
        return;
      }

      const transport = transports.get(sessionId)!;
      await transport.handlePostMessage(req, res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  // UDS support on Linux
  const socketPath = config.mcpSocketPath;
  if (socketPath && process.platform !== 'win32') {
    if (fs.existsSync(socketPath)) {
      const isAlive = await checkSocketAlive(socketPath);
      if (isAlive) {
        logger.error(`MCP server: another instance is already listening on ${socketPath} — aborting`);
        mcpServer = null;
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
      logger.info(`MCP server listening on UDS ${socketPath} (mode 0600)`);
    });
  } else {
    httpServer.listen(mcpPort, MCP_HOST, () => {
      logger.info(`MCP server listening on ${MCP_HOST}:${mcpPort}`);
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

  for (const [, transport] of transports) {
    transport.close?.();
  }
  transports.clear();

  mcpServer = null;
}
