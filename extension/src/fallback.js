/**
 * Banner-free path: drive a tab through its declared content script.
 *
 * No chrome.debugger attach → no "Chrome is being debugged" infobar. This path
 * covers everything a page can do itself (navigate, click, type, read DOM,
 * scroll, hover, indicators, in-page fetch).
 */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export class ContentBridgeError extends Error {
  constructor(message, code = 'content-error', detail = {}) {
    super(message);
    this.name = 'ContentBridgeError';
    this.code = code;
    this.detail = detail;
  }
}

export function createContentBridge({ api, timeoutMs = 10000 } = {}) {
  if (!api || !api.tabs) throw new Error('createContentBridge needs a chrome-like api');

  function rawSend(tabId, message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new ContentBridgeError(`content op ${message.op} timed out after ${timeoutMs}ms`, 'content-timeout'));
      }, timeoutMs);
      try {
        api.tabs.sendMessage(tabId, message, (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const lastError = api.runtime && api.runtime.lastError;
          if (lastError) {
            reject(new ContentBridgeError(lastError.message, 'no-content-script', { tabId }));
            return;
          }
          resolve(response);
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new ContentBridgeError(String(err && err.message ? err.message : err), 'no-content-script', { tabId }));
        }
      }
    });
  }

  async function send(tabId, op, args = {}) {
    const response = await rawSend(tabId, { type: 'hermes/content', op, args });
    if (!response || typeof response !== 'object') {
      throw new ContentBridgeError(`content op ${op} returned no payload`, 'content-empty', { tabId, op });
    }
    if (response.ok === false) {
      throw new ContentBridgeError(response.error || `content op ${op} failed`, response.code || 'content-failed', { tabId, op });
    }
    return response;
  }

  async function ping(tabId) {
    try {
      const response = await rawSend(tabId, { type: 'hermes/content', op: 'ping' });
      return Boolean(response && response.ok);
    } catch {
      return false;
    }
  }

  /**
   * The content script may not have been injected yet (fresh navigation, page
   * still loading). Retry briefly before giving up — we cannot inject by hand
   * because this slice deliberately does not request the `scripting` permission.
   */
  async function ensure(tabId, { attempts = 6, waitMs = 150 } = {}) {
    for (let i = 0; i < attempts; i += 1) {
      if (await ping(tabId)) return true;
      await delay(waitMs);
    }
    return false;
  }

  function broadcastHudHide(tabIds) {
    return Promise.allSettled([...tabIds].map((tabId) => rawSend(tabId, { type: 'hermes/content', op: 'hud', args: { action: 'hide' } })));
  }

  return { send, ping, ensure, rawSend, broadcastHudHide };
}
