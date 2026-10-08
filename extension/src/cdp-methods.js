/**
 * CDP method allowlist.
 *
 * The agent never gets raw CDP: only the methods below can be forwarded through
 * chrome.debugger, and only with the declared parameters. Anything else is
 * rejected (fail-closed) — this keeps the blast radius small even if a prompt
 * or a compromised page tries to talk the controller into `Browser.grantPermissions`
 * or `Storage.getCookies`.
 */

/** @type {Record<string, {required: string[], defaults?: object, artifact?: string}>} */
export const CDP_ALLOWLIST = Object.freeze({
  // --- page lifecycle -------------------------------------------------------
  'Page.enable': { required: [] },
  'Page.navigate': { required: ['url'] },
  'Page.reload': { required: [], defaults: { ignoreCache: false } },
  'Page.getNavigationHistory': { required: [] },
  'Page.captureScreenshot': {
    required: [],
    defaults: { format: 'png', fromSurface: true, captureBeyondViewport: false },
    artifact: 'screenshot',
  },

  // --- input ---------------------------------------------------------------
  'Input.dispatchMouseEvent': { required: ['type', 'x', 'y'] },
  'Input.dispatchKeyEvent': { required: ['type'] },
  'Input.insertText': { required: ['text'] },

  // --- runtime -------------------------------------------------------------
  'Runtime.enable': { required: [] },
  'Runtime.evaluate': {
    required: ['expression'],
    defaults: { returnByValue: true, awaitPromise: true, userGesture: true },
  },

  // --- DOM -----------------------------------------------------------------
  'DOM.enable': { required: [] },
  'DOM.getDocument': { required: [], defaults: { depth: 1, pierce: false } },
  'DOM.getOuterHTML': { required: ['nodeId'] },
  'DOM.querySelector': { required: ['nodeId', 'selector'] },
  'DOM.getBoxModel': { required: ['nodeId'] },

  // --- network -------------------------------------------------------------
  'Network.enable': { required: [] },
  'Network.setCacheDisabled': { required: ['cacheDisabled'] },
  'Network.getResponseBody': { required: ['requestId'], artifact: 'response' },

  // --- misc ----------------------------------------------------------------
  'Log.enable': { required: [] },
  'Emulation.setFocusEmulationEnabled': { required: ['enabled'] },
});

export const CDP_METHOD_NAMES = Object.freeze(Object.keys(CDP_ALLOWLIST));

/** CDP events the controller subscribes to (never forwarded to the agent raw). */
export const OBSERVED_EVENTS = Object.freeze([
  'Page.loadEventFired',
  'Page.frameNavigated',
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown',
  'Network.loadingFinished',
  'Network.responseReceived',
  'Log.entryAdded',
]);

/**
 * Validate and normalize one CDP call.
 * @returns {{ok: true, method: string, params: object} | {ok: false, code: string, message: string}}
 */
export function validateCdpCall(method, params = {}) {
  if (typeof method !== 'string' || method.length === 0) {
    return { ok: false, code: 'bad-method', message: 'CDP method must be a non-empty string' };
  }
  const spec = CDP_ALLOWLIST[method];
  if (!spec) {
    return { ok: false, code: 'method-not-allowed', message: `CDP method not in allowlist: ${method}` };
  }
  if (params == null || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, code: 'bad-params', message: `params for ${method} must be an object` };
  }
  for (const key of spec.required) {
    if (params[key] === undefined || params[key] === null) {
      return { ok: false, code: 'missing-param', message: `${method} requires param "${key}"` };
    }
  }
  const normalized = { ...(spec.defaults || {}), ...params };
  return { ok: true, method, params: normalized };
}
