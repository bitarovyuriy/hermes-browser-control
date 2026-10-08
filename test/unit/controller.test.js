import test from 'node:test';
import assert from 'node:assert/strict';
import { createCdpController } from '../../extension/src/controller.js';
import { createArtifactStore } from '../../extension/src/artifacts.js';
import { MODES } from '../../extension/src/access-policy.js';

const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function listenerBag() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    fire: (...args) => listeners.forEach((fn) => fn(...args)),
  };
}

/** Minimal chrome-like API: no browser needed. */
function createFakeChrome() {
  const tabs = [
    { id: 10, url: 'http://127.0.0.1:8791/', title: 'fixture', groupId: -1, status: 'complete', active: true },
    { id: 11, url: 'http://127.0.0.1:8791/other', title: 'other', groupId: -1, status: 'complete', active: false },
  ];
  const state = { attached: new Set(), sent: [], groups: 1, groupUpdates: [], contentCalls: [] };
  const byId = (id) => tabs.find((t) => t.id === id);

  function respond(method, params) {
    if (method === 'Runtime.evaluate') {
      if (String(params.expression).includes('readyState')) return { result: { value: 'complete' } };
      if (String(params.expression).includes('getBoundingClientRect')) {
        return { result: { value: { x: 42, y: 24, tag: 'button' } } };
      }
      return { result: { value: null } };
    }
    if (method === 'Page.captureScreenshot') return { data: PNG_1x1 };
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.getOuterHTML') return { outerHTML: '<html><body>fixture</body></html>' };
    if (method === 'Network.getResponseBody') return { body: '{"ok":true}' };
    return {};
  }

  const api = {
    runtime: {},
    debugger: {
      attach(target, version, cb) {
        state.attached.add(target.tabId);
        cb();
      },
      detach(target, cb) {
        state.attached.delete(target.tabId);
        cb();
      },
      sendCommand(target, method, params, cb) {
        state.sent.push({ tabId: target.tabId, method, params });
        cb(respond(method, params));
      },
      onEvent: listenerBag(),
      onDetach: listenerBag(),
    },
    tabs: {
      get(id, cb) {
        cb(byId(id));
      },
      query(_q, cb) {
        cb(tabs.filter((t) => t.active));
      },
      create(opts, cb) {
        const tab = { id: 99, url: opts.url, title: 'new', groupId: -1, status: 'complete', active: true };
        tabs.push(tab);
        cb(tab);
      },
      group(opts, cb) {
        const gid = opts.groupId ?? (state.groups += 1);
        for (const id of opts.tabIds) byId(id).groupId = gid;
        cb(gid);
      },
      sendMessage(tabId, message, cb) {
        state.contentCalls.push({ tabId, op: message.op });
        const op = message.op;
        if (op === 'ping') return cb({ ok: true, url: 'http://127.0.0.1:8791/' });
        if (op === 'readDom') return cb({ ok: true, url: 'http://127.0.0.1:8791/', title: 'fixture', text: 'hello', html: '<html/>' });
        if (op === 'hud') return cb({ ok: true, action: 'show' });
        if (op === 'pointer') return cb({ ok: true });
        if (op === 'responseText') return cb({ ok: true, url: 'http://127.0.0.1:8791/data.json', status: 200, text: '{"ok":true}' });
        return cb({ ok: true, op });
      },
      onRemoved: listenerBag(),
    },
    tabGroups: {
      update(groupId, props, cb) {
        state.groupUpdates.push({ groupId, props });
        cb();
      },
    },
  };
  return { api, state, tabs };
}

function setup() {
  const { api, state, tabs } = createFakeChrome();
  const store = createArtifactStore({ sink: async () => {} });
  const controller = createCdpController({ api, store, log: () => {}, loadTimeoutMs: 200, pollMs: 5 });
  controller.start();
  return { api, state, tabs, store, controller };
}

