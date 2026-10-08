// Security gate tests. Run: node --test security/operation-guard.test.mjs
//
// Covers the deny-list (banking + email + the rest), fail-closed behavior on a
// stale/missing profile or port, and the live enforcement point in the browser
// control gate.

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateTargetUrl, evaluateOperationGate, OPERATION_DECISIONS } from '../../extension/security/operation-guard.mjs';
import { sensitiveDomainCategories, isSensitiveDomainUrl } from '../../extension/lib/sensitive-domains.mjs';
import { createAdmissionGuard } from '../../extension/src/admission.js';

const freshLease = { profileId: 'profile-a', port: 8642, documentGeneration: 7 };
const liveBinding = { profileId: 'profile-a', port: 8642, documentGeneration: 7 };

test('deny-list blocks email providers', () => {
  for (const url of [
    'https://mail.google.com/mail/u/0/#inbox',
    'https://gmail.com',
    'https://outlook.live.com/mail/0/inbox',
    'https://mail.yandex.ru/?login=1',
    'https://protonmail.com/u/0/inbox',
    'https://mail.ru/inbox/',
  ]) {
    assert.equal(isSensitiveDomainUrl(url), true, `${url} must be denied`);
    assert.ok(sensitiveDomainCategories(url).includes('email'), `${url} must classify as email`);
  }
});

test('deny-list blocks banking, crypto, password managers, health, tax, checkout', () => {
  const cases = {
    'https://secure.chase.com/web/auth': 'banking',
    'https://www.bankofamerica.com/': 'banking',
    'https://online.sberbank.ru/': 'banking',
    'https://www.coinbase.com/dashboard': 'crypto',
    'https://binance.com/en/my/wallet': 'crypto',
    'https://my.1password.com/': 'password-manager',
    'https://vault.bitwarden.com/#/login': 'password-manager',
    'https://mychart.example.org/patient': 'medical',
    'https://www.irs.gov/payments': 'government-tax',
    'https://shop.example.com/checkout/step2': 'payments',
  };
  for (const [url, category] of Object.entries(cases)) {
    assert.equal(isSensitiveDomainUrl(url), true, `${url} must be denied`);
    assert.ok(sensitiveDomainCategories(url).includes(category), `${url} must classify as ${category}`);
  }
});

test('deny-list leaves ordinary sites alone', () => {
  for (const url of [
    'https://example.com/article',
    'https://news.ycombinator.com/item?id=1',
    'https://github.com/nous-research/hermes-agent',
    'https://en.wikipedia.org/wiki/Email',
    'https://developer.mozilla.org/en-US/docs/Web/API',
  ]) {
    assert.equal(isSensitiveDomainUrl(url), false, `${url} must not be denied`);
  }
});

test('evaluateTargetUrl fails closed on a bad or unparseable target', () => {
  assert.equal(evaluateTargetUrl('').code, 'bad_target');
  assert.equal(evaluateTargetUrl('not a url').code, 'bad_target');
  assert.equal(evaluateTargetUrl('javascript:alert(1)').code, 'bad_target');
  const denied = evaluateTargetUrl('https://mail.google.com/');
  assert.equal(denied.decision, OPERATION_DECISIONS.DENY);
  assert.equal(denied.code, 'sensitive_domain');
});

test('gate allows a fresh operation on an ordinary site', () => {
  const result = evaluateOperationGate({
    url: 'https://example.com/page',
    lease: freshLease,
    expected: liveBinding,
  });
  assert.equal(result.decision, OPERATION_DECISIONS.ALLOW);
});

test('gate denies a sensitive target even with a fresh lease', () => {
  const result = evaluateOperationGate({
    url: 'https://mail.google.com/mail/u/0/#inbox',
    lease: freshLease,
    expected: liveBinding,
  });
  assert.equal(result.decision, OPERATION_DECISIONS.DENY);
  assert.equal(result.code, 'sensitive_domain');
});

test('gate fails closed on a stale profile', () => {
  const result = evaluateOperationGate({
    url: 'https://example.com/page',
    lease: { ...freshLease, profileId: 'profile-a' },
    expected: { ...liveBinding, profileId: 'profile-b' },
  });
  assert.equal(result.decision, OPERATION_DECISIONS.DENY);
  assert.equal(result.code, 'stale_profile');
});

test('gate fails closed on a stale port', () => {
  const result = evaluateOperationGate({
    url: 'https://example.com/page',
    lease: { ...freshLease, port: 8642 },
    expected: { ...liveBinding, port: 8645 },
  });
  assert.equal(result.decision, OPERATION_DECISIONS.DENY);
  assert.equal(result.code, 'stale_port');
});

test('gate fails closed on a stale document generation', () => {
  const result = evaluateOperationGate({
    url: 'https://example.com/page',
    lease: { ...freshLease, documentGeneration: 7 },
    expected: { ...liveBinding, documentGeneration: 8 },
  });
  assert.equal(result.decision, OPERATION_DECISIONS.DENY);
  assert.equal(result.code, 'stale_document');
});

test('gate fails closed when the lease, the live binding, or the profile/port is missing', () => {
  assert.equal(evaluateOperationGate({ url: 'https://example.com/', lease: null, expected: liveBinding }).code, 'no_lease');
  assert.equal(evaluateOperationGate({ url: 'https://example.com/', lease: freshLease, expected: null }).code, 'no_expected_binding');
  assert.equal(
    evaluateOperationGate({ url: 'https://example.com/', lease: { port: 8642 }, expected: liveBinding }).code,
    'no_lease',
  );
  assert.equal(
    evaluateOperationGate({ url: 'https://example.com/', lease: freshLease, expected: { profileId: 'profile-a' } }).code,
    'no_lease',
  );
});

test('live admission guard blocks commands on a denied page (MVP enforcement point)', () => {
  const guard = createAdmissionGuard();

  // Panel-driven commands: the deny-list is the whole gate.
  assert.equal(guard.check({ url: 'https://mail.google.com/mail/u/0/#inbox', source: 'panel' }).code, 'sensitive-domain');
  assert.equal(guard.check({ url: 'https://chase.com/account', source: 'panel' }).code, 'sensitive-domain');
  assert.equal(guard.check({ url: 'https://example.com/article', source: 'panel' }).ok, true);

  // Relay-driven commands with no connection binding: fail closed.
  const unbound = guard.check({ url: 'https://example.com/article', source: 'relay' });
  assert.equal(unbound.ok, false);
  assert.equal(unbound.code, 'no-lease');

  // Bound: the live profile/port matches the armed session's lease.
  guard.setBinding({ profileId: 'profile-a', port: 8642, documentGeneration: 1 });
  assert.equal(guard.check({ url: 'https://example.com/article', source: 'relay' }).ok, true);

  // The port moves under an armed session: denied, not silently re-targeted.
  guard.refreshLease();
  guard.overrideBinding({ profileId: 'profile-a', port: 9999, documentGeneration: 1 });
  const stale = guard.check({ url: 'https://example.com/article', source: 'relay' });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale-port');
});
