// Sensitive-domain deny-list — single source of truth.
//
// Every URL that the extension might read from or act on is classified here.
// The operation gate (`lib/browser-control-safety.mjs`), the context-capture
// guard (`lib/browser-context-protocol.mjs`), and the side-panel prompt builder
// (`lib/common.mjs`) all consume this module so the list cannot drift.
//
// Posture: FAIL-CLOSED. An unparseable URL, a missing host, or a match on any
// rule denies the operation. Adding a rule only ever narrows what the agent can
// touch; it never widens it.

export const SENSITIVE_DOMAINS_VERSION = 1;

// Bank / brokerage / payment brands that do not contain the literal "bank".
const FINANCE_BRAND_RE = /(^|\.)(chase|wellsfargo|bankofamerica|bofa|citibank|citi|capitalone|hsbc|barclays|lloydsbank|natwest|santander|revolut|monzo|n26|deutschebank|unicredit|raiffeisen|sberbank|tinkoff|tbank|alfabank|vtb|gazprombank|paypal|venmo|wise|zelle|stripe|squareup)\b/i;
const CRYPTO_BRAND_RE = /(^|\.)(coinbase|binance|kraken|crypto\.com|metamask|blockchain\.com|kucoin|okx|bybit|gemini)\b/i;
const PASSWORD_MANAGER_RE = /(^|\.)(1password|bitwarden|lastpass|dashlane|keepersecurity|nordpass|protonpass)\b/i;

// Email providers. Anchored to the start of the haystack so only the hostname
// (always the first token) matches — a page *about* mail does not trip it.
// NB: no bare `yandex`/`ya`/`rambler` here — those are whole portals, not mail
// hosts; their mailboxes live on `mail.<domain>` and stay covered by the generic
// `mail.` entry below plus EMAIL_PATH_RE.
const EMAIL_HOST_RE = /^(?:www\.)?(?:mail\.google|gmail|googlemail|mymail|outlook|hotmail|live|msn|yahoo|ymail|proton|protonmail|tutanota|fastmail|zoho|gmx|aol|mail|inbox|imap|bk|list)\./i;
const EMAIL_PATH_RE = /\/(?:mail|webmail|inbox|compose|messages?)\/(?:inbox|compose|u\/|#|\d)|[?#]inbox\b/i;

// Government / tax / benefits.
const GOV_TAX_RE = /(^|\.)(irs\.gov|ssa\.gov|hmrc\.gov\.uk|gov\.uk|gosuslugi|nalog\.ru|pfrf\.ru|fns\.ru)\b|\/(?:tax|taxes|irs|hmrc|benefits|social-security)\b/i;

// Healthcare portals.
const HEALTH_RE = /\/(?:medical|healthcare|patient|mychart|appointments)\b|(^|\.)(mychart|myhealth|patient-portal)\b/i;

/**
 * Categorized deny-list rules. `id` is stable and machine-readable; `patterns`
 * are tested against a decoded URL haystack (hostname + path + query + hash).
 * @type {ReadonlyArray<{id: string, label: string, patterns: readonly RegExp[]}>}
 */
export const SENSITIVE_DOMAIN_RULES = Object.freeze([
  Object.freeze({ id: 'banking', label: 'Banking & payments', patterns: Object.freeze([/bank/i, /banking/i, /\/bank/i, FINANCE_BRAND_RE]) }),
  Object.freeze({ id: 'crypto', label: 'Crypto & wallets', patterns: Object.freeze([/coinbase|binance|kraken|crypto\.com|wallet/i, CRYPTO_BRAND_RE]) }),
  Object.freeze({ id: 'password-manager', label: 'Password managers', patterns: Object.freeze([/1password|bitwarden|lastpass|dashlane|keepersecurity/i, PASSWORD_MANAGER_RE]) }),
  Object.freeze({ id: 'email', label: 'Email', patterns: Object.freeze([EMAIL_HOST_RE, EMAIL_PATH_RE]) }),
  Object.freeze({ id: 'government-tax', label: 'Government & tax', patterns: Object.freeze([GOV_TAX_RE]) }),
  Object.freeze({ id: 'medical', label: 'Medical & health', patterns: Object.freeze([HEALTH_RE]) }),
  Object.freeze({ id: 'credentials', label: 'Credential surfaces', patterns: Object.freeze([/\/password/i]) }),
  Object.freeze({ id: 'payments', label: 'Checkout & billing', patterns: Object.freeze([/\/billing/i, /\/checkout/i, /\/payments?/i]) }),
]);

/** Flat pattern list for callers that only need a boolean test. */
export const SENSITIVE_URL_PATTERNS = Object.freeze(
  SENSITIVE_DOMAIN_RULES.flatMap((rule) => rule.patterns),
);

function decodePart(value = '') {
  const normalized = String(value || '').replace(/\+/g, ' ');
  try {
    return decodeURIComponent(normalized);
  } catch {
    return normalized.replace(/%([0-9a-fA-F]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  }
}

/** Build the same decoded haystack the operation gate uses for its tests. */
export function sensitiveUrlHaystack(url = '') {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return '';
  }
  const raw = [parsed.hostname, parsed.pathname, parsed.search, parsed.hash];
  return [...raw, ...raw.map(decodePart)].join(' ');
}

/** Category ids whose rules match the URL (empty when nothing matches). */
export function sensitiveDomainCategories(url = '') {
  const haystack = sensitiveUrlHaystack(url);
  if (!haystack) return [];
  return SENSITIVE_DOMAIN_RULES
    .filter((rule) => rule.patterns.some((pattern) => pattern.test(haystack)))
    .map((rule) => rule.id);
}

/** True when the URL is on the deny-list. Unparseable URLs count as denied. */
export function isSensitiveDomainUrl(url = '') {
  if (!String(url || '').trim()) return false;
  const haystack = sensitiveUrlHaystack(url);
  if (!haystack) return true;
  return SENSITIVE_URL_PATTERNS.some((pattern) => pattern.test(haystack));
}
