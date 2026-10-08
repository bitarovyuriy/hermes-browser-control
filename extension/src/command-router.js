/**
 * Agent command vocabulary → execution plan.
 *
 * Two paths exist for the same verbs:
 *   - `cdp`     : chrome.debugger.attach + CDP (shows the "being debugged" banner)
 *   - `content` : the declared content script over chrome.tabs.sendMessage (banner-free)
 *
 * Some verbs are CDP-only (screenshot, console logs, network bodies, raw evaluate);
 * everything else defaults to the banner-free content path and can be forced onto
 * CDP with `forceCdp`. Pure module — unit-testable.
 */

export const PATHS = Object.freeze({ CDP: 'cdp', CONTENT: 'content' });

/** Verb table. `cdpOnly` verbs have no content-script equivalent. */
export const COMMANDS = Object.freeze({
  // --- things a content script can do just as well --------------------------
  navigate: { args: ['url'], content: { op: 'navigate' }, cdp: { method: 'Page.navigate' } },
  click: { args: ['selector'], content: { op: 'click' }, cdp: { method: 'Input.dispatchMouseEvent' } },
  type: { args: ['selector', 'text'], content: { op: 'type' }, cdp: { method: 'Input.dispatchKeyEvent' } },
  hover: { args: ['selector'], content: { op: 'hover' }, cdp: { method: 'Input.dispatchMouseEvent' } },
  scroll: { args: [], content: { op: 'scroll' }, cdp: { method: 'Input.dispatchMouseEvent' } },
  readDom: { args: [], content: { op: 'readDom' }, cdp: { method: 'Runtime.evaluate' } },
  getText: { args: ['selector'], content: { op: 'getText' }, cdp: { method: 'Runtime.evaluate' } },
  waitFor: { args: ['selector'], content: { op: 'waitFor' }, cdp: { method: 'Runtime.evaluate' } },
  badge: { args: ['selector'], content: { op: 'badge' } },
  pointer: { args: [], content: { op: 'pointer' } },
  hud: { args: [], content: { op: 'hud' } },
  responseText: { args: [], content: { op: 'responseText' } }, // banner-free fetch-text path

  // --- CDP-only -------------------------------------------------------------
  screenshot: { args: [], cdpOnly: true, cdp: { method: 'Page.captureScreenshot' }, artifact: 'screenshot' },
  evaluate: { args: ['expression'], cdpOnly: true, cdp: { method: 'Runtime.evaluate' }, artifact: 'text' },
  consoleLogs: { args: [], cdpOnly: true, cdp: { method: 'Runtime.enable' }, artifact: 'console' },
  networkBodies: { args: [], cdpOnly: true, cdp: { method: 'Network.enable' }, artifact: 'response' },
  domSnapshot: { args: [], cdpOnly: true, cdp: { method: 'DOM.getDocument' }, artifact: 'dom' },
});

export const COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS));

/**
 * Turn `{name, tabId, args}` into an executable plan.
 *
 * @param {object} command
 * @param {string} command.name         one of COMMAND_NAMES
 * @param {number} command.tabId
 * @param {object} [command.args]
 * @param {object} [opts]
 * @param {boolean} [opts.forceCdp]     use CDP even when a content path exists
 * @returns {{ok: true, name: string, tabId: number, path: string, op?: string, method?: string, params: object, artifact?: string}
 *          | {ok: false, code: string, message: string}}
 */
export function planCommand(command = {}, opts = {}) {
  const { name, tabId, args = {} } = command;
  if (!COMMANDS[name]) {
    return { ok: false, code: 'unknown-command', message: `unknown command: ${name}` };
  }
  if (typeof tabId !== 'number' || tabId < 0) {
    return { ok: false, code: 'no-target', message: `command ${name} needs a numeric tabId` };
  }
  const spec = COMMANDS[name];
  const params = { ...args };

  const canUseContent = Boolean(spec.content);
  const wantsCdp = spec.cdpOnly === true || opts.forceCdp === true;

  if (wantsCdp && !spec.cdp) {
    return { ok: false, code: 'no-cdp-path', message: `${name} has no CDP path` };
  }

  if (wantsCdp) {
    return {
      ok: true,
      name,
      tabId,
      path: PATHS.CDP,
      method: spec.cdp.method,
      params,
      artifact: spec.artifact,
    };
  }

  if (!canUseContent) {
    return { ok: false, code: 'no-content-path', message: `${name} has no banner-free path` };
  }

  return {
    ok: true,
    name,
    tabId,
    path: PATHS.CONTENT,
    op: spec.content.op,
    params,
    artifact: spec.artifact,
  };
}

/** Which verbs can run without a debugger attach (acceptance criterion: banner-free path). */
export function bannerFreeCommands() {
  return COMMAND_NAMES.filter((n) => Boolean(COMMANDS[n].content));
}
