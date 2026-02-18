/**
 * MCP tool definitions for Foundry bridge.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GameStateStore } from '../foundry/game-state-store.js';
import type { FoundryWsServer } from '../foundry/ws-server.js';
import { getConfig } from '../config.js';
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

  // list_images — enumerate image files under the Foundry data directory
  server.tool(
    'list_images',
    'List image files available in the Foundry VTT data directory. Requires FOUNDRY_DATA_DIR to be configured.',
    {
      path: z.string().optional().describe('Subdirectory to list (relative to Foundry data dir). Default: current world directory.'),
      type: z.enum(['maps', 'portraits', 'tokens', 'art']).optional().describe('Filter by image type/subdirectory name'),
    },
    async ({ path: subPath, type: imageType }) => {
      const config = getConfig();
      if (!config.foundryDataDir) {
        return {
          content: [{ type: 'text' as const, text: 'Error: FOUNDRY_DATA_DIR not configured. Set this environment variable to the Foundry VTT Data directory path.' }],
          isError: true,
        };
      }

      const baseDir = config.foundryDataDir;

      // Determine search directory
      let searchDir: string;
      if (subPath) {
        searchDir = path.resolve(baseDir, subPath);
      } else if (imageType) {
        // Search under the base dir for a subdirectory matching the type
        searchDir = path.resolve(baseDir, imageType);
      } else {
        searchDir = baseDir;
      }

      // Path traversal protection: ensure resolved path is under the base directory
      // Use path.sep suffix to prevent sibling-prefix bypass (e.g. /data/foundry vs /data/foundry-evil)
      const resolvedBase = path.resolve(baseDir);
      const resolvedSearch = path.resolve(searchDir);
      if (resolvedSearch !== resolvedBase && !resolvedSearch.startsWith(resolvedBase + path.sep)) {
        return {
          content: [{ type: 'text' as const, text: 'Error: Path traversal detected — path must be within the Foundry data directory.' }],
          isError: true,
        };
      }

      try {
        if (!fs.existsSync(resolvedSearch)) {
          return {
            content: [{ type: 'text' as const, text: `Directory not found: ${subPath ?? imageType ?? '(root)'}` }],
            isError: true,
          };
        }

        const IMAGE_EXTENSIONS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.avif']);
        const results: Array<{ path: string; filename: string; type: string; size: number }> = [];

        // Recursive walk (max depth 3 to avoid huge traversals)
        function walk(dir: string, depth: number): void {
          if (depth > 3) return;
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return; // Permission denied or similar
          }

          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(fullPath, depth + 1);
            } else if (entry.isFile()) {
              const ext = path.extname(entry.name).toLowerCase();
              if (IMAGE_EXTENSIONS.has(ext)) {
                // Compute relative path from the Foundry data directory
                const relativePath = path.relative(resolvedBase, fullPath).replace(/\\/g, '/');
                const parentDir = path.basename(path.dirname(fullPath)).toLowerCase();
                // Infer type from parent directory name
                let inferredType = 'other';
                if (/maps?/i.test(parentDir)) inferredType = 'maps';
                else if (/portraits?/i.test(parentDir)) inferredType = 'portraits';
                else if (/tokens?/i.test(parentDir)) inferredType = 'tokens';
                else if (/art|artwork|images?/i.test(parentDir)) inferredType = 'art';

                try {
                  const stat = fs.statSync(fullPath);
                  results.push({
                    path: relativePath,
                    filename: entry.name,
                    type: inferredType,
                    size: stat.size,
                  });
                } catch {
                  // Skip files we can't stat
                }
              }
            }
          }
        }

        walk(resolvedSearch, 0);

        // Filter by type if specified
        const filtered = imageType
          ? results.filter(r => r.type === imageType)
          : results;

        logger.debug(`list_images: found ${filtered.length} images in ${subPath ?? imageType ?? '(root)'}`);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(filtered) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('list_images: error:', err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
