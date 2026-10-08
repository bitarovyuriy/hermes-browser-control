#!/usr/bin/env bash
# build-release.sh — wrapper around build_release.py.
#
#   bash release/scripts/build-release.sh                     # zip + unpacked, version from release/VERSION
#   bash release/scripts/build-release.sh --unpacked-only     # just the load-unpacked tree
#   bash release/scripts/build-release.sh --crx               # zip, then sign a .crx with release/keys/
#   bash release/scripts/build-release.sh --source /path/to/ext --version 0.5.0
#   bash release/scripts/build-release.sh --allow-dirty       # test build from an uncommitted tree
#
# Works against any extension source directory, so the same script packages the MVP
# build no matter which repo it lands in.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="$(cd "$HERE/.." && pwd)"

PY=""
for candidate in python python3 py; do
  if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
done
if [ -z "$PY" ]; then
  echo "build-release: no python interpreter found (tried python, python3, py)" >&2
  exit 2
fi

CRX=0
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--crx" ]; then CRX=1; else ARGS+=("$arg"); fi
done

# Native tools do not understand MSYS /c/... paths; hand them Windows paths.
native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

echo "== package build =="
"$PY" "$(native "$HERE/build_release.py")" ${ARGS[@]+"${ARGS[@]}"}

if [ "$CRX" = "1" ]; then
  echo
  echo "== signed crx (self-hosted channel) =="
  bash "$HERE/pack-crx.sh"
fi

echo
echo "== outputs =="
ls -la "$RELEASE_DIR/dist" 2>/dev/null || true
