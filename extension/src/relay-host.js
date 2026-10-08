/**
 * Relay host — the transport workstream grafted into the CDP carrier worker.
 *
 * Responsibilities:
 *   * own the `TransportClient` (pairing, WS session, backoff, heartbeat, queue);
 *   * route every command that arrives over the relay into the CDP controller,
 *     after the admission guard has approved it (`source: 'relay'`);
 *   * publish controller artifacts to the runtime as `event` envelopes;
 *   * keep the transport phase in lockstep with the session kill switch;
 *   * register the live connection binding `{ profileId, port }` so the guard can
 *     fail closed if the runtime swaps under an armed session.
 *
 * The ticket never leaves `TransportClient`'s private field: nothing here stores
 * or logs it (the redacting logger is shared with the relay).
 */

import { TransportClient } from '../vendor/transport/client.js';
import { chromeLocalStorage, chromeSessionStorage } from '../vendor/transport/storage.js';
import { createNativePairingProvider, createStaticPairingProvider } from '../vendor/transport/pairing.js';
import { browserSocketFactory } from '../vendor/transport/socket.js';
import { RedactingLogger } from '../vendor/transport/logger.js';
import { buildEndpoint } from '../vendor/transport/config.js';
import { DEFAULT_NATIVE_HOST, DEFAULT_RELAY_PORT } from '../vendor/transport/types.js';
import { isAgentVerb } from './agent-ops.js';

export const RELAY_SETTINGS_KEY = 'hermes.relay.settings';
export const PROFILE_ID_KEY = 'hermes.browser.profileId';

export const DEFAULT_RELAY_SETTINGS = Object.freeze({
  mode: 'local',
  port: DEFAULT_RELAY_PORT,
  baseUrl: '',
});

function normaliseSettings(value = {}) {
  const mode = ['local', 'cloud', 'remote'].includes(value.mode) ? value.mode : 'local';
  const port = Number.isInteger(Number(value.port)) && Number(value.port) > 0 && Number(value.port) <= 65535
    ? Number(value.port)
    : DEFAULT_RELAY_PORT;
  return { mode, port, baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '' };
}

/** Port the guard binds to: the configured one, or the URL's own port. */
function portFor(settings, url) {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    if (parsed.protocol === 'wss:') return 443;
    if (parsed.protocol === 'ws:') return 80;
  } catch {
    /* fall through to the configured port */
  }
  return settings.port;
}

/**
 * @param {object} opts
 * @param {(command: object, opts: object) => Promise<object>} opts.execute
 *        Bridge into the CDP controller (`source: 'relay'` is added here).
 * @param {(status: object) => void} [opts.onStatus]
 * @param {object} opts.admission  createAdmissionGuard() instance
 * @param {(line: string, detail?: unknown) => void} [opts.log]
 */
