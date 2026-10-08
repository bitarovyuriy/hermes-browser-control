import test from 'node:test';
import assert from 'node:assert/strict';
import { MODES, MODE_LIST, isTabAllowed, isValidMode, describeMode } from '../../extension/src/access-policy.js';

test('mode list is the panel modes plus the self-service agent mode', () => {
  assert.deepEqual(MODE_LIST, ['active-tab', 'selected-tabs', 'tab-group', 'agent-all']);
  assert.ok(isValidMode(MODES.GROUP));
  assert.ok(isValidMode(MODES.AGENT));
  assert.ok(!isValidMode('everything'));
});

test('agent-all mode allows every tab (revocations are checked before the policy)', () => {
  assert.equal(isTabAllowed(MODES.AGENT, { tabId: 1, activeTabId: 2 }), true);
  assert.equal(isTabAllowed(MODES.AGENT, { tabId: 999 }), true);
  // fails closed without a usable tab id
  assert.equal(isTabAllowed(MODES.AGENT, {}), false);
  assert.equal(isTabAllowed(MODES.AGENT, { tabId: -1 }), false);
});

test('active-tab mode allows only the pinned active tab', () => {
  const ctx = { tabId: 7, activeTabId: 7, pinnedActiveTabId: 7 };
  assert.equal(isTabAllowed(MODES.ACTIVE, ctx), true);
  assert.equal(isTabAllowed(MODES.ACTIVE, { ...ctx, tabId: 8 }), false);
  // user switches tabs → the agent follows only the pinned one
  assert.equal(isTabAllowed(MODES.ACTIVE, { tabId: 7, activeTabId: 9, pinnedActiveTabId: 7 }), true);
  assert.equal(isTabAllowed(MODES.ACTIVE, { tabId: 9, activeTabId: 9, pinnedActiveTabId: 7 }), false);
});

test('active-tab mode falls back to the live active tab when nothing is pinned', () => {
  assert.equal(isTabAllowed(MODES.ACTIVE, { tabId: 3, activeTabId: 3 }), true);
  assert.equal(isTabAllowed(MODES.ACTIVE, { tabId: 4, activeTabId: 3 }), false);
});

test('selected-tabs mode is exactly the granted set', () => {
  const ctx = { selectedTabIds: new Set([11, 12]) };
  assert.equal(isTabAllowed(MODES.SELECTED, { ...ctx, tabId: 11 }), true);
  assert.equal(isTabAllowed(MODES.SELECTED, { ...ctx, tabId: 13 }), false);
});

test('tab-group mode requires a real group id match', () => {
  assert.equal(isTabAllowed(MODES.GROUP, { tabId: 5, agentGroupId: 42, tabGroupId: 42 }), true);
  assert.equal(isTabAllowed(MODES.GROUP, { tabId: 5, agentGroupId: 42, tabGroupId: 43 }), false);
  assert.equal(isTabAllowed(MODES.GROUP, { tabId: 5, agentGroupId: 42, tabGroupId: -1 }), false, 'ungrouped tab is never allowed');
  assert.equal(isTabAllowed(MODES.GROUP, { tabId: 5, tabGroupId: 42 }), false, 'no agent group → fail closed');
});

test('fails closed on junk input', () => {
  assert.equal(isTabAllowed(MODES.ACTIVE, {}), false);
  assert.equal(isTabAllowed(MODES.ACTIVE, { tabId: -1, activeTabId: -1 }), false);
  assert.equal(isTabAllowed('wildcard', { tabId: 1, activeTabId: 1 }), false);
  assert.equal(isTabAllowed(null, { tabId: 1, activeTabId: 1 }), false);
});

test('describeMode is human readable', () => {
  assert.match(describeMode(MODES.GROUP), /tab group/);
  assert.equal(describeMode('nope'), 'no access');
});
