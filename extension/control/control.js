/**
 * Control page — the human stop. Two entries load this script:
 *
 * - `control/popup.html` — the toolbar popup (`action.default_popup`), the primary way
 *   in: a small window next to the icon.
 * - `control/control.html` — the same page as the extension's options page, for when the
 *   popup is too small to watch (the popup links to it).
 *
 * The agent is driven by the Hermes runtime through the loopback relay — the
 * native host pairs, the runtime issues the commands. So this page carries no
 * command box, no pairing form and no relay configuration: only the live state
 * and the switches a human needs to stop the agent (Pause / Kill) or to make it
 * retry its connection (Reconnect).
 *
 * All work happens in the service worker; this page is a thin client over the
 * `hermes/state` and `hermes/relay` message surface.
 */

const $ = (id) => document.getElementById(id);
const logEl = $('log');

function log(line) {
  const stamp = new Date().toISOString().slice(11, 19);
  logEl.textContent += `[${stamp}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, code: 'no-worker', message: err.message });
      else resolve(response);
    });
  });
}

function renderState(state) {
  if (!state) return;
  $('stateArmed').textContent = state.killed ? 'KILLED' : state.armed ? (state.paused ? 'paused' : 'armed') : 'idle';
  $('stateMode').textContent = state.mode || 'none';
  $('stateRev').textContent = String(state.revision);
  const attached = state.attached && state.attached.length ? `attached: ${state.attached.join(',')}` : 'attached: -';
  $('status').dataset.summary = attached;
}

function renderRelay(status) {
  if (!status) return;
  $('relayPhase').textContent = status.phase || 'none';
  const endpoint = $('relayUrl');
  endpoint.textContent = status.url || 'none';
  endpoint.title = status.url || '';
}

async function refresh() {
  const state = await send({ type: 'hermes/state' });
  if (state && state.ok) renderState(state.state);
  const relay = await send({ type: 'hermes/relay', payload: { action: 'status' } });
  if (relay && relay.ok) renderRelay(relay.status);
  return state;
}

async function session(action, payload = {}) {
  const response = await send({ type: 'hermes/session', payload: { action, ...payload } });
  log(`${action}: ${JSON.stringify(response && response.state ? response.state : response)}`);
  renderState(response && response.state);
  return response;
}

$('pause').addEventListener('click', () => session('pause'));
$('resume').addEventListener('click', () => session('resume'));
$('kill').addEventListener('click', () => session('kill'));
$('clearKill').addEventListener('click', () => session('clearKill'));
$('reconnect').addEventListener('click', async () => {
  const response = await send({ type: 'hermes/relay', payload: { action: 'reconnect' } });
  if (response && response.ok) renderRelay(response.status);
  log(`reconnect: ${JSON.stringify(response && response.status ? response.status.phase : response)}`);
});

// Popup only: the same page as a full tab, for when the popup is too small to watch.
const openPage = $('openPage');
if (openPage) {
  openPage.addEventListener('click', (event) => {
    event.preventDefault();
    const opened = chrome.runtime.openOptionsPage();
    if (opened && typeof opened.catch === 'function') opened.catch(() => {});
    window.close();
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === 'hermes/event' && message.event) {
    if (message.event.type === 'relay-status') {
      renderRelay(message.event.status);
      return;
    }
    if (message.event.state) renderState(message.event.state);
  }
});

// The page is a view, so it polls as well: an idle service-worker restart must
// not leave a stale "armed" on screen while the agent is actually stopped.
setInterval(() => void refresh(), 2000);

(async function boot() {
  await refresh();
  log('control page ready');
})();
