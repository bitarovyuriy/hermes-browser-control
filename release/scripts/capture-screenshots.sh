#!/usr/bin/env bash
# capture-screenshots.sh — render the packaged extension's own pages to exact-size PNGs.
#
# Captures proof-of-render images (and, once a runtime is connected, the store screenshots).
# See release/assets/ASSET-MANIFEST.md for why the current images are proof, not store art.
#
#   bash release/scripts/capture-screenshots.sh                       # default set
#   bash release/scripts/capture-screenshots.sh control/control.html=1280x800
#   OUT=release/assets/out bash release/scripts/capture-screenshots.sh
#
# Exit 0 = every capture came out at exactly the requested pixel size.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_chrome-session.sh
source "$HERE/_chrome-session.sh"

OUT="${OUT:-$RELEASE_DIR/assets/render-proof}"
SPECS=("$@")
if [ "${#SPECS[@]}" -eq 0 ]; then
  SPECS=("control/control.html=1280x800" "control/popup.html=336x432")
fi

start_chrome_session

STATUS=1
RESULT="$("$NODE" "$(native "$HERE/capture-screenshots.cjs")" "$WS_URL" "$(native "$UNPACKED")" "$(native "$OUT")" "${SPECS[@]}" 2>&1)"
echo "$RESULT"
printf '%s' "$RESULT" | grep -q '"ok":true' && STATUS=0

if [ "$STATUS" = "0" ]; then
  echo
  echo "capture-screenshots: ok -> $OUT"
else
  echo
  echo "capture-screenshots: FAILED — see the JSON above" >&2
fi
exit $STATUS
