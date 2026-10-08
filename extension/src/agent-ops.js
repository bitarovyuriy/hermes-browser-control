/**
 * Agent operations — the self-service surface the Hermes runtime drives over the
 * loopback relay.
 *
 * Design goals (why this module exists):
 *   * no panel clicks: the session auto-arms in `agent-all` mode, so every tab
 *     passes the tab gate without an "Arm active tab" step;
 *   * text-first: read/query/click/type work off the DOM, so the agent never has
 *     to screenshot-hunt for buttons;
 *   * full navigation control: list / open / close / activate / reload tabs;
 *   * downloads: `page.fetch` pulls bytes through the page (cookies included) so
 *     images and files can be saved by the client;
 *   * fail-closed guards kept: the sensitive-domain deny-list runs on every URL,
 *     the freshness lease still binds relay commands to the live connection, and
 *     the kill switch still stops everything.
 *
 * Every verb is a plain object -> object call. Errors carry a stable `code`.
 */

const DEFAULT_MAX_CHARS = 20000;
const DEFAULT_LIMIT = 50;
const MAX_FETCH_BYTES = 12 * 1024 * 1024;

export class AgentOpError extends Error {
  constructor(message, code = 'agent-op-failed') {
    super(message);
    this.name = 'AgentOpError';
    this.code = code;
  }
}

const q = (s) => JSON.stringify(String(s ?? ''));

/** Verbs that the agent bridge owns (everything else falls through to the controller). */
export const AGENT_VERBS = Object.freeze([
  'agent.status', 'agent.arm', 'agent.disarm', 'agent.autoarm', 'agent.reload', 'agent.window', 'agent.windows',
  'tabs.list', 'tabs.open', 'tabs.close', 'tabs.activate', 'tabs.reload', 'tabs.group',
  'page.read', 'page.query', 'page.click', 'page.type', 'page.press', 'page.scroll',
  'page.eval', 'page.wait', 'page.screenshot', 'page.fetch', 'page.network', 'page.forms', 'page.links',
]);

export function isAgentVerb(method) {
  return typeof method === 'string' && AGENT_VERBS.includes(method);
}

