/**
 * "Director runs the table" end to end, with a fake Foundry module standing in
 * for the GM's browser: table_apply reaches the module and returns what it
 * made, is refused while the GM has the setting off, rejects malformed ops, and
 * table_events hands back the moves and chat people made.
 *
 * Usage: start the sidecar (WS_AUTH_TOKEN, MCP_AUTH_TOKEN set), then
 *   npx tsx scripts/table-test.ts
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

/** The fake module's table: tokens by key, and the ops it was sent. */
const board = { scene: '', tokens: new Map<string, [number, number]>(), chat: [] as string[] };
let tableControl = false;

function ready(ws: WebSocket) {
  ws.send(JSON.stringify({ type: 'gameReady', worldId: 'w1', gameSystem: 'dnd5e', actors: {}, scene: null,
    combat: null, chatHistory: [], tableControl }));
}

async function main() {
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}?token=${wsToken}`);
  await new Promise((r) => ws.once('open', r));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    if (msg.type !== 'tableCommand') return;
    const reply = (ok: boolean, detail: string, data?: unknown) =>
      ws.send(JSON.stringify({ type: 'actionResult', correlationId: msg.correlationId, ok, detail, data }));
    if (!tableControl) return reply(false, 'table-control-off');
    const data: Record<string, unknown> = {};
    for (const op of msg.ops) {
      if (op.op === 'scene') { board.scene = op.key; board.tokens.clear(); data[op.key] = 'scene-1'; }
      if (op.op === 'token') { board.tokens.set(op.key, op.cell); data[op.key] = `token-${op.key}`; }
      if (op.op === 'move') board.tokens.set(op.key, op.cell);
      if (op.op === 'remove') op.keys.forEach((k: string) => board.tokens.delete(k));
      if (op.op === 'chat') board.chat.push(`${op.speaker}: ${op.text}`);
    }
    reply(true, 'applied', data);
  });
  ready(ws);
  await new Promise((r) => setTimeout(r, 300));

  const client = new Client({ name: 'table-test', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
  }));
  const text = (r: any) => r.content[0].text as string;
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check(['table_apply', 'table_events'].every((t) => tools.includes(t)), 'table tools listed');

  const scene = { op: 'scene', key: 'scene:inn', name: 'The Inn', cols: 12, rows: 8, background: '#d9c3a0',
    features: [{ cell: [0, 0], colour: '#5b5148', label: 'wall', blocks: true }] };
  const off = await client.callTool({ name: 'table_apply', arguments: { ops: [scene] } });
  check(off.isError && text(off).includes('table-control-off'), 'refused while the GM has it off');
  let status = JSON.parse(text(await client.callTool({ name: 'director_status', arguments: {} })));
  check(status.tableControl === false, 'status: table control off');

  tableControl = true;
  ready(ws);
  await new Promise((r) => setTimeout(r, 200));
  status = JSON.parse(text(await client.callTool({ name: 'director_status', arguments: {} })));
  check(status.tableControl === true, 'status: table control on');

  const done = await client.callTool({ name: 'table_apply', arguments: { ops: [
    scene,
    { op: 'token', key: 'Kestrel', name: 'Kestrel', cell: [1, 2], colour: '#3b6fb6', kind: 'pc', owners: ['ana'], hp: [9, 9] },
    { op: 'token', key: 'Goblin 1', name: 'Goblin 1', cell: [8, 2], colour: '#b8352f', kind: 'foe', owners: [] },
    { op: 'move', key: 'Goblin 1', cell: [6, 2] },
    { op: 'line', key: 'attack', from: [6, 2], to: [1, 2], colour: '#b8352f' },
    { op: 'chat', speaker: 'Director', text: 'The goblin lunges.', whisperTo: [] },
  ] } });
  const result = JSON.parse(text(done));
  check(!done.isError && result.ok && result.data['Kestrel'] === 'token-Kestrel', 'ops applied in order, results returned');
  check(board.tokens.get('Goblin 1')?.[0] === 6 && board.chat.length === 1, 'the module saw the move and the narration');

  const bad = await client.callTool({ name: 'table_apply', arguments: { ops: [{ op: 'move', key: 'Kestrel', cell: [-1, 2] }] } });
  check(bad.isError, 'a square off the grid is refused');
  const colour = await client.callTool({ name: 'table_apply', arguments: { ops: [{ op: 'line', key: 'x', from: [0, 0], to: [1, 1], colour: 'red;' }] } });
  check(colour.isError, 'a colour that is not #rrggbb is refused');

  ws.send(JSON.stringify({ type: 'tableEvent', event: { kind: 'tokenMoved', key: 'Kestrel', name: 'Kestrel', cell: [2, 2], user: 'ana' } }));
  ws.send(JSON.stringify({ type: 'tableEvent', event: { kind: 'chat', user: 'ana', text: 'attack goblin 1' } }));
  await new Promise((r) => setTimeout(r, 200));
  const first = JSON.parse(text(await client.callTool({ name: 'table_events', arguments: { after: 0 } })));
  check(first.events.length === 2 && first.events[0].event.kind === 'tokenMoved' && first.last === 2, 'events: a drag and a chat line');
  const none = JSON.parse(text(await client.callTool({ name: 'table_events', arguments: { after: first.last } })));
  check(none.events.length === 0 && none.last === 2, 'events: nothing new after the last one read');

  await client.close();
  ws.close();
  console.log('table tools: all checks passed');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
