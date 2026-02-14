/**
 * Wire GameStateStore change events to MCP resource update notifications.
 * Sends one notification per changed URI (not one per event).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GameStateStore } from '../foundry/game-state-store.js';
import { logger } from '../logger.js';

export function wireLiveEvents(mcpServer: McpServer, store: GameStateStore): void {
  // Deduplicate: only send one list-changed notification per stateChanged event
  // (the MCP SDK does not currently support per-URI update notifications,
  // so sendResourceListChanged is the correct signal for clients to re-read).
  // Note: stateChanged is already debounced in GameStateStore (500ms).
  store.on('stateChanged', (_uris: string[]) => {
    mcpServer.server.sendResourceListChanged().catch((err) => {
      logger.debug('Failed to send resource update notification:', err);
    });
  });
}
