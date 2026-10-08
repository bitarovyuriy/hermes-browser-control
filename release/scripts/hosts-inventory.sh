#!/usr/bin/env bash
# hosts-inventory.sh — enumerate every outbound host referenced by the extension bundle.
#
# Purpose: make the privacy-policy claims auditable. If a host shows up here that is
# not documented in release/store/privacy-policy.md (section 3), either document it or
# remove the code — do not ship a policy that contradicts the bundle.
#
# Usage:  bash release/scripts/hosts-inventory.sh [source-dir]
# Default source dir: the shipped extension (release/../extension), i.e. only code that
# actually goes into the package — not the repo's tests and docs.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="$(cd "$HERE/.." && pwd)"
SRC="${1:-$RELEASE_DIR/../extension}"
cd "$SRC"

native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

echo "== source: $SRC"
EXCLUDES=(--exclude-dir=release --exclude-dir=node_modules --exclude-dir=.git
          --exclude-dir=dist --exclude-dir=build --exclude-dir=out --exclude-dir=.worktrees
          --exclude-dir=test-results --exclude-dir=playwright-report --exclude-dir=coverage
          --exclude-dir=tests)

echo
echo "== outbound hosts referenced in shipped code =="
grep -rhoE 'https?://[a-zA-Z0-9._:-]+' \
  --include='*.js' --include='*.mjs' --include='*.html' --include='*.json' \
  "${EXCLUDES[@]}" . 2>/dev/null \
  | sed -E 's#(https?://[^/]+).*#\1#' \
  | sort | uniq -c | sort -rn

echo
echo "== tracking / analytics SDK markers (expect: none) =="
# Match vendor endpoints and SDK handles, not bare words: "amplitude" is also an SVG attribute
# and a variable name, and a false positive here would block the release gate.
MARKERS='google-analytics\.com|googletagmanager\.com|gtag\s*\(|posthog\.com|us\.posthog|mixpanel\.com|api\.segment\.io|cdn\.segment\.com|amplitude\.com|api\.amplitude|amplitude-js|sentry\.io|@sentry/|browser\.sentry|bugsnag\.com|hotjar\.com|matomo\.(js|org)|piwik\.|plausible\.io|umami\.is|fullstory\.com|newrelic\.com|nr-loader|datadog-rum|heapanalytics'
if grep -rinE "$MARKERS" \
  --include='*.js' --include='*.mjs' --include='*.html' --include='*.json' \
  "${EXCLUDES[@]}" . 2>/dev/null; then
  echo "!! markers found — document or remove them before shipping"
  exit 1
else
  echo "none"
fi

echo
echo "== declared permissions =="
MANIFEST="${MANIFEST:-$SRC/manifest.json}"
python -c "import json,sys;m=json.load(open(sys.argv[1]));print('permissions:',m.get('permissions'));print('host_permissions:',m.get('host_permissions'))" "$(native "$MANIFEST")" 2>/dev/null \
  || echo "(manifest.json not found at $MANIFEST)"
