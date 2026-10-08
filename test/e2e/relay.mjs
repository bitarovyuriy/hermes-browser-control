#!/usr/bin/env node
/**
 * E2E: the whole MVP pipeline, end to end, in real Chrome.
 *
 *   node test/e2e/relay.mjs
 *
 *   Hermes runtime  --HTTP/WS-->  loopback relay  --WS-->  extension service
 *        worker  -->  CDP controller  -->  the user's real browser tab
 *
 * What this proves (the MVP definition of done plus the security hand-off):
 *   * the extension pairs with the relay and holds a live session;
 *   * a command injected by the runtime over the relay opens/navigates a real
 *     tab, reads its DOM, and takes a screenshot;
 *   * the operation guard on the live command path refuses sensitive domains
 *     (fail-closed) both over the relay and on the worker command path;
 *   * a stale profile/port under an armed session is refused, not re-targeted;
 *   * the kill switch halts the relay session too;
 *   * the pairing ticket never reaches disk, storage, or the log sink.
 *
 * The relay is the real `relay/relay-cli.ts` from the loopback transport checkout
 * (default: this repository's own `relay/`; HERMES_TRANSPORT_DIR points at the upstream
 * transport checkout instead); the
 * extension is this directory's `extension/`.
 *
 * Opt-in native-messaging run — the real install path, no manual pairing string:
 *
 *   npm run test:relay:native
 *
 * registers the host in HKCU exactly as `tools/install-native-host.mjs` does for
 * a user, launches Chrome, and requires the extension to reach `connected` from
 * the native host alone. It writes to HKCU and %LOCALAPPDATA%, then uninstalls.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync, readdirSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  HOST_NAME,
  buildPlan,
  check as checkNativeInstall,
  install as installNativeHost,
  uninstall as uninstallNativeHost,
} from '../../tools/install-native-host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(here, '../../extension');
const FIXTURES = path.resolve(here, 'fixtures');
const OUT_DIR = path.resolve(here, 'artifacts');
// The relay ships in this repository (`relay/`). HERMES_TRANSPORT_DIR overrides it with
// the upstream transport checkout, which keeps its relay one level deeper (`relay/relay-cli.ts`).
const RELAY_CLI = [
  path.resolve(here, '..', '..', 'relay', 'relay-cli.ts'),
  process.env.HERMES_TRANSPORT_DIR && path.join(process.env.HERMES_TRANSPORT_DIR, 'relay', 'relay-cli.ts'),
  path.resolve(here, '..', '..', '..', '..', 'hermes-ext-transport', 'relay', 'relay-cli.ts'),
].find((candidate) => candidate && existsSync(candidate));
if (!RELAY_CLI) {
  console.error('relay-cli.ts not found: expected relay/relay-cli.ts in this repository\n'
    + 'set HERMES_TRANSPORT_DIR to the transport checkout (it ships relay/relay-cli.ts)');
  process.exit(3);
}
// Run the relay from the nearest directory that has its dependencies installed.
function moduleRoot(start) {
  let dir = path.dirname(start);
  for (let i = 0; i < 4; i += 1) {
    if (existsSync(path.join(dir, 'node_modules'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(start);
}
const TRANSPORT_DIR = moduleRoot(RELAY_CLI);
const RELAY_LOG = path.join(OUT_DIR, 'relay.log');
const REAL_SITE = process.env.HERMES_E2E_REAL_SITE || 'https://example.com/';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// `--native-host` (or HERMES_NATIVE_HOST=1) runs the real native-messaging
// install instead of the manual pairing string.
const NATIVE_HOST = process.env.HERMES_NATIVE_HOST === '1' || process.argv.includes('--native-host');
const NATIVE_BROWSERS = (process.env.HERMES_NATIVE_BROWSERS ?? 'chrome')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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
      for (const exe of ['chrome-win64/chrome.exe', 'chrome-linux64/chrome', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']) {
        const candidate = path.join(root, version, exe);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  for (const candidate of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
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

function launchChrome({ chromePath, debugPort, userDataDir, headless, env }) {
  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--window-size=1100,760',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  // Chrome hands its own environment to the native-messaging host it spawns, so
  // `env` is how the host learns which relay to pair against.
  const proc = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env });
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

// ----------------------------------------------------------------------- relay
/**
 * The relay writes its rendezvous file into %LOCALAPPDATA%\hermes. Give the
 * child a private one so a test run can never race a sibling run (or the user's
 * real Hermes runtime) over that shared file.
 */
