/**
 * MCP resource definitions for Foundry game state.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GameStateStore } from '../foundry/game-state-store.js';
import { parseFateRoll } from '../foundry/fate-parser.js';
import type { VideoCaptureCoordinator } from '../video/capture.js';

export function registerResources(server: McpServer, store: GameStateStore, videoCapture?: VideoCaptureCoordinator): void {
  // game://state — full game state snapshot
  server.resource(
    'game-state',
    'game://state',
    { description: 'Full game state snapshot including actors, scene, combat, and recent chat' },
    () => {
      const state = store.getState();
      const snapshot = {
        actors: Object.fromEntries(state.actors),
        scene: state.scene,
        combat: state.combat,
        recentChat: state.chatHistory.slice(-50),
        connectedAt: state.connectedAt,
      };
      return {
        contents: [{
          uri: 'game://state',
          mimeType: 'application/json',
          text: JSON.stringify(snapshot, null, 2),
        }],
      };
    }
  );

  // game://actors — all actors
  server.resource(
    'actors',
    'game://actors',
    { description: 'All Fate Core actors in the game' },
    () => {
      const actors = store.getActors();
      return {
        contents: [{
          uri: 'game://actors',
          mimeType: 'application/json',
          text: JSON.stringify(actors, null, 2),
        }],
      };
    }
  );

  // game://actors/{id} — specific actor by ID
  server.resource(
    'actor-by-id',
    'game://actors/{id}',
    { description: 'Specific Fate Core actor by ID' },
    (uri) => {
      const id = uri.pathname.split('/').pop() ?? '';
      const actor = store.getActor(id);
      if (!actor) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: 'Actor not found' }),
          }],
        };
      }
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(actor, null, 2),
        }],
      };
    }
  );

  // game://scene — current active scene
  server.resource(
    'scene',
    'game://scene',
    { description: 'Current active Foundry scene' },
    () => {
      return {
        contents: [{
          uri: 'game://scene',
          mimeType: 'application/json',
          text: JSON.stringify(store.getScene(), null, 2),
        }],
      };
    }
  );

  // game://combat — current combat state
  server.resource(
    'combat',
    'game://combat',
    { description: 'Current combat encounter state' },
    () => {
      return {
        contents: [{
          uri: 'game://combat',
          mimeType: 'application/json',
          text: JSON.stringify(store.getCombat(), null, 2),
        }],
      };
    }
  );

  // game://chat/recent — last 50 chat messages with parsed Fate rolls
  server.resource(
    'chat-recent',
    'game://chat/recent',
    { description: 'Last 50 chat messages with parsed Fate rolls' },
    () => {
      const messages = store.getRecentChat(50).map((msg) => ({
        ...msg,
        parsedRoll: parseFateRoll(msg),
      }));
      return {
        contents: [{
          uri: 'game://chat/recent',
          mimeType: 'application/json',
          text: JSON.stringify(messages, null, 2),
        }],
      };
    }
  );

  // game://video/status — video capture status
  server.resource(
    'video-status',
    'game://video/status',
    { description: 'Current video capture status' },
    () => {
      const status = videoCapture?.getStatus() ?? { active: false, filePath: null, startTime: null, totalBytes: 0 };
      return {
        contents: [{
          uri: 'game://video/status',
          mimeType: 'application/json',
          text: JSON.stringify(status, null, 2),
        }],
      };
    }
  );
}
