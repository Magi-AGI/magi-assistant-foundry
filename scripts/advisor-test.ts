/**
 * The MAGI advisor end to end, with a fake Foundry module standing in for the
 * bridge GM's browser: a question asked in the MAGI tab reaches advisor_inbox
 * (long-poll included), advisor_say reaches the module and returns its result,
 * the module hears that the advisor is listening, and director_status says so.
 *
 * Usage: start the sidecar (WS_AUTH_TOKEN, MCP_AUTH_TOKEN set), then
 *   npx tsx scripts/advisor-test.ts
 */

import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const wsPort = process.env.WS_PORT ?? '3300';
const mcpPort = process.env.MCP_PORT ?? '3002';
const wsToken = process.env.WS_AUTH_TOKEN ?? '';
const mcpToken = process.env.MCP_AUTH_TOKEN ?? '';

function check(cond: unknown, label: string) {
  if (!cond) { console.error(`FAIL ${label}`); process.exit(1); }
  console.log(`ok   ${label}`);
}

const said: any[] = [];
const statuses: boolean[] = [];

async function main() {
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}?token=${wsToken}`);
  await new Promise((r) => ws.once('open', r));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    if (msg.type === 'advisorStatus') statuses.push(msg.serving);
    if (msg.type === 'advisorSay') {
      said.push(msg);
      const ok = msg.audience !== 'asker' || msg.replyTo === 'm-ask-1';
      ws.send(JSON.stringify({ type: 'actionResult', correlationId: msg.correlationId, ok, detail: ok ? 'posted' : 'no-question' }));
    }
  });
  ws.send(JSON.stringify({ type: 'gameReady', worldId: 'w1', gameSystem: 'dnd5e', actors: {}, scene: null,
    combat: null, chatHistory: [], tableControl: false }));
  await new Promise((r) => setTimeout(r, 300));
  check(statuses.length >= 1 && statuses[statuses.length - 1] === false, 'module told the advisor is not listening yet');

  const client = new Client({ name: 'advisor-test', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
  }));
  const text = (r: any) => r.content[0].text as string;
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check(['advisor_inbox', 'advisor_say'].every((t) => tools.includes(t)), 'advisor tools listed');

  let inbox = JSON.parse(text(await client.callTool({ name: 'advisor_inbox', arguments: { after: 0 } })));
  check(inbox.asks.length === 0 && inbox.moduleConnected === true, 'inbox empty, module connected');
  const start = inbox.last;

  // A long poll that a question arriving mid-wait wakes up.
  const t0 = Date.now();
  const polling = client.callTool({ name: 'advisor_inbox', arguments: { after: start, waitMs: 10_000 } });
  await new Promise((r) => setTimeout(r, 400));
  const ask = { id: 'm-ask-1', user: 'Alice', userId: 'u1', role: 'player', character: 'Kestrel',
    text: 'Can I hide behind the barrels?', audience: 'me', topic: 'rules' };
  ws.send(JSON.stringify({ type: 'advisorAsk', ask }));
  ws.send(JSON.stringify({ type: 'advisorAsk', ask })); // a reconnecting bridge resends: kept once
  inbox = JSON.parse(text(await polling));
  check(Date.now() - t0 < 5_000, 'long poll returned as soon as the question came');
  check(inbox.asks.length === 1 && inbox.asks[0].ask.user === 'Alice' && inbox.asks[0].ask.character === 'Kestrel', 'question delivered once, with who asked');

  await new Promise((r) => setTimeout(r, 300));
  check(statuses[statuses.length - 1] === true, 'module told the advisor is listening');
  const status = JSON.parse(text(await client.callTool({ name: 'director_status', arguments: {} })));
  check(status.advisorServing === true, 'director_status: advisor serving');

  const empty = JSON.parse(text(await client.callTool({ name: 'advisor_inbox', arguments: { after: inbox.last, waitMs: 300 } })));
  check(empty.asks.length === 0, 'a poll with nothing new times out empty');

  const reply = await client.callTool({ name: 'advisor_say', arguments: { text: 'Yes: roll Stealth.', audience: 'asker', replyTo: 'm-ask-1' } });
  check(!reply.isError && JSON.parse(text(reply)).detail === 'posted', 'answer posted');
  check(said[0]?.text === 'Yes: roll Stealth.' && said[0]?.replyTo === 'm-ask-1', 'module got the answer');
  const again = JSON.parse(text(await client.callTool({ name: 'advisor_inbox', arguments: { after: start } })));
  check(again.asks[0].answered === true, 'the question is marked answered');

  const feedback = await client.callTool({ name: 'advisor_say', arguments: { text: 'Bram has been quiet for a while.', audience: 'gm', title: 'Spotlight' } });
  check(!feedback.isError && said[1]?.audience === 'gm' && said[1]?.title === 'Spotlight', 'GM-only live feedback posted');

  const bad = await client.callTool({ name: 'advisor_say', arguments: { text: 'x', audience: 'asker' } });
  check(bad.isError && text(bad).includes('replyTo'), 'answer without replyTo refused');
  const nobody = await client.callTool({ name: 'advisor_say', arguments: { text: 'x', audience: 'users' } });
  check(nobody.isError, 'users audience without users refused');
  const wrong = await client.callTool({ name: 'advisor_say', arguments: { text: 'x', audience: 'asker', replyTo: 'gone' } });
  check(wrong.isError && text(wrong).includes('no-question'), 'module refusal comes back as an error');

  await client.close();
  ws.close();
  console.log('advisor test passed');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
