/**
 * Dedicated WebSocket server for video chunk traffic.
 * Runs on a separate port from the game-state WS server so that
 * large video payloads (~430KB base64 every 5s) don't cause
 * head-of-line blocking on game-state events.
 */

import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';

export interface VideoWsServerEvents {
  chunk: [data: Buffer, timestamp: string];
  connected: [];
  disconnected: [];
}

export class VideoWsServer extends EventEmitter<VideoWsServerEvents> {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongReceived = true;

  start(): void {
    const config = getConfig();
    const port = config.videoWsPort;
    const expectedToken = config.wsToken;

    this.wss = new WebSocketServer({
      host: '127.0.0.1',
      port,
      verifyClient: (info: { req: IncomingMessage }, cb: (result: boolean, code?: number, name?: string) => void) => {
        if (!expectedToken) {
          cb(true);
          return;
        }
        const url = new URL(info.req.url ?? '/', `http://127.0.0.1:${port}`);
        const token = url.searchParams.get('token');
        if (token === expectedToken) {
          cb(true);
        } else {
          logger.warn('Video WS: rejected connection — invalid token');
          cb(false, 401, 'Unauthorized');
        }
      },
    });

    this.wss.on('connection', (ws: WebSocket) => {
      if (this.client) {
        logger.info('Video WS: new connection replacing existing one');
        this.client.terminate();
      }

      this.client = ws;
      this.pongReceived = true;
      logger.info('Video WS: client connected');
      this.emit('connected');

      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          // Binary frame = a video chunk. Use server receive time as timestamp;
          // network transit is sub-second so this is close enough for chunk
          // ordering and file naming, and avoids any browser-clock dependency.
          this.emit('chunk', data, new Date().toISOString());
          return;
        }
        try {
          const msg = JSON.parse(data.toString()) as { type: string };
          if (msg.type === 'pong') {
            this.pongReceived = true;
          }
        } catch (err) {
          logger.warn('Video WS: failed to parse text message:', err);
        }
      });

      ws.on('close', () => {
        if (this.client === ws) {
          this.client = null;
          logger.info('Video WS: client disconnected');
          this.emit('disconnected');
        }
      });

      ws.on('error', (err) => {
        logger.error('Video WS: client error:', err);
      });
    });

    this.wss.on('error', (err) => {
      logger.error('Video WS: server error:', err);
    });

    this.wss.on('listening', () => {
      logger.info(`Video WS server listening on 127.0.0.1:${port}`);
    });

    // Ping/pong heartbeat (30s interval — less aggressive than game-state
    // since video is non-critical and chunks themselves serve as liveness signal)
    this.pingInterval = setInterval(() => {
      if (!this.client) return;
      if (!this.pongReceived) {
        logger.warn('Video WS: pong not received — terminating connection');
        this.client.terminate();
        this.client = null;
        this.emit('disconnected');
        return;
      }
      this.pongReceived = false;
      if (this.client.readyState === WebSocket.OPEN) {
        this.client.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30_000);
  }

  isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
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
    logger.info('Video WS server stopped');
  }
}
