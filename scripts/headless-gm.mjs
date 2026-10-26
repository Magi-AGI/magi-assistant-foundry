#!/usr/bin/env node
/**
 * A headless Gamemaster for a Foundry server the AI Director runs.
 *
 * Foundry v13 has no server-side module code: the Magi Bridge module only runs
 * in a GM's browser. On a server nobody sits at, this script is that browser.
 * It keeps a headless Chromium logged in as the GM, so the module stays
 * connected to the sidecar, and on first start it:
 *
 *   - accepts the license agreement and enters the license key if Foundry asks,
 *   - logs in to setup with the admin key and launches the world,
 *   - joins as the GM user,
 *   - enables Magi Bridge in the world and points it at the sidecar, makes this
 *     user the bridge user, and (with DIRECTOR_RUNS_TABLE=true) lets the
 *     Director run the table.
 *
 * Then it watches the page and starts over if Foundry restarts or the page dies.
 *
 * Environment:
 *   FOUNDRY_URL            http://127.0.0.1:30000 (https:// too; a self-signed certificate is accepted)
 *   FOUNDRY_WORLD          world id to launch (default magi-director)
 *   FOUNDRY_ADMIN_KEY      Foundry's admin password, for /auth and /setup
 *   FOUNDRY_LICENSE_KEY    only used if Foundry asks for a key
 *   FOUNDRY_GM_USER        GM user to join as (default Gamemaster)
 *   FOUNDRY_GM_PASSWORD    its password. Foundry makes the Gamemaster user with none, so when
 *                          this is set the GM gives it this one (a public Foundry otherwise
 *                          lets anyone join as Gamemaster)
 *   SIDECAR_WS_URL         ws://127.0.0.1:3300
 *   WS_AUTH_TOKEN          the sidecar's module token
 *   DIRECTOR_RUNS_TABLE    true to turn on "Director runs the table"
 *   GM_SCREENSHOTS         directory for a screenshot of each stage (optional)
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const env = (k, d = '') => process.env[k] ?? d;
const URL_ = env('FOUNDRY_URL', 'http://127.0.0.1:30000').replace(/\/$/, '');
const WORLD = env('FOUNDRY_WORLD', 'magi-director');
const GM_USER = env('FOUNDRY_GM_USER', 'Gamemaster');
const SHOTS = env('GM_SCREENSHOTS');

const log = (...a) => console.log(new Date().toISOString(), 'headless-gm |', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  if (!SHOTS) return;
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  } catch { /* best effort */ }
}

/**
 * The first of `selectors` that is visible. Foundry v13 renders its license,
 * auth and join forms in the browser after the page loads, so wait (up to
 * `timeout` ms) for one of them before looking.
 */
