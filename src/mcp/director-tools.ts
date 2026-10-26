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
import type { TableEvents } from '../foundry/table-events.js';
import { computeSpotlight } from '../foundry/spotlight.js';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';

/** The GM may take a while to read and decide. */
const DIRECTOR_ACTION_TIMEOUT_MS = 120_000;
/** Table ops need no GM decision, only Foundry's own round trips. */
/** A table op takes a GM browser a second or more (a token makes an actor too), so allow for the batch. */
const TABLE_COMMAND_TIMEOUT_MS = 30_000;
const TABLE_OP_TIMEOUT_MS = 5_000;
const TABLE_COMMAND_MAX_TIMEOUT_MS = 300_000;

/** Dice formulas only: numbers, dice, keep/drop, arithmetic, and @-references. */
const FORMULA = /^[0-9dDkKhHlLfF+\-*/() @._a-zA-Z]{1,80}$/;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError } : {}) });

export function registerDirectorTools(
  server: McpServer,
  store: GameStateStore,
  wsServer: FoundryWsServer,
  results: ActionResults,
  tableEvents?: TableEvents,
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
      tableControl: store.getState().tableControl,
      actionsAwaitingGm: results.pending,
      playerCharacters: store.getActors().filter((a) => a.playerOwned ?? a.type === 'character').map((a) => ({ id: a.id, name: a.name })),
    }, null, 2)),
  );

  // -- The Director runs the table: scenes, tokens, narration ----------------

  const cell = z.tuple([z.number().int().min(0).max(500), z.number().int().min(0).max(500)]);
  const key = z.string().min(1).max(120);
  const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);
  const name = z.string().min(1).max(120);
  const op = z.discriminatedUnion('op', [
    z.object({ op: z.literal('scene'), key, name, cols: z.number().int().min(1).max(200),
      rows: z.number().int().min(1).max(200), background: colour,
      features: z.array(z.object({ cell, w: z.number().int().min(1).optional(), h: z.number().int().min(1).optional(),
        colour, label: z.string().max(80), blocks: z.boolean() })).max(5000) }),
    z.object({ op: z.literal('token'), key, name, cell, colour, kind: z.enum(['pc', 'foe', 'npc']),
      owners: z.array(name).max(20), hp: z.tuple([z.number().int(), z.number().int()]).optional() }),
    z.object({ op: z.literal('move'), key, cell }),
    z.object({ op: z.literal('remove'), keys: z.array(key).max(500) }),
    z.object({ op: z.literal('defeated'), key, value: z.boolean() }),
    z.object({ op: z.literal('hp'), key, value: z.number().int(), max: z.number().int() }),
    z.object({ op: z.literal('line'), key, from: cell, to: cell, colour }),
    z.object({ op: z.literal('chat'), speaker: name, text: z.string().min(1).max(4000),
      whisperTo: z.array(name).max(20).optional() }),
    z.object({ op: z.literal('users'), users: z.array(z.object({ name, password: z.string().max(200),
      role: z.enum(['player', 'assistant']) })).max(20) }),
  ]);

  server.tool(
    'table_apply',
    'Run the table: apply ops in order (draw a scene\'s map and activate it, place, move or remove tokens, mark one defeated, set HP, draw an attack line, post narration or a whisper, make Foundry users for the people seated). Works only when the GM has turned on the Magi Bridge setting "Director runs the table". Cells are [column, row] on the Director\'s grid.',
    { ops: z.array(op).min(1).max(200).describe('Table ops, applied in order') },
    async ({ ops }) => {
      if (!wsServer.isConnected()) return text('Error: Foundry module not connected', true);
      const timeout = Math.min(TABLE_COMMAND_TIMEOUT_MS + ops.length * TABLE_OP_TIMEOUT_MS, TABLE_COMMAND_MAX_TIMEOUT_MS);
      const { correlationId, promise } = results.await(timeout);
      if (!wsServer.send({ type: 'tableCommand', correlationId, ops } as never)) {
        return text('Error: failed to send to the Foundry module', true);
      }
      try {
        const result = await promise;
        return text(JSON.stringify({ ok: result.ok, detail: result.detail, data: result.data ?? null }), !result.ok);
      } catch (err) {
        return text(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    },
  );

  server.tool(
    'table_events',
    'What people did at the Director\'s table since `after`: tokens they dragged (with the square it landed on) and what they wrote in chat. Returns {events, last}; pass `last` back as `after` next time.',
    {
      after: z.number().int().min(0).optional().default(0).describe('The last sequence number already read'),
      limit: z.number().int().min(1).max(500).optional().default(100),
    },
    async ({ after, limit }) => text(JSON.stringify(tableEvents ? tableEvents.since(after, limit) : { events: [], last: 0 })),
  );
}
