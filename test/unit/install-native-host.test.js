/**
 * Unit coverage for the native-messaging install:
 *   * the unpacked-extension id derivation (pinned against a measurement),
 *   * the manifest + launcher artefacts,
 *   * install / check / uninstall against an injected registry (no real HKCU),
 *   * the vendored host's framing, relay discovery, redaction and error paths,
 *   * behavioural parity with the transport workstream's `relay/native-host.ts`.
 *
 * The registry is faked here so the unit suite stays side-effect free; the real
 * HKCU round trip is the job of `npm run test:relay:native`.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  BROWSER_FAMILIES,
  DEFAULT_BROWSERS,
  HOST_NAME,
  buildPlan,
  check,
  extensionIdForPath,
  install,
  launcherScript,
  manifestFor,
  registryKeysFor,
  registryParentsFor,
  uninstall,
} from '../../tools/install-native-host.mjs';
import {
  DEFAULT_NATIVE_HOST,
  DEFAULT_RELAY_PORT,
  NativeMessageDecoder,
  encodeNativeMessage,
  pairRequest,
  redact,
  resolveRelayBase,
} from '../../tools/native-host/relay-host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MVP_ROOT = path.resolve(here, '../..');
const EXT_DIR = path.join(MVP_ROOT, 'extension');
// The transport checkout sits beside this repo by default, so the comparison against the
// reference host implementation works on any machine that has both side by side.
const TRANSPORT_HOST = path.join(
  process.env.HERMES_TRANSPORT_DIR || path.resolve(MVP_ROOT, '..', '..', 'hermes-ext-transport'),
  'relay',
  'native-host.ts',
);

function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A `reg.exe` stand-in: an in-memory key/value store with reg's exit codes. */
function fakeRegistry() {
  const store = new Map();
  return {
    store,
    spawn(_exe, args) {
      const [verb, key] = args;
      if (verb === 'add') {
        store.set(key, args[args.indexOf('/d') + 1]);
        return { status: 0, stdout: 'The operation completed successfully.\r\n', stderr: '' };
      }
      if (verb === 'delete') {
        return store.delete(key) ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: 'ERROR: not found' };
      }
      if (verb === 'query') {
        const value = store.get(key);
        if (value === undefined) return { status: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key' };
        return { status: 0, stdout: `\r\n${key}\r\n    (Default)    REG_SZ    ${value}\r\n`, stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unknown verb ${verb}` };
    },
  };
}

/** A stub relay that mints a fixed ticket, so host parity is comparable. */
async function stubRelay({ ticket = 'hbrt_UNITTEST', status = 200, body } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c.toString(); });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, body: raw ? JSON.parse(raw) : null });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body ?? { ok: true, ticket, expiresAt: 1234, expiresIn: 120000, wsUrl: 'ws://127.0.0.1:1/browser/extension' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

/**
 * Drive a native host *process* with one framed request and return its reply.
 * stdin is left open on purpose: Chrome keeps the port open for the lifetime of
 * the request, and a host that sees EOF first is entitled to stop.
 */
function runHostProcess(hostPath, request, env, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [hostPath], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let out = Buffer.alloc(0);
    let err = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`${path.basename(hostPath)} never answered (stdout ${out.length}B, stderr ${err.slice(0, 300)})`));
    }, timeoutMs);
    proc.stdout.on('data', (chunk) => {
      out = Buffer.concat([out, chunk]);
      if (out.length < 4) return;
      const length = out.readUInt32LE(0);
      if (out.length < 4 + length) return;
      clearTimeout(timer);
      const frame = JSON.parse(out.subarray(4, 4 + length).toString('utf8'));
      proc.kill();
      resolve({ frame, rawBytes: out.length });
    });
    proc.stderr.on('data', (chunk) => {
      err += chunk.toString();
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.stdin.write(encodeNativeMessage(request));
  });
}

// ------------------------------------------------------------------ id + plan

test('the unpacked extension id is Chrome own derivation, pinned to a measurement', () => {
  // Pinned vector: Chrome 154.0.8037.57 reports this id for an unpacked extension loaded
  // from `C:\\example\\extension` on any machine.
  const observed = 'khljnbaehneoiakcfkbmegihfaokaboc';
  const id = extensionIdForPath('C:\\example\\extension');
  assert.equal(id, observed);
  assert.match(id, /^[a-p]{32}$/);
});

test('the id derivation is separator-agnostic but case-sensitive', () => {
  const withBackslashes = extensionIdForPath('C:\\example\\somewhere\\extension');
  const withSlashes = extensionIdForPath('C:/example/somewhere/extension');
  const differentCase = extensionIdForPath('C:\\EXAMPLE\\somewhere\\extension');
  assert.equal(withBackslashes, withSlashes);
  assert.notEqual(withBackslashes, differentCase);
});

test('the registry keys are per-user for the families we can prove work', () => {
  assert.deepEqual(DEFAULT_BROWSERS, ['chrome', 'chromium']);
  assert.deepEqual(registryKeysFor(['chrome']), [`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`]);
  assert.deepEqual(registryParentsFor(['chromium']), ['HKCU\\Software\\Chromium\\NativeMessagingHosts']);
  assert.deepEqual(Object.keys(BROWSER_FAMILIES).sort(), ['chrome', 'chromium']);
  // Chrome for Testing was measured to read the Google\Chrome key, not its own
  assert.ok(!registryKeysFor(['chrome']).some((k) => k.includes('Chrome for Testing')));
  assert.throws(() => registryKeysFor(['firefox']), /unknown browser family/);
});

test('the manifest names the launcher and only the extension origin', () => {
  const manifest = manifestFor({ launcherPath: 'C:\\x\\host.bat', extensionId: 'abcdefghijklmnopabcdefghijklmnop' });
  assert.equal(manifest.name, HOST_NAME);
  assert.equal(manifest.type, 'stdio');
  assert.equal(manifest.path, 'C:\\x\\host.bat');
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/']);
});

test('the launcher pins absolute paths, fails loudly and stays parsed as CRLF', () => {
  const script = launcherScript({ nodePath: 'C:\\node dir\\node.exe', hostScript: 'C:\\h\\relay-host.mjs', logPath: 'C:\\h\\host.log' });
  assert.ok(script.startsWith('@echo off\r\n'));
  assert.ok(script.includes('if not defined HERMES_NATIVE_LOG set "HERMES_NATIVE_LOG=C:\\h\\host.log"'));
  assert.ok(script.includes('if not exist "C:\\node dir\\node.exe" ('));
  assert.ok(script.includes('exit /b 9009'));
  assert.ok(script.includes('if not exist "C:\\h\\relay-host.mjs" ('));
  assert.ok(script.includes('exit /b 9008'));
  assert.ok(script.includes('"C:\\node dir\\node.exe" "C:\\h\\relay-host.mjs"'));
  assert.ok(script.includes('exit /b %RC%'));
  assert.ok(script.endsWith('\r\n'));
  assert.equal(script.split('\r\n').filter((l) => l.length && !l.startsWith('rem')).length > 8, true);
});

test('install / check / uninstall are idempotent and need no real registry', () => {
  const localAppData = tempDir('nh-unit-');
  const reg = fakeRegistry();
  const plan = buildPlan({ localAppData, extensionDir: EXT_DIR, browsers: ['chrome'] });
  try {
    assert.equal(existsSync(plan.manifestPath), false);
    const state = install(plan, { spawn: reg.spawn });
    assert.equal(state.extensionId, plan.extensionId);

    // both artefacts landed, with the launcher's paths baked in
    assert.ok(existsSync(plan.manifestPath));
    assert.ok(existsSync(plan.launcherPath));
    assert.ok(existsSync(plan.statePath));
    const manifest = JSON.parse(readFileSync(plan.manifestPath, 'utf8'));
    assert.equal(manifest.path, plan.launcherPath);
    assert.ok(path.isAbsolute(manifest.path));
    assert.ok(readFileSync(plan.launcherPath, 'utf8').includes(plan.hostScript));
    assert.equal(reg.store.get(plan.registryKeys[0]), plan.manifestPath);

    assert.deepEqual(check(plan, { spawn: reg.spawn }), []);

    // installing twice is a no-op, not a second registration
    install(plan, { spawn: reg.spawn });
    assert.equal(reg.store.size, 1);
    assert.deepEqual(check(plan, { spawn: reg.spawn }), []);

    // drift is reported, not swallowed
    writeFileSync(plan.manifestPath, JSON.stringify({ ...manifest, allowed_origins: ['chrome-extension://someone-else/'] }), 'utf8');
    const problems = check(plan, { spawn: reg.spawn });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /allowed_origins/);

    writeFileSync(plan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    rmSync(plan.launcherPath, { force: true });
    assert.match(check(plan, { spawn: reg.spawn })[0], /launcher missing/);

    const removed = uninstall(plan, { spawn: reg.spawn });
    assert.deepEqual(removed.registry, plan.registryKeys);
    assert.equal(reg.store.size, 0);
    assert.equal(existsSync(plan.manifestPath), false);
    assert.equal(existsSync(plan.launcherPath), false);
    assert.equal(existsSync(plan.statePath), false);
  } finally {
    rmSync(localAppData, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the host

test('native-messaging framing survives chunk boundaries', () => {
  const decoder = new NativeMessageDecoder();
  const one = encodeNativeMessage({ type: 'pair.request', clientId: 'a' });
  const two = encodeNativeMessage({ type: 'pair.request', clientId: 'b' });
  assert.deepEqual(decoder.push(one.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(Buffer.concat([one.subarray(3), two.subarray(0, 5)])), [{ type: 'pair.request', clientId: 'a' }]);
  assert.deepEqual(decoder.push(two.subarray(5)), [{ type: 'pair.request', clientId: 'b' }]);
  // a malformed body is reported, never thrown
  const bad = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from('{o}')]);
  assert.deepEqual(decoder.push(bad), [{ type: 'decode.error', raw: '{o}' }]);
});

test('relay discovery prefers an explicit URL, then the rendezvous file, then the port', () => {
  const dir = tempDir('nh-rendezvous-');
  try {
    assert.equal(resolveRelayBase({ HERMES_RELAY_URL: 'http://127.0.0.1:9999//' }), 'http://127.0.0.1:9999');

    const rendezvous = path.join(dir, 'browser-relay.json');
    writeFileSync(rendezvous, JSON.stringify({ port: 51234 }), 'utf8');
    assert.equal(resolveRelayBase({ LOCALAPPDATA: dir, HERMES_RELAY_RENDEZVOUS: rendezvous }), 'http://127.0.0.1:51234');
    writeFileSync(rendezvous, JSON.stringify({ url: 'http://127.0.0.1:51235/' }), 'utf8');
    assert.equal(resolveRelayBase({ LOCALAPPDATA: dir, HERMES_RELAY_RENDEZVOUS: rendezvous }), 'http://127.0.0.1:51235');

    // an explicit URL always wins, even with a rendezvous in reach
    assert.equal(resolveRelayBase({ HERMES_RELAY_URL: 'http://127.0.0.1:1', LOCALAPPDATA: dir, HERMES_RELAY_RENDEZVOUS: rendezvous }), 'http://127.0.0.1:1');

    // an empty profile falls all the way back to the documented default port
    assert.equal(resolveRelayBase({ LOCALAPPDATA: dir }), `http://127.0.0.1:${DEFAULT_RELAY_PORT}`);
    assert.equal(resolveRelayBase({ LOCALAPPDATA: dir, HERMES_RELAY_RENDEZVOUS: path.join(dir, 'gone.json') }), `http://127.0.0.1:${DEFAULT_RELAY_PORT}`);
    // a rendezvous file the runtime wrote under %LOCALAPPDATA%\hermes is found too
    mkdirSync(path.join(dir, 'hermes'), { recursive: true });
    writeFileSync(path.join(dir, 'hermes', 'browser-relay.json'), JSON.stringify({ port: 51236 }), 'utf8');
    assert.equal(resolveRelayBase({ LOCALAPPDATA: dir }), 'http://127.0.0.1:51236');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ticket values are redacted out of the log sink', () => {
  assert.equal(redact('ticket hbrt_abc-DEF_123 written'), 'ticket hbrt_[redacted] written');
  assert.equal(redact('no ticket here'), 'no ticket here');
});

test('the host pairs against a live relay and never logs the ticket', async () => {
  const relay = await stubRelay();
  const lines = [];
  try {
    const reply = await pairRequest({ type: 'pair.request', clientId: 'unit', mode: 'local' }, { base: relay.base, log: (l) => lines.push(redact(l)) });
    assert.equal(reply.type, 'pair.response');
    assert.equal(reply.ticket, 'hbrt_UNITTEST');
    assert.equal(reply.host, DEFAULT_NATIVE_HOST);
    assert.equal(reply.mode, 'local');
    assert.equal(reply.relayUrl, 'ws://127.0.0.1:1/browser/extension');
    assert.deepEqual(relay.seen, [{ url: '/browser/pair', method: 'POST', body: { clientId: 'unit', mode: 'local' } }]);
    assert.equal(lines.join('\n').includes('hbrt_'), false);
  } finally {
    await relay.close();
  }
});

test('the host refuses a bad mode, a non-ticket answer and an unreachable relay', async () => {
  const lines = [];
  const bad = await pairRequest({ type: 'pair.request', mode: 'sideways' }, { base: 'http://127.0.0.1:1', log: (l) => lines.push(l) });
  assert.deepEqual(bad, { type: 'pair.error', error: 'unsupported mode: sideways' });

  const notATicket = await stubRelay({ body: { ok: true, ticket: 'not-a-ticket' } });
  try {
    const reply = await pairRequest({ type: 'pair.request', mode: 'local' }, { base: notATicket.base, log: () => {} });
    assert.equal(reply.type, 'pair.error');
  } finally {
    await notATicket.close();
  }

  const refused = await stubRelay({ status: 503 });
  try {
    const reply = await pairRequest({ type: 'pair.request', mode: 'local' }, { base: refused.base, log: () => {} });
    assert.equal(reply.type, 'pair.error');
    assert.match(reply.error, /refused pairing \(503\)/);
  } finally {
    await refused.close();
  }

  const unreachable = await pairRequest({ type: 'pair.request', mode: 'local' }, { base: 'http://127.0.0.1:1', timeoutMs: 2000, log: () => {} });
  assert.equal(unreachable.type, 'pair.error');
  assert.match(unreachable.error, /relay unreachable/);
});

test('the vendored host behaves exactly like the transport workstream host', async (t) => {
  if (!existsSync(TRANSPORT_HOST)) {
    return t.skip(`transport checkout not present at ${TRANSPORT_HOST}`);
  }
  const relay = await stubRelay();
  const env = { HERMES_RELAY_URL: relay.base, HERMES_PAIR_TIMEOUT_MS: '5000' };
  try {
    const requests = [
      { type: 'pair.request', clientId: 'parity', mode: 'local', v: 1 },
      { type: 'pair.request', clientId: 'parity', mode: 'sideways', v: 1 },
      { type: 'not-a-pair-request', clientId: 'parity' },
    ];
    for (const request of requests) {
      const mine = await runHostProcess(path.join(MVP_ROOT, 'tools', 'native-host', 'relay-host.mjs'), request, env);
      const theirs = await runHostProcess(TRANSPORT_HOST, request, env);
      assert.deepEqual(mine.frame, theirs.frame, `divergence for ${JSON.stringify(request)}`);
    }
  } finally {
    await relay.close();
  }
});
