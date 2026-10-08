#!/usr/bin/env bash
# pack-crx.sh — sign the built extension with our own key (self-hosted / enterprise channel).
#
# Chrome Web Store builds do NOT need this: upload the .zip and Google signs it.
# This produces a .crx3 for policy-based (ExtensionInstallForcelist) or off-store
# distribution, plus the .pem key that generated it.
#
#   bash release/scripts/pack-crx.sh
#
# Key handling: the first run creates release/keys/hermes-browser-extension.pem.
# BACK THAT FILE UP OFFLINE. If it is lost, existing installs cannot be updated and the
# extension ID changes. Never commit it (it is git-ignored by the build's exclude rules and
# by release/keys/.gitignore).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="$(cd "$HERE/.." && pwd)"
DIST="$RELEASE_DIR/dist"
UNPACKED="$DIST/unpacked"
KEYS="$RELEASE_DIR/keys"
KEY="$KEYS/hermes-browser-extension.pem"

if [ ! -d "$UNPACKED" ]; then
  echo "pack-crx: no $UNPACKED — run build-release.sh first" >&2
  exit 2
fi

# Locate a Chromium-family binary.
CHROME="${CHROME_BIN:-}"
if [ -z "$CHROME" ]; then
  for candidate in \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
    "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
    "/usr/bin/google-chrome" "/usr/bin/chromium" "/usr/bin/chromium-browser"
  do
    if [ -x "$candidate" ]; then CHROME="$candidate"; break; fi
  done
fi
[ -n "$CHROME" ] || { echo "pack-crx: no Chrome/Chromium found (set CHROME_BIN)" >&2; exit 2; }
echo "pack-crx: using $CHROME"

PY=""
for candidate in python python3 py; do
  command -v "$candidate" >/dev/null 2>&1 && { PY="$candidate"; break; }
done
[ -n "$PY" ] || { echo "pack-crx: no python interpreter found" >&2; exit 2; }

# Native tools do not understand MSYS /c/... paths; hand them Windows paths.
native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

mkdir -p "$KEYS"
# Pack with a scratch profile so a running Chrome instance cannot swallow the flags.
PROFILE="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/hermes-crx-profile")"
mkdir -p "$PROFILE"

PACK_ARGS=("--pack-extension=$(cygpath -w "$UNPACKED" 2>/dev/null || echo "$UNPACKED")")
if [ -f "$KEY" ]; then
  echo "pack-crx: signing with existing key $KEY"
  PACK_ARGS+=("--pack-extension-key=$(cygpath -w "$KEY" 2>/dev/null || echo "$KEY")")
else
  echo "pack-crx: no key yet — Chrome will create one next to the packed dir"
fi

set +e
"$CHROME" --user-data-dir="$(cygpath -w "$PROFILE" 2>/dev/null || echo "$PROFILE")" \
  --no-first-run --no-default-browser-check --disable-gpu "${PACK_ARGS[@]}" >/dev/null 2>&1
PACK_STATUS=$?
set -e
rm -rf "$PROFILE" 2>/dev/null || true

# Chrome writes <dirname>.crx / <dirname>.pem next to the packed directory.
PRODUCED_CRX="$DIST/unpacked.crx"
PRODUCED_PEM="$DIST/unpacked.pem"
if [ -f "$PRODUCED_PEM" ] && [ ! -f "$KEY" ]; then
  mv "$PRODUCED_PEM" "$KEY"
  echo "pack-crx: generated key -> $KEY  (back it up offline, never commit it)"
fi

if [ -f "$PRODUCED_CRX" ]; then
  VERSION="$("$PY" -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$(native "$UNPACKED/manifest.json")" 2>/dev/null || echo 0.0.0)"
  mv "$PRODUCED_CRX" "$DIST/hermes-browser-extension-$VERSION.crx"
  CRX="$DIST/hermes-browser-extension-$VERSION.crx"
  echo "pack-crx: ok -> $CRX"
  "$PY" - "$(native "$CRX")" <<'PY'
import hashlib, sys, json, os
path = sys.argv[1]
data = open(path, "rb").read()
if not data.startswith(b"Cr24"):
    raise SystemExit("pack-crx: output is not a CRX file")
version = int.from_bytes(data[4:8], "little")
header_len = int.from_bytes(data[8:12], "little")
header = data[12:12 + header_len]
print(f"pack-crx: crx version={version} sha256={hashlib.sha256(data).hexdigest()}")
# The CRX3 header embeds the SubjectPublicKeyInfo DER of the signing key; the extension ID
# is the first 16 bytes of its SHA-256, hex digits remapped 0-f -> a-p.
idx = header.find(b"\x30\x82")
ext_id = None
if idx != -1:
    der_len = int.from_bytes(header[idx + 2:idx + 4], "big") + 4
    der = header[idx:idx + der_len]
    ext_id = "".join(chr(ord("a") + int(c, 16)) for c in hashlib.sha256(der).hexdigest()[:32])
    print(f"pack-crx: extension id={ext_id}")
with open(os.path.join(os.path.dirname(path), "crx-manifest.json"), "w", encoding="utf-8") as handle:
    json.dump({"crx": os.path.basename(path), "crxVersion": version,
               "sha256": hashlib.sha256(data).hexdigest(), "extensionId": ext_id}, handle, indent=2)
PY
else
  echo "pack-crx: FAILED (chrome exit $PACK_STATUS) — .crx not produced." >&2
  echo "  Close Chrome and re-run, or just ship the .zip: the store signs it for you." >&2
  exit 1
fi
