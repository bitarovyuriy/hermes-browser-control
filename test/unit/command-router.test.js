import test from 'node:test';
import assert from 'node:assert/strict';
import { planCommand, COMMAND_NAMES, PATHS, bannerFreeCommands } from '../../extension/src/command-router.js';

test('page-level verbs default to the banner-free content path', () => {
  for (const name of ['navigate', 'click', 'type', 'readDom', 'getText', 'hover', 'scroll', 'waitFor']) {
    const plan = planCommand({ name, tabId: 3, args: {} });
    assert.equal(plan.ok, true, name);
    assert.equal(plan.path, PATHS.CONTENT, name);
    assert.ok(plan.op, name);
  }
});

test('CDP-only verbs always take the debugger path', () => {
  for (const name of ['screenshot', 'evaluate', 'consoleLogs', 'networkBodies', 'domSnapshot']) {
    const plan = planCommand({ name, tabId: 3, args: {} });
    assert.equal(plan.ok, true, name);
    assert.equal(plan.path, PATHS.CDP, name);
    assert.match(plan.method, /\./, name);
  }
});

test('forceCdp moves a content-capable verb onto CDP', () => {
  const content = planCommand({ name: 'click', tabId: 3, args: { selector: '#a' } });
  assert.equal(content.path, PATHS.CONTENT);
  const cdp = planCommand({ name: 'click', tabId: 3, args: { selector: '#a' } }, { forceCdp: true });
  assert.equal(cdp.path, PATHS.CDP);
  assert.equal(cdp.method, 'Input.dispatchMouseEvent');
});

test('verbs with no CDP implementation cannot be forced onto CDP', () => {
  const plan = planCommand({ name: 'badge', tabId: 3, args: { selector: 'a' } }, { forceCdp: true });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'no-cdp-path');
});

test('unknown command and missing target are rejected', () => {
  assert.equal(planCommand({ name: 'rm-rf', tabId: 1 }).code, 'unknown-command');
  assert.equal(planCommand({ name: 'click', args: {} }).code, 'no-target');
  assert.equal(planCommand({ name: 'click', tabId: -3 }).code, 'no-target');
});

test('screenshot and domSnapshot declare their artifact kinds', () => {
  assert.equal(planCommand({ name: 'screenshot', tabId: 1 }).artifact, 'screenshot');
  assert.equal(planCommand({ name: 'domSnapshot', tabId: 1 }).artifact, 'dom');
});

test('the banner-free set covers the MVP verbs', () => {
  const free = bannerFreeCommands();
  for (const verb of ['navigate', 'click', 'type', 'readDom']) assert.ok(free.includes(verb), verb);
  assert.ok(!free.includes('screenshot'));
  assert.equal(COMMAND_NAMES.length, Object.keys({ ...Object.fromEntries(COMMAND_NAMES.map((n) => [n, 1])) }).length);
});
