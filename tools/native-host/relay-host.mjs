/**
 * Vendored native-messaging host — the one-shot bootstrap pairer.
 *
 * This is the installed, dependency-free copy of the transport workstream's
 * `relay/native-host.ts`. It is plain ESM using nothing but the Node standard
 * library, so the installed host cannot break when a git checkout moves or an
 * npm tree is pruned. Parity with the TypeScript original is asserted by
 * `test/unit/native-host-parity.test.js`.
 *
 * Lifecycle (unchanged from the original):
 *   Chrome spawns this on `chrome.runtime.connectNative('com.hermes.browser_relay')`.
 *   It asks the loopback relay to mint a one-time ticket, writes exactly one
 *   framed response, and exits. The extension disconnects the port immediately;
 *   the live session afterwards is the relay WebSocket, never this channel.
 *
 * Relay discovery order: HERMES_RELAY_URL, HERMES_RELAY_RENDEZVOUS,
 * HERMES_RELAY_URL_FILE, %LOCALAPPDATA%\hermes\browser-relay.json, then the
 * default loopback port.
 *
 * Diagnostics: Chrome discards a native host's stderr, so anything that goes
 * wrong is appended to a log file instead (HERMES_NATIVE_LOG, else
 * %LOCALAPPDATA%\hermes\logs\com.hermes.browser_relay.log). Ticket values are
 * never logged.
 *
 * One deliberate deviation from `native-host.ts`: if stdin reaches EOF while a
 * pairing request is still in flight, this copy still answers. The original
 * exits at once, which turns a slow relay into a silent "host disconnected"
 * with nothing in the log.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_RELAY_PORT = 47317;
export const DEFAULT_NATIVE_HOST = 'com.hermes.browser_relay';
export const TICKET_PREFIX = 'hbrt_';
export const MODES = ['local', 'cloud', 'remote'];

// ------------------------------------------------------------------- framing

/** 4-byte little-endian length prefix + UTF-8 JSON, per the Chrome contract. */
export function encodeNativeMessage(value) {
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

export class NativeMessageDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const out = [];
    for (;;) {
      if (this.#buffer.length < 4) break;
      const length = this.#buffer.readUInt32LE(0);
      if (this.#buffer.length < 4 + length) break;
      const body = this.#buffer.subarray(4, 4 + length).toString('utf8');
      this.#buffer = this.#buffer.subarray(4 + length);
      try {
        out.push(JSON.parse(body));
      } catch {
        out.push({ type: 'decode.error', raw: body.slice(0, 200) });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- diagnostics

function localAppData(env = process.env) {
  return env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
}

export function logPath(env = process.env) {
  if (env.HERMES_NATIVE_LOG) return env.HERMES_NATIVE_LOG;
  return join(localAppData(env), 'hermes', 'logs', `${DEFAULT_NATIVE_HOST}.log`);
}

/** A ticket is greppable by design; make sure it can never reach the log sink. */
export function redact(text) {
  return String(text).replaceAll(/hbrt_[A-Za-z0-9_-]+/g, 'hbrt_[redacted]');
}

export function writeLog(line) {
  const path = logPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${new Date().toISOString()} ${redact(line)}\n`, 'utf8');
  } catch {
    /* logging is best effort — never take the pairing down with it */
  }
}

// -------------------------------------------------------------- rendezvous

function rendezvousPaths(env) {
  return [
    env.HERMES_RELAY_RENDEZVOUS,
    env.HERMES_RELAY_URL_FILE,
    join(localAppData(env), 'hermes', 'browser-relay.json'),
  ].filter(Boolean);
}

export function resolveRelayBase(env = process.env) {
  const explicit = env.HERMES_RELAY_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  for (const path of rendezvousPaths(env)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof parsed.url === 'string' && parsed.url) return parsed.url.replace(/\/+$/, '');
      if (typeof parsed.port === 'number') return `http://127.0.0.1:${parsed.port}`;
    } catch {
      /* try the next candidate */
    }
  }
  return `http://127.0.0.1:${DEFAULT_RELAY_PORT}`;
}

/**
 * POST /browser/pair and translate the answer into a `pair.response` frame.
 * Exported so the parity test can drive it without spawning a process.
 */
export async function pairRequest(request = {}, { base, timeoutMs, log = writeLog } = {}) {
  const mode = request.mode ?? process.env.HERMES_RELAY_MODE ?? 'local';
  log(`pair.request clientId=${request.clientId ?? 'unknown'} mode=${mode}`);
  if (!MODES.includes(mode)) {
    log(`rejecting unsupported mode ${mode}`);
    return { type: 'pair.error', error: `unsupported mode: ${String(request.mode)}` };
  }
  const relayBase = base ?? resolveRelayBase();
  const budget = timeoutMs ?? Number(process.env.HERMES_PAIR_TIMEOUT_MS ?? 5_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    const response = await fetch(`${relayBase}/browser/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: request.clientId ?? 'unknown', mode }),
      signal: controller.signal,
    });
    const body = await response.json();
    if (!response.ok || !body.ok || typeof body.ticket !== 'string' || !body.ticket.startsWith(TICKET_PREFIX)) {
      log(`relay refused pairing (${response.status})`);
      return { type: 'pair.error', error: `relay refused pairing (${response.status})` };
    }
    log(`paired via ${relayBase} (ticket held in memory only)`);
    return {
      type: 'pair.response',
      ticket: body.ticket,
      relayUrl: body.wsUrl,
      expiresAt: body.expiresAt,
      expiresIn: body.expiresIn,
      mode,
      host: DEFAULT_NATIVE_HOST,
    };
  } catch (err) {
    const reason =
      err?.name === 'AbortError' ? 'relay unreachable (timeout)' : `relay unreachable: ${err?.message ?? err}`;
    log(`pairing failed: ${reason}`);
    return { type: 'pair.error', error: reason };
  } finally {
    clearTimeout(timer);
  }
}

// -------------------------------------------------------------------- main

export function main({ stdin = process.stdin, stdout = process.stdout, log = writeLog } = {}) {
  const decoder = new NativeMessageDecoder();
  let inFlight = 0;
  const writeAndExit = (message, code = 0) => {
    stdout.write(encodeNativeMessage(message), () => process.exit(code));
  };
  stdin.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      const request = message ?? {};
      if (request.type !== 'pair.request') {
        log(`unexpected message: ${String(request.type)}`);
        writeAndExit({ type: 'pair.error', error: `unexpected message: ${String(request.type)}` }, 0);
        continue;
      }
      inFlight += 1;
      void pairRequest(request, { log })
        .then((reply) => writeAndExit(reply, 0))
        .finally(() => {
          inFlight -= 1;
        });
    }
  });
  // Chrome keeps stdin open until the extension disconnects the port. If the
  // port goes away mid-pairing, finish the request and answer anyway — a silent
  // exit here is exactly the failure mode a native host is hard to debug for.
  stdin.on('end', () => {
    if (inFlight === 0) process.exit(0);
    else log(`stdin closed with ${inFlight} pairing request(s) in flight — answering before exit`);
  });
  stdin.resume();
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href;
if (invokedDirectly || process.env.HERMES_NATIVE_HOST_MAIN === '1') {
  try {
    main();
  } catch (err) {
    writeLog(`FATAL ${err?.stack ?? err}`);
    process.exit(1);
  }
}
