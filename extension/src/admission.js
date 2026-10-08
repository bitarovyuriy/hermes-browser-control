/**
 * Admission guard — the security workstream wired onto the live command path.
 *
 * `evaluateOperationGate` (security/operation-guard.mjs) is a pure, fail-closed
 * gate: it denies sensitive domains (banking, email, crypto, password managers,
 * gov/tax, medical, checkout) and denies when the operation cannot be bound to
 * the SAME browser profile / gateway port the controller is connected to.
 *
 * This module is the missing glue the security verdict called out (blocker #1):
 * it is the only place that turns the guard's decision into a controller-level
 * refusal, so a denied command never reaches `planCommand`.
 *
 * Two sources of commands:
 *   * `panel`  — the human driving the side panel. The deny-list applies; there
 *                is no connection binding to check, so the freshness lease is
 *                skipped (nothing to be stale against).
 *   * `relay`  — the Hermes runtime over the loopback relay. The deny-list and
 *                the freshness lease both apply: the lease captured when the
 *                session was armed must still match the live binding, otherwise
 *                the command is refused instead of running against the wrong
 *                runtime.
 */

import { evaluateOperationGate, evaluateTargetUrl } from '../security/operation-guard.mjs';

/** Map the guard's snake_case codes onto the hyphenated controller vocabulary. */
function controllerCode(code) {
  return String(code || 'denied').replace(/_/g, '-');
}

/**
 * @param {object} [opts]
 * @param {(line: string, detail?: unknown) => void} [opts.log]
 */
export function createAdmissionGuard({ log = () => {} } = {}) {
  /** Live binding of the transport connection: { profileId, port }. */
  let binding = null;
  /** Binding captured when the agent session was armed (what the lease means). */
  let lease = null;

  /**
   * @param {{url?: string, source?: 'panel'|'relay', command?: string}} args
   * @returns {{ok: true, guard: object} | {ok: false, code: string, message: string, guard: object}}
   */
  function check({ url = '', source = 'panel', command = '' } = {}) {
    const target = evaluateTargetUrl(url);

    if (url && target.decision === 'deny') {
      log('admission denied', { command, code: target.code, url: String(url).slice(0, 120) });
      return { ok: false, code: controllerCode(target.code), message: target.reason, guard: target };
    }

    if (source !== 'relay') {
      // No connection binding exists for panel-driven commands; the deny-list is
      // the whole gate.
      return { ok: true, guard: target };
    }

    const gate = evaluateOperationGate({ url, lease, expected: binding });
    if (gate.decision === 'deny') {
      log('admission denied (binding)', { command, code: gate.code });
      return { ok: false, code: controllerCode(gate.code), message: gate.reason, guard: gate };
    }
    return { ok: true, guard: gate };
  }

  /** Register the live connection binding; the next arm copies it into the lease. */
  function setBinding(next) {
    binding = next ? { profileId: next.profileId, port: next.port, documentGeneration: next.documentGeneration } : null;
    if (binding) lease = { ...binding };
    return binding;
  }

  /** Re-capture the lease from the current binding (called on arm). */
  function refreshLease() {
    lease = binding ? { ...binding } : null;
    return lease;
  }

  /** Test seam: deliberately move the live binding away from the lease. */
  function overrideBinding(next) {
    binding = next ? { ...next } : null;
    return binding;
  }

  return {
    check,
    setBinding,
    refreshLease,
    overrideBinding,
    snapshot: () => ({ binding, lease }),
  };
}
