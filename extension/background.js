/**
 * Service worker: wires the CDP controller to the control page, to the relay
 * transport, and to the Hermes runtime.
 *
 * Kept deliberately thin — all behaviour lives in src/ so it stays testable.
 */
import { createCdpController } from './src/controller.js';
import { createArtifactStore } from './src/artifacts.js';
import { createAdmissionGuard } from './src/admission.js';
import { createRelayHost } from './src/relay-host.js';
import { createAgentOps } from './src/agent-ops.js';

const KEEPALIVE_ALARM = 'hermes-keepalive';

// ------------------------------------------------------------- security guard
// The guard is created first: the controller consults it before planning any
// command, and the relay host registers the live profile/port binding with it.
const admission = createAdmissionGuard({ log: (...a) => console.debug('[hermes/guard]', ...a) });

// --------------------------------------------------------------------- sink
/**
 * Artifact sink. Two destinations:
 *  1. `chrome.runtime.sendMessage` → the control page (live view);
 *  2. `globalThis.hermesRelay.send` → the loopback relay built by the transport
 *     workstream, which forwards to the Hermes runtime. Wired by transport code
 *     doing `globalThis.hermesRelay = relay` in this worker; absent here.
 */
function artifactSink(record) {
  try {
    const promise = chrome.runtime.sendMessage({ type: 'hermes/artifact', record });
    if (promise && typeof promise.catch === 'function') promise.catch(() => {});
  } catch {
    /* no page listening */
  }
  const relay = globalThis.hermesRelay;
  if (relay && typeof relay.send === 'function') {
    try {
      relay.send({ type: 'artifact', record });
    } catch {
      /* relay down; the artifact is still in the ring buffer */
    }
  }
  // The real runtime sink: an `event` envelope over the transport session.
  try {
    relayHost.publishArtifact(record);
  } catch {
    /* transport not up yet */
  }
}

const store = createArtifactStore({ sink: artifactSink, limit: 200 });
const controller = createCdpController({ api: chrome, store, admission, log: (...a) => console.debug('[hermes]', ...a) });
controller.start();

// --------------------------------------------------------------- agent bridge
// Self-service verbs for the Hermes runtime: tabs.*, page.*, agent.*. Reached over
// the relay (no page clicks) and auto-armed on connect in `agent-all` mode.
const agentOps = createAgentOps({ api: chrome, controller, admission, log: (...a) => console.debug('[hermes/agent]', ...a) });

// --------------------------------------------------------------- relay host
// Grafts the loopback transport layer onto this worker: the relay
// session drives the same controller the control page does, and the guard's
// lease is refreshed whenever an armed session changes.
const relayHost = createRelayHost({
  admission,
  agent: agentOps,
  execute: (command, opts) => controller.execute(command, opts),
  log: (...a) => console.debug('[hermes/relay]', ...a),
  onStatus: (status) => broadcast({ type: 'relay-status', status }),
});
globalThis.hermesRelay = {
  send(message) {
    const record = message && message.record ? message.record : message;
    return relayHost.publishArtifact(record);
  },
};

function broadcast(event) {
  try {
    const promise = chrome.runtime.sendMessage({ type: 'hermes/event', event });
    if (promise && typeof promise.catch === 'function') promise.catch(() => {});
  } catch {
    /* no page listening */
  }
}
controller.on(broadcast);
controller.on((event) => {
  // An armed session adopts the live connection binding as its guard lease.
  if (event && event.type === 'state' && event.state && event.state.armed) relayHost.onArmed();
});

// ------------------------------------------------------------------- alarms
// MV3 kills an idle worker after ~30s; the alarm is the standard keep-alive.
function ensureKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}
async function bootstrap() {
  ensureKeepalive();
  // Connect the relay transport if it is configured. Without a registered
  // native host (or a pairing string over the message surface) this settles
  // into `reconnecting`.
  try {
    await relayHost.start();
  } catch (err) {
    console.debug('[hermes/relay] bootstrap failed', err && err.message);
  }
}
chrome.runtime.onInstalled.addListener(() => void bootstrap());
chrome.runtime.onStartup.addListener(() => void bootstrap());
ensureKeepalive();
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  controller.snapshot();
  // Wake-up hook: re-arm a stalled transport session (MV3 worker-restart trap).
  try {
    relayHost.reconnect();
  } catch {
    /* transport not up */
  }
});

// The toolbar click opens the popup (`control/popup.html`) — the human stop. It is a
// small window next to the icon, not a side panel and not a new tab; the same page is
// also reachable as the options page (`control/control.html`), and the popup links to it.
// With `action.default_popup` set Chrome opens that popup itself, so there is no
// `chrome.action.onClicked` handler here.

// ------------------------------------------------------------------ messages
const SESSION_ACTIONS = new Set(['arm', 'pause', 'resume', 'kill', 'clearKill', 'revoke', 'allow']);