export const RENDEZVOUS_ROOT = mkdtempSync(path.join(os.tmpdir(), 'hermes-e2e-la-'));
export const RENDEZVOUS_FILE = path.join(RENDEZVOUS_ROOT, 'hermes', 'browser-relay.json');

async function startRelay(port) {
  await mkdir(OUT_DIR, { recursive: true });
  const proc = spawn(process.execPath, [RELAY_CLI, '--port', String(port), '--log', RELAY_LOG], {
    cwd: TRANSPORT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LOCALAPPDATA: RENDEZVOUS_ROOT },
  });
  let stdout = '';
  proc.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  proc.stderr.on('data', () => {});
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (stdout.includes('relay on')) return proc;
    if (proc.exitCode !== null) throw new Error(`relay exited early (${proc.exitCode})`);
    await delay(150);
  }
  throw new Error('relay never reported ready');
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, json: await response.json() };
}
async function getJson(url) {
  const response = await fetch(url);
  return { status: response.status, json: await response.json() };
}

// ------------------------------------------------------------------- CDP glue
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
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

async function findExtensionWorker(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const target of targetInfos.filter((t) => t.type === 'service_worker' && String(t.url).startsWith('chrome-extension://'))) {
      try {
        const sessionId = (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
        await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
        if ((await evaluate(cdp, sessionId, 'typeof globalThis.__hermesTest')) === 'object') return { target, sessionId };
        await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      } catch {
        /* not ours */
      }
    }
    await delay(300);
  }
  throw new Error('no extension service worker exposed __hermesTest');
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

async function waitForControlLog(cdp, sessionId, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = (await evaluate(cdp, sessionId, 'document.getElementById("log") ? document.getElementById("log").textContent : ""')) || '';
    if (text.includes(needle)) return text;
    await delay(150);
  }
  throw new Error(`control page log never contained "${needle}"; log was: ${text}`);
}

/** Drives the control page's DOM exactly like a human would (no debug surface). */
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

// ------------------------------------------------------------ native messaging

