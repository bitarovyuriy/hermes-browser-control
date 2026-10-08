import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCdpCall, CDP_ALLOWLIST, CDP_METHOD_NAMES } from '../../extension/src/cdp-methods.js';

test('the CDP surface required by the task is allowlisted', () => {
  for (const method of [
    'Page.navigate',
    'Input.dispatchMouseEvent',
    'Input.dispatchKeyEvent',
    'Runtime.evaluate',
    'Page.captureScreenshot',
    'DOM.getDocument',
    'DOM.getOuterHTML',
    'Network.getResponseBody',
  ]) {
    assert.ok(CDP_METHOD_NAMES.includes(method), method);
  }
});

test('anything outside the allowlist is refused', () => {
  for (const method of ['Browser.grantPermissions', 'Storage.getCookies', 'Network.setCookie', 'Target.createTarget', 'Page.navigateToHistoryEntry']) {
    const result = validateCdpCall(method, {});
    assert.equal(result.ok, false, method);
    assert.equal(result.code, 'method-not-allowed');
  }
});

test('missing required params are refused', () => {
  assert.equal(validateCdpCall('Page.navigate', {}).code, 'missing-param');
  assert.equal(validateCdpCall('Runtime.evaluate', {}).code, 'missing-param');
  assert.equal(validateCdpCall('Input.dispatchMouseEvent', { type: 'mouseMoved' }).code, 'missing-param');
  assert.equal(validateCdpCall('Network.getResponseBody', {}).code, 'missing-param');
});

test('defaults are applied and caller params win', () => {
  const withDefaults = validateCdpCall('Page.captureScreenshot', {});
  assert.equal(withDefaults.params.format, 'png');
  const overridden = validateCdpCall('Page.captureScreenshot', { format: 'jpeg' });
  assert.equal(overridden.params.format, 'jpeg');
  const evaluate = validateCdpCall('Runtime.evaluate', { expression: '1+1' });
  assert.equal(evaluate.params.returnByValue, true);
  assert.equal(evaluate.params.awaitPromise, true);
});

test('bad method / bad params shapes are refused', () => {
  assert.equal(validateCdpCall('', {}).code, 'bad-method');
  assert.equal(validateCdpCall('Page.enable', null).code, 'bad-params');
  assert.equal(validateCdpCall('Page.enable', []).code, 'bad-params');
});

test('every allowlisted entry declares its required params', () => {
  for (const [method, spec] of Object.entries(CDP_ALLOWLIST)) {
    assert.ok(Array.isArray(spec.required), method);
  }
});