async function firstVisible(page, selectors, timeout = 20_000) {
  await page.locator(selectors.join(', ')).first().waitFor({ state: 'visible', timeout }).catch(() => {});
  for (const s of selectors) {
    const el = page.locator(s).first();
    if (await el.count() && await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

/** Foundry asks for a key or for the license agreement on a fresh install. */
async function license(page) {
  const key = await firstVisible(page, ['input[name="licenseKey"]', '#key']);
  if (key && env('FOUNDRY_LICENSE_KEY')) {
    log('entering the license key');
    await key.fill(env('FOUNDRY_LICENSE_KEY'));
    await key.press('Enter');
    await page.waitForLoadState('domcontentloaded');
    return;
  }
  const agree = await firstVisible(page, ['input[name="agree"]', '#eula-agree', 'input[type="checkbox"]']);
  if (agree) {
    log('accepting the license agreement');
    await agree.check();
    const sign = await firstVisible(page, ['button[name="sign"]', 'button#sign', 'button[type="submit"]']);
    await sign?.click();
    await page.waitForLoadState('domcontentloaded');
    return;
  }
  throw new Error('on /license but found neither a key field nor the agreement');
}

async function adminAuth(page) {
  const field = await firstVisible(page, ['input[name="adminPassword"]', 'input[name="adminKey"]', 'input[type="password"]']);
  if (!field) throw new Error('on /auth but found no admin password field');
  log('logging in to setup');
  await field.fill(env('FOUNDRY_ADMIN_KEY'));
  await field.press('Enter');
  await page.waitForLoadState('domcontentloaded');
}

async function launchWorld(page) {
  log(`launching world ${WORLD}`);
  const result = await page.evaluate(async (world) => {
    const r = await fetch('/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'launchWorld', world }) });
    return `${r.status} ${(await r.text()).slice(0, 300)}`;
  }, WORLD);
  log(`launch: ${result}`);
  await sleep(5000);
}

async function join(page) {
  const select = page.locator('select[name="userid"]');
  await select.waitFor({ timeout: 30_000 });
  const users = await select.locator('option').allTextContents();
  if (!users.some((u) => u.trim() === GM_USER)) {
    throw new Error(`no user ${GM_USER} on the join page (have: ${users.map((u) => u.trim()).filter(Boolean).join(', ')})`);
  }
  log(`joining as ${GM_USER}`);
  // With FOUNDRY_GM_PASSWORD set, the first start finds the Gamemaster still
  // without a password (Foundry makes it with none): try that before giving up.
  const passwords = [...new Set([env('FOUNDRY_GM_PASSWORD'), ''])];
  for (const [i, password] of passwords.entries()) {
    await select.selectOption({ label: GM_USER });
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[name="join"]').click();
    const last = i === passwords.length - 1;
    try {
      await page.waitForURL(/\/game/, { timeout: last ? 60_000 : 15_000 });
      if (!password && env('FOUNDRY_GM_PASSWORD')) log('joined with no password; setting FOUNDRY_GM_PASSWORD');
      return;
    } catch (err) {
      if (last) throw err;
    }
  }
}

/** Enable Magi Bridge and point it at the sidecar. True if Foundry must reload to pick it up. */
async function configure(page) {
  return page.evaluate(async (want) => {
    const mods = foundry.utils.deepClone(game.settings.get('core', 'moduleConfiguration') ?? {});
    if (!mods['magi-bridge']) {
      mods['magi-bridge'] = true;
      await game.settings.set('core', 'moduleConfiguration', mods);
      return 'enabled the module';
    }
    const changes = [];
    const set = async (key, value) => {
      if (game.settings.get('magi-bridge', key) !== value) {
        await game.settings.set('magi-bridge', key, value);
        changes.push(key);
      }
    };
    await set('sidecarUrl', want.url);
    await set('sidecarToken', want.token);
    await set('bridgeUser', game.user.name);
    // Nobody looks at this browser's canvas, and drawing it in software at full
    // rate keeps the CPU busy and makes every table op take seconds. Throttle it
    // rather than turn it off: with core.noCanvas, Foundry 13 throws on every
    // placeable deletion (CanvasDocument#_onDelete reads layer.clipboard).
    const cheap = { performanceMode: CONST.CANVAS_PERFORMANCE_MODES?.LOW ?? 0, maxFPS: 10 };
    for (const [key, value] of Object.entries(cheap)) {
      if (game.settings.settings.has(`core.${key}`) && game.settings.get('core', key) !== value) {
        await game.settings.set('core', key, value);
        changes.push(key);
      }
    }
    if (want.runsTable) await set('directorRunsTable', true);
    // The module connects at ready, with the settings it had then.
    return changes.filter((k) => k !== 'directorRunsTable').length ? `set ${changes.join(', ')}` : '';
  }, { url: env('SIDECAR_WS_URL', 'ws://127.0.0.1:3300'), token: env('WS_AUTH_TOKEN'),
    runsTable: env('DIRECTOR_RUNS_TABLE') === 'true' });
}

async function inGame(page) {
  await page.waitForFunction(() => window.game?.ready, null, { timeout: 180_000 });
  for (let i = 0; i < 3; i++) {
    const reload = await configure(page);
    if (!reload) break;
    log(`${reload}; reloading`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.game?.ready, null, { timeout: 180_000 });
  }
  const secured = await page.evaluate(async (password) => {
    if (!password) return false;
    await game.user.update({ password });  // the same value on every start: a no-op after the first
    return true;
  }, env('FOUNDRY_GM_PASSWORD'));
  if (!secured) log('FOUNDRY_GM_PASSWORD is not set: the Gamemaster user keeps whatever password it has');
  const status = await page.evaluate(() => ({
    world: game.world.id, system: game.system.id, version: game.version, user: game.user.name,
    module: !!game.modules.get('magi-bridge')?.active,
    runsTable: game.settings.get('magi-bridge', 'directorRunsTable'),
  }));
  log('ready:', JSON.stringify(status));
  await shot(page, 'game');
}

/** Drive the page until it is in the game as the GM. Returns when it is. */
async function reach(page) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const where = new URL(page.url()).pathname;
    await shot(page, where.replace(/\W/g, '') || 'root');
    if (where.startsWith('/license')) await license(page);
    else if (where.startsWith('/auth')) await adminAuth(page);
    else if (where.startsWith('/setup')) await launchWorld(page);
    else if (where.startsWith('/join')) await join(page);
    else if (where.startsWith('/players') || where.startsWith('/stream')) await page.goto(`${URL_}/join`);
    if (new URL(page.url()).pathname.startsWith('/game')) return inGame(page);
    await sleep(2000);
  }
  throw new Error('could not get into the game after 20 tries');
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  for (;;) {
    // Foundry may serve HTTPS with a self-signed certificate (a public magi-dev table);
    // this browser only ever talks to its own server.
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
    page.on('console', (m) => { if (m.text().includes('Magi Bridge')) log('browser:', m.text()); });
    try {
      await reach(page);
      // Stay in the game; start over if Foundry sends us elsewhere or the page dies.
      for (;;) {
        await sleep(15_000);
        const ok = await page.evaluate(() => !!window.game?.ready && location.pathname.startsWith('/game')).catch(() => false);
        if (!ok) { log('left the game; starting over'); break; }
      }
    } catch (err) {
      log('error:', err?.message ?? err);
      await shot(page, 'error');
      await sleep(10_000);
    }
    await page.close().catch(() => {});
  }
}

main().catch((err) => { log('fatal:', err); process.exit(1); });
