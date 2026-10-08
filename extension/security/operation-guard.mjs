/**
 * Operation guard — the fail-closed admission gate for every agent-initiated
 * browser operation.
 *
 * Two independent checks, both fail-closed:
 *
 *   1. Deny-list. The target URL must not be a sensitive domain (banking,
 *      email, crypto, password manager, government/tax, medical, checkout).
 *      An unparseable or empty URL is denied, never allowed.
 *
 *   2. Freshness lease. The operation must be bound to the SAME browser
 *      profile, gateway port, and document generation that the controller is
 *      currently connected to. If any of those cannot be confirmed — the lease
 *      is missing, the "expected" live binding is missing, or they disagree —
 *      the operation is denied. A stale profile/port (the user switched
 *      gateways or profiles after the tab lease was minted) therefore fails
 *      closed instead of running against the wrong runtime.
 *
 * Pure module: no browser APIs, no I/O. Everything is injectable, so the whole
 * gate is unit-testable.
 */

import { isSensitiveDomainUrl, sensitiveDomainCategories } from '../lib/sensitive-domains.mjs';

export const OPERATION_GUARD_VERSION = 1;

export const OPERATION_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  DENY: 'deny',
});

const DENY_CODES = Object.freeze({
  BAD_TARGET: 'bad_target',
  SENSITIVE_DOMAIN: 'sensitive_domain',
  NO_LEASE: 'no_lease',
  NO_EXPECTED_BINDING: 'no_expected_binding',
  STALE_PROFILE: 'stale_profile',
  STALE_PORT: 'stale_port',
  STALE_DOCUMENT: 'stale_document',
});

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function originOf(url) {
  try {
    const parsed = new URL(String(url || ''));
    // Opaque origins (javascript:, data:, ...) report the string "null".
    if (!parsed.origin || parsed.origin === 'null') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function deny(code, reason) {
  return Object.freeze({ decision: OPERATION_DECISIONS.DENY, code, reason });
}

/** Evaluate the raw deny-list decision for a single URL target. */
export function evaluateTargetUrl(url = '') {
  const raw = compact(url);
  if (!raw) return deny(DENY_CODES.BAD_TARGET, 'No target URL was supplied.');
  if (!originOf(raw)) return deny(DENY_CODES.BAD_TARGET, `The target URL is not an absolute, parseable URL: "${raw.slice(0, 120)}".`);
  if (isSensitiveDomainUrl(raw)) {
    const categories = sensitiveDomainCategories(raw);
    return deny(
      DENY_CODES.SENSITIVE_DOMAIN,
      `The target is a sensitive domain (${categories.join(', ') || 'unclassified'}); operations here are blocked.`,
    );
  }
  return Object.freeze({ decision: OPERATION_DECISIONS.ALLOW, code: 'target_ok', categories: [] });
}

/**
 * Evaluate the freshness lease.
 *
 * @param {object} args
 * @param {{profileId?: string, port?: number, documentGeneration?: number}} args.lease
 *        The binding captured when the tab lease / WS ticket was minted.
 * @param {{profileId?: string, port?: number, documentGeneration?: number}} args.expected
 *        The authoritative live binding of the current connection.
 * @param {string} [args.url] - optional URL; when present the deny-list is checked too.
  */
export function evaluateOperationGate({ url = '', lease = null, expected = null } = {}) {
  const target = evaluateTargetUrl(url);
  if (!url && target.code !== DENY_CODES.BAD_TARGET) {
    // No URL supplied at all is only acceptable for the deny-list check when the
    // caller explicitly omits a target (e.g. a tab-list read). Fall through to
    // the lease check; a URL always gets the deny-list treatment above.
  } else if (url && target.decision === OPERATION_DECISIONS.DENY) {
    return target;
  }

  if (!lease || typeof lease !== 'object') {
    return deny(DENY_CODES.NO_LEASE, 'This operation has no lease binding, so its profile/port cannot be confirmed.');
  }
  if (!expected || typeof expected !== 'object') {
    return deny(DENY_CODES.NO_EXPECTED_BINDING, 'The live profile/port binding is unknown; refusing to fail open.');
  }

  const leaseProfile = compact(lease.profileId);
  const expectedProfile = compact(expected.profileId);
  if (!leaseProfile || !expectedProfile) {
    return deny(DENY_CODES.NO_LEASE, 'Either the lease or the live binding omits its browser profile id.');
  }
  if (leaseProfile !== expectedProfile) {
    return deny(DENY_CODES.STALE_PROFILE, `Stale profile: the lease was minted for "${leaseProfile}" but the live connection is "${expectedProfile}".`);
  }

  const leasePort = normalizePort(lease.port);
  const expectedPort = normalizePort(expected.port);
  if (leasePort === null || expectedPort === null) {
    return deny(DENY_CODES.NO_LEASE, 'Either the lease or the live binding omits a valid gateway port.');
  }
  if (leasePort !== expectedPort) {
    return deny(DENY_CODES.STALE_PORT, `Stale port: the lease was minted for port ${leasePort} but the live connection is on port ${expectedPort}.`);
  }

  const leaseDoc = Number(lease.documentGeneration);
  const expectedDoc = Number(expected.documentGeneration);
  if (Number.isInteger(leaseDoc) && Number.isInteger(expectedDoc) && leaseDoc > 0 && expectedDoc > 0 && leaseDoc !== expectedDoc) {
    return deny(DENY_CODES.STALE_DOCUMENT, `Stale document: the lease targets generation ${leaseDoc} but the live document is ${expectedDoc}.`);
  }

  return Object.freeze({
    decision: OPERATION_DECISIONS.ALLOW,
    code: 'ok',
    profileId: leaseProfile,
    port: leasePort,
  });
}
