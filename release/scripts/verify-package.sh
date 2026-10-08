#!/usr/bin/env bash
# verify-package.sh — run verify_package.py over the built artifacts.
#
#   bash release/scripts/verify-package.sh                       # latest zip + unpacked/ in dist/
#   bash release/scripts/verify-package.sh release/dist/foo.zip  # a specific artifact

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="$(cd "$HERE/.." && pwd)"
DIST="$RELEASE_DIR/dist"

PY=""
for candidate in python python3 py; do
  if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
done
[ -n "$PY" ] || { echo "verify-package: no python interpreter found" >&2; exit 2; }

# Native tools do not understand MSYS /c/... paths; hand them Windows paths.
native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

TARGETS=("$@")
if [ "${#TARGETS[@]}" -eq 0 ]; then
  for candidate in "$DIST"/*.zip; do
    [ -e "$candidate" ] && TARGETS+=("$candidate")
  done
  [ -d "$DIST/unpacked" ] && TARGETS+=("$DIST/unpacked")
fi

if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "verify-package: nothing to verify — run build-release.sh first" >&2
  exit 2
fi

NATIVE_TARGETS=()
for target in "${TARGETS[@]}"; do
  NATIVE_TARGETS+=("$(native "$target")")
done

"$PY" "$(native "$HERE/verify_package.py")" "${NATIVE_TARGETS[@]}"
