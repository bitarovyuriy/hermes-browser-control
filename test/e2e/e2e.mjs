#!/usr/bin/env node
/**
 * E2E: real Chrome + the unpacked extension, driven over the Hermes runtime's
 * own surface.
 *
 *   node test/e2e/e2e.mjs
 *
 * The harness launches Chrome with the extension loaded and talks to it over the
 * DevTools protocol on the *browser* target only. It attaches to the extension's
 * service-worker target (never to the page targets the extension is about to
 * drive), so chrome.debugger.attach inside the extension is free to work.
 *
 * Commands go in through `hermes/command` on the worker's message surface — the
 * same entry point the runtime uses over the relay. The only page the harness
 * drives is the control page, and only for the human-stop checks: it reads the
 * rendered state and presses the kill switch.
 *
 * Covered acceptance criteria:
 *   - the agent opens its own tab, navigates, clicks, types, reads the DOM;
 *   - artifacts (screenshot / DOM / console / response text) reach the runtime sink;
 *   - the kill switch halts everything at once; tab access can be revoked live;
 *   - the banner-free content-script path works without any debugger attach.
 *
 * Chrome is picked from CHROME_PATH, then the local puppeteer cache, then the
 * usual install locations. Nothing is downloaded.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(here, '../../extension');
const FIXTURES = path.resolve(here, 'fixtures');
const OUT_DIR = path.resolve(here, 'artifacts');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ reporting
const results = [];
function record(name, ok, detail = '') {
  const short = String(detail).length > 400 ? `${String(detail).slice(0, 400)}…[+${String(detail).length - 400} chars]` : String(detail);
  results.push({ name, ok, detail: short });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${short ? `  — ${short}` : ''}`);
}
function check(name, condition, detail = '') {
  record(name, Boolean(condition), detail);
  if (!condition) throw new Error(`assertion failed: ${name}${detail ? ` (${detail})` : ''}`);
}

// --------------------------------------------------------------------- chrome
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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startFixtureServer(port) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/data.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: 'hermes-payload', ok: true }));
      return;
    }
    const file = url.pathname === '/page2' ? 'page2.html' : 'testpage.html';
    try {
      const body = await readFile(path.join(FIXTURES, file));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err.message));
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

function launchChrome({ chromePath, debugPort, userDataDir, headless }) {
  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-features=Translate,AcceptCHFrame,OptimizationHints',
    '--window-size=1100,760',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  const proc = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  return proc;
}

async function waitForDevTools(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      /* not up yet */
    }
    await delay(250);
  }
  throw new Error('DevTools endpoint never came up');
}

// ------------------------------------------------------------------- CDP glue
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
        return;
      }
      if (message.method) {
        for (const handler of this.handlers.get(message.method) || []) handler(message.params, message.sessionId);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot open ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(method, handler) {
    const list = this.handlers.get(method) || [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(`evaluate threw: ${detail}`);
  }
  return result.result?.value;
}

/**
 * Chrome ships its own component-extension workers, so identity is proven by
 * probing each worker for our test surface instead of trusting the first hit.
 */
async function findExtensionWorker(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const tried = [];
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const target of targetInfos.filter((t) => t.type === 'service_worker' && String(t.url).startsWith('chrome-extension://'))) {
      try {
        const sessionId = (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
        await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
        const probe = await evaluate(cdp, sessionId, 'typeof globalThis.__hermesTest');
        if (probe === 'object') return { target, sessionId, extensionId: new URL(target.url).host };
        tried.push(target.url);
        await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      } catch (err) {
        tried.push(`${target.url} (${err.message})`);
      }
    }
    await delay(300);
  }
  throw new Error(`no extension service worker exposed __hermesTest; probed: ${JSON.stringify(tried)}`);
}

async function findTarget(cdp, predicate, timeoutMs = 25000, label = 'target') {
  const deadline = Date.now() + timeoutMs;
  let seen = [];
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    seen = targetInfos;
    const hit = targetInfos.find(predicate);
    if (hit) return hit;
    await delay(250);
  }
  throw new Error(`${label} never appeared; saw: ${JSON.stringify(seen.map((t) => `${t.type}:${t.url}`))}`);
}

