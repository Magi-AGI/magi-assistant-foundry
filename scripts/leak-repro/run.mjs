/**
 * Leak-repro orchestrator — task #38.
 *
 * Spawns sink.mjs, launches Playwright Firefox against repro.html, samples
 * the Firefox process tree's RSS every 30s, and writes a CSV alongside the
 * page-side diagnostics probe. Stops after --duration-min (default 30).
 *
 * Usage:
 *   npm i -D playwright
 *   npx playwright install firefox
 *   node scripts/leak-repro/run.mjs --duration-min=30
 *
 * Output: scripts/leak-repro/runs/<iso>/{rss.csv, console.log}
 */

import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
  })
);
const durationMin = Number(args['duration-min'] ?? 30);
const sampleEverySec = Number(args['sample-sec'] ?? 30);
const headless = args['headed'] !== 'true';

const isWin = process.platform === 'win32';

// ─── Output dir ──────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(__dirname, 'runs', stamp);
mkdirSync(outDir, { recursive: true });
const csv = createWriteStream(resolve(outDir, 'rss.csv'));
csv.write('uptime_s,parent_rss_mb,tree_rss_mb,jsHeap_used_mb,chunks_emitted,chunks_sent,chunks_dropped,readers_in_flight,bytes_enqueued,ws_buffered\n');
const consoleLog = createWriteStream(resolve(outDir, 'console.log'));

console.log(`[run] output dir: ${outDir}`);
console.log(`[run] duration:   ${durationMin} min`);
console.log(`[run] sample:     every ${sampleEverySec}s`);
console.log(`[run] headless:   ${headless}`);

// ─── Spawn sink ──────────────────────────────────────────────────────────
const sink = spawn(process.execPath, [resolve(__dirname, 'sink.mjs')], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
sink.on('exit', (code) => console.log(`[run] sink exited: ${code}`));

// Give sink a moment to bind ports.
await new Promise((r) => setTimeout(r, 500));

// ─── Launch Playwright Firefox ────────────────────────────────────────────
let playwright;
try {
  playwright = await import('playwright');
} catch {
  console.error('[run] playwright is not installed. Run:  npm i -D playwright && npx playwright install firefox');
  sink.kill();
  process.exit(1);
}

const browser = await playwright.firefox.launch({ headless });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const startTime = Date.now();

// Latest probe payload received from the page (parsed from console).
let latestProbe = null;
page.on('console', (msg) => {
  const text = msg.text();
  consoleLog.write(text + '\n');
  if (text.startsWith('REPRO_DIAG ')) {
    try {
      latestProbe = JSON.parse(text.slice('REPRO_DIAG '.length));
    } catch (err) {
      console.warn('[run] failed to parse probe:', err.message);
    }
  }
});
page.on('pageerror', (err) => {
  consoleLog.write(`PAGE_ERROR ${err.message}\n${err.stack ?? ''}\n`);
  console.error('[run] page error:', err.message);
});

await page.goto('http://127.0.0.1:4080/repro.html');
console.log('[run] page loaded; recording started');

// ─── RSS sampling ────────────────────────────────────────────────────────
// We can't reliably get the Playwright-launched Firefox PID via the public
// API. Instead, identify all Firefox processes whose command line includes
// "ms-playwright" — that path component is unique to the Playwright Firefox
// install and isolates our launch from any normal Firefox the user is
// running side-by-side.

import fs from 'node:fs';

function sampleRssWindows() {
  // Pass the command via base64-encoded UTF-16LE so we don't fight cmd.exe
  // quoting. PowerShell's -EncodedCommand expects exactly that.
  const ps = `$ErrorActionPreference='SilentlyContinue';$ProgressPreference='SilentlyContinue';$total=0;Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'firefox.exe' -and $_.CommandLine -like '*ms-playwright*' } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { $total += $p.WorkingSet64 } }; Write-Output $total`;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  try {
    const out = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'ignore'] });
    const total = Number(out.trim()) || 0;
    return { parent: total, tree: total };
  } catch {
    return { parent: 0, tree: 0 };
  }
}

function sampleRssLinux() {
  try {
    let total = 0;
    for (const ent of fs.readdirSync('/proc')) {
      const pid = Number(ent);
      if (!Number.isFinite(pid)) continue;
      try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (!cmdline.includes('ms-playwright') || !cmdline.includes('firefox')) continue;
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const m = status.match(/VmRSS:\s*(\d+)\s*kB/);
        if (m) total += Number(m[1]) * 1024;
      } catch { /* process gone */ }
    }
    return { parent: total, tree: total };
  } catch {
    return { parent: 0, tree: 0 };
  }
}

function sampleRss() {
  return isWin ? sampleRssWindows() : sampleRssLinux();
}

// ─── Sample loop ─────────────────────────────────────────────────────────
const stopAt = startTime + durationMin * 60 * 1000;
const interval = setInterval(() => {
  const uptime = Math.round((Date.now() - startTime) / 1000);
  const rss = sampleRss();
  const probe = latestProbe ?? {};
  const row = [
    uptime,
    Math.round(rss.parent / 1024 / 1024),
    Math.round(rss.tree / 1024 / 1024),
    probe.jsHeap?.used_mb ?? '',
    probe.chunks?.emitted ?? '',
    probe.chunks?.sent ?? '',
    probe.chunks?.droppedNoWs ?? '',
    probe.chunks?.readersInFlight ?? '',
    probe.chunks?.bytesEnqueued ?? '',
    probe.ws?.bufferedAmount ?? '',
  ].join(',');
  csv.write(row + '\n');
  console.log(`[run] t=${uptime}s rss_tree=${Math.round(rss.tree / 1024 / 1024)}MB heap=${probe.jsHeap?.used_mb ?? '-'}MB chunks=${probe.chunks?.emitted ?? '-'} buffered=${probe.ws?.bufferedAmount ?? '-'}`);

  if (Date.now() >= stopAt) {
    clearInterval(interval);
    finish();
  }
}, sampleEverySec * 1000);

async function finish() {
  console.log('[run] duration reached — shutting down');
  csv.end();
  consoleLog.end();
  try { await browser.close(); } catch { /* ignore */ }
  sink.kill();
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', finish);
process.on('SIGTERM', finish);
