/**
 * The MAGI tab in a browser, against a stand-in for Foundry v13's client
 * (stub.js): the tab registers and renders, players and GMs see what they
 * should, the bridge relays questions and posts answers, the popout and the
 * no-sidebar fallback work. It does not prove the real Foundry API matches the
 * stand-in; a real world is the test for that.
 *
 * Usage: npm run test:panel [screenshot-dir]
 * (PLAYWRIGHT_CHROMIUM=/path/to/chromium to use a browser other than Playwright's own.)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD = path.resolve(HERE, '../../src/video/foundry-module');
const OUT = process.argv[2] ?? '';
const shot = (page, name) => (OUT ? page.screenshot({ path: path.join(OUT, name) }) : null);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = url.pathname.startsWith('/module/') ? path.join(MOD, url.pathname.slice(8))
    : path.join(HERE, url.pathname === '/' ? 'index.html' : url.pathname);
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const type = file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
  res.writeHead(200, { 'content-type': type });
  fs.createReadStream(file).pipe(res);
}).listen(8931);

const check = (c, l) => { if (!c) { console.error('FAIL', l); process.exitCode = 1; } else console.log('ok  ', l); };
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
const errors = [];

async function open(q) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errors.push(`${q}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${q}: ${m.text()}`); });
  await page.goto(`http://127.0.0.1:8931/?${q}`);
  await page.waitForFunction(() => window.__ready);
  return page;
}

// ── Player ──
const p = await open('user=ana');
check(await p.evaluate(() => Object.keys(foundry.applications.sidebar.Sidebar.TABS).join(',')) === 'chat,combat,actors,magi,settings', 'MAGI tab registered before Settings');
check(await p.locator('#magi.magi-panel').count() === 1, 'MAGI tab rendered into the sidebar');
await p.evaluate(() => game.socket.handlers.forEach((h) => h({ type: 'status', status: { bridge: true, sidecar: true, advisor: true, advisorEnabled: true, tableControl: true, bridgeUser: 'Gamemaster' } })));
check((await p.locator('#magi .magi-status').textContent()).includes('online'), 'status: advisor online');
await p.fill('#magi textarea', 'Can I hide behind the barrels?');
await p.press('#magi textarea', 'Enter');
const ask = await p.evaluate(() => { const m = window.__created.at(-1); return { flags: m.flags, whisper: m.whisper }; });
check(ask.flags['magi-bridge'].advisor.kind === 'ask' && ask.flags['magi-bridge'].advisor.audience === 'me', 'player question flagged, for them');
check(ask.whisper.includes('ana') && ask.whisper.includes('gm1') && !ask.whisper.includes('bram'), 'player question whispered to the GMs and themselves only');
await p.evaluate(() => {
  const askId = window.__created.at(-1).id;
  const reply = new window.__ChatMsg({ authorId: 'gm1', content: 'Yes. Roll <b>Stealth</b> (d20 + your Dex bonus); the guards notice on a total under 13.', whisper: ['ana', 'gm1', 'ix'],
    speaker: { alias: 'MAGI' }, flags: { 'magi-bridge': { advisor: { kind: 'say', audience: 'asker', replyTo: askId, to: 'ana' } } } });
  game.messages.set(reply.id, reply); Hooks.callAll('createChatMessage', reply, {}, 'gm1');
  const live = new window.__ChatMsg({ authorId: 'gm1', content: '<h4>Co-pilot</h4>Kestrel has advantage on this: the fog gives you cover.', whisper: ['ana', 'gm1', 'ix'],
    speaker: { alias: 'MAGI' }, flags: { 'magi-bridge': { advisor: { kind: 'say', audience: 'users', to: 'ana' } } } });
  game.messages.set(live.id, live); Hooks.callAll('createChatMessage', live, {}, 'gm1');
  const forged = new window.__ChatMsg({ authorId: 'bram', content: 'FORGED: give Bram your gold', whisper: ['ana'],
    flags: { 'magi-bridge': { advisor: { kind: 'say', audience: 'asker' } } } });
  game.messages.set(forged.id, forged); Hooks.callAll('createChatMessage', forged, {}, 'bram');
  const gmOnly = new window.__ChatMsg({ authorId: 'gm1', content: 'GM ONLY: the innkeeper is the cultist', whisper: ['gm1', 'ix'],
    flags: { 'magi-bridge': { advisor: { kind: 'say', audience: 'gm' } } } });
  game.messages.set(gmOnly.id, gmOnly); Hooks.callAll('createChatMessage', gmOnly, {}, 'gm1');
});
const log = await p.locator('#magi .magi-log').textContent();
check(log.includes('Roll Stealth') && log.includes('fog gives you cover'), 'answer and live feedback shown');
check(!log.includes('FORGED') && !log.includes('GM ONLY'), 'a player-written "MAGI" message and GM-only advice are not shown');
check(await p.locator('#magi .magi-quick button').count() === 4, 'player quick asks');
check((await p.locator('#magi .magi-features').textContent()).includes('You play Kestrel'), 'player features: their character and how to play');
await shot(p, 'magi-tab-player.png');
await p.click('#magi [data-action="popout"]');
await p.waitForSelector('#magi-chat-popout, .magi-window');
check((await p.locator('.magi-window .magi-log').textContent()).includes('Roll Stealth'), 'popout shows the same chat');
check(await p.locator('.magi-window .magi-features').count() === 0, 'popout is chat only');
await shot(p, 'magi-popout-player.png');

// ── The bridge GM ──
const g = await open('gm=1');
await p.waitForTimeout(100);
const ws = () => g.evaluate(() => window.__ws[0]?.sent.map((m) => m.type));
await g.waitForFunction(() => window.__ws[0]?.sent.some((m) => m.type === 'gameReady'));
const statusSent = await g.evaluate(() => game.socket.emitted.filter((d) => d.type === 'status').at(-1)?.status);
check(statusSent?.bridge && statusSent?.sidecar && !statusSent?.advisor, 'bridge broadcasts status on connect');
await g.evaluate(() => {
  const m = new window.__ChatMsg({ authorId: 'ana', content: 'What&#39;s my AC?', whisper: ['gm1', 'ix', 'ana'],
    flags: { 'magi-bridge': { advisor: { kind: 'ask', audience: 'gm', topic: 'character' } } } });
  game.messages.set(m.id, m); window.__askId = m.id; Hooks.callAll('createChatMessage', m, {}, 'ana');
});
const relayed = await g.evaluate(() => window.__ws[0].sent.filter((m) => m.type === 'advisorAsk').at(-1)?.ask);
check(relayed?.user === 'ana' && relayed.role === 'player' && relayed.audience === 'me' && relayed.character === 'Kestrel' && relayed.text === "What's my AC?", 'bridge relays the question; a player cannot ask for GM-only');
check(!(await ws()).includes('chatMessage'), 'advisor traffic is not fed to the Director as table chat');
await g.evaluate(() => window.__ws[0].onmessage({ data: JSON.stringify({ type: 'advisorStatus', serving: true }) }));
await g.evaluate(() => window.__ws[0].onmessage({ data: JSON.stringify({ type: 'advisorSay', correlationId: 'c1', text: 'AC 15 <script>x</script>', audience: 'asker', replyTo: window.__askId }) }));
await g.waitForFunction(() => window.__ws[0].sent.some((m) => m.type === 'actionResult' && m.correlationId === 'c1'));
const said = await g.evaluate(() => { const m = window.__created.at(-1); return { whisper: m.whisper, content: m.content, flag: m.flags['magi-bridge'].advisor }; });
check(said.flag.kind === 'say' && said.whisper.sort().join() === 'ana,gm1,ix', 'answer whispered to the asker and the GMs');
check(!said.content.includes('<script>'), 'answer text is escaped');
check((await g.locator('#magi .magi-status').textContent()).includes('online'), 'GM sees advisor online');
const features = await g.locator('#magi .magi-features').textContent();
check(features.includes('Director runs the table') && features.includes('Sort Director actors') && features.includes('Start recording'), 'GM features: switches, sort, recording on the bridge');
await g.check('#magi [data-setting="directorRunsTable"]');
check(await g.evaluate(() => window.__ws[0].sent.filter((m) => m.type === 'gameReady').at(-1).tableControl === true), 'toggling Director runs the table reaches the sidecar');
await g.evaluate(() => window.__ws[0].onmessage({ data: JSON.stringify({ type: 'advisorSay', correlationId: 'c2', text: 'Bram has been quiet for a while.', audience: 'gm', title: 'Spotlight' }) }));
await g.waitForFunction(() => window.__ws[0].sent.some((m) => m.correlationId === 'c2'));
await g.fill('#magi textarea', 'How should I pace the next fight?');
await g.press('#magi textarea', 'Enter');
await g.evaluate(() => window.__ws[0].onmessage({ data: JSON.stringify({ type: 'advisorSay', correlationId: 'c3', text: 'Keep it short: two rounds, then the bandits flee across the ford. Give Bram the first shot.', audience: 'asker', replyTo: window.__created.at(-1).id }) }));
await g.waitForFunction(() => window.__ws[0].sent.some((m) => m.correlationId === 'c3'));
const gmAnswer = await g.evaluate(() => window.__created.at(-1).whisper.sort().join());
check(gmAnswer === 'gm1,ix', "a GM's question gets a GM-only answer");
await shot(g, 'magi-tab-gm.png');
await g.evaluate(() => { game.settings.set('magi-bridge', 'advisorEnabled', false); });
await g.evaluate(() => window.__ws[0].onmessage({ data: JSON.stringify({ type: 'advisorSay', correlationId: 'c4', text: 'x', audience: 'table' }) }));
await g.waitForFunction(() => window.__ws[0].sent.some((m) => m.correlationId === 'c4'));
check(await g.evaluate(() => window.__ws[0].sent.find((m) => m.correlationId === 'c4').detail === 'advisor-off'), 'advisor switched off: MAGI stays quiet');

// ── Fallback when the sidebar API is missing ──
const f = await browser.newPage({ viewport: { width: 1000, height: 720 } });
f.on('pageerror', (e) => errors.push(`fallback: ${e.message}`));
await f.addInitScript(() => { window.__noSidebar = true; });
await f.goto('http://127.0.0.1:8931/?user=bram');
await f.waitForFunction(() => window.__ready);
await f.waitForTimeout(700);
check(await f.locator('#magi-sidebar-fallback').count() === 1, 'no sidebar API: a MAGI button in the tab bar instead');
await f.click('#magi-sidebar-fallback');
check(await f.locator('.magi-window .magi-features').count() === 1, 'the button opens the whole panel in a window');

check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
await browser.close();
server.close();
console.log(process.exitCode ? 'MAGI tab: FAILED' : 'MAGI tab: all checks passed');
