/**
 * Director tools end to end, with a fake Foundry module standing in for the
 * browser: post_as_actor and roll_for_actor round-trip through the GM's
 * decision, get_spotlight counts who has spoken, director_status reports.
 *
 * Usage: start the sidecar (WS_AUTH_TOKEN, MCP_AUTH_TOKEN set), then
 *   npx tsx scripts/director-test.ts
 */

import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const wsPort = process.env.WS_PORT ?? '3300';
const mcpPort = process.env.MCP_PORT ?? '3002';
const wsToken = process.env.WS_AUTH_TOKEN ?? '';
const mcpToken = process.env.MCP_AUTH_TOKEN ?? '';
/** What the fake GM answers when asked to confirm. */
let gmApproves = true;

function chat(id: string, actor: string, alias: string, content: string) {
  return { id, speakerActorId: actor, speakerAlias: alias, content, type: 0, isGm: false, whisper: [], rolls: [], timestamp: new Date().toISOString() };
}

const actor = (id: string, name: string) => ({
  id, name, type: 'character', img: '', aspects: [], skills: [], stunts: [], tracks: [], fatePoints: 0, refresh: 0,
  system: 'dnd5e', playerOwned: true, d20: { hp: { value: 9, max: 9 }, ac: 14, level: 1, summary: 'Rogue 1', skills: { stealth: 7 } },
});

function check(cond: unknown, label: string) {
  if (!cond) { console.error(`FAIL ${label}`); process.exit(1); }
  console.log(`ok   ${label}`);
}

async function main() {
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}?token=${wsToken}`);
  await new Promise((r) => ws.once('open', r));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    if (msg.type === 'queryState' || msg.type === 'ping') return;
    if (msg.type === 'postAsActor' || msg.type === 'rollForActor') {
      const ok = !msg.requireConfirm || gmApproves;
      ws.send(JSON.stringify({ type: 'actionResult', correlationId: msg.correlationId, ok,
        detail: ok ? (msg.type === 'postAsActor' ? 'posted' : `rolled ${msg.formula} = 12`) : 'declined-by-gm' }));
    }
  });
  ws.send(JSON.stringify({
    type: 'gameReady', worldId: 'w1', gameSystem: 'dnd5e',
    actors: { a1: actor('a1', 'Kestrel'), a2: actor('a2', 'Brannoc') }, scene: null, combat: null,
    chatHistory: [chat('m1', 'a1', 'Kestrel', 'I charge!'), chat('m2', 'a1', 'Kestrel', 'Again!'), chat('m3', 'a2', 'Brannoc', 'Um, can I look?')],
  }));
  await new Promise((r) => setTimeout(r, 300));

  const client = new Client({ name: 'director-test', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
  }));
  const text = (r: any) => r.content[0].text as string;

  const tools = (await client.listTools()).tools.map((t) => t.name);
  check(['post_as_actor', 'roll_for_actor', 'get_spotlight', 'director_status'].every((t) => tools.includes(t)), 'director tools listed');

  const status = JSON.parse(text(await client.callTool({ name: 'director_status', arguments: {} })));
  check(status.gameSystem === 'dnd5e' && status.requiresGmConfirmation === true, 'status: dnd5e, GM confirms');

  const spot = JSON.parse(text(await client.callTool({ name: 'get_spotlight', arguments: {} })));
  check(spot[0].name === 'Brannoc' && spot[0].turns === 1 && spot[1].turns === 2, 'spotlight: least-served first');

  check(text(await client.callTool({ name: 'post_as_actor', arguments: { actorId: 'a2', content: 'I check the door.' } })).includes('posted'), 'post approved by GM');
  check(text(await client.callTool({ name: 'roll_for_actor', arguments: { actorId: 'a2', formula: '1d20+7', flavor: 'Stealth' } })).includes('rolled'), 'roll approved by GM');
  gmApproves = false;
  const declined = await client.callTool({ name: 'post_as_actor', arguments: { actorId: 'a2', content: 'Something the GM rejects' } });
  check(declined.isError && text(declined).includes('declined-by-gm'), 'GM can decline');
  const bad = await client.callTool({ name: 'roll_for_actor', arguments: { actorId: 'a2', formula: '1d20; alert(1)' } });
  check(bad.isError, 'non-dice formula refused');
  const missing = await client.callTool({ name: 'post_as_actor', arguments: { actorId: 'nobody', content: 'hi' } });
  check(missing.isError, 'unknown actor refused');

  await client.close();
  ws.close();
  console.log('director tools: all checks passed');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
