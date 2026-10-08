import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionState, GATE_CODES } from '../../extension/src/session-state.js';
import { MODES } from '../../extension/src/access-policy.js';

const ctxFor = (tabId) => ({ tabId, activeTabId: tabId, tabGroupId: null });

test('an unarmed session rejects everything', () => {
  const state = createSessionState();
  const gate = state.gate({ tabId: 1, ctx: ctxFor(1) });
  assert.equal(gate.ok, false);
  assert.equal(gate.code, GATE_CODES.NOT_ARMED);
});

test('arming grants exactly the selected tabs', () => {
  const state = createSessionState();
  state.arm({ mode: MODES.SELECTED, tabIds: [10] });
  assert.equal(state.gate({ tabId: 10, ctx: ctxFor(10) }).ok, true);
  const denied = state.gate({ tabId: 11, ctx: ctxFor(11) });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, GATE_CODES.TAB_NOT_ALLOWED);
});

test('pause stops commands, resume restores them', () => {
  const state = createSessionState();
  state.arm({ mode: MODES.SELECTED, tabIds: [10] });
  state.pause();
  assert.equal(state.gate({ tabId: 10, ctx: ctxFor(10) }).code, GATE_CODES.PAUSED);
  state.resume();
  assert.equal(state.gate({ tabId: 10, ctx: ctxFor(10) }).ok, true);
});

test('kill is terminal and outranks every other state', () => {
  const state = createSessionState();
  state.arm({ mode: MODES.SELECTED, tabIds: [10] });
  state.kill();
  assert.equal(state.gate({ tabId: 10, ctx: ctxFor(10) }).code, GATE_CODES.KILLED);
  assert.equal(state.snapshot().armed, false);
  assert.equal(state.snapshot().selectedTabIds.length, 0);
  assert.equal(state.isLive(), false);
  // pausing/resuming cannot resurrect a killed session
  state.resume();
  assert.equal(state.gate({ tabId: 10, ctx: ctxFor(10) }).code, GATE_CODES.KILLED);
  assert.throws(() => state.arm({ mode: MODES.SELECTED, tabIds: [10] }), /killed/);
});

test('clearKill is the only way back, and it requires a fresh arm', () => {
  const state = createSessionState();
  state.arm({ mode: MODES.SELECTED, tabIds: [10] });
  state.kill();
  state.clearKill();
  assert.equal(state.gate({ tabId: 10, ctx: ctxFor(10) }).code, GATE_CODES.NOT_ARMED);
  state.arm({ mode: MODES.SELECTED, tabIds: [10] });
  assert.equal(state.gate({ tabId: 10, ctx: ctxFor(10) }).ok, true);
});

test('live revocation drops the tab immediately and bumps the revision', () => {
  const state = createSessionState();
  state.arm({ mode: MODES.SELECTED, tabIds: [10, 11] });
  const before = state.revision;
  const { revoked, snapshot } = state.revoke(10);
  assert.equal(revoked, true);
  assert.ok(snapshot.revision > before);
  assert.deepEqual(snapshot.selectedTabIds, [11]);
  assert.equal(state.gate({ tabId: 10, ctx: ctxFor(10) }).code, GATE_CODES.TAB_NOT_ALLOWED);
  assert.equal(state.gate({ tabId: 11, ctx: ctxFor(11) }).ok, true);
});

test('revoking the pinned active tab narrows active-tab mode', () => {
  const state = createSessionState();
  state.arm({ mode: MODES.ACTIVE, tabIds: [10], pinnedActiveTabId: 10 });
  state.revoke(10);
  assert.equal(state.gate({ tabId: 10, ctx: ctxFor(10) }).code, GATE_CODES.TAB_NOT_ALLOWED);
});

test('tab-group mode needs the group id to match', () => {
  const state = createSessionState();
  state.arm({ mode: MODES.GROUP, tabIds: [10], agentGroupId: 99 });
  assert.equal(state.gate({ tabId: 10, ctx: { tabId: 10, tabGroupId: 99 } }).ok, true);
  assert.equal(state.gate({ tabId: 10, ctx: { tabId: 10, tabGroupId: 100 } }).code, GATE_CODES.TAB_NOT_ALLOWED);
  assert.equal(state.gate({ tabId: 10, ctx: { tabId: 10, tabGroupId: -1 } }).code, GATE_CODES.TAB_NOT_ALLOWED);
});

test('arm rejects an unknown mode', () => {
  const state = createSessionState();
  assert.throws(() => state.arm({ mode: 'all-tabs' }), /bad mode/);
});