// ----------------------------------------------------------------------- main
async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const chromePath = findChrome();
  console.log(`chrome: ${chromePath}`);
  const httpPort = await freePort();
  const debugPort = await freePort();
  const userDataDir = path.join(os.tmpdir(), `hermes-cdp-e2e-${Date.now()}`);
  const fixtureUrl = `http://127.0.0.1:${httpPort}/`;

  const server = await startFixtureServer(httpPort);
  let chrome = launchChrome({ chromePath, debugPort, userDataDir, headless: process.env.HEADED !== '1' });
  let cdp = null;
  let swSession = null;
  let controlSession = null; // the control page's CDP session (human-stop checks)

  try {
    let version;
    try {
      version = await waitForDevTools(debugPort, 25000);
    } catch (err) {
      console.log(`headless launch failed (${err.message}); retrying headed`);
      chrome.kill();
      chrome = launchChrome({ chromePath, debugPort, userDataDir, headless: false });
      version = await waitForDevTools(debugPort, 30000);
    }
    console.log(`browser: ${version.Browser}`);
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);

    // ---- service worker ---------------------------------------------------
    const worker = await findExtensionWorker(cdp);
    swSession = worker.sessionId;
    const extensionId = worker.extensionId;
    check('extension service worker target found', Boolean(extensionId), `${extensionId} (${version.Browser})`);
    const swPong = await evaluate(cdp, swSession, 'globalThis.__hermesTest ? "ready" : "missing"');
    check('service worker exposes the controller test surface', swPong === 'ready');

    // keep-alive alarm present (MV3 idle-worker trap)
    const alarms = await evaluate(cdp, swSession, '(async () => (await chrome.alarms.getAll()).map((a) => a.name))()');
    check('service worker keep-alive alarm is registered', Array.isArray(alarms) && alarms.includes('hermes-keepalive'), JSON.stringify(alarms));

    // ---- relay sink -------------------------------------------------------
    await evaluate(cdp, swSession, `globalThis.hermesRelay = { sent: [], send(m) { this.sent.push(m); } }; "ok"`);

    // Hermetic transport: this machine has a native host registered for this
    // extension id, so the worker's boot-time pair lands on the user's live relay
    // (and auto-arms `agent-all`). Drop that session and point the harness's
    // transport at an unusable remote endpoint: it never connects again, so the
    // only arm that stays is the one the test asks for.
    await evaluate(
      cdp,
      swSession,
      `(async () => {
         __hermesTest.relayHost.kill();
         await __hermesTest.handleRelay({ action: 'settings', value: { mode: 'remote', port: 1, baseUrl: '' } });
         return true;
       })()`,
    );
    const harnessPhase = await evaluate(cdp, swSession, '__hermesTest.relayHost.status().phase');
    check('the harness keeps its own transport off the live relay', harnessPhase !== 'connected', `phase=${harnessPhase}`);
    // let the boot-time auto-arm settle before the test starts driving
    await delay(1200);

    // ---- control page (the human stop) as a real tab ----------------------
    const pageTabId = await evaluate(cdp, swSession, `(async () => { const t = await chrome.tabs.create({ url: chrome.runtime.getURL('control/control.html') }); return t.id; })()`);
    const controlTarget = await findTarget(cdp, (t) => t.type === 'page' && String(t.url).includes('control/control.html'), 20000, 'control page');
    controlSession = (await cdp.send('Target.attachToTarget', { targetId: controlTarget.targetId, flatten: true })).sessionId;
    const pageReady = await waitForControlLog(cdp, controlSession, 'control page ready', 15000);
    check('the control page boots and talks to the service worker', pageReady.includes('control page ready'), `control page tab #${pageTabId}`);
    const page = makePageDriver(cdp, controlSession);

    // ---- the agent opens the tab it will drive (no page clicks) -----------
    const opened = await evaluate(cdp, swSession, `__hermesTest.handleSession({ action: 'openTab', url: ${JSON.stringify(fixtureUrl)} })`);
    check('the agent opens its own tab over the session surface', Boolean(opened && opened.ok), JSON.stringify(opened && { ok: opened.ok, tabId: opened.tabId }));
    const fixtureTabs = await evaluate(cdp, swSession, `(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:${httpPort}/*' })).map((t) => ({ id: t.id, groupId: t.groupId, url: t.url })))()`);
    check('the agent tab is a real Chrome tab', fixtureTabs.length === 1, JSON.stringify(fixtureTabs));
    const tabId = fixtureTabs[0].id;
    check('the agent tab is placed in its own tab group', fixtureTabs[0].groupId >= 0, `groupId=${fixtureTabs[0].groupId}`);
    let swState = await evaluate(cdp, swSession, 'globalThis.__hermesTest.controller.snapshot()');
    check('session is armed in tab-group mode after opening the tab', swState.armed && swState.mode === 'tab-group', JSON.stringify({ armed: swState.armed, mode: swState.mode }));
    // the content script is declared for 127.0.0.1/* and needs a moment to boot
    let contentPing = null;
    for (let i = 0; i < 60; i += 1) {
      contentPing = await evaluate(cdp, swSession, `(async () => { try { return await chrome.tabs.sendMessage(${tabId}, { type: 'hermes/content', op: 'ping' }); } catch (err) { return { ok: false, error: String((err && err.message) || err) }; } })()`);
      if (contentPing && contentPing.ok) break;
      await delay(250);
    }
    check('the content script is live in the agent tab', Boolean(contentPing && contentPing.ok), JSON.stringify(contentPing));

    // the control page renders what the worker reports — the stop is live
    let pageState = '';
    for (let i = 0; i < 20; i += 1) {
      pageState = String((await page.text('stateArmed')) || '');
      if (pageState === 'armed') break;
      await delay(250);
    }
    check('the control page renders the live session state', pageState === 'armed', `#stateArmed=${pageState}`);

    // ---- banner-free path: read / type / click / read --------------------
    let response = await runCommand(cdp, swSession, 'readDom', { tabId });
    check('readDom succeeds on the banner-free path', response.ok && response.path === 'content', JSON.stringify(response.result || response));
    swState = await evaluate(cdp, swSession, 'globalThis.__hermesTest.controller.snapshot()');
    check('no debugger is attached for the banner-free path', swState.attached.length === 0, JSON.stringify(swState.attached));

    response = await runCommand(cdp, swSession, 'type', { tabId, args: { selector: '#name', text: 'Ada Lovelace' } });
    check('type (content path) succeeds', response.ok && response.result.value === 'Ada Lovelace', JSON.stringify(response.result || response));
    response = await runCommand(cdp, swSession, 'click', { tabId, args: { selector: '#inc' } });
    check('click (content path) succeeds', response.ok === true, JSON.stringify(response.result || response));
    response = await runCommand(cdp, swSession, 'getText', { tabId, args: { selector: '#count' } });
    check('the banner-free click really hit the page handler', response.ok && response.result.text === '1', JSON.stringify(response.result || response));

    // ---- CDP path ---------------------------------------------------------
    response = await runCommand(cdp, swSession, 'click', { tabId, args: { selector: '#inc' }, forceCdp: true });
    check('click (forced CDP) succeeds', response.ok && response.path === 'cdp', JSON.stringify(response.result || response));
    swState = await evaluate(cdp, swSession, 'globalThis.__hermesTest.controller.snapshot()');
    check('the debugger is attached on the CDP path', swState.attached.includes(tabId), JSON.stringify(swState.attached));
    const debugTargets = await evaluate(cdp, swSession, '(async () => (await chrome.debugger.getTargets()).filter((t) => t.attached).map((t) => t.tabId))()');
    check('chrome.debugger reports the tab as attached', debugTargets.includes(tabId), JSON.stringify(debugTargets));

    response = await runCommand(cdp, swSession, 'getText', { tabId, args: { selector: '#count' } });
    check('the CDP click really hit the page handler', response.ok && response.result.text === '2', JSON.stringify(response.result || response));

    response = await runCommand(cdp, swSession, 'type', { tabId, args: { selector: '#name', text: 'Grace Hopper' }, forceCdp: true });
    check('type (forced CDP, insertText) succeeds', response.ok && response.result.value === 'Grace Hopper', JSON.stringify(response.result || response));
    response = await runCommand(cdp, swSession, 'evaluate', { tabId, args: { expression: 'document.querySelector("#name").value' } });
    check('Runtime.evaluate reads the typed value back', response.ok && response.result.value === 'Grace Hopper', JSON.stringify(response.result || response));

    response = await runCommand(cdp, swSession, 'screenshot', { tabId });
    check('Page.captureScreenshot returns a real PNG', response.ok && response.result.png === true && response.result.width > 0 && response.result.height > 0, JSON.stringify(response.result || response));

    // screenshot bytes out to disk for the human
    const shotBase64 = await evaluate(cdp, swSession, `(async () => (await globalThis.__hermesTest.controller.sendCdp(${tabId}, 'Page.captureScreenshot', {})).data)()`);
    const shotPath = path.join(OUT_DIR, 'screenshot.png');
    await writeFile(shotPath, Buffer.from(shotBase64, 'base64'));
    check('the screenshot artifact is written to disk', existsSync(shotPath), shotPath);

    response = await runCommand(cdp, swSession, 'consoleLogs', { tabId });
    const consoleText = (response.result?.entries || []).map((e) => e.text).join(' | ');
    check('console logs are captured through Runtime.consoleAPICalled', response.ok && /HERMES_E2E_CLICK/.test(consoleText), consoleText || JSON.stringify(response));

    await runCommand(cdp, swSession, 'click', { tabId, args: { selector: '#fetch' }, forceCdp: true });
    await delay(700);
    response = await runCommand(cdp, swSession, 'networkBodies', { tabId });
    const jsonEntry = (response.result?.entries || []).find((e) => String(e.url).endsWith('/data.json'));
    check('response text is captured through Network.*', Boolean(jsonEntry), JSON.stringify(response.result?.entries || response));
    const responseArtifacts = await evaluate(cdp, swSession, 'globalThis.__hermesTest.store.ofKind("response").map((r) => ({ url: r.url, status: r.status, text: r.text }))');
    check('the response body artifact holds the real payload', responseArtifacts.some((r) => String(r.text).includes('hermes-payload')), JSON.stringify(responseArtifacts));

    response = await runCommand(cdp, swSession, 'domSnapshot', { tabId });
    check('DOM.getDocument + DOM.getOuterHTML produce a DOM artifact', response.ok && response.result.htmlLength > 0, JSON.stringify(response.result || response));

    response = await runCommand(cdp, swSession, 'badge', { tabId, args: { selector: 'button' } });
    check('element badges are drawn on the page', response.ok && response.result.count >= 2, JSON.stringify(response.result || response));
    let layerPing = null;
    for (let i = 0; i < 40; i += 1) {
      layerPing = await evaluate(cdp, swSession, `(async () => { try { return await chrome.tabs.sendMessage(${tabId}, { type: 'hermes/content', op: 'ping' }); } catch (err) { return { ok: false, error: String((err && err.message) || err) }; } })()`);
      if (layerPing && layerPing.ok) break;
      await delay(250);
    }
    check('the on-page agent layer is present in the target tab', Boolean(layerPing && layerPing.ok), JSON.stringify(layerPing));

    // ---- artifacts reach the runtime sink --------------------------------
    const relay = await evaluate(cdp, swSession, 'globalThis.hermesRelay.sent.filter((m) => m.type === "artifact").map((m) => m.record.kind)');
    check('artifacts are shipped to the runtime sink (relay adapter)', relay.includes('screenshot') && relay.includes('dom') && relay.includes('console') && relay.includes('response'), JSON.stringify(relay));
    const storeKinds = await evaluate(cdp, swSession, '[...new Set(globalThis.__hermesTest.store.list().map((r) => r.kind))]');
    check('the artifact ring buffer holds every kind', ['screenshot', 'dom', 'console', 'response', 'text'].every((k) => storeKinds.includes(k)), JSON.stringify(storeKinds));
    const feedSize = await evaluate(cdp, swSession, `(async () => (await globalThis.__hermesTest.handleMessage({ type: 'hermes/artifacts' })).artifacts.length)()`);
    check('the artifact feed is served on the message surface', feedSize > 0, `${feedSize} rows`);

    // ---- access modes + live revocation ----------------------------------
    const secondTabId = await evaluate(cdp, swSession, `(async () => { const t = await chrome.tabs.create({ url: 'http://127.0.0.1:${httpPort}/page2' }); return t.id; })()`);
    response = await runCommand(cdp, swSession, 'readDom', { tabId: secondTabId });
    check('a tab outside the agent tab group is refused', response.ok === false && response.code === 'tab-not-allowed', JSON.stringify(response));

    await evaluate(cdp, swSession, `__hermesTest.handleSession({ action: 'revoke', tabId: ${tabId} })`);
    await delay(600);
    response = await runCommand(cdp, swSession, 'readDom', { tabId });
    check('live revocation stops commands on that tab', response.ok === false && response.code === 'tab-not-allowed', JSON.stringify(response));
    swState = await evaluate(cdp, swSession, 'globalThis.__hermesTest.controller.snapshot()');
    check('revocation detaches the debugger from the revoked tab', !swState.attached.includes(tabId), JSON.stringify(swState.attached));

    // re-arm the revoked tab explicitly, selected-tabs mode
    await evaluate(cdp, swSession, `__hermesTest.handleSession({ action: 'arm', mode: 'selected-tabs', tabIds: [${tabId}] })`);
    await delay(500);
    response = await runCommand(cdp, swSession, 'readDom', { tabId });
    check('re-arming the tab restores access (selected-tabs mode)', response.ok === true, JSON.stringify(response));

    // ---- kill switch (pressed on the control page, as a human would) ------
    await page.click('#kill');
    await delay(400);
    response = await runCommand(cdp, swSession, 'readDom', { tabId });
    check('the kill switch refuses further commands immediately', response.ok === false && response.code === 'killed', JSON.stringify(response));
    swState = await evaluate(cdp, swSession, 'globalThis.__hermesTest.controller.snapshot()');
    check('the kill switch detaches every debugger session', swState.attached.length === 0 && swState.killed === true, JSON.stringify({ attached: swState.attached, killed: swState.killed }));
    const stillAttached = await evaluate(cdp, swSession, '(async () => (await chrome.debugger.getTargets()).filter((t) => t.attached).map((t) => t.tabId))()');
    // the harness itself holds a DevTools session on the control page, so only
    // the agent's own targets must be gone
    const agentAttached = stillAttached.filter((id) => id != null && id !== pageTabId);
    check('chrome.debugger has no live attach after the kill switch', agentAttached.length === 0, `still attached: ${JSON.stringify(stillAttached)}`);

    // HUD torn down: check the page itself (safe now — the extension detached)
    const pageTarget = await findTarget(cdp, (t) => t.type === 'page' && String(t.url) === fixtureUrl, 10000, 'fixture page');
    const pageSession = (await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true })).sessionId;
    // The content script hides the HUD when the detach lands, which can be a tick after the
    // kill returns — poll instead of sampling once (this used to flake as `false`).
    let hudHidden = 'no-layer';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      hudHidden = await evaluate(cdp, pageSession, `(() => { const host = document.getElementById('__hermes_agent_layer'); return host ? host.shadowRoot.querySelector('.hud').hidden : 'no-layer'; })()`);
      if (hudHidden === true) break;
      await delay(150);
    }
    check('the kill switch tears the on-page indicator down', hudHidden === true, String(hudHidden));

    const resumeAfterKill = await runCommand(cdp, swSession, 'readDom', { tabId });
    check('the kill switch stays terminal until explicitly cleared', resumeAfterKill.code === 'killed', JSON.stringify(resumeAfterKill));
  } finally {
    try {
      cdp?.close();
    } catch {
      /* ignore */
    }
    try {
      chrome.kill();
    } catch {
      /* ignore */
    }
    await delay(500);
    server.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const report = { at: new Date().toISOString(), chrome: findChrome(), passed, failed, results };
  await writeFile(path.join(OUT_DIR, 'last-run.json'), JSON.stringify(report, null, 2));
  console.log(`\n${passed}/${results.length} checks passed${failed ? ` — ${failed} FAILED` : ''}`);
  console.log(`report: ${path.join(OUT_DIR, 'last-run.json')}`);
  if (failed) process.exitCode = 1;
}

