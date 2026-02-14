/**
 * MCP tool definitions for Foundry bridge.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GameStateStore } from '../foundry/game-state-store.js';
import type { FoundryWsServer } from '../foundry/ws-server.js';
import { logger } from '../logger.js';

/** Fate ladder labels. */
function fateLadder(value: number): string {
  const ladder: Record<number, string> = {
    8: 'Legendary',
    7: 'Epic',
    6: 'Fantastic',
    5: 'Superb',
    4: 'Great',
    3: 'Good',
    2: 'Fair',
    1: 'Average',
    0: 'Mediocre',
    '-1': 'Poor',
    '-2': 'Terrible',
  };
  if (value > 8) return `Beyond Legendary (+${value})`;
  if (value < -2) return `Abysmal (${value})`;
  return ladder[value] ?? `+${value}`;
}

export function registerTools(server: McpServer, store: GameStateStore, wsServer: FoundryWsServer): void {
  // send_whisper — send a whispered message to the GM in Foundry
  server.tool(
    'send_whisper',
    'Send a whispered chat message to the GM in Foundry VTT',
    {
      content: z.string().describe('The message content (HTML supported)'),
      title: z.string().optional().describe('Optional title/header for the message'),
    },
    async ({ content, title }) => {
      const sent = wsServer.send({
        type: 'whisper',
        content,
        title,
      });
      if (!sent) {
        return {
          content: [{ type: 'text' as const, text: 'Error: Foundry module not connected' }],
          isError: true,
        };
      }
      logger.debug('Sent whisper to Foundry:', title ?? '(no title)');
      return {
        content: [{ type: 'text' as const, text: 'Whisper sent successfully' }],
      };
    }
  );

  // get_actor_details — full actor data from store
  server.tool(
    'get_actor_details',
    'Get full details for a specific Fate Core actor',
    {
      actorId: z.string().describe('The actor ID to look up'),
    },
    async ({ actorId }) => {
      const actor = store.getActor(actorId);
      if (!actor) {
        return {
          content: [{ type: 'text' as const, text: `Actor not found: ${actorId}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(actor, null, 2) }],
      };
    }
  );

  // search_chat — case-insensitive search over recent chat
  server.tool(
    'search_chat',
    'Search recent chat messages by content (case-insensitive)',
    {
      query: z.string().describe('Search query string'),
      limit: z.number().optional().default(20).describe('Maximum results to return'),
    },
    async ({ query, limit }) => {
      const lowerQuery = query.toLowerCase();
      const matches = store.getRecentChat(200)
        .filter((msg) => msg.content.toLowerCase().includes(lowerQuery) ||
                         msg.speakerAlias.toLowerCase().includes(lowerQuery))
        .slice(-limit);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(matches, null, 2) }],
      };
    }
  );

  // get_fate_ladder — Fate ladder label for a numeric value
  server.tool(
    'get_fate_ladder',
    'Get the Fate ladder label for a numeric skill/roll value',
    {
      value: z.number().describe('The numeric value to look up on the Fate ladder'),
    },
    async ({ value }) => {
      const label = fateLadder(value);
      return {
        content: [{ type: 'text' as const, text: `+${value} = ${label}` }],
      };
    }
  );
}
