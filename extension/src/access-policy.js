/**
 * Access policy — which tabs the agent is allowed to touch.
 *
 * Pure module: no chrome.* references, so it is unit-testable in Node.
 */

/** Access modes offered by the side panel. */
export const MODES = Object.freeze({
  ACTIVE: 'active-tab',
  SELECTED: 'selected-tabs',
  GROUP: 'tab-group',
  /** Full self-service mode: every tab is in the access set (revocations still win). */
  AGENT: 'agent-all',
});

export const MODE_LIST = Object.freeze([MODES.ACTIVE, MODES.SELECTED, MODES.GROUP, MODES.AGENT]);

export function isValidMode(mode) {
  return MODE_LIST.includes(mode);
}

/**
 * Decide whether the targeted tab is inside the granted access set.
 * Fails closed: unknown mode, missing/negative tabId, missing context → false.
 *
 * @param {string} mode
 * @param {object} ctx
 * @param {number} [ctx.tabId]              tab being targeted
 * @param {number} [ctx.activeTabId]        live active tab of the window
 * @param {number} [ctx.pinnedActiveTabId]  active tab pinned when the mode was armed
 * @param {Set<number>} [ctx.selectedTabIds]
 * @param {number} [ctx.agentGroupId]       tab group owned by the agent
 * @param {number} [ctx.tabGroupId]         group of the targeted tab (-1 = none)
 * @returns {boolean}
 */
export function isTabAllowed(mode, ctx = {}) {
  const { tabId } = ctx;
  if (typeof tabId !== 'number' || tabId < 0) return false;
  switch (mode) {
    case MODES.ACTIVE: {
      const target = ctx.pinnedActiveTabId ?? ctx.activeTabId;
      return typeof target === 'number' && target === tabId;
    }
    case MODES.SELECTED:
      return Boolean(ctx.selectedTabIds && ctx.selectedTabIds.has(tabId));
    case MODES.GROUP:
      return (
        typeof ctx.agentGroupId === 'number' &&
        typeof ctx.tabGroupId === 'number' &&
        ctx.tabGroupId !== -1 &&
        ctx.tabGroupId === ctx.agentGroupId
      );
    case MODES.AGENT:
      // Self-service mode: the agent owns every tab it can see. Explicit
      // revocations are checked before this policy (see session-state.gate)
      // and browser-internal pages are rejected by the controller.
      return true;
    default:
      return false;
  }
}

export function describeMode(mode) {
  switch (mode) {
    case MODES.ACTIVE:
      return 'only the active tab (pinned when armed)';
    case MODES.SELECTED:
      return 'only explicitly selected tabs';
    case MODES.GROUP:
      return 'only tabs inside the agent tab group';
    case MODES.AGENT:
      return 'every tab (self-service mode; revocations still apply)';
    default:
      return 'no access';
  }
}
