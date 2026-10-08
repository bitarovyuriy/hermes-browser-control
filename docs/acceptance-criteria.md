# Acceptance criteria → evidence

Task: *Implement CDP browser control via chrome.debugger and content-script fallback*.

Every line below is produced by a real run, not by reading the code.

| Acceptance criterion | Evidence |
| --- | --- |
| The agent opens a tab, navigates, clicks, types, and reads the DOM | `test/e2e/e2e.mjs`, checks 6–22: the harness asks the worker's own surface (`hermes/session` → `openTab`) for the tab (created + grouped + armed), then runs `readDom`, `type`, `click`, `getText`, `evaluate`, and the page's own click handler proves the input landed (`#count` goes `0 → 1 → 2`). |
| Artifacts are delivered to the runtime | checks 23–33: `Page.captureScreenshot` returns a real 1084×609 PNG (written to `test/e2e/artifacts/screenshot.png`), console lines captured through `Runtime.consoleAPICalled`, `Network.getResponseBody` returns `{"value":"hermes-payload","ok":true}`, `DOM.getDocument`+`DOM.getOuterHTML` produce an 88 392-char DOM artifact, and the sink receives `["dom","text","screenshot","console","response"]` — verified both in the ring buffer and at the relay adapter (`globalThis.hermesRelay.sent`). |
| Kill-switch halts all activity immediately; tab access can be revoked live | checks 34–42: after `revoke` the revoked tab returns `tab-not-allowed` and is detached; after the kill switch every command returns `killed`, `chrome.debugger.getTargets()` shows no live agent attach, the on-page HUD is hidden, and the state stays terminal until explicitly cleared. |
| Banner-free fallback path works for non-CDP commands | checks 12–16: `readDom`, `type`, `click`, `getText` all return `path: "content"` and the controller snapshot shows `attached: []` — the debugger is never attached, so no infobar is shown. |
| The control page is a working human stop | checks 5, 11, 38–42: the page boots as a real Chrome tab over `chrome.runtime.getURL('control/control.html')`, renders the live session state (`#stateArmed=armed`), and its kill switch halts the agent (`killed`), detaches every debugger session, hides the on-page HUD, and stays terminal. |

## How to reproduce

    cd <path-to-this-repo>
    npm test          # 60 unit + 11 security checks, no browser
    npm run test:e2e  # 42 checks against a real Chrome 154 with the extension loaded,
                      # driven over the worker's own message surface

Last verified run: 2026-10-08, Chrome/154.0.8037.57 (puppeteer cache),
`42/42 checks passed`, report at `test/e2e/artifacts/last-run.json`.

## Unit suite coverage (54 CDP checks + 6 native-messaging)

* `access-policy` — mode semantics, fail-closed on junk input (8)
* `session-state` — arm/pause/resume/kill/clearKill, sticky revocation, group gating, revisions (10)
* `cdp-methods` — allowlist completeness, refusal of `Storage.*`/`Browser.*`/`Target.*`, param validation and defaults (6)
* `command-router` — content vs CDP routing, `forceCdp`, no-CDP verbs (7)
* `artifacts` — PNG IHDR parsing, base64 never retained, bounded ring buffer, sink failure handling (6)
* `controller` (fake chrome API) — unarmed refusal, banner-free path never attaches, allowlist enforcement at the debugger boundary, tab grant, live revocation + detach, kill switch terminal + detach, pause/resume, console + network event collection, group mode, CDP click event sequence, responseText artifact (10)
