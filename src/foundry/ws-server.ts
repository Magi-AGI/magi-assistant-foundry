/**
 * WebSocket server accepting a single Foundry module connection.
 * Listens on 127.0.0.1:{wsPort} with token auth via ?token= query param.
 */

import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { ModuleMessage, SidecarMessage } from '../types/index.js';

export interface WsServerEvents {
  message: [msg: ModuleMessage];
  connected: [];
  disconnected: [];
}

export class FoundryWsServer extends EventEmitter<WsServerEvents> {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongReceived = true;

  start(): void {
    const config = getConfig();
    const port = config.wsPort;
    const expectedToken = config.wsToken;

    this.wss = new WebSocketServer({
      host: '127.0.0.1',
      port,
      verifyClient: (info: { req: IncomingMessage }, cb: (result: boolean, code?: number, name?: string) => void) => {
        if (!expectedToken) {
          // No token configured — allow all local connections
          cb(true);
          return;
        }
        const url = new URL(info.req.url ?? '/', `http://127.0.0.1:${port}`);
        const token = url.searchParams.get('token');
        if (token === expectedToken) {
          cb(true);
        } else {
          logger.warn('WebSocket: rejected connection — invalid token');
          cb(false, 401, 'Unauthorized');
        }
      },
    });

    this.wss.on('connection', (ws: WebSocket) => {
      // Single active connection — new connection replaces old (reconnect-friendly).
      // Use terminate() instead of close() to immediately free resources —
      // close() initiates a graceful handshake that may never complete on zombie connections.
      if (this.client) {
        logger.info('WebSocket: new connection replacing existing one');
        this.client.terminate();
      }

      this.client = ws;
      this.pongReceived = true;
      logger.info('WebSocket: Foundry module connected');
      this.emit('connected');

      ws.on('message', (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString()) as ModuleMessage;
          this.emit('message', msg);
        } catch (err) {
          logger.warn('WebSocket: failed to parse message:', err);
        }
      });

      ws.on('close', () => {
        if (this.client === ws) {
          this.client = null;
          logger.info('WebSocket: Foundry module disconnected');
          this.emit('disconnected');
        }
      });

      ws.on('error', (err) => {
        logger.error('WebSocket client error:', err);
      });
    });

    this.wss.on('error', (err) => {
      logger.error('WebSocket server error:', err);
    });

    this.wss.on('listening', () => {
      logger.info(`WebSocket server listening on 127.0.0.1:${port}`);
    });

    // Ping/pong heartbeat (15s interval, 10s timeout)
    this.pingInterval = setInterval(() => {
      if (!this.client) return;
      if (!this.pongReceived) {
        logger.warn('WebSocket: pong not received — terminating connection');
        this.client.terminate();
        this.client = null;
        this.emit('disconnected');
        return;
      }
      this.pongReceived = false;
      this.send({ type: 'ping' });
    }, 15_000);
  }

  /** Handle pong response from module. Call from message handler. */
  handlePong(): void {
    this.pongReceived = true;
  }

  send(msg: SidecarMessage): boolean {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.client.send(JSON.stringify(msg));
    return true;
  }

  isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  requestStateSnapshot(): void {
    this.send({ type: 'queryState' });
  }

  stop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.client) {
      this.client.close(1000, 'Server shutting down');
      this.client = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    logger.info('WebSocket server stopped');
  }
}