function frameNative(message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

function readNativeFrame(buffer) {
  if (buffer.length < 4) return null;
  const length = buffer.readUInt32LE(0);
  if (buffer.length < 4 + length) return null;
  return { message: JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')), rest: buffer.subarray(4 + length) };
}

/**
 * Run the installed launcher the way Chrome runs it — `cmd.exe /c <launcher>`
 * with the framed request on stdin — and return the framed reply.
 *
 * Chrome launches `.bat` hosts through cmd.exe, and Node refuses to spawn a
 * `.bat` without a shell, so this is what the browser does, reproduced.
 */
function runNativeLauncher(launcherPath, request, { env = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    const proc = spawn(comspec, ['/c', launcherPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let out = Buffer.alloc(0);
    let err = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`launcher never answered (stdout ${out.length}B, stderr ${err.slice(0, 200)})`));
    }, timeoutMs);
    proc.stdout.on('data', (chunk) => {
      out = Buffer.concat([out, chunk]);
      const frame = readNativeFrame(out);
      if (frame) {
        clearTimeout(timer);
        proc.kill();
        resolve({ frame: frame.message, rawBytes: out.length });
      }
    });
    proc.stderr.on('data', (chunk) => {
      err += chunk.toString();
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.stdin.write(frameNative(request));
  });
}

/** Every check the native-messaging install has to pass before Chrome sees it. */
async function assertNativeInstall(plan, { relayPort, launcherEnv }) {
  const problems = checkNativeInstall(plan);
  check('the installer self-check reports the install intact', problems.length === 0, problems.join('; '));

  const manifest = JSON.parse(readFileSync(plan.manifestPath, 'utf8'));
  check('the host manifest sits under %LOCALAPPDATA%', plan.manifestPath.startsWith(path.join(process.env.LOCALAPPDATA, 'hermes')), plan.manifestPath);
  check('the manifest is stdio and points at an existing absolute launcher', manifest.type === 'stdio' && path.isAbsolute(manifest.path) && existsSync(manifest.path), `type=${manifest.type} path=${manifest.path}`);
  check(
    'allowed_origins carries exactly the unpacked extension id',
    JSON.stringify(manifest.allowed_origins) === JSON.stringify([`chrome-extension://${plan.extensionId}/`]),
    JSON.stringify(manifest.allowed_origins),
  );
  const launcherText = readFileSync(plan.launcherPath, 'utf8');
  check(
    'the launcher pins absolute paths for node and the host script',
    launcherText.includes(plan.nodePath) && launcherText.includes(plan.hostScript) && /@echo off\r\n/.test(launcherText),
    `${launcherText.split('\r\n').length} lines`,
  );

  // per-user only: the value is in HKCU and nowhere in HKLM
  const machineKey = plan.registryKeys[0].replace(/^HKCU/, 'HKLM');
  const machineValue = spawnSync('reg.exe', ['query', machineKey, '/ve']).status;
  check('the registration is per-user (HKCU); nothing machine-wide was written', machineValue !== 0, `HKLM query status=${machineValue}`);

  // the launcher works on its own, with a private %LOCALAPPDATA% rendezvous —
  // the exact contract Chrome relies on before Chrome is even involved
  const direct = await runNativeLauncher(plan.launcherPath, { type: 'pair.request', clientId: 'e2e-launcher', mode: 'local', v: 1 }, {
    env: { LOCALAPPDATA: launcherEnv.root, HERMES_NATIVE_LOG: launcherEnv.log, HERMES_RELAY_URL: `http://127.0.0.1:${relayPort}` },
  });
  check('the launcher answers a framed pair.request with a framed pair.response', direct.frame.type === 'pair.response', JSON.stringify(direct.frame).slice(0, 200));
  check('the native host minted a real single-use ticket', String(direct.frame.ticket).startsWith('hbrt_') && typeof direct.frame.relayUrl === 'string', `relayUrl=${direct.frame.relayUrl} ticketPrefix=${String(direct.frame.ticket).slice(0, 5)}`);
  check('the response frame is exact — no stray bytes from the launcher', direct.rawBytes === 4 + Buffer.byteLength(JSON.stringify(direct.frame), 'utf8'), `bytes=${direct.rawBytes}`);

  // discovery through the %LOCALAPPDATA% rendezvous file (no HERMES_RELAY_URL)
  const rendezvousDir = path.join(launcherEnv.root, 'hermes');
  mkdirSync(rendezvousDir, { recursive: true });
  writeFileSync(path.join(rendezvousDir, 'browser-relay.json'), JSON.stringify({ url: `http://127.0.0.1:${relayPort}`, port: relayPort }), 'utf8');
  const viaRendezvous = await runNativeLauncher(plan.launcherPath, { type: 'pair.request', clientId: 'e2e-rendezvous', mode: 'local', v: 1 }, {
    env: { LOCALAPPDATA: launcherEnv.root, HERMES_NATIVE_LOG: launcherEnv.log },
  });
  check(
    'the host finds the relay through %LOCALAPPDATA%\\hermes\\browser-relay.json',
    viaRendezvous.frame.type === 'pair.response' && viaRendezvous.frame.relayUrl.includes(String(relayPort)),
    JSON.stringify(viaRendezvous.frame).slice(0, 160),
  );

  // failures are loud, not silent: Chrome drops stderr, so they land in the log
  const unreachable = await runNativeLauncher(plan.launcherPath, { type: 'pair.request', clientId: 'e2e-unreachable', mode: 'local', v: 1 }, {
    env: { LOCALAPPDATA: launcherEnv.root, HERMES_NATIVE_LOG: launcherEnv.log, HERMES_RELAY_URL: 'http://127.0.0.1:1', HERMES_PAIR_TIMEOUT_MS: '2500' },
  });
  check(
    'an unreachable relay fails loudly with a framed pair.error',
    unreachable.frame.type === 'pair.error' && /unreachable/.test(String(unreachable.frame.error)),
    JSON.stringify(unreachable.frame),
  );
  const hostLog = existsSync(launcherEnv.log) ? readFileSync(launcherEnv.log, 'utf8') : '';
  check('the host log records the failure and never a ticket value', hostLog.includes('pairing failed') && !hostLog.includes('hbrt_'), `${hostLog.length} chars`);
}

// ----------------------------------------------------------------------- main
async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const chromePath = findChrome();
  console.log(`chrome: ${chromePath}`);
  const httpPort = await freePort();
  const debugPort = await freePort();
  const relayPort = await freePort();
  const userDataDir = path.join(os.tmpdir(), `hermes-relay-e2e-${Date.now()}`);
  const fixtureUrl = `http://127.0.0.1:${httpPort}/`;
  const relayBase = `http://127.0.0.1:${relayPort}`;

  const server = await startFixtureServer(httpPort);
  const relay = await startRelay(relayPort);
  console.log(`relay: ${relayBase}  (log ${RELAY_LOG})`);

  // --- native-messaging install (opt-in): real HKCU registration + manifest,
  //     exactly what `npm run native-host:install` does for a user
  const nativePlan = NATIVE_HOST ? buildPlan({ browsers: NATIVE_BROWSERS }) : null;
  let nativeUninstalled = false;
  const launcherEnv = NATIVE_HOST ? { root: mkdtempSync(path.join(os.tmpdir(), 'hermes-e2e-native-la-')), log: '' } : null;
  if (launcherEnv) launcherEnv.log = path.join(launcherEnv.root, 'native-host-probe.log');
  if (nativePlan) {
    if (existsSync(nativePlan.logPath)) rmSync(nativePlan.logPath, { force: true });
    installNativeHost(nativePlan);
    console.log(`native host: ${nativePlan.manifestPath}  (id ${nativePlan.extensionId})`);
  }

  let chrome = launchChrome({
    chromePath,
    debugPort,
    userDataDir,
    headless: process.env.HEADED !== '1',
    // Chrome passes its environment on to the native host it spawns.
    env: NATIVE_HOST ? { HERMES_RELAY_RENDEZVOUS: RENDEZVOUS_FILE, HERMES_NATIVE_LOG: nativePlan.logPath } : undefined,
  });
  let cdp = null;
  try {
    const version = await waitForDevTools(debugPort, 30000);
    console.log(`browser: ${version.Browser}`);
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    const { sessionId } = await findExtensionWorker(cdp);
    record('extension service worker found', true, 'globalThis.__hermesTest present');

    // --- the native-messaging path: registered host, no pairing string anywhere
    if (NATIVE_HOST) {
      const realId = await evaluate(cdp, sessionId, 'chrome.runtime.id');
      check(
        'the installer derives exactly the id Chrome assigns the unpacked extension',
        realId === nativePlan.extensionId,
        `chrome=${realId} installer=${nativePlan.extensionId}`,
      );
      await assertNativeInstall(nativePlan, { relayPort, launcherEnv });

      const pairingEnvIsClean = await evaluate(
        cdp,
        sessionId,
        `(async () => { const s = await chrome.storage.local.get(null); return JSON.stringify(s).includes('hbr1:') || JSON.stringify(s).includes('hbrt_'); })()`,
      );
      check('no pairing string or ticket was seeded into the extension', pairingEnvIsClean === false, `clean=${pairingEnvIsClean === false}`);

      let nativePhase = null;
      for (let i = 0; i < 80; i += 1) {
        nativePhase = await evaluate(cdp, sessionId, '__hermesTest.relayHost.status().phase');
        if (nativePhase === 'connected') break;
        if (i === 30) await evaluate(cdp, sessionId, '__hermesTest.relayHost.reconnect()');
        await delay(250);
      }
      check('the extension pairs through the native host and reaches `connected` with no manual pairing string', nativePhase === 'connected', `phase=${nativePhase}`);

      const nativeStatus = JSON.parse(await evaluate(cdp, sessionId, 'JSON.stringify(__hermesTest.relayHost.status())'));
      check('the natively paired session is the loopback relay that minted the ticket', String(nativeStatus.url || '').includes(String(relayPort)), `url=${nativeStatus.url}`);

      const nativeRelayStatus = await getJson(`${relayBase}/browser/status`);
      check('the relay sees the natively paired extension session', Boolean(nativeRelayStatus.json.extension), JSON.stringify(nativeRelayStatus.json.extension));

      // a real command all the way through: runtime -> relay -> natively paired worker
      const nativeEcho = await postJson(`${relayBase}/browser/echo`, { method: 'test.echo', params: { hello: 'native' } });
      check('a command round-trips over the natively paired session', nativeEcho.json.ok === true && nativeEcho.json.result?.payload?.echo?.hello === 'native', JSON.stringify(nativeEcho.json.result?.payload).slice(0, 160));

      const nativeLog = existsSync(nativePlan.logPath) ? readFileSync(nativePlan.logPath, 'utf8') : '';
      check('the installed host paired Chrome for real', nativeLog.includes('pair.request'), `${nativeLog.split('\n').filter(Boolean).length} log lines`);
      check('the native host log never carries a ticket value', !nativeLog.includes('hbrt_'), `${nativeLog.length} chars`);
      const relayLogText = existsSync(RELAY_LOG) ? await readFile(RELAY_LOG, 'utf8') : '';
      check('the relay log never carries a ticket value', !relayLogText.includes('hbrt_'), `${relayLogText.length} chars`);

      // uninstall has to be as clean as install: no HKCU value, no manifest left
      uninstallNativeHost(nativePlan);
      nativeUninstalled = true;
      const registryStillThere = spawnSync('reg.exe', ['query', nativePlan.registryKeys[0]]).status === 0;
      check(
        'uninstall removes the registry value and the manifest it wrote',
        !registryStillThere && !existsSync(nativePlan.manifestPath) && !existsSync(nativePlan.launcherPath),
        `registry=${registryStillThere} manifest=${existsSync(nativePlan.manifestPath)} launcher=${existsSync(nativePlan.launcherPath)}`,
      );
    }

    // --- the agent opens its own tab, then the relay drives it
    const opened = await evaluate(cdp, sessionId, `__hermesTest.handleSession({ action: 'openTab', url: ${JSON.stringify(fixtureUrl)} })`);
    const tabId = opened && opened.tabId;
    check('the agent opens a tab before the relay connects', opened && opened.ok && typeof tabId === 'number', JSON.stringify(opened && { ok: opened.ok, tabId, groupId: opened.groupId }));

    // --- pair over the real relay, then hand the ticket to the worker over the
    //     message surface — the same `hermes/relay` actions the runtime side uses
    //     (the native host is the path a human takes; no pairing form exists).
    const pair = await postJson(`${relayBase}/browser/pair`, { clientId: 'e2e-runtime', mode: 'local' });
    check('the relay mints a one-time pairing ticket', pair.json.ok && String(pair.json.ticket).startsWith('hbrt_'), `expiresIn=${pair.json.expiresIn}ms`);
    const pairingString = `hbr1:${Buffer.from(JSON.stringify({ v: 1, url: pair.json.wsUrl, ticket: pair.json.ticket, exp: pair.json.expiresAt })).toString('base64url')}`;

    // the control page open as a real tab: state, relay phase, and the stop
    const controlTabId = await evaluate(cdp, sessionId, `(async () => (await chrome.tabs.create({ url: chrome.runtime.getURL('control/control.html') })).id)()`);
    const controlTarget = await findTarget(cdp, (t) => t.type === 'page' && String(t.url).includes('control/control.html'), 20000, 'control page');
    const controlSession = (await cdp.send('Target.attachToTarget', { targetId: controlTarget.targetId, flatten: true })).sessionId;
    await waitForControlLog(cdp, controlSession, 'control page ready', 15000);
    const control = makePageDriver(cdp, controlSession);
    record('the control page is open and booted', true, `control page tab #${controlTabId}`);

    await evaluate(
      cdp,
      sessionId,
      `(async () => {
         await __hermesTest.handleRelay({ action: 'settings', value: { mode: 'local', port: ${relayPort} } });
         return __hermesTest.handleRelay({ action: 'pairingString', value: ${JSON.stringify(pairingString)} });
       })()`,
    );

    // the page renders the phase it reads back over `hermes/relay`
    let controlPhase = '';
    for (let i = 0; i < 100; i += 1) {
      controlPhase = String((await control.text('relayPhase')) || '');
      if (controlPhase === 'connected') break;
      await delay(200);
    }
    check('pairing over the message surface reaches `connected`', controlPhase === 'connected', `#relayPhase=${controlPhase}`);

    let phase = null;
    for (let i = 0; i < 60; i += 1) {
      phase = await evaluate(cdp, sessionId, '__hermesTest.relayHost.status().phase');
      if (phase === 'connected') break;
      await delay(200);
    }
    check('the worker transport agrees it is connected', phase === 'connected', `phase=${phase}`);
    const workerStatus = await evaluate(cdp, sessionId, 'JSON.stringify(__hermesTest.relayHost.status())');
    record('worker relay status snapshot', true, workerStatus);

    // the ticket never lingers anywhere a page can read: it lives in the
    // transport client's private field, and this page never sees it at all
    const controlText = await control.evaluate('document.body.textContent + "\\n" + (document.getElementById("log").textContent || "")');
    check('no pairing string / ticket appears in the control page DOM or log', !String(controlText).includes('hbr1:') && !String(controlText).includes('hbrt_'), `chars=${String(controlText).length}`);
    const workerSettings = await evaluate(cdp, sessionId, 'JSON.stringify(__hermesTest.relayHost.settings())');
    check('the pairing string is not folded into the worker settings', !String(workerSettings).includes('hbr1:') && !String(workerSettings).includes('hbrt_'), workerSettings);
    const hasTicket = await evaluate(cdp, sessionId, '__hermesTest.relayHost.status().hasTicket');
    check('the worker reports a live session ticket from status()', hasTicket === true, `hasTicket=${hasTicket}`);

    // the relay status probe as the extension worker issues it: GET /browser/status
    const info = await evaluate(
      cdp,
      sessionId,
      `(async () => (await (await fetch('http://127.0.0.1:${relayPort}/browser/status')).json()))()`,
    );
    check(
      'the relay snapshot reports listening / runtimePeers / outstandingTickets',
      Boolean(info) && info.listening === true && typeof info.runtimePeers === 'number' && typeof info.outstandingTickets === 'number',
      JSON.stringify(info),
    );
    check('the relay snapshot sees the live extension session', Boolean(info && info.extension), JSON.stringify(info && info.extension));

    const status = await getJson(`${relayBase}/browser/status`);
    check('the relay reports a live extension session', Boolean(status.json.extension), JSON.stringify(status.json.extension));

    const echo = async (method, params) => postJson(`${relayBase}/browser/echo`, { method, params });
    const tabsOf = async () => evaluate(cdp, sessionId, `__hermesTest.listTabs()`);
    const tabUrl = async (id) => (await tabsOf()).find((t) => t.id === id)?.url;

    // --- liveness round trip (the transport's own proof)
    const pong = await echo('test.echo', { hello: 'runtime' });
    check('runtime -> relay -> extension round trip answers', pong.json.ok && pong.json.result?.payload?.echo?.hello === 'runtime', JSON.stringify(pong.json.result?.payload));

    // --- real browsing over the relay
    const nav = await echo('navigate', { tabId, url: `${fixtureUrl}page2` });
    check('navigate over the relay succeeds', nav.json.ok === true, JSON.stringify(nav.json.result?.payload || nav.json).slice(0, 200));
    await delay(400);
    const afterNav = await tabUrl(tabId);
    check('the real Chrome tab navigated', String(afterNav || '').endsWith('/page2'), `url=${afterNav}`);

    const dom = await echo('readDom', { tabId });
    const domPayload = dom.json.result?.payload?.result || dom.json.result?.payload;
    check('readDom over the relay returns the live DOM', dom.json.ok === true && String(domPayload?.html || '').length > 200, `htmlLength=${String(domPayload?.html || '').length}`);

    const shot = await echo('screenshot', { tabId });
    const shotPayload = shot.json.result?.payload?.result || shot.json.result?.payload;
    check('screenshot over the relay returns a real PNG', shot.json.ok === true && shotPayload?.png === true && shotPayload?.bytes > 1000, `bytes=${shotPayload?.bytes}`);

    // --- a real site on the open internet, on the CDP path (arbitrary origins have
    // no declared content script, so the runtime picks the debugger path)
    const realNav = await echo('navigate', { tabId, url: REAL_SITE, forceCdp: true });
    check('navigate over the relay reaches a real internet site', realNav.json.ok === true, JSON.stringify(realNav.json.result?.error || realNav.json.result?.payload?.result).slice(0, 220));
    await delay(800);
    const realUrl = await tabUrl(tabId);
    check(`the live tab is on ${REAL_SITE}`, String(realUrl || '').startsWith(REAL_SITE), `url=${realUrl}`);
    const realDom = await echo('readDom', { tabId, forceCdp: true });
    const realDomPayload = realDom.json.result?.payload?.result || realDom.json.result?.payload;
    check(
      'the real page DOM is read back through CDP',
      realDom.json.ok === true && realDomPayload?.htmlLength > 200 && /example domain/i.test(String(realDomPayload?.title || '')),
      `title="${realDomPayload?.title}" htmlLength=${realDomPayload?.htmlLength} readyState=${realDomPayload?.readyState}`,
    );
    const realShot = await echo('screenshot', { tabId, forceCdp: true });
    const realShotPayload = realShot.json.result?.payload?.result || realShot.json.result?.payload;
    check('a screenshot of the real page is captured', realShot.json.ok === true && realShotPayload?.png === true, `bytes=${realShotPayload?.bytes}`);

    // back to the loopback fixture so the banner-free content path is exercisable again
    const back = await echo('navigate', { tabId, url: `${fixtureUrl}page2`, forceCdp: true });
    await delay(600);
    const backUrl = await tabUrl(tabId);
    check('the agent returns to the fixture page', back.json.ok === true && String(backUrl).endsWith('/page2'), `ok=${back.json.ok} url=${backUrl} ${JSON.stringify(back.json.result?.error || '')}`);

    // --- the guard on the relay path
    const urlBeforeDenied = await tabUrl(tabId);
    const denied = await echo('navigate', { tabId, url: `http://127.0.0.1:${httpPort}/bank/account` });
    check('the deny-list refuses a sensitive target over the relay', denied.json.ok === false && denied.json.result?.error?.code === 'sensitive-domain', JSON.stringify(denied.json.result?.error));
    const afterDenied = await tabUrl(tabId);
    check('the refused command never navigated the tab', afterDenied === urlBeforeDenied, `before=${urlBeforeDenied} after=${afterDenied}`);

    // --- the guard on the request path the control page and the harness share
    const deniedDirect = await evaluate(
      cdp,
      sessionId,
      `__hermesTest.controller.execute({ name: 'navigate', tabId: ${tabId}, args: { url: 'http://127.0.0.1:${httpPort}/checkout/pay' } })`,
    );
    check('the deny-list refuses a sensitive target on the worker path too', deniedDirect && deniedDirect.ok === false && deniedDirect.code === 'sensitive-domain', JSON.stringify(deniedDirect));

    // --- stale profile/port under an armed session fails closed
    await evaluate(cdp, sessionId, `__hermesTest.handleSession({ action: 'arm', mode: 'tab-group', tabIds: [${tabId}] })`);
    const lease = await evaluate(cdp, sessionId, '__hermesTest.admission.snapshot().lease');
    check('the armed session holds a connection lease', Boolean(lease && lease.profileId && lease.port), JSON.stringify(lease));
    check('the lease is bound to the live relay port', Number(lease?.port) === relayPort, `lease.port=${lease?.port} relayPort=${relayPort}`);
    await evaluate(cdp, sessionId, `__hermesTest.relayHost.debug.setBinding(${JSON.stringify({ ...lease, port: 1 })})`);
    const stale = await echo('readDom', { tabId });
    check('a stale port under an armed session is refused, not re-targeted', stale.json.ok === false && stale.json.result?.error?.code === 'stale-port', JSON.stringify(stale.json.result?.error));
    await evaluate(cdp, sessionId, `__hermesTest.relayHost.debug.setBinding(${JSON.stringify({ ...lease, profileId: 'someone-else' })})`);
    const staleProfile = await echo('readDom', { tabId });
    check('a stale profile under an armed session is refused', staleProfile.json.ok === false && staleProfile.json.result?.error?.code === 'stale-profile', JSON.stringify(staleProfile.json.result?.error));
    await evaluate(cdp, sessionId, `__hermesTest.relayHost.debug.setBinding(${JSON.stringify(lease)})`);
    const restored = await echo('readDom', { tabId });
    check('restoring the binding restores relay commands', restored.json.ok === true, JSON.stringify(restored.json.result?.error || 'ok'));

    // --- no ticket leak
    const leakProbe = await evaluate(
      cdp,
      sessionId,
      `(async () => {
         const local = await chrome.storage.local.get(null);
         const session = await chrome.storage.session.get(null);
         return JSON.stringify({ local, session, status: __hermesTest.relayHost.status() });
       })()`,
    );
    check('no ticket value in storage or transport status', !String(leakProbe).includes('hbrt_'), `keys=${Object.keys(JSON.parse(leakProbe).local).join(',')}`);
    const relayLogText = existsSync(RELAY_LOG) ? await readFile(RELAY_LOG, 'utf8') : '';
    check('the relay log carries no ticket value', !relayLogText.includes('hbrt_'), `bytes=${relayLogText.length}`);

    // --- pause / resume on the control page drive the transport (requirement 3)
    await control.click('#pause');
    let pausedPhase = null;
    for (let i = 0; i < 40; i += 1) {
      pausedPhase = await evaluate(cdp, sessionId, '__hermesTest.relayHost.status().phase');
      if (pausedPhase === 'paused') break;
      await delay(200);
    }
    check('the control page pause button pauses the transport', pausedPhase === 'paused', `phase=${pausedPhase}`);
    let pausedAtRelay = await getJson(`${relayBase}/browser/status`);
    for (let i = 0; i < 25 && pausedAtRelay.json.extension !== null; i += 1) {
      await delay(200);
      pausedAtRelay = await getJson(`${relayBase}/browser/status`);
    }
    check('a paused transport has no live extension session at the relay', pausedAtRelay.json.extension === null, JSON.stringify(pausedAtRelay.json.extension));

    await control.click('#resume');
    // A session ticket is single-use, so the resumed transport re-pairs with the
    // spent string: it re-arms but cannot reach `connected` again on its own.
    await delay(1500);
    let afterResume = null;
    for (let i = 0; i < 30; i += 1) {
      afterResume = await evaluate(cdp, sessionId, '__hermesTest.relayHost.status().phase');
      if (afterResume === 'connected') break;
      await delay(200);
    }
    check(
      'the control page resume button re-arms the transport, but the spent ticket cannot reconnect it',
      ['pairing', 'connecting', 'authenticating', 'reconnecting'].includes(afterResume),
      `phase=${afterResume}`,
    );

    // A fresh pairing string over the message surface gets the transport back to
    // `connected` (the native host does the same thing for a human).
    const pair2 = await postJson(`${relayBase}/browser/pair`, { clientId: 'e2e-runtime', mode: 'local' });
    const pairing2 = `hbr1:${Buffer.from(JSON.stringify({ v: 1, url: pair2.json.wsUrl, ticket: pair2.json.ticket, exp: pair2.json.expiresAt })).toString('base64url')}`;
    await evaluate(cdp, sessionId, `__hermesTest.handleRelay({ action: 'pairingString', value: ${JSON.stringify(pairing2)} })`);
    let reconnected = null;
    for (let i = 0; i < 60; i += 1) {
      reconnected = await evaluate(cdp, sessionId, '__hermesTest.relayHost.status().phase');
      if (reconnected === 'connected') break;
      await delay(200);
    }
    check('the transport reconnects with a fresh pairing string', reconnected === 'connected', `phase=${reconnected}`);

    // --- the kill switch halts the relay session as well — pressed on the page
    await control.click('#kill');
    const killedDirect = await evaluate(cdp, sessionId, `__hermesTest.controller.execute({ name: 'readDom', tabId: ${tabId} })`);
    check('the control page kill switch refuses commands at the extension immediately', killedDirect && killedDirect.ok === false && killedDirect.code === 'killed', JSON.stringify(killedDirect));
    let killedPhase = null;
    for (let i = 0; i < 40; i += 1) {
      killedPhase = await evaluate(cdp, sessionId, '__hermesTest.relayHost.status().phase');
      if (['fatal', 'stopped', 'idle'].includes(killedPhase)) break;
      await delay(200);
    }
    check('the control page kill switch also tears the transport session down', ['fatal', 'stopped', 'idle'].includes(killedPhase), `phase=${killedPhase}`);
    await delay(600);
    const killedOverRelay = await echo('readDom', { tabId });
    check(
      'the relay has no live extension session after the kill switch',
      killedOverRelay.json.ok === false && ['no_extension', 'killed', 'relay_stopped'].includes(killedOverRelay.json.result?.error?.code),
      JSON.stringify(killedOverRelay.json.result?.error),
    );
    const postKillStatus = await getJson(`${relayBase}/browser/status`);
    check('the relay reports the extension session gone', !postKillStatus.json.extension, JSON.stringify(postKillStatus.json.extension));

    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) process.exitCode = 1;
  } finally {
    cdp?.close();
    chrome.kill();
    relay.kill();
    server.close();
    if (nativePlan) {
      if (!nativeUninstalled) {
        const removed = uninstallNativeHost(nativePlan);
        console.log(`native host uninstalled after a failed run (${removed.registry.length} registry value(s), ${removed.files.length} file(s))`);
      }
    }
    if (launcherEnv) rmSync(launcherEnv.root, { recursive: true, force: true });
    if (RENDEZVOUS_ROOT) rmSync(RENDEZVOUS_ROOT, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\nE2E failed: ${err.stack || err.message}`);
  const passed = results.filter((r) => r.ok).length;
  console.error(`${passed}/${results.length} checks passed before the failure`);
  process.exitCode = 1;
});
