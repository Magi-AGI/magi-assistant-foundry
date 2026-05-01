/**
 * Wire GameStateStore change events to MCP resource update notifications.
 * Broadcasts to every active SSE client.
 */

import type { GameStateStore } from '../foundry/game-state-store.js';
import type { McpServerRegistry } from './server.js';
import { logger } from '../logger.js';

export function wireLiveEvents(registry: McpServerRegistry, store: GameStateStore): void {
  // Deduplicate: only send one list-changed notification per stateChanged event
  // (the MCP SDK does not currently support per-URI update notifications,
  // so sendResourceListChanged is the correct signal for clients to re-read).
  // Note: stateChanged is already debounced in GameStateStore (500ms).
  store.on('stateChanged', (_uris: string[]) => {
    registry.broadcast(async (server) => {
      await server.server.sendResourceListChanged();
    }).catch((err) => {
      logger.debug('Failed to broadcast resource update notification:', err);
    });
  });
}