async function handleSession(payload = {}) {
  switch (payload.action) {
    case 'arm': {
      const state = await controller.arm({ mode: payload.mode, tabIds: payload.tabIds || [], tabId: payload.tabId ?? null });
      // The armed session adopts the live connection binding as its lease.
      relayHost.onArmed();
      return { ok: true, state };
    }
    case 'pause':
      relayHost.pause();
      return { ok: true, state: controller.pause() };
    case 'resume':
      relayHost.resume();
      return { ok: true, state: controller.resume() };
    case 'kill':
      relayHost.kill();
      return { ok: true, ...(await controller.kill('kill-switch')) };
    case 'clearKill':
      return { ok: true, state: controller.clearKill() };
    case 'revoke':
      return { ok: true, ...(await controller.revokeTab(payload.tabId)) };
    case 'allow':
      return { ok: true, state: await controller.allowTabs(payload.tabIds || []) };
    case 'openTab': {
      // Opening a tab is an agent action too — the deny-list applies.
      const verdict = admission.check({ url: payload.url || '', source: payload.source || 'session', command: 'openTab' });
      if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };
      // openTargetTab arms the session itself (arm defaults to true).
      const opened = await controller.openTargetTab({ url: payload.url, group: payload.group !== false, arm: payload.arm !== false });
      relayHost.onArmed();
      return { ok: true, ...opened, state: controller.snapshot() };
    }
    default:
      return { ok: false, code: 'unknown-action', message: `unknown session action: ${payload.action}` };
  }
}

/**
 * Transport control surface. The control page uses `status` / `reconnect`; the
 * runtime side (and the E2E harness) can drive the rest, including the manual
 * pairing string, whenever the native host is not the thing pairing.
 */
async function handleRelay(payload = {}) {
  switch (payload.action) {
    case 'status':
      return { ok: true, status: relayHost.status(), settings: relayHost.settings(), binding: admission.snapshot() };
    case 'settings':
      return { ok: true, status: await relayHost.setSettings(payload.value || {}) };
    case 'pairingString':
      return { ok: true, status: await relayHost.setPairingString(payload.value) };
    case 'reconnect':
      return { ok: true, status: await relayHost.reconnect() };
    case 'pause':
      relayHost.pause();
      return { ok: true, status: relayHost.status() };
    case 'resume':
      relayHost.resume();
      return { ok: true, status: relayHost.status() };
    case 'kill':
      relayHost.kill();
      return { ok: true, status: relayHost.status() };
    default:
      return { ok: false, code: 'unknown-action', message: `unknown relay action: ${payload.action}` };
  }
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => !String(t.url || '').startsWith('chrome-extension://'))
    .map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, status: t.status, groupId: t.groupId }));
}

async function handleMessage(message) {
  switch (message.type) {
    case 'hermes/command':
      return await controller.execute(message.command, message.opts || {});
    case 'hermes/session':
      return await handleSession(message.payload);
    case 'hermes/state':
      return { ok: true, state: controller.snapshot() };
    case 'hermes/tabs':
      return { ok: true, tabs: await listTabs() };
    case 'hermes/artifacts':
      return { ok: true, artifacts: store.list() };
    case 'hermes/relay':
      return await handleRelay(message.payload);
    case 'hermes/ping':
      return { ok: true, pong: true, state: controller.snapshot() };
    case 'hermes/agent':
      // Self-service bridge, also reachable from the control page / E2E harness:
      // { type: 'hermes/agent', method: 'tabs.list', params: {} }
      return await agentOps.handle(String(message.method || ''), message.params || {});
    default:
      return { ok: false, code: 'unknown-message', message: `unknown message type: ${message.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || !message.type.startsWith('hermes/')) return false;
  if (message.type === 'hermes/event' || message.type === 'hermes/artifact' || message.type === 'hermes/content-ready') return false;
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, code: 'internal', message: String(err && err.message ? err.message : err) }));
  return true;
});

// Long-lived port so the transport workstream (WS relay) can plug straight in:
//   const port = chrome.runtime.connect({ name: 'hermes-relay' })
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'hermes-relay') return;
  port.onMessage.addListener(async (message) => {
    if (message && message.type === 'hermes/command') {
      port.postMessage({ id: message.id, response: await controller.execute(message.command, message.opts || {}) });
      return;
    }
    if (message && message.type === 'hermes/session') {
      port.postMessage({ id: message.id, response: await handleSession(message.payload) });
      return;
    }
    port.postMessage({ id: message && message.id, response: { ok: false, code: 'unknown-message' } });
  });
});

// ------------------------------------------------------- E2E / debug surface
globalThis.__hermesTest = {
  controller,
  store,
  api: chrome,
  handleMessage,
  handleSession,
  handleRelay,
  listTabs,
  SESSION_ACTIONS,
  admission,
  relayHost,
  agentOps,
};
globalThis.__hermesRelayHost = relayHost;
globalThis.__hermesAdmission = admission;
