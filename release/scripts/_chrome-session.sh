#!/usr/bin/env bash
# _chrome-session.sh — shared helper for scripts that need a Chrome session with the
# packaged extension. SOURCE this file, do not execute it.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/_chrome-session.sh"
#   start_chrome_session          # exports CHROME_PID, WS_URL, CHROME, NODE, UNPACKED
#   ... use "$NODE" x.cjs "$WS_URL" "$(native "$UNPACKED")" ...
#   stop_chrome_session           # also runs on EXIT
#
# Why the CDP dance: Chrome >= 137 (fully from 142) ignores the --load-extension
# command-line flag in branded builds. The supported way to load an unpacked extension is
# the CDP `Extensions.loadUnpacked` command, which requires the browser to start with
# --enable-unsafe-extension-debugging. Chromium and Chrome for Testing still support
# --load-extension, so `start_chrome_session --legacy` is available as a fallback.

set -uo pipefail

CS_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="$(cd "$CS_HERE/.." && pwd)"
UNPACKED="${UNPACKED:-$RELEASE_DIR/dist/unpacked}"
# A fresh port per run: a Chrome that outlives its kill still holds the old one.
PORT="${PORT:-$((9300 + RANDOM % 600))}"
WS_MODULE="${WS_MODULE:-ws}"

native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

cs_find_chrome() {
  [ -n "${CHROME_BIN:-}" ] && { printf '%s' "$CHROME_BIN"; return; }
  for candidate in \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
    "/usr/bin/google-chrome" "/usr/bin/chromium" "/usr/bin/chromium-browser"
  do
    [ -x "$candidate" ] && { printf '%s' "$candidate"; return; }
  done
}

cs_find_node() {
  [ -n "${NODE_BIN:-}" ] && { printf '%s' "$NODE_BIN"; return; }
  command -v node 2>/dev/null && return
  for candidate in /c/Users/*/AppData/Local/hermes/tools/node-*/node.exe; do
    [ -x "$candidate" ] && { printf '%s' "$candidate"; return; }
  done
}

CHROME="$(cs_find_chrome)"
[ -n "$CHROME" ] || { echo "chrome-session: no Chrome/Chromium found (set CHROME_BIN)" >&2; exit 3; }
NODE="$(cs_find_node)"
[ -n "$NODE" ] || { echo "chrome-session: no node found (set NODE_BIN)" >&2; exit 3; }

CHROME_PID=""
CS_PROFILE=""

chrome_session_cleanup() {
  if [ -n "$CHROME_PID" ]; then
    taskkill //F //T //PID "$CHROME_PID" >/dev/null 2>&1 || kill "$CHROME_PID" 2>/dev/null || true
    # Wait (bounded) for the debug port to be released so the next run can bind it.
    for _wait in $(seq 1 20); do
      curl -s --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 || break
      sleep 0.5
    done
    CHROME_PID=""
  fi
  [ -n "$CS_PROFILE" ] && { sleep 1; rm -rf "$CS_PROFILE" 2>/dev/null || true; }
}

# start_chrome_session [--legacy] [--headed]
start_chrome_session() {
  local legacy=0 headed=0
  for arg in "$@"; do
    case "$arg" in
      --legacy) legacy=1 ;;
      --headed) headed=1 ;;
    esac
  done

  [ -d "$UNPACKED" ] || { echo "chrome-session: no $UNPACKED — run build-release.sh first" >&2; exit 2; }

  CS_PROFILE="$(mktemp -d)"
  local flags=(--user-data-dir="$(native "$CS_PROFILE")"
               --remote-debugging-port="$PORT"
               --no-first-run --no-default-browser-check --disable-gpu)
  if [ "$legacy" = "1" ]; then
    flags+=(--load-extension="$(native "$UNPACKED")"
            --disable-extensions-except="$(native "$UNPACKED")")
  else
    flags+=(--enable-unsafe-extension-debugging)
  fi
  [ "$headed" = "1" ] && flags+=(--window-size=1280,800) || flags+=(--headless=new)

  echo "chrome-session: chrome=$CHROME profile=$CS_PROFILE port=$PORT legacy=$legacy" >&2
  "$CHROME" "${flags[@]}" about:blank >/dev/null 2>&1 &
  CHROME_PID=$!
  trap chrome_session_cleanup EXIT

  WS_URL=""
  for _attempt in $(seq 1 60); do
    WS_URL="$("$NODE" -e "
fetch('http://127.0.0.1:$PORT/json/version')
  .then((r) => r.json())
  .then((d) => console.log(d.webSocketDebuggerUrl || ''))
  .catch(() => console.log(''));
" 2>/dev/null)"
    [ -n "$WS_URL" ] && break
    sleep 0.5
  done
  if [ -z "$WS_URL" ]; then
    echo "chrome-session: Chrome never exposed a DevTools endpoint on port $PORT" >&2
    exit 2
  fi
  export WS_URL
}

stop_chrome_session() { chrome_session_cleanup; }
