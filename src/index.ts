import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { getConfig } from './config.js';
import { logger } from './logger.js';
import { FoundryWsServer } from './foundry/ws-server.js';
import { GameStateStore } from './foundry/game-state-store.js';
import { startMcpServer, stopMcpServer, getMcpServer } from './mcp/server.js';
import { wireLiveEvents } from './mcp/live-events.js';
import { VideoCaptureCoordinator } from './video/capture.js';
import type { ModuleMessage } from './types/index.js';

const config = getConfig();

const store = new GameStateStore();
const wsServer = new FoundryWsServer();
const videoCapture = new VideoCaptureCoordinator();

// --- Wire WebSocket events → store ---

wsServer.on('message', (msg: ModuleMessage) => {
  switch (msg.type) {
    case 'gameReady':
      store.applyGameReady(msg);
      break;
    case 'chatMessage':
      store.applyChatMessage(msg.message);
      break;
    case 'chatMessageUpdate':
      store.applyChatMessageUpdate(msg.message);
      break;
    case 'actorUpdate':
      store.applyActorUpdate(msg.actorId, msg.actor);
      break;
    case 'combatUpdate':
      store.applyCombatUpdate(msg.combat);
      break;
    case 'sceneChange':
      store.applySceneChange(msg.scene);
      break;
    case 'videoChunk':
      videoCapture.handleChunk(msg.data, msg.timestamp);
      break;
    case 'pong':
      wsServer.handlePong();
      break;
    default:
      logger.warn('Unknown message type:', (msg as { type: string }).type);
  }
});

// --- Wire WS disconnect → mark state stale ---

wsServer.on('disconnected', () => {
  store.markDisconnected();
  videoCapture.stop();
});

// --- Graceful shutdown ---

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal} — starting graceful shutdown...`);

  try {
    videoCapture.stop();
    stopMcpServer();
    wsServer.stop();
    logger.info('Shutdown complete. Goodbye.');
  } catch (err) {
    logger.error('Error during shutdown:', err);
  }

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  gracefulShutdown('uncaughtException');
});

// --- Startup ---

async function main(): Promise<void> {
  logger.info('Magi Assistant Foundry Bridge starting...');
  logger.info(`  WS port: ${config.wsPort}`);
  logger.info(`  MCP port: ${config.mcpPort}`);
  logger.info(`  Video dir: ${config.videoDir}`);

  wsServer.start();

  await startMcpServer(store, wsServer, videoCapture);

  // Wire live events once MCP server is up
  const mcp = getMcpServer();
  if (mcp) {
    wireLiveEvents(mcp, store);
  }

  logger.info('Foundry Bridge ready — waiting for Foundry module connection');
}

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});
