/**
 * AI Director tools: act at a live Foundry table, in suggest mode.
 *
 * The Magi Server Director decides what a simulated player says or rolls and
 * gets its own staff approval first (director.actions.ActionGate). Here, at
 * the table, the GM sees and confirms the exact text in Foundry before it is
 * posted, unless the sidecar was started with DIRECTOR_AUTONOMOUS=true.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GameStateStore } from '../foundry/game-state-store.js';
import type { FoundryWsServer } from '../foundry/ws-server.js';
import type { ActionResults } from '../foundry/action-results.js';
import { computeSpotlight } from '../foundry/spotlight.js';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';

/** The GM may take a while to read and decide. */
const DIRECTOR_ACTION_TIMEOUT_MS = 120_000;

/** Dice formulas only: numbers, dice, keep/drop, arithmetic, and @-references. */
const FORMULA = /^[0-9dDkKhHlLfF+\-*/() @._a-zA-Z]{1,80}$/;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError } : {}) });

export function registerDirectorTools(
  server: McpServer,
  store: GameStateStore,
  wsServer: FoundryWsServer,
  results: ActionResults,
): void {
  async function act(kind: 'postAsActor' | 'rollForActor', fields: Record<string, string | undefined>): Promise<ToolResult> {
    if (!wsServer.isConnected()) return text('Error: Foundry module not connected', true);
    const actor = store.getActor(fields.actorId as string);
    if (!actor) return text(`Actor not found: ${fields.actorId}`, true);
    const requireConfirm = !getConfig().directorAutonomous;
    const { correlationId, promise } = results.await(DIRECTOR_ACTION_TIMEOUT_MS);
    const sent = wsServer.send({ type: kind, correlationId, requireConfirm, ...fields } as never);
    if (!sent) return text('Error: failed to send to the Foundry module', true);
    logger.info(`director ${kind} for ${actor.name}${requireConfirm ? ' (awaiting GM)' : ''}`);
    try {
      const result = await promise;
      return text(`${result.ok ? 'Done' : 'Not done'}: ${result.detail}`, !result.ok);
    } catch (err) {
      return text(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  server.tool(
    'post_as_actor',
    'Post an in-character chat message as an actor (a simulated player\'s character or an NPC). The GM confirms the exact text in Foundry first unless the sidecar runs autonomously.',
    {
      actorId: z.string().describe('The actor to speak as'),
      content: z.string().min(1).max(2000).describe('What they say or do (plain text or simple HTML)'),
    },
    async ({ actorId, content }) => act('postAsActor', { actorId, content }),
  );

  server.tool(
    'roll_for_actor',
    'Roll dice for an actor and post the roll to chat (e.g. "1d20+5", "4df+2"). The GM confirms first unless the sidecar runs autonomously.',
    {
      actorId: z.string().describe('The actor rolling'),
      formula: z.string().regex(FORMULA).describe('A Foundry dice formula'),
      flavor: z.string().max(200).optional().describe('What the roll is for, e.g. "Stealth check"'),
    },
    async ({ actorId, formula, flavor }) => act('rollForActor', { actorId, formula, flavor }),
  );

  server.tool(
    'get_spotlight',
    'Who has had the spotlight recently: messages and rolls per player character over the recent chat window, least-served first.',
    {
      window: z.number().int().min(5).max(200).optional().default(60).describe('How many recent chat messages to count'),
    },
    async ({ window }) => {
      const entries = computeSpotlight(store.getRecentChat(200), store.getActors(), window);
      return text(JSON.stringify(entries, null, 2));
    },
  );

  server.tool(
    'director_status',
    'AI Director status for this table: connection, game system, whether actions need GM confirmation, and actions awaiting the GM.',
    {},
    async () => text(JSON.stringify({
      moduleConnected: wsServer.isConnected(),
      gameSystem: store.getState().gameSystem,
      requiresGmConfirmation: !getConfig().directorAutonomous,
      actionsAwaitingGm: results.pending,
      playerCharacters: store.getActors().filter((a) => a.playerOwned ?? a.type === 'character').map((a) => ({ id: a.id, name: a.name })),
    }, null, 2)),
  );
}
