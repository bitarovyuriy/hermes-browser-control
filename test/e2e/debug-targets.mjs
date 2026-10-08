#!/usr/bin/env node
/** Debug helper: launch Chrome with the extension and dump every CDP target. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(here, '../../extension');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** CHROME_PATH, then the puppeteer cache, then the usual install locations. */
function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const roots = [path.join(os.homedir(), '.cache', 'puppeteer', 'chrome'), path.join(os.homedir(), '.cache', 'hyperframes', 'chrome')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const version of readdirSync(root).sort().reverse()) {
      for (const exe of ['chrome-win64/chrome.exe', 'chrome-win64/chrome', 'chrome-linux64/chrome', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']) {
        const candidate = path.join(root, version, exe);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  for (const candidate of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('no Chrome/Chromium found — set CHROME_PATH');
}

const CHROME = findChrome();

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const port = await freePort();
const profile = path.join(os.tmpdir(), `hermes-cdp-debug-${Date.now()}`);
const args = [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  `--load-extension=${EXT_DIR}`,
  `--disable-extensions-except=${EXT_DIR}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1100,760',
  'about:blank',
];
console.log('ext dir exists:', existsSync(path.join(EXT_DIR, 'manifest.json')), EXT_DIR);
const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
proc.stderr.on('data', (d) => {
  const line = String(d);
  if (/error|fail|extens/i.test(line)) console.log('[chrome stderr]', line.trim().slice(0, 300));
});

let version = null;
for (let i = 0; i < 60 && !version; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (r.ok) version = await r.json();
  } catch { /* wait */ }
  if (!version) await delay(250);
}
console.log('version:', version && version.Browser, version && version.webSocketDebuggerUrl);

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
});

await send('Target.setDiscoverTargets', { discover: true });
await delay(4000);
const { result: all } = await send('Target.getTargets');
console.log('--- targets ---');
for (const t of all.targetInfos) console.log(`${t.type}  ${t.url}  ${t.targetId}`);

for (const t of all.targetInfos.filter((x) => x.type === 'service_worker')) {
  const attach = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const sid = attach.result.sessionId;
  await send('Runtime.enable', {}, sid).catch(() => {});
  await send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
  const info = await send(
    'Runtime.evaluate',
    {
      expression: `(() => { try { const m = chrome.runtime.getManifest(); return JSON.stringify({ name: m.name, test: typeof globalThis.__hermesTest, hasController: typeof globalThis.__hermesTest !== 'undefined' }); } catch (e) { return 'ERR ' + e.message; } })()`,
      returnByValue: true,
    },
    sid,
  );
  console.log(`SW ${t.url} →`, JSON.stringify(info.result?.result?.value ?? info.result));
}

// try to find the unpacked extension's service worker via the extension page
const { result: pages } = await send('Target.getTargets');
const panel = pages.targetInfos.find((t) => t.type === 'page' && t.url === 'about:blank');
if (panel) {
  const attach = await send('Target.attachToTarget', { targetId: panel.targetId, flatten: true });
  const sid = attach.result.sessionId;
  const ev = await send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, sid);
  console.log('page eval:', JSON.stringify(ev.result));
}
console.log('\nprofile:', profile);
ws.close();
proc.kill();
await delay(300);
process.exit(0);
