/**
 * Leak-repro sink server.
 *
 * Stands up two endpoints on localhost:
 *   - HTTP 4080 — serves repro.html (the page-side harness)
 *   - WS   4081 — accepts videoChunk messages and discards them (so the
 *                 send pipeline is real but downstream cannot bottleneck)
 *
 * Used by run.mjs (Playwright orchestrator) for task #38 leak investigation.
 */

import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = 4080;
const WS_PORT = 4081;

const reproHtml = readFileSync(resolve(__dirname, 'repro.html'), 'utf8');

const http = createHttpServer((req, res) => {
  if (req.url === '/' || req.url === '/repro.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(reproHtml);
  } else {
    res.writeHead(404);
    res.end();
  }
});
http.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[sink] http   listening on http://127.0.0.1:${HTTP_PORT}/`);
});

let totalChunks = 0;
let totalBytes = 0;
let lastReportChunks = 0;
let lastReportBytes = 0;

const wss = new WebSocketServer({ host: '127.0.0.1', port: WS_PORT });
wss.on('listening', () => {
  console.log(`[sink] ws     listening on ws://127.0.0.1:${WS_PORT}/`);
});
wss.on('connection', (ws) => {
  console.log('[sink] ws     client connected');
  ws.on('message', (data) => {
    totalChunks++;
    totalBytes += data.length;
    // Discard. We don't even parse — the goal is to drain the WS as fast as
    // possible so backpressure isn't the variable we're measuring.
  });
  ws.on('close', () => console.log('[sink] ws     client disconnected'));
});

setInterval(() => {
  const dChunks = totalChunks - lastReportChunks;
  const dBytes = totalBytes - lastReportBytes;
  lastReportChunks = totalChunks;
  lastReportBytes = totalBytes;
  console.log(`[sink] stats  total=${totalChunks} chunks ${(totalBytes / 1024 / 1024).toFixed(1)} MB | +${dChunks} chunks ${(dBytes / 1024 / 1024).toFixed(1)} MB in last 30s`);
}, 30_000);

const shutdown = () => {
  console.log('[sink] shutting down');
  wss.close();
  http.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