// -------------------------------------------------------------------- helpers
async function waitForControlLog(cdp, sessionId, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = (await evaluate(cdp, sessionId, 'document.getElementById("log") ? document.getElementById("log").textContent : ""')) || '';
    if (text.includes(needle)) return text;
    await delay(150);
  }
  const readyState = await evaluate(cdp, sessionId, 'document.readyState + " " + document.title + " " + location.href');
  throw new Error(`control page log never contained "${needle}" (page: ${readyState}); log was: ${text}`);
}

/**
 * Drive a command through the worker's own message surface — the same entry
 * point the Hermes runtime uses over the relay. No page, no debug verbs.
 */
function runCommand(cdp, swSession, name, { tabId, args = {}, forceCdp = false } = {}) {
  const command = { name, tabId, args };
  return evaluate(
    cdp,
    swSession,
    `globalThis.__hermesTest.handleMessage({ type: 'hermes/command', command: ${JSON.stringify(command)}, opts: ${JSON.stringify({ forceCdp })} })`,
  );
}

/** Reads and clicks the control page's DOM exactly like a human would. */
function makePageDriver(cdp, sessionId) {
  const evaluateInPage = (expression) => evaluate(cdp, sessionId, expression);
  return {
    evaluate: evaluateInPage,
    async click(selector) {
      return evaluateInPage(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ${selector}'); el.click(); return true; })()`);
    },
    async text(id) {
      return evaluateInPage(`(() => { const el = document.getElementById(${JSON.stringify(id)}); return el ? el.textContent : null; })()`);
    },
  };
}

main().catch(async (err) => {
  console.error(`\nE2E FAILED: ${err.message}`);
  results.push({ name: 'harness', ok: false, detail: err.message });
  try {
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(path.join(OUT_DIR, 'last-run.json'), JSON.stringify({ at: new Date().toISOString(), error: err.message, results }, null, 2));
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
});
