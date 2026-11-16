/**
 * The MAGI advisor: questions people ask in Foundry's MAGI tab, and the
 * advisor's answers and live feedback back into it.
 *
 * Magi Server's advisor (director/advisor.py) long-polls `advisor_inbox` and
 * answers with `advisor_say`. It is a voice, not a hand on the table: it posts
 * only whispers flagged as MAGI advisor messages, which the MAGI tab shows and
 * the chat log hides, so it needs neither the GM's confirmation nor "Director
 * runs the table". The GM can switch it off with the module's "MAGI advisor"
 * setting, and the module then declines.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FoundryWsServer } from '../foundry/ws-server.js';
import type { ActionResults } from '../foundry/action-results.js';
import type { AdvisorInbox } from '../foundry/advisor-inbox.js';

/** Longest a poll may hang: under the MCP client's own timeouts. */
const MAX_WAIT_MS = 25_000;
const SAY_TIMEOUT_MS = 15_000;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError } : {}) });

export function registerAdvisorTools(
  server: McpServer,
  wsServer: FoundryWsServer,
  results: ActionResults,
  inbox: AdvisorInbox,
  onPoll: () => void = () => {},
): void {
  server.tool(
    'advisor_inbox',
    'Questions people asked the MAGI advisor in Foundry\'s MAGI tab since `after`: who asked (user, role gm/assistant/player, their character), the text, and whether the answer is for them alone ("me") or GM-only ("gm"). With waitMs, waits that long for a question when none is new. Each ask says whether it was already answered. Returns {asks, last, moduleConnected}; pass `last` back as `after`.',
    {
      after: z.number().int().min(0).optional().default(0).describe('The last sequence number already read'),
      waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional().default(0).describe('How long to wait for a new question'),
      limit: z.number().int().min(1).max(200).optional().default(50),
    },
    async ({ after, waitMs, limit }) => {
      onPoll();
      const got = await inbox.wait(after, waitMs, limit);
      return text(JSON.stringify({ ...got, moduleConnected: wsServer.isConnected() }));
    },
  );

  server.tool(
    'advisor_say',
    'The MAGI advisor speaks in Foundry\'s MAGI tab: answer a question (audience "asker" with replyTo = the ask id), or give live feedback to named users ("users"), the GMs only ("gm"), or everyone ("table"). GMs see everything addressed to players. Plain text; it is HTML-escaped.',
    {
      text: z.string().min(1).max(6000).describe('What the advisor says'),
      audience: z.enum(['asker', 'users', 'gm', 'table']).describe('Who sees it'),
      replyTo: z.string().max(64).optional().describe('The ask id this answers (needed for audience "asker")'),
      users: z.array(z.string().min(1).max(120)).max(20).optional().describe('Foundry user names (audience "users")'),
      title: z.string().max(120).optional().describe('A short heading, e.g. "Spotlight"'),
    },
    async ({ text: said, audience, replyTo, users, title }) => {
      if (audience === 'asker' && !replyTo) return text('Error: audience "asker" needs replyTo', true);
      if (audience === 'users' && !users?.length) return text('Error: audience "users" needs users', true);
      if (!wsServer.isConnected()) return text('Error: Foundry module not connected', true);
      const { correlationId, promise } = results.await(SAY_TIMEOUT_MS);
      if (!wsServer.send({ type: 'advisorSay', correlationId, text: said, audience, replyTo, users, title } as never)) {
        return text('Error: failed to send to the Foundry module', true);
      }
      try {
        const result = await promise;
        if (result.ok && replyTo) inbox.markAnswered(replyTo);
        return text(JSON.stringify({ ok: result.ok, detail: result.detail }), !result.ok);
      } catch (err) {
        return text(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    },
  );
}