test('an unarmed controller refuses every command', async () => {
  const { controller } = setup();
  const result = await controller.execute({ name: 'readDom', tabId: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-armed');
});

test('content path runs readDom without ever attaching the debugger', async () => {
  const { controller, state, store } = setup();
  await controller.arm({ mode: MODES.SELECTED, tabIds: [10] });
  const result = await controller.execute({ name: 'readDom', tabId: 10 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.path, 'content');
  assert.equal(result.result.text, 'hello');
  assert.equal(state.attached.size, 0, 'no debugger attach on the banner-free path');
  assert.equal(store.ofKind('dom').length, 1);
  assert.ok(store.latest('dom').digest);
});

test('CDP path attaches, forwards only allowlisted methods, and stores the screenshot', async () => {
  const { controller, state, store } = setup();
  await controller.arm({ mode: MODES.SELECTED, tabIds: [10] });
  const result = await controller.execute({ name: 'screenshot', tabId: 10 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.path, 'cdp');
  assert.equal(result.result.png, true);
  assert.deepEqual({ w: result.result.width, h: result.result.height }, { w: 1, h: 1 });
  assert.ok(state.attached.has(10));
  assert.deepEqual(store.ofKind('screenshot').length, 1);
  const forwarded = state.sent.map((s) => s.method);
  assert.ok(forwarded.includes('Page.captureScreenshot'));
  assert.ok(forwarded.includes('Page.enable'));
  assert.ok(forwarded.includes('Runtime.enable'));
});

test('the debugger is never handed a method outside the allowlist', async () => {
  const { controller, state } = setup();
  await controller.arm({ mode: MODES.SELECTED, tabIds: [10] });
  await assert.rejects(() => controller.sendCdp(10, 'Storage.getCookies', {}), (err) => err.code === 'method-not-allowed');
  await assert.rejects(() => controller.sendCdp(10, 'Browser.grantPermissions', {}), (err) => err.code === 'method-not-allowed');
  assert.equal(state.sent.filter((s) => /Storage|Browser\./.test(s.method)).length, 0);
});

test('tabs outside the grant are refused', async () => {
  const { controller } = setup();
  await controller.arm({ mode: MODES.SELECTED, tabIds: [10] });
  const denied = await controller.execute({ name: 'readDom', tabId: 11 });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'tab-not-allowed');
});

test('revoking a tab live stops commands and detaches the debugger', async () => {
  const { controller, state } = setup();
  await controller.arm({ mode: MODES.SELECTED, tabIds: [10] });
  await controller.execute({ name: 'screenshot', tabId: 10 });
  assert.ok(state.attached.has(10));
  const { revoked } = await controller.revokeTab(10);
  assert.equal(revoked, true);
  assert.equal(state.attached.has(10), false, 'revocation detaches the debugger');
  const after = await controller.execute({ name: 'readDom', tabId: 10 });
  assert.equal(after.code, 'tab-not-allowed');
});

test('the kill switch halts everything at once and is terminal', async () => {
  const { controller, state, store } = setup();
  await controller.arm({ mode: MODES.SELECTED, tabIds: [10] });
  await controller.execute({ name: 'screenshot', tabId: 10 });
  const killed = await controller.kill('test');
  assert.deepEqual(killed.detachedTabs, [10]);
  assert.equal(state.attached.size, 0);
  assert.equal(killed.state.killed, true);
  const after = await controller.execute({ name: 'readDom', tabId: 10 });
  assert.equal(after.ok, false);
  assert.equal(after.code, 'killed');
  // re-arming without clearing the kill switch stays refused
  await assert.rejects(() => controller.arm({ mode: MODES.SELECTED, tabIds: [10] }), /killed/);
  controller.clearKill();
  const stillUnarmed = await controller.execute({ name: 'readDom', tabId: 10 });
  assert.equal(stillUnarmed.code, 'not-armed');
  assert.ok(store.size() >= 1, 'artifacts survive the kill switch');
});

test('pause freezes commands without detaching', async () => {
  const { controller, state } = setup();
  await controller.arm({ mode: MODES.SELECTED, tabIds: [10] });
  await controller.execute({ name: 'screenshot', tabId: 10 });
  controller.pause();
  const paused = await controller.execute({ name: 'readDom', tabId: 10 });
  assert.equal(paused.code, 'paused');
  assert.ok(state.attached.has(10), 'pause keeps the debugger session for a fast resume');
  controller.resume();
  const resumed = await controller.execute({ name: 'readDom', tabId: 10 });
  assert.equal(resumed.ok, true);
});

test('console logs and network bodies are collected from CDP events', async () => {
  const { controller, api, store } = setup();
  await controller.arm({ mode: MODES.SELECTED, tabIds: [10] });
  api.debugger.onEvent.fire({ tabId: 10 }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'hello' }, { value: 42 }] });
  api.debugger.onEvent.fire({ tabId: 10 }, 'Network.responseReceived', {
    requestId: 'r1',
    response: { url: 'http://127.0.0.1:8791/data.json', status: 200, mimeType: 'application/json' },
  });
  const logs = await controller.execute({ name: 'consoleLogs', tabId: 10 });
  assert.equal(logs.result.count, 1);
  assert.equal(logs.result.entries[0].text, 'hello 42');
  assert.equal(store.ofKind('console').length, 1);

  await controller.execute({ name: 'networkBodies', tabId: 10 });
  api.debugger.onEvent.fire({ tabId: 10 }, 'Network.loadingFinished', { requestId: 'r1' });
  await new Promise((r) => setTimeout(r, 10));
  const responses = store.ofKind('response');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].text, '{"ok":true}');
});

test('tab-group mode grants exactly the grouped tabs', async () => {
  const { controller, tabs } = setup();
  const state = await controller.arm({ mode: MODES.GROUP, tabIds: [10] });
  assert.equal(typeof state.agentGroupId, 'number');
  assert.equal(tabs.find((t) => t.id === 10).groupId, state.agentGroupId);
  const allowed = await controller.execute({ name: 'readDom', tabId: 10 });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  const denied = await controller.execute({ name: 'readDom', tabId: 11 });
  assert.equal(denied.code, 'tab-not-allowed');
});

test('cdp click forwards a real mouse press/release pair at the element centre', async () => {
  const { controller, state } = setup();
  await controller.arm({ mode: MODES.SELECTED, tabIds: [10] });
  const result = await controller.execute({ name: 'click', tabId: 10, args: { selector: '#inc' } }, { forceCdp: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual({ x: result.result.x, y: result.result.y }, { x: 42, y: 24 });
  const types = state.sent.filter((s) => s.method === 'Input.dispatchMouseEvent').map((s) => s.params.type);
  assert.deepEqual(types, ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('the content path is used for responseText and the body lands in the store', async () => {
  const { controller, store } = setup();
  await controller.arm({ mode: MODES.SELECTED, tabIds: [10] });
  const result = await controller.execute({ name: 'responseText', tabId: 10, args: { url: 'http://127.0.0.1:8791/data.json' } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.text, '{"ok":true}');
  assert.equal(store.ofKind('response').length, 1);
});
