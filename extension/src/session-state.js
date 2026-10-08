/**
 * Session state machine for the agent session.
 *
 * Holds: armed / paused / killed, the access grant (mode + tab set + tab group),
 * and a monotonically increasing `revision`. Every command entry point must call
 * `gate()` first; the revision counter lets the controller drop work that was
 * queued before a pause/kill/revocation.
 *
 * Pure module (no chrome.*) — unit-testable.
 */
import { MODES, isValidMode, isTabAllowed } from './access-policy.js';

export const GATE_CODES = Object.freeze({
  OK: 'ok',
  NOT_ARMED: 'not-armed',
  PAUSED: 'paused',
  KILLED: 'killed',
  TAB_NOT_ALLOWED: 'tab-not-allowed',
});

export function createSessionState() {
  let armed = false;
  let paused = false;
  let killed = false;
  let mode = null;
  let agentGroupId = null;
  let pinnedActiveTabId = null;
  const selectedTabIds = new Set();
  const revokedTabIds = new Set();
  let revision = 0;

  const bump = () => ++revision;

  function snapshot() {
    return {
      armed,
      paused,
      killed,
      mode,
      agentGroupId,
      pinnedActiveTabId,
      selectedTabIds: [...selectedTabIds],
      revokedTabIds: [...revokedTabIds],
      revision,
    };
  }

  /** Arm the session with a mode and an initial grant. */
  function arm({ mode: nextMode, tabIds = [], agentGroupId: groupId = null, pinnedActiveTabId: pinned = null, preserveRevoked = false } = {}) {
    if (!isValidMode(nextMode)) throw new Error(`bad mode: ${nextMode}`);
    if (killed) throw new Error('session is killed; clear the kill-switch first');
    armed = true;
    mode = nextMode;
    agentGroupId = nextMode === MODES.GROUP ? groupId : null;
    pinnedActiveTabId = nextMode === MODES.ACTIVE ? pinned : null;
    selectedTabIds.clear();
    // Auto-arm keeps the user's explicit revocations; a deliberate panel arm
    // starts from a clean slate.
    if (!preserveRevoked) revokedTabIds.clear();
    for (const id of tabIds) selectedTabIds.add(id);
    bump();
    return snapshot();
  }

  function setMode(nextMode, opts = {}) {
    return arm({ mode: nextMode, ...opts });
  }

  /** Grant access to more tabs (selected-tabs mode) or to a group. */
  function allow({ tabIds = [], agentGroupId: groupId = null } = {}) {
    for (const id of tabIds) {
      selectedTabIds.add(id);
      revokedTabIds.delete(id);
    }
    if (groupId != null) agentGroupId = groupId;
    bump();
    return snapshot();
  }

  /**
   * Revoke a single tab's access live.
   * Revocation is sticky: it outranks the access mode, so a revoked tab cannot
   * come back just because it happens to be the active tab again.
   */
  function revoke(tabId) {
    selectedTabIds.delete(tabId);
    revokedTabIds.add(tabId);
    bump();
    return { revoked: true, snapshot: snapshot() };
  }

  function pause() {
    if (!killed) paused = true;
    bump();
    return snapshot();
  }

  function resume() {
    if (!killed) paused = false;
    bump();
    return snapshot();
  }

  /** Kill switch: terminal until explicitly cleared. Halts everything now. */
  function kill() {
    killed = true;
    paused = true;
    armed = false;
    mode = null;
    agentGroupId = null;
    pinnedActiveTabId = null;
    selectedTabIds.clear();
    revokedTabIds.clear();
    bump();
    return snapshot();
  }

  /** Deliberate, user-initiated re-arm after a kill. */
  function clearKill() {
    if (killed) {
      killed = false;
      paused = false;
      bump();
    }
    return snapshot();
  }

  function isLive() {
    return armed && !paused && !killed;
  }

  /**
   * Gate one command. `ctx` carries the live tab facts the policy needs.
   * @returns {{ok: true, revision: number} | {ok: false, code: string, message: string, revision: number}}
   */
  function gate({ tabId = null, ctx = {} } = {}) {
    if (killed) return { ok: false, code: GATE_CODES.KILLED, message: 'agent killed by kill-switch', revision };
    if (!armed) return { ok: false, code: GATE_CODES.NOT_ARMED, message: 'agent session is not armed', revision };
    if (paused) return { ok: false, code: GATE_CODES.PAUSED, message: 'agent session is paused', revision };
    if (tabId != null) {
      if (revokedTabIds.has(tabId)) {
        return { ok: false, code: GATE_CODES.TAB_NOT_ALLOWED, message: `tab ${tabId} was revoked by the user`, revision };
      }
      const allowed = isTabAllowed(mode, {
        ...ctx,
        tabId,
        agentGroupId,
        selectedTabIds,
        pinnedActiveTabId: mode === MODES.ACTIVE ? (pinnedActiveTabId ?? ctx.activeTabId) : null,
      });
      if (!allowed) {
        return { ok: false, code: GATE_CODES.TAB_NOT_ALLOWED, message: `tab ${tabId} is not in the agent's access set`, revision };
      }
    }
    return { ok: true, revision };
  }

  return {
    snapshot,
    arm,
    setMode,
    allow,
    revoke,
    pause,
    resume,
    kill,
    clearKill,
    isLive,
    gate,
    get revision() {
      return revision;
    },
    get mode() {
      return mode;
    },
    get agentGroupId() {
      return agentGroupId;
    },
  };
}
