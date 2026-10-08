/**
 * CDP controller: chrome.debugger attach + CDP forwarding, with the banner-free
 * content-script path for everything that does not need CDP.
 *
 * Everything chrome-shaped is injected as `api` (a chrome-like object), so the
 * module is unit-testable with a fake api and exercised for real in
 * test/e2e/e2e.mjs against a live Chrome.
 */
import { createSessionState } from './session-state.js';
import { MODES, isValidMode } from './access-policy.js';
import { planCommand, PATHS } from './command-router.js';
import { validateCdpCall } from './cdp-methods.js';
import { createContentBridge } from './fallback.js';

export const DEBUGGER_PROTOCOL_VERSION = '1.3';
export const AGENT_GROUP_TITLE = 'Hermes agent';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => JSON.stringify(String(s ?? ''));

export class ControllerError extends Error {
  constructor(message, code = 'controller-error') {
    super(message);
    this.name = 'ControllerError';
    this.code = code;
  }
}

export function createCdpController({
  api,
  store,
  clock = () => Date.now(),
  log = () => {},
  loadTimeoutMs = 20000,
  pollMs = 120,
  admission = null,
} = {}) {
  if (!api) throw new ControllerError('createCdpController needs a chrome-like api');
  if (!store) throw new ControllerError('createCdpController needs an artifact store');

  const state = createSessionState();
  const bridge = createContentBridge({ api });
  const attached = new Map(); // tabId -> {attachedAt, domains:Set<string>}
  const buffers = new Map(); // tabId -> {console:[], responses:[], errors:[], loads:[]}
  const indicatorTabs = new Set();
  const listeners = [];
  let started = false;
  let killGeneration = 0;

  // ---------------------------------------------------------------- utilities
  function p(fn, thisArg, ...args) {
    return new Promise((resolve, reject) => {
      let done = false;
      try {
        const maybe = fn.call(
          thisArg,
          ...args,
          (result) => {
            done = true;
            const lastError = api.runtime && api.runtime.lastError;
            if (lastError) reject(new ControllerError(lastError.message, 'chrome-error'));
            else resolve(result);
          },
        );
        if (!done && maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  function buffer(tabId) {
    if (!buffers.has(tabId)) buffers.set(tabId, { console: [], responses: [], errors: [], loads: [] });
    return buffers.get(tabId);
  }

  function emit(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        log('listener failed', err);
      }
    }
  }

  function assertLive() {
    if (state.snapshot().killed) throw new ControllerError('agent killed by kill-switch', 'killed');
  }

  // ------------------------------------------------------------ chrome events
  function onDebuggerEvent(source, method, params) {
    const tabId = source && source.tabId;
    if (typeof tabId !== 'number') return;
    const buf = buffer(tabId);
    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args || [])
        .map((a) => (a.value !== undefined ? a.value : a.description || a.type))
        .join(' ');
      buf.console.push({ type: params.type, text, at: clock() });
      emit({ type: 'console', tabId, text, level: params.type });
    } else if (method === 'Runtime.exceptionThrown') {
      buf.errors.push({ text: params.exceptionDetails && params.exceptionDetails.text, at: clock() });
    } else if (method === 'Network.responseReceived') {
      buf.responses.push({
        requestId: params.requestId,
        url: params.response && params.response.url,
        status: params.response && params.response.status,
        mimeType: params.response && params.response.mimeType,
        fromCache: Boolean(params.response && params.response.fromCache),
        at: clock(),
      });
      buf.responses = buf.responses.slice(-50);
    } else if (method === 'Network.loadingFinished') {
      const entry = [...buf.responses].reverse().find((r) => r.requestId === params.requestId);
      if (entry && !entry.bodyFetched && /json|text|html|xml|javascript/.test(entry.mimeType || '')) {
        entry.bodyFetched = true;
        sendCdp(tabId, 'Network.getResponseBody', { requestId: params.requestId })
          .then(async (body) => {
            entry.body = body && body.base64Encoded ? '[base64]' : (body && body.body) || '';
            await store.add({
              kind: 'response',
              tabId,
              source: 'cdp',
              url: entry.url,
              status: entry.status,
              mimeType: entry.mimeType,
              text: entry.body,
            });
            emit({ type: 'artifact', artifact: { kind: 'response', tabId, url: entry.url, status: entry.status } });
          })
          .catch((err) => log('getResponseBody failed', err.message));
      }
    } else if (method === 'Page.loadEventFired') {
      buf.loads.push(clock());
    }
  }

  function onDebuggerDetach(source, reason) {
    const tabId = source && source.tabId;
    if (typeof tabId === 'number') attached.delete(tabId);
    emit({ type: 'detached', tabId, reason });
  }

  async function onTabRemoved(tabId) {
    attached.delete(tabId);
    buffers.delete(tabId);
    indicatorTabs.delete(tabId);
    state.revoke(tabId);
  }

  // ------------------------------------------------------------------- attach
  async function attachTab(tabId) {
    assertLive();
    if (attached.has(tabId)) return attached.get(tabId);
    try {
      await p(api.debugger.attach, api.debugger, { tabId }, DEBUGGER_PROTOCOL_VERSION);
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      if (/another debugger is already attached/i.test(message)) {
        throw new ControllerError(`tab ${tabId}: another debugger is already attached`, 'debugger-busy');
      }
      throw new ControllerError(`attach failed for tab ${tabId}: ${message}`, 'attach-failed');
    }
    const entry = { attachedAt: clock(), domains: new Set() };
    attached.set(tabId, entry);
    emit({ type: 'attached', tabId });
    return entry;
  }

  async function detachTab(tabId) {
    if (!attached.has(tabId)) return false;
    attached.delete(tabId);
    try {
      await p(api.debugger.detach, api.debugger, { tabId });
    } catch (err) {
      log('detach failed', err.message);
    }
    emit({ type: 'detached', tabId, reason: 'requested' });
    return true;
  }

  async function detachAll() {
    const ids = [...attached.keys()];
    await Promise.allSettled(ids.map((tabId) => detachTab(tabId)));
    return ids;
  }

  /** Forward one allowlisted CDP command. Re-throws on failure. */
  async function sendCdp(tabId, method, params = {}) {
    assertLive();
    const validated = validateCdpCall(method, params);
    if (!validated.ok) throw new ControllerError(validated.message, validated.code);
    await attachTab(tabId);
    return await p(api.debugger.sendCommand, api.debugger, { tabId }, validated.method, validated.params);
  }

  async function enableDomain(tabId, method) {
    const entry = await attachTab(tabId);
    if (entry.domains.has(method)) return;
    await p(api.debugger.sendCommand, api.debugger, { tabId }, method, {});
    entry.domains.add(method);
  }

  async function enableDomains(tabId) {
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable', 'DOM.enable', 'Log.enable']) {
      await enableDomain(tabId, method);
    }
    // Background tabs do not get input events without focus emulation.
    await sendCdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  }

  // ------------------------------------------------------------------ context
  async function liveContext(tabId) {
    let tab = null;
    if (typeof tabId === 'number') {
      try {
        tab = await p(api.tabs.get, api.tabs, tabId);
      } catch {
        tab = null;
      }
    }
    let activeTabId = null;
    try {
      const tabs = await p(api.tabs.query, api.tabs, { active: true, lastFocusedWindow: true });
      activeTabId = tabs && tabs[0] ? tabs[0].id : null;
    } catch {
      activeTabId = null;
    }
    return {
      tabId,
      activeTabId,
      tabGroupId: tab && typeof tab.groupId === 'number' ? tab.groupId : null,
      tabUrl: tab && tab.url,
    };
  }

  // ----------------------------------------------------------------- indicators
  async function showHud(tabId, extra = {}) {
    indicatorTabs.add(tabId);
    try {
      await bridge.send(tabId, 'hud', { action: 'show', ...describeSession(), ...extra });
      return true;
    } catch (err) {
      log(`hud failed on tab ${tabId}`, err.message);
      return false;
    }
  }

  async function hideHud(tabId) {
    try {
      await bridge.send(tabId, 'hud', { action: 'hide' });
    } catch {
      /* tab gone — nothing to clean */
    }
    indicatorTabs.delete(tabId);
  }

  async function showPointer(tabId, x, y, label) {
    try {
      await bridge.send(tabId, 'pointer', { x, y, label });
    } catch {
      /* indicator only */
    }
  }

  function describeSession() {
    const s = state.snapshot();
    return { mode: s.mode, revision: s.revision, armed: s.armed, paused: s.paused, killed: s.killed };
  }

  // ------------------------------------------------------------------- session
  async function arm({ mode, tabIds = [], tabId = null, groupTitle = AGENT_GROUP_TITLE, agentGroupId: reuseGroupId = null, preserveRevoked = false } = {}) {
    if (!isValidMode(mode)) throw new ControllerError(`bad mode: ${mode}`, 'bad-mode');
    const targetIds = [...new Set([...(tabIds || []), ...(tabId != null ? [tabId] : [])])];
    let agentGroupId = null;

    if (mode === MODES.GROUP) {
      const grouped = await ensureGroup({ tabIds: targetIds, title: groupTitle, groupId: reuseGroupId });
      agentGroupId = grouped.groupId;
    }

    let pinnedActiveTabId = null;
    if (mode === MODES.ACTIVE) {
      if (tabId != null) pinnedActiveTabId = tabId;
      else {
        const tabs = await p(api.tabs.query, api.tabs, { active: true, lastFocusedWindow: true });
        pinnedActiveTabId = tabs && tabs[0] ? tabs[0].id : null;
      }
    }

    const snapshot = state.arm({ mode, tabIds: targetIds, agentGroupId, pinnedActiveTabId, preserveRevoked });
    for (const id of targetIds) await showHud(id);
    emit({ type: 'state', state: snapshot });
    return snapshot;
  }

  async function ensureGroup({ tabIds, title = AGENT_GROUP_TITLE, groupId: reuseGroupId = null }) {
    assertLive();
    if (!api.tabs.group) throw new ControllerError('tabGroups API unavailable', 'no-tab-groups');
    const ids = tabIds.filter((id) => typeof id === 'number');
    const resolved = await p(
      api.tabs.group,
      api.tabs,
      reuseGroupId != null ? { tabIds: ids, groupId: reuseGroupId } : { tabIds: ids },
    );
    try {
      if (api.tabGroups && api.tabGroups.update) {
        await p(api.tabGroups.update, api.tabGroups, resolved, { title, color: 'blue', collapsed: false });
      }
    } catch (err) {
      log('tabGroups.update failed', err.message);
    }
    return { groupId: resolved };
  }

  async function addToGroup(tabId, groupTitle = AGENT_GROUP_TITLE) {
    const s = state.snapshot();
    const { groupId } = await ensureGroup({ tabIds: [tabId], title: groupTitle });
    state.allow({ tabIds: [tabId], agentGroupId: s.mode === MODES.GROUP ? groupId : undefined });
    await showHud(tabId);
    return { groupId, state: state.snapshot() };
  }

  function pause() {
    const snapshot = state.pause();
    emit({ type: 'state', state: snapshot });
    return snapshot;
  }

  function resume() {
    const snapshot = state.resume();
    emit({ type: 'state', state: snapshot });
    return snapshot;
  }

  /**
   * Kill switch: halt everything now.
   * Detaches every debugger session, tears the on-page indicators down, drops
   * buffered observations, and makes every later command fail with `killed`.
   */
  async function kill(reason = 'user kill-switch') {
    killGeneration += 1;
    const snapshot = state.kill();
    const attachedIds = await detachAll();
    await Promise.allSettled([...indicatorTabs].map((tabId) => hideHud(tabId)));
    indicatorTabs.clear();
    buffers.clear();
    emit({ type: 'killed', reason, tabIds: attachedIds });
    emit({ type: 'state', state: snapshot });
    return { state: snapshot, detachedTabs: attachedIds, generation: killGeneration };
  }

  function clearKill() {
    const snapshot = state.clearKill();
    emit({ type: 'state', state: snapshot });
    return snapshot;
  }

  async function revokeTab(tabId) {
    const { revoked, snapshot } = state.revoke(tabId);
    await detachTab(tabId);
    await hideHud(tabId);
    buffers.delete(tabId);
    emit({ type: 'revoked', tabId, revoked });
    emit({ type: 'state', state: snapshot });
    return { revoked, state: snapshot };
  }

  async function allowTabs(tabIds) {
    const snapshot = state.allow({ tabIds });
    for (const tabId of tabIds) await showHud(tabId);
    emit({ type: 'state', state: snapshot });
    return snapshot;
  }

  // ----------------------------------------------------------------- execution
  async function execute(command = {}, opts = {}) {
    const tabId = typeof command.tabId === 'number' ? command.tabId : null;
    const ctx = await liveContext(tabId);
    const gate = state.gate({ tabId, ctx });
    if (!gate.ok) return { ok: false, code: gate.code, message: gate.message, revision: gate.revision };

    // The operation guard on the live command path: the deny-list of
    // sensitive domains, plus the fail-closed profile/port lease when the command
    // arrives over the relay. A denied command never reaches planCommand.
    if (admission) {
      const targetUrl = command.name === 'navigate' && command.args && command.args.url ? command.args.url : ctx.tabUrl;
      const verdict = admission.check({ url: targetUrl || '', source: opts.source || 'panel', command: command.name });
      if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message, command: command.name, guard: verdict.guard };
    }

    const plan = planCommand(command, opts);
    if (!plan.ok) return plan;

    const generation = killGeneration;
    try {
      const result = plan.path === PATHS.CDP ? await runCdp(plan, ctx) : await runContent(plan, ctx);
      if (state.snapshot().killed || generation !== killGeneration) {
        return { ok: false, code: 'killed', message: 'agent killed while the command was running' };
      }
      return { ok: true, command: plan.name, path: plan.path, tabId: plan.tabId, result };
    } catch (err) {
      const code = err instanceof ControllerError ? err.code : 'command-failed';
      log(`command ${plan.name} failed`, err && err.message);
      return { ok: false, code, message: String(err && err.message ? err.message : err), command: plan.name };
    }
  }

  async function runContent(plan, ctx) {
    const { tabId } = plan;
    if (plan.op === 'navigate') {
      const loaded = await bridge.ensure(tabId, { attempts: 3, waitMs: 100 });
      if (!loaded) log(`tab ${tabId}: content script unavailable before navigate (ok if the page is still loading)`);
      const response = await bridge.rawSend(tabId, { type: 'hermes/content', op: 'navigate', args: plan.params });
      if (!response || response.ok === false) {
        throw new ControllerError((response && response.error) || 'navigate failed', 'content-failed');
      }
      const settled = await waitForTabComplete(tabId);
      return { url: plan.params.url, state: response.state, loaded: settled };
    }

    const ready = await bridge.ensure(tabId);
    if (!ready) throw new ControllerError(`content script is not available on tab ${tabId}`, 'no-content-script');

    if (plan.op === 'responseText') {
      const response = await bridge.send(tabId, 'responseText', plan.params);
      await store.add({
        kind: 'response',
        tabId,
        source: 'content',
        url: response.url || plan.params.url,
        status: response.status ?? null,
        text: response.text,
      });
      emit({ type: 'artifact', artifact: { kind: 'response', tabId, path: 'content' } });
      return response;
    }

    const response = await bridge.send(tabId, plan.op, plan.params);

    if (plan.op === 'readDom' || plan.op === 'getText') {
      await store.add({
        kind: plan.op === 'readDom' ? 'dom' : 'text',
        tabId,
        source: 'content',
        url: response.url,
        title: response.title,
        text: response.text,
        html: response.html,
      });
      emit({ type: 'artifact', artifact: { kind: plan.op === 'readDom' ? 'dom' : 'text', tabId, path: 'content' } });
    }
    if (plan.op === 'hud' || plan.op === 'badge' || plan.op === 'pointer') {
      indicatorTabs.add(tabId);
    }
    return response;
  }

  async function runCdp(plan, ctx) {
    const { tabId } = plan;
    await attachTab(tabId);
    await enableDomains(tabId);
    await showHud(tabId, { via: 'cdp' });

    switch (plan.name) {
      case 'navigate': {
        const before = buffer(tabId).loads.length;
        await sendCdp(tabId, 'Page.navigate', { url: plan.params.url });
        const loaded = await waitForLoad(tabId, { sinceIndex: before });
        return { url: plan.params.url, loaded };
      }
      case 'click': {
        const box = await elementBox(tabId, plan.params.selector);
        await showPointer(tabId, box.x, box.y, `click ${plan.params.selector}`);
        await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
        await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
        await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
        return { selector: plan.params.selector, tag: box.tag, x: box.x, y: box.y };
      }
      case 'type': {
        const box = await elementBox(tabId, plan.params.selector);
        await showPointer(tabId, box.x, box.y, `type ${plan.params.selector}`);
        await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
        await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
        if (plan.params.append !== true) {
          // Select the existing content first so insertText replaces it, exactly
          // like a user typing over a selection (Ctrl+A). Pass append=true to
          // type at the caret instead.
          const selectAll = { key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 };
          await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...selectAll });
          await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...selectAll });
        }
        await sendCdp(tabId, 'Input.insertText', { text: String(plan.params.text ?? '') });
        if (plan.params.submit) {
          await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
          await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        }
        const value = await evaluateValue(tabId, `(() => { const el = document.querySelector(${q(plan.params.selector)}); return el ? el.value : null; })()`);
        return { selector: plan.params.selector, value };
      }
      case 'hover': {
        const box = await elementBox(tabId, plan.params.selector);
        await showPointer(tabId, box.x, box.y, `hover ${plan.params.selector}`);
        await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
        return { selector: plan.params.selector, x: box.x, y: box.y };
      }
      case 'scroll': {
        const deltaY = Number(plan.params.deltaY ?? 400);
        const deltaX = Number(plan.params.deltaX ?? 0);
        await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: Number(plan.params.x ?? 10), y: Number(plan.params.y ?? 10), deltaX, deltaY });
        return { deltaX, deltaY };
      }
      case 'readDom': {
        const dom = await evaluateValue(
          tabId,
          `(() => ({ url: location.href, title: document.title, readyState: document.readyState, html: document.documentElement.outerHTML, text: document.body ? document.body.innerText : '' }))()`,
        );
        await store.add({ kind: 'dom', tabId, source: 'cdp', url: dom.url, title: dom.title, html: dom.html, text: dom.text });
        emit({ type: 'artifact', artifact: { kind: 'dom', tabId, path: 'cdp' } });
        return { url: dom.url, title: dom.title, readyState: dom.readyState, htmlLength: (dom.html || '').length, textLength: (dom.text || '').length };
      }
      case 'getText': {
        const value = await evaluateValue(
          tabId,
          `(() => { const el = document.querySelector(${q(plan.params.selector)}); return el ? el.textContent : null; })()`,
        );
        await store.add({ kind: 'text', tabId, source: 'cdp', text: value || '', selector: plan.params.selector });
        return { selector: plan.params.selector, text: value };
      }
      case 'waitFor': {
        const deadline = clock() + Number(plan.params.timeoutMs ?? 5000);
        let found = false;
        while (clock() < deadline) {
          found = await evaluateValue(tabId, `Boolean(document.querySelector(${q(plan.params.selector)}))`);
          if (found) break;
          await delay(pollMs);
        }
        return { selector: plan.params.selector, found };
      }
      case 'evaluate': {
        const value = await evaluateValue(tabId, plan.params.expression);
        await store.add({ kind: 'text', tabId, source: 'cdp-evaluate', text: typeof value === 'string' ? value : JSON.stringify(value) });
        return { value };
      }
      case 'screenshot': {
        const shot = await sendCdp(tabId, 'Page.captureScreenshot', plan.params);
        const record = await store.add({ kind: 'screenshot', tabId, source: 'cdp', data: shot.data });
        emit({ type: 'artifact', artifact: { kind: 'screenshot', tabId, bytes: record.bytes, width: record.width, height: record.height } });
        return { bytes: record.bytes, width: record.width, height: record.height, png: record.png, digest: record.digest };
      }
      case 'consoleLogs': {
        const entries = buffer(tabId).console.slice();
        await store.add({ kind: 'console', tabId, source: 'cdp', entries, text: entries.map((e) => `${e.type}: ${e.text}`).join('\n') });
        emit({ type: 'artifact', artifact: { kind: 'console', tabId, count: entries.length } });
        return { count: entries.length, entries };
      }
      case 'networkBodies': {
        const entries = buffer(tabId).responses.slice();
        return { count: entries.length, entries };
      }
      case 'domSnapshot': {
        const doc = await sendCdp(tabId, 'DOM.getDocument', plan.params);
        const html = await sendCdp(tabId, 'DOM.getOuterHTML', { nodeId: doc.root.nodeId });
        const record = await store.add({ kind: 'dom', tabId, source: 'cdp-dom', html: html.outerHTML, url: ctx.tabUrl });
        return { htmlLength: (html.outerHTML || '').length, digest: record.digest };
      }
      default:
        throw new ControllerError(`no CDP implementation for ${plan.name}`, 'not-implemented');
    }
  }

  async function elementBox(tabId, selector) {
    const box = await evaluateValue(
      tabId,
      `(() => { const el = document.querySelector(${q(selector)}); if (!el) return null; const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase() }; })()`,
    );
    if (!box) throw new ControllerError(`selector not found: ${selector}`, 'selector-not-found');
    return box;
  }

  async function evaluateValue(tabId, expression) {
    assertLive();
    const result = await sendCdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result && result.exceptionDetails) {
      throw new ControllerError(
        `evaluate failed: ${(result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text}`,
        'evaluate-failed',
      );
    }
    return result && result.result ? result.result.value : undefined;
  }

  async function waitForLoad(tabId, { sinceIndex = 0 } = {}) {
    const deadline = clock() + loadTimeoutMs;
    while (clock() < deadline) {
      assertLive();
      const buf = buffer(tabId);
      if (buf.loads.length > sinceIndex) return true;
      const ready = await evaluateValue(tabId, 'document.readyState');
      if (ready === 'complete') return true;
      await delay(pollMs);
    }
    return false;
  }

  async function waitForTabComplete(tabId, timeoutMs = loadTimeoutMs) {
    if (!api.tabs || !api.tabs.onUpdated) return false;
    const deadline = clock() + timeoutMs;
    while (clock() < deadline) {
      const tab = await p(api.tabs.get, api.tabs, tabId).catch(() => null);
      if (tab && tab.status === 'complete') return true;
      await delay(pollMs);
    }
    return false;
  }

  // ------------------------------------------------------------------ lifecycle
  function start() {
    if (started) return;
    started = true;
    if (api.debugger && api.debugger.onEvent) api.debugger.onEvent.addListener(onDebuggerEvent);
    if (api.debugger && api.debugger.onDetach) api.debugger.onDetach.addListener(onDebuggerDetach);
    if (api.tabs && api.tabs.onRemoved) api.tabs.onRemoved.addListener(onTabRemoved);
  }

  function stop() {
    if (!started) return;
    started = false;
    if (api.debugger && api.debugger.onEvent) api.debugger.onEvent.removeListener(onDebuggerEvent);
    if (api.debugger && api.debugger.onDetach) api.debugger.onDetach.removeListener(onDebuggerDetach);
    if (api.tabs && api.tabs.onRemoved) api.tabs.onRemoved.removeListener(onTabRemoved);
  }

  async function disarm() {
    const snapshot = state.pause();
    const ids = await detachAll();
    await Promise.allSettled([...indicatorTabs].map((tabId) => hideHud(tabId)));
    indicatorTabs.clear();
    return { state: snapshot, detachedTabs: ids };
  }

  async function openTargetTab({ url, group = true, arm: shouldArm = true } = {}) {
    const tab = await p(api.tabs.create, api.tabs, { url, active: true });
    const tabId = tab.id;
    let groupId = null;
    if (group) {
      try {
        groupId = (await ensureGroup({ tabIds: [tabId] })).groupId;
      } catch (err) {
        log('could not group the agent tab', err.message);
      }
    }
    if (shouldArm) {
      if (groupId != null) await arm({ mode: MODES.GROUP, tabIds: [tabId], tabId, agentGroupId: groupId });
      else await arm({ mode: MODES.SELECTED, tabIds: [tabId], tabId });
    }
    return { tabId, groupId };
  }

  function snapshot() {
    return {
      ...state.snapshot(),
      attached: [...attached.keys()],
      indicators: [...indicatorTabs],
      buffers: [...buffers.entries()].map(([tabId, b]) => ({ tabId, console: b.console.length, responses: b.responses.length })),
      killGeneration,
    };
  }

  /** Read-only view of one tab's CDP buffers (agent download path needs requestIds). */
  function bufferSnapshot(tabId) {
    const buf = buffers.get(tabId);
    if (!buf) return { console: [], responses: [], errors: [], loads: [] };
    return {
      console: [...buf.console],
      responses: buf.responses.map(({ body, ...rest }) => rest),
      errors: [...buf.errors],
      loads: [...buf.loads],
    };
  }

  return {
    state,
    store,
    bridge,
    start,
    stop,
    arm,
    addToGroup,
    pause,
    resume,
    kill,
    clearKill,
    revokeTab,
    allowTabs,
    disarm,
    openTargetTab,
    execute,
    sendCdp,
    attachTab,
    detachTab,
    detachAll,
    evaluateValue,
    showHud,
    hideHud,
    showPointer,
    snapshot,
    on: (listener) => {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    bufferSnapshot,
  };
}