export function createRelayHost({ execute, agent = null, onStatus = () => {}, admission, log = () => {} } = {}) {
  const logger = new RedactingLogger((line) => log(line));
  let client = null;
  let settings = { ...DEFAULT_RELAY_SETTINGS };
  /** Memory only: it carries a ticket, so it is never persisted. */
  let manualPairingString = null;
  let profileId = null;
  const clientId = `ext-${Math.random().toString(36).slice(2, 10)}`;
  let lastUrl = null;

  async function ensureProfileId() {
    if (profileId) return profileId;
    const storage = chromeLocalStorage();
    profileId = (await storage.get(PROFILE_ID_KEY)) || null;
    if (!profileId || typeof profileId !== 'string') {
      profileId = `profile-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
      await storage.set(PROFILE_ID_KEY, profileId);
    }
    return profileId;
  }

  function makePairingProvider(mode) {
    if (manualPairingString) return createStaticPairingProvider(manualPairingString, mode);
    if (mode === 'local') {
      return createNativePairingProvider({
        connectNative: (host) => chrome.runtime.connectNative(host),
        hostName: DEFAULT_NATIVE_HOST,
        mode,
        clientId,
      });
    }
    return {
      async request() {
        throw new Error('no pairing string supplied for this mode');
      },
    };
  }

  function handleStatus(status) {
    if (status && status.phase === 'connected') {
      // The live port is the one we actually connected to (the pairing result
      // may point somewhere other than the configured default), so read it off
      // the session URL rather than the settings.
      const port = portFor(settings, (status && status.url) || lastUrl || '');
      admission.setBinding({ profileId, port, documentGeneration: 1 });
      // Self-service: as soon as the runtime is connected, arm the session in
      // `agent-all` mode so no panel click is needed. Respects pause/kill.
      if (agent && typeof agent.ensureArmed === 'function') {
        Promise.resolve()
          .then(() => agent.ensureArmed())
          .then((result) => log('auto-arm', result))
          .catch((err) => log('auto-arm failed', err && err.message));
      }
    }
    onStatus(status);
  }

  async function ensureClient(force = false) {
    if (client && !force) {
      client.ensureAlive();
      return client;
    }
    client?.dispose();
    await ensureProfileId();
    const endpoint = buildEndpoint(settings);
    const url = endpoint.ok ? endpoint.url : undefined;
    const next = new TransportClient({
      config: settings,
      url,
      clientId,
      storage: chromeSessionStorage(),
      socketFactory: browserSocketFactory(),
      pairing: makePairingProvider(settings.mode),
      logger,
      onCommand: async (command) => {
        if (command.method === 'test.echo') {
          return { type: 'result', id: command.id, ok: true, payload: { echo: command.params ?? null, at: Date.now() } };
        }
        const params = command.params && typeof command.params === 'object' ? command.params : {};
        let response;
        if (agent && isAgentVerb(command.method)) {
          // Self-service verbs (tabs.*, page.*, agent.*) — no per-tab arming,
          // the deny-list and the connection lease still apply inside.
          response = await agent.handle(command.method, params);
        } else {
          const { tabId, forceCdp, ...args } = params;
          response = await execute(
            { name: command.method, tabId, args },
            { forceCdp: forceCdp === true, source: 'relay' },
          );
        }
        if (response && response.ok) {
          return { type: 'result', id: command.id, ok: true, payload: response };
        }
        return {
          type: 'result',
          id: command.id,
          ok: false,
          error: {
            code: (response && response.code) || 'command-failed',
            message: (response && response.message) || `command ${command.method} failed`,
          },
          payload: response,
        };
      },
    });
    next.onStatus(handleStatus);
    client = next;
    const endpoint2 = buildEndpoint(settings);
    lastUrl = endpoint2.ok ? endpoint2.url : null;
    await next.start();
    return next;
  }

  /** Publish a controller artifact to the runtime, if the transport is up. */
  function publishArtifact(record) {
    if (!client) return false;
    try {
      client.send({ type: 'event', name: 'artifact', data: { record } });
      return true;
    } catch {
      return false;
    }
  }

  return {
    async start() {
      settings = normaliseSettings(await chromeLocalStorage().get(RELAY_SETTINGS_KEY));
      await ensureClient();
      return this.status();
    },
    async setSettings(value) {
      settings = normaliseSettings(value);
      await chromeLocalStorage().set(RELAY_SETTINGS_KEY, settings);
      await ensureClient(true);
      return this.status();
    },
    /** Memory-only pairing string (carries a ticket). */
    async setPairingString(value) {
      manualPairingString = typeof value === 'string' && value.trim() ? value.trim() : null;
      await ensureClient(true);
      return this.status();
    },
    async reconnect() {
      await ensureClient();
      return this.status();
    },
    kill() {
      client?.kill();
    },
    pause() {
      client?.pause();
    },
    resume() {
      client?.resume();
    },
    /** Refresh the guard lease: the armed session adopts the current binding. */
    onArmed() {
      return admission.refreshLease();
    },
    publishArtifact,
    settings: () => ({ ...settings }),
    status: () => (client ? client.status : { phase: 'idle', mode: settings.mode }),
    phase: () => (client ? client.phase : 'idle'),
    /** Test seam. */
    debug: {
      logger,
      setBinding: (next) => admission.overrideBinding(next),
      admissionSnapshot: () => admission.snapshot(),
    },
  };
}