export function createAgentOps({ api, controller, admission, log = () => {} } = {}) {
  if (!api) throw new AgentOpError('createAgentOps needs a chrome-like api');
  if (!controller) throw new AgentOpError('createAgentOps needs the controller');

  const AUTO_ARM_KEY = 'hermes.agent.settings';
  const AGENT_WINDOW_KEY = 'hermes.agent.windowId';
  let lastUsedTabId = null;
  /** In-memory only: the auto-arm preference, hydrated from storage. */
  let settings = { autoArm: true };
  let hydrated = false;
  /** The agent's own window — kept apart from the user's window on purpose. */
  let agentWindowId = null;
  /** Default geometry applied when the agent window is shown on request. */
  const AGENT_WINDOW_BOUNDS = { width: 1440, height: 900, left: 80, top: 60 };

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = () => controller.state || controller.snapshot();

  function isKilled() {
    const s = controller.snapshot ? controller.snapshot() : {};
    return Boolean(s.killed);
  }
  function isPaused() {
    const s = controller.snapshot ? controller.snapshot() : {};
    return Boolean(s.paused);
  }

  // ------------------------------------------------------------------ settings
  async function hydrate() {
    if (hydrated) return settings;
    hydrated = true;
    try {
      const stored = await api.storage.local.get(AUTO_ARM_KEY);
      const value = stored && stored[AUTO_ARM_KEY];
      if (value && typeof value === 'object' && typeof value.autoArm === 'boolean') {
        settings = { ...settings, ...value };
      }
    } catch (err) {
      log('agent settings hydrate failed', err && err.message);
    }
    return settings;
  }

  async function setSettings(patch = {}) {
    await hydrate();
    settings = { ...settings, ...patch };
    try {
      await api.storage.local.set({ [AUTO_ARM_KEY]: settings });
    } catch (err) {
      log('agent settings persist failed', err && err.message);
    }
    if (settings.autoArm) await ensureArmed();
    return { ...settings };
  }

  // ----------------------------------------------------------------- auto-arm
  /**
   * Arm the session in `agent-all` mode unless the user paused/killed it.
   * Called whenever the relay reports `connected` and on `agent.arm`.
   */
  async function ensureArmed() {
    await hydrate();
    const s = controller.snapshot ? controller.snapshot() : {};
    if (s.killed) return { armed: false, reason: 'killed' };
    if (s.paused) return { armed: false, reason: 'paused' };
    if (s.armed && s.mode === 'agent-all') return { armed: true, mode: s.mode, revision: s.revision };
    await controller.arm({ mode: 'agent-all', preserveRevoked: true });
    if (admission && typeof admission.refreshLease === 'function') admission.refreshLease();
    return { armed: true, mode: 'agent-all' };
  }

  // ------------------------------------------------------- the agent's window
  // The agent works in its own Chrome window so its tabs never mix with (or
  // steal focus from) the user's window. The id is cached in storage because
  // the service worker restarts all the time.

  async function storageGet(key) {
    try {
      const bag = await api.storage.local.get(key);
      return bag ? bag[key] : undefined;
    } catch (err) {
      log('storage read failed', err && err.message);
      return undefined;
    }
  }

  async function storageSet(key, value) {
    try {
      await api.storage.local.set({ [key]: value });
    } catch (err) {
      log('storage write failed', err && err.message);
    }
  }

  async function loadAgentWindowId() {
    if (agentWindowId != null) return agentWindowId;
    const stored = await storageGet(AGENT_WINDOW_KEY);
    if (typeof stored === 'number') agentWindowId = stored;
    return agentWindowId;
  }

  /**
   * Create-or-reuse the agent window. Created MINIMIZED: a normal-state window
   * can get itself raised (Chrome bubbles, restore on un-minimise) and pop over
   * whatever the user is doing, which is exactly what must never happen. A minimised
   * window still loads pages, runs the DOM path for clicks/typing and screenshots fine.
   */
  async function ensureAgentWindow(options = {}) {
    const candidates = [];
    const known = await loadAgentWindowId();
    if (known != null) candidates.push(known);
    for (const id of candidates) {
      const win = await api.windows.get(id).catch(() => null);
      if (win && typeof win.id === 'number') {
        agentWindowId = win.id;
        if (options.focus === true) await api.windows.update(win.id, { focused: true }).catch(() => {});
        return { id: win.id, created: false, state: win.state };
      }
    }
    const win = await api.windows.create({ url: 'about:blank', focused: false, state: 'minimized' });
    if (!win || typeof win.id !== 'number') throw new AgentOpError('could not create the agent window', 'window-create-failed');
    agentWindowId = win.id;
    await storageSet(AGENT_WINDOW_KEY, win.id);
    // windows.create ignores state:'minimized' on a fresh window — minimise it right away
    // so it can never sit on top of the user's work.
    const minimized = await api.windows.update(win.id, { state: 'minimized' }).catch(() => null);
    const anchorTabId = win.tabs && win.tabs[0] && typeof win.tabs[0].id === 'number' ? win.tabs[0].id : null;
    return { id: win.id, created: true, anchorTabId, state: (minimized && minimized.state) || win.state || 'normal' };
  }

  async function agentWindowTabs(tabs) {
    const id = await loadAgentWindowId();
    if (id == null) return [];
    const all = tabs || (await allTabs());
    return all.filter((t) => t.windowId === id);
  }

  /** First tab of the agent window, for commands that omit a tab reference. */
  async function pickAgentTab(tabs, requireControllable) {
    const mine = await agentWindowTabs(tabs);
    if (!mine.length) return null;
    const pick = mine.find((t) => t.active) || mine[0];
    if (requireControllable && !isControllable(pick)) return null;
    lastUsedTabId = pick.id;
    return pick.id;
  }

  async function blankAnchorTabId(windowId) {
    const tabs = await allTabs();
    const blank = tabs.find((t) => t.windowId === windowId && (t.url === 'about:blank' || t.url === 'chrome://newtab/' || t.url === ''));
    return blank ? blank.id : null;
  }

  // ---------------------------------------------------------------- tab access
  async function allTabs() {
    await loadAgentWindowId();
    const tabs = await api.tabs.query({});
    return (tabs || [])
      .filter((t) => typeof t.id === 'number')
      .map((t) => ({
        id: t.id,
        url: t.url || '',
        title: t.title || '',
        active: Boolean(t.active),
        status: t.status || '',
        windowId: t.windowId,
        agentWindow: agentWindowId != null && t.windowId === agentWindowId,
        groupId: typeof t.groupId === 'number' ? t.groupId : -1,
        pinned: Boolean(t.pinned),
        audible: Boolean(t.audible),
        discarded: Boolean(t.discarded),
      }));
  }

  function isControllable(tab) {
    const url = String(tab.url || '');
    return !url.startsWith('chrome://') && !url.startsWith('chrome-extension://') && !url.startsWith('devtools://') && !url.startsWith('edge://');
  }

  /**
   * Resolve a tab reference into a tab id.
   * @param {number|string|null} ref  number | 'active' | 'last' | url/title substring
   */
  async function resolveTab(ref, { requireControllable = true } = {}) {
    if (typeof ref === 'number' && Number.isFinite(ref)) {
      const tab = await api.tabs.get(ref).catch(() => null);
      if (!tab) throw new AgentOpError(`no such tab: ${ref}`, 'tab-not-found');
      if (requireControllable && !isControllable(tab)) {
        throw new AgentOpError(`tab ${ref} is a browser-internal page (${tab.url})`, 'tab-restricted');
      }
      lastUsedTabId = ref;
      return ref;
    }
    const tabs = await allTabs();
    if (typeof ref === 'string' && ref.trim()) {
      const needle = ref.trim();
      if (needle === 'active') {
        const active = tabs.find((t) => t.active);
        if (!active) throw new AgentOpError('no active tab', 'tab-not-found');
        return await resolveTab(active.id, { requireControllable });
      }
      if (needle === 'last') {
        if (lastUsedTabId != null && tabs.some((t) => t.id === lastUsedTabId)) {
          return await resolveTab(lastUsedTabId, { requireControllable });
        }
        const mine = await pickAgentTab(tabs, requireControllable);
        if (mine != null) return mine;
        const active = tabs.find((t) => t.active) || tabs[0];
        if (!active) throw new AgentOpError('no tabs open', 'tab-not-found');
        return await resolveTab(active.id, { requireControllable });
      }
      const lower = needle.toLowerCase();
      const matches = tabs.filter((t) => t.url.toLowerCase().includes(lower) || t.title.toLowerCase().includes(lower));
      if (!matches.length) throw new AgentOpError(`no tab matching "${needle}"`, 'tab-not-found');
      const inAgentWindow = matches.find((t) => t.agentWindow);
      const pick = inAgentWindow || matches.find((t) => t.active) || matches[0];
      return await resolveTab(pick.id, { requireControllable });
    }
    // No reference at all: prefer the agent's own window over the user's tab.
    const mine = await pickAgentTab(tabs, requireControllable);
    if (mine != null) return mine;
    const active = tabs.find((t) => t.active) || tabs[0];
    if (!active) throw new AgentOpError('no tabs open', 'tab-not-found');
    return await resolveTab(active.id, { requireControllable });
  }

  async function tabMeta(tabId) {
    const tab = await api.tabs.get(tabId).catch(() => null);
    return tab ? { id: tab.id, url: tab.url || '', title: tab.title || '', active: Boolean(tab.active), status: tab.status || '' } : { id: tabId };
  }

  /** Deny-list + lease check for a URL, fail-closed. Relay source. */
  function admit(url, command) {
    if (!admission || typeof admission.check !== 'function') return;
    const verdict = admission.check({ url: url || '', source: 'relay', command });
    if (!verdict.ok) throw new AgentOpError(verdict.message || 'operation denied', verdict.code || 'denied');
  }

  async function admitTab(tabId, command) {
    const meta = await tabMeta(tabId);
    if (meta.url) admit(meta.url, command);
    return meta;
  }

  // ------------------------------------------------------------------- helpers
  async function evalOn(tabId, expression) {
    return await controller.evaluateValue(tabId, expression);
  }

  async function ensureInputFocus(tabId) {
    try {
      await controller.sendCdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (err) {
      log('focus emulation failed', err && err.message);
    }
  }

  /**
   * Is the tab's window the focused window? Chrome drops synthesised mouse and
   * key events for unfocused windows (the agent's window is unfocused by design),
   * so clicks/typing there fall back to DOM events instead.
   */
  async function tabWindowFocused(tabId) {
    if (!api.windows || !api.windows.getLastFocused) return true;
    const tab = await api.tabs.get(tabId).catch(() => null);
    if (!tab || typeof tab.windowId !== 'number') return true;
    const last = await api.windows.getLastFocused({}).catch(() => null);
    return Boolean(last && last.id === tab.windowId);
  }

  async function mouseClickAt(tabId, x, y) {
    await ensureInputFocus(tabId);
    await controller.sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await controller.sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await controller.sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  // ------------------------------------------------------------------- verbs
  const verbs = {
    // ---------------------------------------------------------------- agent.*
    'agent.status': async () => {
      await hydrate();
      const s = controller.snapshot ? controller.snapshot() : {};
      return {
        armed: Boolean(s.armed),
        paused: Boolean(s.paused),
        killed: Boolean(s.killed),
        mode: s.mode || null,
        revision: s.revision,
        autoArm: settings.autoArm,
        attached: s.attached || [],
        lastUsedTabId,
        agentWindowId: await loadAgentWindowId(),
      };
    },

    /** Debug/inspection: every Chrome window with its tabs. */
    'agent.windows': async () => {
      const wins = await api.windows.getAll({ populate: true }).catch((err) => {
        log('windows.getAll failed', err && err.message);
        return [];
      });
      return {
        agentWindowId: await loadAgentWindowId(),
        windows: (wins || []).map((w) => ({
          id: w.id,
          focused: Boolean(w.focused),
          state: w.state,
          type: w.type,
          incognito: Boolean(w.incognito),
          tabs: (w.tabs || []).map((t) => ({ id: t.id, url: t.url || '', active: Boolean(t.active) })),
        })),
      };
    },

    /** Manage the agent's own window: ensure | show | hide | reset | close. */
    'agent.window': async (params = {}) => {
      const action = String(params.action || 'ensure');
      if (action === 'ensure' || action === 'show') {
        const win = await ensureAgentWindow({});
        let state = win.state;
        if (action === 'show') {
          // Bring it up with the standard geometry — the user asked to look at it.
          const bounds = {
            width: Number(params.width) || AGENT_WINDOW_BOUNDS.width,
            height: Number(params.height) || AGENT_WINDOW_BOUNDS.height,
            left: Number.isFinite(Number(params.left)) ? Number(params.left) : AGENT_WINDOW_BOUNDS.left,
            top: Number.isFinite(Number(params.top)) ? Number(params.top) : AGENT_WINDOW_BOUNDS.top,
          };
          await api.windows.update(win.id, { state: 'normal', focused: true, ...bounds }).catch((err) => log('window show failed', err && err.message));
          state = 'normal';
        }
        const tabs = await agentWindowTabs();
        return { windowId: win.id, created: Boolean(win.created), state, shown: action === 'show', tabCount: tabs.length, tabIds: tabs.map((t) => t.id) };
      }
      if (action === 'hide') {
        const id = await loadAgentWindowId();
        if (id == null) return { windowId: null, state: null };
        const win = await api.windows.get(id).catch(() => null);
        if (!win) return { windowId: null, state: null };
        await api.windows.update(id, { state: 'minimized' }).catch((err) => log('window hide failed', err && err.message));
        return { windowId: id, state: 'minimized' };
      }
      if (action === 'close') {
        const id = await loadAgentWindowId();
        if (id == null) return { windowId: null, closed: false };
        try {
          await api.windows.remove(id);
        } catch (err) {
          log('agent window remove failed', err && err.message);
        }
        agentWindowId = null;
        await storageSet(AGENT_WINDOW_KEY, null);
        return { windowId: id, closed: true };
      }
      if (action === 'reset') {
        const id = await loadAgentWindowId();
        if (id == null) return { windowId: null, closedTabs: 0, anchorTabId: null };
        const win = await api.windows.get(id).catch(() => null);
        if (!win) {
          agentWindowId = null;
          await storageSet(AGENT_WINDOW_KEY, null);
          return { windowId: null, closedTabs: 0, anchorTabId: null };
        }
        const tabs = await agentWindowTabs();
        const keep = tabs.find((t) => t.url === 'about:blank' || t.url === 'chrome://newtab/' || t.url === '') || null;
        // Create the fresh anchor first: removing the last tab would close the window.
        const anchor = keep ? keep.id : (await api.tabs.create({ url: 'about:blank', active: true, windowId: id })).id;
        const doomed = tabs.filter((t) => t.id !== anchor).map((t) => t.id);
        if (doomed.length) await api.tabs.remove(doomed).catch(() => {});
        if (lastUsedTabId != null && doomed.includes(lastUsedTabId)) lastUsedTabId = anchor;
        return { windowId: id, closedTabs: doomed.length, anchorTabId: anchor };
      }
      throw new AgentOpError(`unknown window action: ${action}`, 'bad-params');
    },

    'agent.arm': async () => ensureArmed(),

    'agent.disarm': async () => {
      const result = await controller.disarm();
      return { state: result.state, detachedTabs: result.detachedTabs };
    },

    'agent.autoarm': async (params = {}) => {
      const enabled = params.enabled !== false;
      const next = await setSettings({ autoArm: enabled });
      return { autoArm: next.autoArm };
    },

    /**
     * Reload the extension after a code change: chrome.runtime.reload() picks up
     * the new files from disk and the relay reconnects by itself. The reply is
     * sent first so the caller sees it before the worker goes away.
     */
    'agent.reload': async (params = {}) => {
      const delayMs = Number(params.delayMs || 400);
      setTimeout(() => {
        try {
          api.runtime.reload();
        } catch (err) {
          log('runtime.reload failed', err && err.message);
        }
      }, delayMs);
      return { reloading: true, delayMs };
    },

    // ----------------------------------------------------------------- tabs.*
    'tabs.list': async () => ({ tabs: await allTabs(), agentWindowId: await loadAgentWindowId() }),

    'tabs.open': async (params = {}) => {
      let url = String(params.url || '').trim();
      if (!url) throw new AgentOpError('tabs.open needs a url', 'bad-params');
      if (!/^[a-z]+:\/\//i.test(url) && !url.startsWith('about:')) url = `https://${url}`;
      admit(url, 'tabs.open');

      // Default home is the agent's own window: the user's tab strip stays untouched.
      let windowId = Number.isFinite(Number(params.windowId)) ? Number(params.windowId) : null;
      let reuseTabId = null;
      if (windowId == null && params.window === 'current') {
        const active = (await allTabs()).find((t) => t.active);
        windowId = active ? active.windowId : null;
      } else if (windowId == null) {
        const win = await ensureAgentWindow({ width: params.width, height: params.height, focus: false });
        windowId = win.id;
        reuseTabId = win.created && win.anchorTabId != null ? win.anchorTabId : await blankAnchorTabId(win.id);
      }

      // A new *active* tab pulls its window to the front — never do that to the user.
      // Default: active only when the agent window is already the focused window.
      const agentWindowIsFocused = async () => {
        const id = await loadAgentWindowId();
        if (id == null || !api.windows || !api.windows.getLastFocused) return false;
        const win = await api.windows.get(id).catch(() => null);
        if (!win || win.state === 'minimized') return false;
        const last = await api.windows.getLastFocused({}).catch(() => null);
        return Boolean(last && last.id === id);
      };
      let active;
      if (params.active === false) active = false;
      else if (params.active === true) active = true;
      else active = windowId != null && windowId === (await loadAgentWindowId()) ? await agentWindowIsFocused() : true;

      const tab = reuseTabId != null
        ? await api.tabs.update(reuseTabId, { url, active })
        : await api.tabs.create({ url, active, windowId: windowId == null ? undefined : windowId });

      // Tabs in the agent window get their own blue group so they are recognisable.
      if (params.group !== false && (params.group || (windowId != null && windowId === (await loadAgentWindowId())))) {
        try {
          const groupId = await api.tabs.group({ tabIds: [tab.id] });
          if (api.tabGroups && api.tabGroups.update) {
            await api.tabGroups.update(groupId, { title: params.groupTitle || 'Hermes agent', color: 'blue' });
          }
        } catch (err) {
          log('tabs.open group failed', err && err.message);
        }
      }
      lastUsedTabId = tab.id;
      return { tabId: tab.id, url: tab.url || url, title: tab.title || '', windowId: tab.windowId };
    },

    'tabs.close': async (params = {}) => {
      if (Array.isArray(params.tabIds) && params.tabIds.length) {
        await api.tabs.remove(params.tabIds);
        return { closed: params.tabIds.length, tabIds: params.tabIds };
      }
      if (params.url) {
        const needle = String(params.url).toLowerCase();
        const scope = params.scope === 'agent' ? await agentWindowTabs() : await allTabs();
        const matches = scope.filter((t) => t.url.toLowerCase().includes(needle));
        if (!matches.length) throw new AgentOpError(`no tab matching "${params.url}"`, 'tab-not-found');
        await api.tabs.remove(matches.map((t) => t.id));
        return { closed: matches.length, tabIds: matches.map((t) => t.id) };
      }
      if (params.all === true || params.scope === 'agent') {
        if (params.scope === 'agent') {
          // Keep the agent window itself alive: a fresh blank anchor goes in first,
          // otherwise removing the last tab would close the window.
          const winId = await loadAgentWindowId();
          const mine = await agentWindowTabs();
          if (winId != null && mine.length) {
            const keep = mine.find((t) => t.id === params.keepTabId)
              || mine.find((t) => t.url === 'about:blank' || t.url === 'chrome://newtab/' || t.url === '');
            if (!keep) {
              const anchor = await api.tabs.create({ url: 'about:blank', active: true, windowId: winId });
              params = { ...params, keepTabId: anchor.id };
            }
          }
        }
        const scope = params.all === true ? await allTabs() : await agentWindowTabs();
        const tabs = scope.filter((t) => t.id !== params.keepTabId);
        if (!tabs.length) return { closed: 0, tabIds: [] };
        await api.tabs.remove(tabs.map((t) => t.id));
        if (lastUsedTabId != null && tabs.some((t) => t.id === lastUsedTabId)) lastUsedTabId = params.keepTabId ?? null;
        return { closed: tabs.length, tabIds: tabs.map((t) => t.id) };
      }
      const tabId = await resolveTab(params.tabId ?? params.tab, { requireControllable: false });
      await api.tabs.remove(tabId);
      if (lastUsedTabId === tabId) lastUsedTabId = null;
      return { closed: 1, tabIds: [tabId] };
    },

    'tabs.activate': async (params = {}) => {
      const tabId = await resolveTab(params.tabId ?? params.tab);
      const tab = await api.tabs.update(tabId, { active: true });
      // Focus is opt-in: activating an agent tab must not yank the user's window away.
      if (params.focus === true) {
        try {
          if (api.windows && api.windows.update && tab && typeof tab.windowId === 'number') {
            await api.windows.update(tab.windowId, { focused: true });
          }
        } catch (err) {
          log('window focus failed', err && err.message);
        }
      }
      return { tabId, url: (tab && tab.url) || '' , title: (tab && tab.title) || '' };
    },

    'tabs.reload': async (params = {}) => {
      const tabId = await resolveTab(params.tabId ?? params.tab);
      await admitTab(tabId, 'tabs.reload');
      await api.tabs.reload(tabId, { bypassCache: params.bypassCache === true });
      await waitForLoad(tabId, Number(params.timeoutMs || 20000));
      return { tabId, reloaded: true };
    },

    'tabs.group': async (params = {}) => {
      const tabId = await resolveTab(params.tabId ?? params.tab);
      const groupId = await api.tabs.group({ tabIds: [tabId] });
      if (api.tabGroups && api.tabGroups.update) {
        await api.tabGroups.update(groupId, { title: params.title || 'Hermes agent', color: params.color || 'blue' });
      }
      return { tabId, groupId };
    },

    // ----------------------------------------------------------------- page.*
    'page.read': async (params = {}) => {
      const tabId = await resolveTab(params.tabId ?? params.tab);
      const meta = await admitTab(tabId, 'page.read');
      const mode = String(params.mode || 'text');
      const maxChars = Number(params.maxChars || DEFAULT_MAX_CHARS);
      const selector = params.selector ? q(params.selector) : 'null';

      if (mode === 'links') return await verbs['page.links']({ ...params, tabId });
      if (mode === 'forms') return await verbs['page.forms']({ ...params, tabId });

      const expression = `(() => {
        const root = ${selector} ? document.querySelector(${selector}) : document.body;
        if (!root) return { ok: false, reason: 'selector not found' };
        const url = location.href; const title = document.title;
        if (${q(mode)} === 'html') return { ok: true, url, title, text: root.outerHTML };
        if (${q(mode)} === 'outline') {
          const parts = [];
          for (const el of root.querySelectorAll('h1,h2,h3,h4,li,a,button,input,textarea,select')) {
            const tag = el.tagName.toLowerCase();
            const label = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
            if (!label) continue;
            const extra = tag === 'a' && el.href ? ' -> ' + el.href : '';
            parts.push(tag + ': ' + label.slice(0, 200) + extra);
            if (parts.length > 300) break;
          }
          return { ok: true, url, title, text: parts.join('\\n') };
        }
        return { ok: true, url, title, text: root.innerText || '' };
      })()`;

      const result = await evalOn(tabId, expression);
      if (!result || result.ok === false) {
        throw new AgentOpError((result && result.reason) || 'read failed', 'read-failed');
      }
      const text = String(result.text || '');
      const clipped = text.length > maxChars;
      return {
        tabId,
        url: result.url || meta.url,
        title: result.title || meta.title,
        mode,
        length: text.length,
        truncated: clipped,
        text: clipped ? `${text.slice(0, maxChars)}\n\n… [обрезано, всего ${text.length} символов]` : text,
      };
    },

    'page.links': async (params = {}) => {
      const tabId = await resolveTab(params.tabId ?? params.tab);
      const meta = await admitTab(tabId, 'page.links');
      const limit = Number(params.limit || 200);
      const result = await evalOn(tabId, `(() => {
        const out = [];
        for (const a of document.querySelectorAll('a[href]')) {
          const label = (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\\s+/g, ' ').trim();
          out.push({ text: label.slice(0, 160), href: a.href });
          if (out.length >= ${limit}) break;
        }
        return { url: location.href, title: document.title, links: out };
      })()`);
      return { tabId, url: (result && result.url) || meta.url, title: (result && result.title) || meta.title, links: (result && result.links) || [] };
    },

    'page.forms': async (params = {}) => {
      const tabId = await resolveTab(params.tabId ?? params.tab);
      const meta = await admitTab(tabId, 'page.forms');
      const result = await evalOn(tabId, `(() => {
        const out = [];
        for (const el of document.querySelectorAll('input,textarea,select,button,[role=button]')) {
          const r = el.getBoundingClientRect();
          out.push({
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            name: el.name || null,
            id: el.id || null,
            placeholder: el.placeholder || null,
            value: typeof el.value === 'string' ? el.value.slice(0, 120) : null,
            text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120) || null,
            visible: r.width > 0 && r.height > 0,
            rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          });
          if (out.length >= 200) break;
        }
        return { url: location.href, title: document.title, fields: out };
      })()`);
      return { tabId, url: (result && result.url) || meta.url, fields: (result && result.fields) || [] };
    },

    'page.query': async (params = {}) => {
      const tabId = await resolveTab(params.tabId ?? params.tab);
      const meta = await admitTab(tabId, 'page.query');
      const selector = String(params.selector || '').trim();
      if (!selector) throw new AgentOpError('page.query needs a selector', 'bad-params');
      const limit = Number(params.limit || DEFAULT_LIMIT);
      const result = await evalOn(tabId, `(() => {
        let nodes = [];
        try { nodes = [...document.querySelectorAll(${q(selector)})]; } catch (err) { return { error: String(err && err.message || err) }; }
        const out = nodes.slice(0, ${limit}).map((el, i) => {
          const r = el.getBoundingClientRect();
          return {
            index: i,
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
            href: el.href || null,
            src: el.src || null,
            value: typeof el.value === 'string' ? el.value.slice(0, 200) : null,
            visible: r.width > 0 && r.height > 0,
            rect: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) },
            attrs: Object.fromEntries([...el.attributes].slice(0, 12).map((a) => [a.name, String(a.value).slice(0, 200)])),
          };
        });
        return { url: location.href, title: document.title, total: nodes.length, matches: out };
      })()`);
      if (result && result.error) throw new AgentOpError(`bad selector: ${result.error}`, 'bad-selector');
      return { tabId, url: (result && result.url) || meta.url, title: (result && result.title) || meta.title, total: (result && result.total) || 0, matches: (result && result.matches) || [] };
    },

    'page.click': async (params = {}) => {
      const tabId = await resolveTab(params.tabId ?? params.tab);
      const meta = await admitTab(tabId, 'page.click');

      if (typeof params.x === 'number' && typeof params.y === 'number') {
        await mouseClickAt(tabId, params.x, params.y);
        return { tabId, clicked: 'coords', x: params.x, y: params.y };
      }

      // Finders yield the element itself; the mode below decides how to hit it.
      let elExpr;
      if (params.text) {
        const needle = String(params.text);
        elExpr = `(() => {
          const wanted = ${q(needle)}.toLowerCase();
          const candidates = [...document.querySelectorAll('a,button,[role=button],input[type=submit],input[type=button],label,span,div,li')];
          let best = null;
          for (const el of candidates) {
            const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
            if (!label) continue;
            const low = label.toLowerCase();
            const hit = ${params.exact === true ? 'low === wanted' : 'low.includes(wanted)'};
            if (!hit) continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const score = (low === wanted ? 0 : 1) * 1000 + label.length;
            if (!best || score < best.score) best = { score, el };
          }
          return best ? best.el : null;
        })()`;
      } else if (typeof params.index === 'number') {
        elExpr = `(() => { const nodes = [...document.querySelectorAll(${q(String(params.selector || 'a,button,[role=button]'))})]; return nodes[${Number(params.index)}] || null; })()`;
      } else {
        const selector = String(params.selector || '').trim();
        if (!selector) throw new AgentOpError('page.click needs selector, index, text or x/y', 'bad-params');
        elExpr = `document.querySelector(${q(selector)})`;
      }

      const method = String(params.method || 'auto');
      const useJs = method === 'js' || (method === 'auto' && !(await tabWindowFocused(tabId)));
      const labelExpr = `(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 120)`;
      const expression = useJs
        ? `(() => {
            const el = ${elExpr};
            if (!el) return null;
            el.scrollIntoView({ block: 'center', inline: 'center' });
            const info = { label: ${labelExpr}, tag: el.tagName.toLowerCase(), js: true };
            el.click();
            return info;
          })()`
        : `(() => {
            const el = ${elExpr};
            if (!el) return null;
            el.scrollIntoView({ block: 'center', inline: 'center' });
            const r = el.getBoundingClientRect();
            return { label: ${labelExpr}, tag: el.tagName.toLowerCase(), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })()`;

      const target = await evalOn(tabId, expression);
      if (!target) throw new AgentOpError('click target not found', 'target-not-found');
      if (target.js === true) {
        await delay(300);
        return { tabId, clicked: target.label || target.tag, js: true, url: meta.url };
      }
      if (target.x === 0 && target.y === 0) await delay(150);
      await mouseClickAt(tabId, target.x, target.y);
      return { tabId, clicked: target.label || target.tag, x: target.x, y: target.y, url: meta.url };
    },

    'page.type': async (params = {}) => {
      const tabId = await resolveTab(params.tabId ?? params.tab);
      await admitTab(tabId, 'page.type');
      const selector = String(params.selector || '').trim();
      const text = String(params.text ?? '');
      if (!selector) throw new AgentOpError('page.type needs a selector', 'bad-params');

      const box = await evalOn(tabId, `(() => {
        const el = document.querySelector(${q(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        el.focus();
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase(), value: typeof el.value === 'string' ? el.value : null, contentEditable: el.isContentEditable === true };
      })()`);
      if (!box) throw new AgentOpError(`selector not found: ${selector}`, 'selector-not-found');

      // Unfocused windows swallow synthesised input — drive the field through the DOM
      // instead (native value setter + input/change events, so React sees it too).
      const method = String(params.method || 'auto');
      const useJs = method === 'js' || (method === 'auto' && !(await tabWindowFocused(tabId)));
      if (useJs) {
        const nextValue = params.append === true ? `(el.value || '') + ${q(text)}` : q(text);
        const jsExpr = `(() => {
          const el = document.querySelector(${q(selector)});
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          if (typeof el.focus === 'function') el.focus();
          const isArea = el instanceof HTMLTextAreaElement;
          const isInput = el instanceof HTMLInputElement;
          const next = ${nextValue};
          if (isInput || isArea) {
            const desc = Object.getOwnPropertyDescriptor(isArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value');
            if (desc && desc.set) desc.set.call(el, next); else el.value = next;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (el.isContentEditable) {
            el.textContent = next;
            el.dispatchEvent(new InputEvent('input', { bubbles: true }));
          } else {
            return null;
          }
          ${params.submit === true ? 'if (el.form && el.form.requestSubmit) el.form.requestSubmit(); else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, which: 13, bubbles: true }));' : ''}
          ${params.blur === true ? 'if (typeof el.blur === "function") el.blur();' : ''}
          return { value: typeof el.value === 'string' ? el.value : el.textContent, js: true };
        })()`;
        const res = await evalOn(tabId, jsExpr);
        if (!res) throw new AgentOpError(`selector not found or not fillable: ${selector}`, 'selector-not-found');
        if (params.submit === true) await waitForLoad(tabId, Number(params.timeoutMs || 20000)).catch(() => {});
        return { tabId, selector, value: res.value, typed: text.length, js: true };
      }

      await ensureInputFocus(tabId);
      await controller.sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
      await controller.sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });

      if (params.append !== true) {
        const selectAll = { key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 };
        await controller.sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...selectAll });
        await controller.sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...selectAll });
      }
      await controller.sendCdp(tabId, 'Input.insertText', { text });
      if (params.submit === true) {
        await controller.sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await controller.sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await waitForLoad(tabId, Number(params.timeoutMs || 20000));
      } else if (params.blur === true) {
        await evalOn(tabId, `(() => { const el = document.querySelector(${q(selector)}); if (el) el.blur(); return true; })()`);
      }
      const value = await evalOn(tabId, `(() => { const el = document.querySelector(${q(selector)}); return el && typeof el.value === 'string' ? el.value : null; })()`);
      return { tabId, selector, value, typed: text.length };
    },

    'page.press': async (params = {}) => {
      const tabId = await resolveTab(params.tabId ?? params.tab);
      await admitTab(tabId, 'page.press');
      const key = String(params.key || 'Enter');
      const map = {
        Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
        Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
        Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
        ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
        ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
        PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
        PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
        Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
      };
      const spec = map[key] || { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: 0 };
      await ensureInputFocus(tabId);
      await controller.sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...spec, nativeVirtualKeyCode: spec.windowsVirtualKeyCode });
      await controller.sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...spec, nativeVirtualKeyCode: spec.windowsVirtualKeyCode });
      if (key === 'Enter') await waitForLoad(tabId, Number(params.timeoutMs || 20000));
      return { tabId, key };
    },

    'page.scroll': async (params = {}) => {
      const tabId = await resolveTab(params.tabId ?? params.tab);
      await admitTab(tabId, 'page.scroll');
      if (params.to === 'bottom' || params.to === 'top') {
        await evalOn(tabId, `(() => { window.scrollTo(0, ${params.to === 'bottom' ? 'document.body.scrollHeight' : '0'}); return window.scrollY; })()`);
      } else {
        const deltaY = Number(params.deltaY ?? 600);
        await ensureInputFocus(tabId);
        await controller.sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: Number(params.x ?? 10), y: Number(params.y ?? 400), deltaX: 0, deltaY });
      }
      const pos = await evalOn(tabId, `({ y: Math.round(window.scrollY), h: document.body ? document.body.scrollHeight : 0, view: window.innerHeight })`);
      return { tabId, scroll: pos };
    },

    'page.eval': async (params = {}) => {
      const tabId = await resolveTab(params.tabId ?? params.tab);
      await admitTab(tabId, 'page.eval');
      const expression = String(params.expression || '').trim();
      if (!expression) throw new AgentOpError('page.eval needs an expression', 'bad-params');
      const value = await evalOn(tabId, expression);
      return { tabId, value };
    },

    'page.wait': async (params = {}) => {
      const tabId = await resolveTab(params.tabId ?? params.tab);
      await admitTab(tabId, 'page.wait');
      const selector = String(params.selector || '').trim();
      const deadline = Date.now() + Number(params.timeoutMs || 15000);
      let found = false;
      while (Date.now() < deadline) {
        found = Boolean(await evalOn(tabId, `Boolean(${selector ? `document.querySelector(${q(selector)})` : 'document.body && document.body.innerText.length > 0'})`));
        if (found) break;
        await delay(200);
      }
      if (params.loaded !== false) {
        await waitForLoad(tabId, Math.max(2000, deadline - Date.now()));
      }
      return { tabId, found, selector: selector || null };
    },

    'page.screenshot': async (params = {}) => {
      const tabId = await resolveTab(params.tabId ?? params.tab);
      const meta = await admitTab(tabId, 'page.screenshot');
      const shot = await controller.sendCdp(tabId, 'Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: params.full === true,
      });
      const data = (shot && shot.data) || '';
      const maxBytes = Number(params.maxBytes || 12 * 1024 * 1024);
      if (data.length * 0.75 > maxBytes) throw new AgentOpError('screenshot too large', 'too-large');
      return { tabId, url: meta.url, format: 'png', base64: data, approxBytes: Math.round(data.length * 0.75) };
    },

    'page.fetch': async (params = {}) => {
      const tabId = await resolveTab(params.tabId ?? params.tab);
      const url = String(params.url || '').trim();
      if (!url) throw new AgentOpError('page.fetch needs a url', 'bad-params');
      admit(url, 'page.fetch');
      const as = params.as === 'text' ? 'text' : 'base64';
      const maxBytes = Number(params.maxBytes || MAX_FETCH_BYTES);

      const fromPage = async () => {
        const expression = `(async () => {
          const res = await fetch(${q(url)}, { credentials: 'include', redirect: 'follow' });
          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          if (bytes.length > ${maxBytes}) return { ok: false, error: 'too large: ' + bytes.length };
          let body;
          if (${q(as)} === 'text') {
            body = new TextDecoder('utf-8').decode(bytes);
          } else {
            let binary = '';
            const chunk = 8192;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
            }
            body = btoa(binary);
          }
          return { ok: true, status: res.status, mime: res.headers.get('content-type') || '', bytes: bytes.length, body };
        })()`;
        const result = await evalOn(tabId, expression);
        if (!result || result.ok === false) {
          throw new AgentOpError((result && result.error) || 'fetch failed', 'fetch-failed');
        }
        return { ...result, via: 'page' };
      };

      // Fallback for cross-origin assets (CDN images, PDFs, media): drive a
      // throwaway background tab over CDP. No CORS, no page context, cookies and
      // referer are the browser's own, and the user's tabs are never reloaded.
      const fromTab = async () => {
        const win = await ensureAgentWindow({});
        const tab = await api.tabs.create({ url: 'about:blank', active: false, windowId: win.id });
        const tempTabId = tab.id;
        try {
          await controller.sendCdp(tempTabId, 'Page.enable', {});
          await controller.sendCdp(tempTabId, 'Network.enable', {});
          await controller.sendCdp(tempTabId, 'Page.navigate', { url });
          const deadline = Date.now() + Number(params.timeoutMs || 25000);
          let entry = null;
          while (Date.now() < deadline && !entry) {
            await delay(250);
            entry = findBufferedResponse(tempTabId, url);
          }
          if (!entry) throw new AgentOpError('resource did not load in the helper tab', 'resource-not-found');
          // give the body a moment to settle after loadingFinished
          await delay(250);
          const body = await controller.sendCdp(tempTabId, 'Network.getResponseBody', { requestId: entry.requestId });
          const isB64 = body && body.base64Encoded === true;
          const data = (body && body.body) || '';
          const bytes = isB64 ? Math.round(data.length * 0.75) : data.length;
          if (bytes > maxBytes) throw new AgentOpError(`too large: ${bytes}`, 'too-large');
          return {
            via: 'tab',
            status: entry.status,
            mime: entry.mimeType || '',
            bytes,
            encoding: isB64 ? 'base64' : (as === 'base64' ? 'binary' : 'utf8'),
            body: as === 'base64' ? (isB64 ? data : btoa(unescape(encodeURIComponent(data)))) : data,
          };
        } finally {
          try {
            await api.tabs.remove(tempTabId);
          } catch (err) {
            log('helper tab cleanup failed', err && err.message);
          }
        }
      };

      const mode = String(params.via || 'auto');
      const errors = [];
      if (mode === 'page' || mode === 'auto') {
        try {
          const result = await fromPage();
          return { tabId, url, status: result.status, mime: result.mime, bytes: result.bytes, encoding: as === 'base64' ? 'base64' : 'utf8', body: result.body, via: result.via };
        } catch (err) {
          errors.push(`page: ${err.message}`);
          if (mode === 'page') throw err;
        }
      }
      if (mode === 'tab' || mode === 'auto') {
        try {
          const result = await fromTab();
          return { tabId, url, status: result.status, mime: result.mime, bytes: result.bytes, encoding: result.encoding, body: result.body, via: result.via };
        } catch (err) {
          errors.push(`tab: ${err.message}`);
          if (mode === 'tab') throw err;
        }
      }
      throw new AgentOpError(`download failed (${errors.join(' | ')})`, 'fetch-failed');
    },

    /** List the tab's recent network responses (debugging + download targeting). */
    'page.network': async (params = {}) => {
      const tabId = await resolveTab(params.tabId ?? params.tab);
      await admitTab(tabId, 'page.network');
      await controller.sendCdp(tabId, 'Network.enable', {});
      const snap = controller.bufferSnapshot ? controller.bufferSnapshot(tabId) : { responses: [] };
      const needle = params.url ? String(params.url).toLowerCase() : '';
      const limit = Number(params.limit || 50);
      const responses = snap.responses
        .filter((r) => !needle || String(r.url || '').toLowerCase().includes(needle))
        .slice(-limit)
        .map((r) => ({ requestId: r.requestId, url: r.url, status: r.status, mimeType: r.mimeType, fromCache: r.fromCache }));
      return { tabId, total: snap.responses.length, responses };
    },
  };

  /** Newest buffered response matching a URL: exact, then path-prefix, then substring. */
  function findBufferedResponse(tabId, url) {
    const snap = controller.bufferSnapshot ? controller.bufferSnapshot(tabId) : null;
    const list = (snap && snap.responses) || [];
    const exact = list.filter((r) => r.url === url);
    if (exact.length) return exact[exact.length - 1];
    const base = String(url).split('?')[0];
    const prefix = list.filter((r) => String(r.url || '').startsWith(base));
    if (prefix.length) return prefix[prefix.length - 1];
    const loose = list.filter((r) => String(r.url || '').includes(base));
    return loose.length ? loose[loose.length - 1] : null;
  }

  async function waitForLoad(tabId, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await evalOn(tabId, 'document.readyState').catch(() => null);
      if (ready === 'complete') return true;
      await delay(200);
    }
    return false;
  }

  /** Bridge entry point: `{ok, ...}` reply, never throws. */
  async function handle(method, params = {}) {
    const fn = verbs[method];
    if (!fn) return { ok: false, code: 'unknown-agent-verb', message: `unknown agent verb: ${method}` };
    try {
      const payload = await fn(params || {});
      return { ok: true, verb: method, ...payload };
    } catch (err) {
      return {
        ok: false,
        code: (err && err.code) || 'agent-op-failed',
        message: String((err && err.message) || err),
        verb: method,
      };
    }
  }

  return { handle, verbs, ensureArmed, resolveTab, allTabs, settings: () => ({ ...settings }), hydrate };
}
