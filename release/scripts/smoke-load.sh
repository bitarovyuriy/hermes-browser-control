#!/usr/bin/env bash
# smoke-load.sh — prove the packaged extension actually loads in Chrome, and that its own
# pages render inside the extension origin.
#
# This is the loadability gate: it loads release/dist/unpacked/ into a throwaway profile
# through the CDP Extensions.loadUnpacked command (Chrome >= 137 removed the
# --load-extension flag), then opens the control page in the extension origin and reads
# document state back. A missing file, a broken manifest or a CSP violation fails here.
#
#   bash release/scripts/smoke-load.sh                 # headless (default)
#   bash release/scripts/smoke-load.sh --headed        # visible window (debugging only)
#   bash release/scripts/smoke-load.sh --legacy        # Chromium/Chrome-for-Testing path
#   PORT=9333 bash release/scripts/smoke-load.sh
#
# Writes release/dist/smoke-load-result.json.
# Exit 0 = loaded and rendered, 2 = failed, 3 = missing Chrome/node.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_chrome-session.sh
source "$HERE/_chrome-session.sh"

HEADED=0
LEGACY=0
for arg in "$@"; do
  case "$arg" in
    --headed) HEADED=1 ;;
    --legacy) LEGACY=1 ;;
  esac
done

SESSION_ARGS=()
[ "$HEADED" = "1" ] && SESSION_ARGS+=(--headed)
[ "$LEGACY" = "1" ] && SESSION_ARGS+=(--legacy)
start_chrome_session ${SESSION_ARGS[@]+"${SESSION_ARGS[@]}"}

if [ "$LEGACY" = "1" ]; then
  # No Extensions.loadUnpacked on this path: the flag did the loading, so just probe the
  # pages of whatever extension id the profile ended up with.
  echo "smoke-load: legacy mode — probing pages of the loaded extension"
  RESULT="$("$NODE" -e "
const WS_MODULE = process.env.WS_MODULE || 'ws';
const WebSocket = require(WS_MODULE);
const ws = new WebSocket(process.argv[1]);
let id = 1; const pending = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => { const i = id++;
  pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p, ...(s ? { sessionId: s } : {}) })); });
ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (!pending.has(m.id)) return;
  const h = pending.get(m.id); pending.delete(m.id); m.error ? h.rej(new Error(m.error.message)) : h.res(m.result); });
ws.on('error', (e) => { console.log(JSON.stringify({ ok: false, error: e.message })); process.exit(2); });
ws.on('open', async () => {
  const { targetInfos } = await send('Target.getTargets');
  const own = (targetInfos || []).filter((t) => /^chrome-extension:\/\//.test(t.url));
  console.log(JSON.stringify({ ok: own.length > 0, targets: own.map((t) => t.url) }));
  process.exit(own.length > 0 ? 0 : 2);
});
" "$WS_URL" 2>&1)"
  echo "$RESULT"
  printf '%s' "$RESULT" | grep -q '"ok":true' || exit 2
else
  RESULT="$("$NODE" "$(native "$HERE/load-extension.cjs")" "$WS_URL" "$(native "$UNPACKED")" control/control.html,control/popup.html 2>&1)"
  echo "$RESULT"
  printf '%s' "$RESULT" | grep -q '"ok":true' || exit 2
fi

mkdir -p "$RELEASE_DIR/dist"
printf '%s' "$RESULT" > "$RELEASE_DIR/dist/smoke-load-result.json"
echo
echo "smoke-load: result written to release/dist/smoke-load-result.json"
