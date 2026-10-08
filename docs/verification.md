# Verification — merged MVP, rework 0.3.0

Re-run on 2026-10-08 22:3x +0300, Windows host, Chrome for Testing 154 (puppeteer cache).
Reproduce with `npm run test:all` inside this directory (test + scan:secrets +
test:e2e + test:relay), plus `npm run test:relay:native` for the native-messaging
install (it writes HKCU + %LOCALAPPDATA%, so it is deliberately not in `test:all`,
and it uninstalls what it wrote). All four gates pass.

## What changed in this rework

* **The side panel is gone.** `side_panel` and the `sidePanel` permission are out of
  the manifest; the page is now the extension's **control page**, reached by the toolbar
  action (`action.default_popup` → `control/popup.html`, a small popup next to the icon)
  and also available as the **options page** (`options_ui`, `open_in_tab` →
  `control/control.html`). Both live in `control/`
  (`control/control.html|js|css` — the old `panel/` name was left behind with the
  panel). Driving the browser never needed a panel: the Hermes runtime reaches the
  worker over the loopback relay, and the page is the human stop only — live state,
  the relay phase, Pause / Resume / Reconnect, Kill switch / Clear kill.
* **The command box, the relay form, the tab grant list and the artifact feed are
  gone from the page** (and `src/panel-commands.js` with them: the command-line
  parser existed only for that box). Pairing for a human is the native host's job;
  the manual `hbr1:` string survives as a message-surface action, which is what the
  harness and the runtime-side tooling use.
* **The E2E harness drives the worker's own surface** (`hermes/command` /
  `hermes/session` via `globalThis.__hermesTest.handleMessage`) instead of typing
  into the page — the same entry point the relay uses. The only page it still
  drives is the control page, for the human-stop checks (state read + kill click).
* The harness Chrome now **kills its own transport session first**: this machine has
  a native host registered for this extension id, so the worker's boot-time pair
  lands on the user's live relay and auto-arms `agent-all`. The harness drops that
  session and repoints its transport at an unusable remote endpoint, so the test
  never disturbs the live relay and the only arm that happens is the one it asks for.

## Unit — `npm test` (60 = 54 CDP + 6 native-messaging, plus 11 security)

```
✔ mode list is the panel modes plus the self-service agent mode (7.9335ms)
✔ agent-all mode allows every tab (revocations are checked before the policy) (0.3461ms)
✔ active-tab mode allows only the pinned active tab (0.2019ms)
✔ active-tab mode falls back to the live active tab when nothing is pinned (0.1927ms)
✔ selected-tabs mode is exactly the granted set (0.2255ms)
✔ tab-group mode requires a real group id match (0.2216ms)
✔ fails closed on junk input (0.1933ms)
✔ describeMode is human readable (0.3088ms)
✔ the 1x1 fixture really is a PNG and its size is read from IHDR (2.1185ms)
✔ screenshots are normalized to metadata, never raw base64 (11.7744ms)
✔ the sink receives every artifact, and a broken sink never loses the record (5.647ms)
✔ the ring buffer is bounded and counts drops (2.9486ms)
✔ long text is truncated instead of blowing up the buffer (1.1391ms)
✔ unknown artifact kinds are rejected (0.9683ms)
✔ the CDP surface required by the task is allowlisted (1.6854ms)
✔ anything outside the allowlist is refused (0.5185ms)
✔ missing required params are refused (0.2215ms)
✔ defaults are applied and caller params win (0.2536ms)
✔ bad method / bad params shapes are refused (0.2654ms)
✔ every allowlisted entry declares its required params (0.2702ms)
✔ page-level verbs default to the banner-free content path (3.0461ms)
✔ CDP-only verbs always take the debugger path (0.5345ms)
✔ forceCdp moves a content-capable verb onto CDP (0.2391ms)
✔ verbs with no CDP implementation cannot be forced onto CDP (0.2052ms)
✔ unknown command and missing target are rejected (0.2118ms)
✔ screenshot and domSnapshot declare their artifact kinds (0.1668ms)
✔ the banner-free set covers the MVP verbs (0.2964ms)
✔ an unarmed controller refuses every command (2.5889ms)
✔ content path runs readDom without ever attaching the debugger (14.6682ms)
✔ CDP path attaches, forwards only allowlisted methods, and stores the screenshot (3.7054ms)
✔ the debugger is never handed a method outside the allowlist (1.2504ms)
✔ tabs outside the grant are refused (0.5051ms)
✔ revoking a tab live stops commands and detaches the debugger (8.0965ms)
✔ the kill switch halts everything at once and is terminal (1.8998ms)
✔ pause freezes commands without detaching (2.8299ms)
✔ console logs and network bodies are collected from CDP events (23.0588ms)
✔ tab-group mode grants exactly the grouped tabs (1.2873ms)
✔ cdp click forwards a real mouse press/release pair at the element centre (0.5538ms)
✔ the content path is used for responseText and the body lands in the store (0.7918ms)
✔ the unpacked extension id is Chrome own derivation, pinned to a measurement (2.1172ms)
✔ the id derivation is separator-agnostic but case-sensitive (0.3176ms)
✔ the registry keys are per-user for the families we can prove work (1.5423ms)
✔ the manifest names the launcher and only the extension origin (0.2029ms)
✔ the launcher pins absolute paths, fails loudly and stays parsed as CRLF (0.2921ms)
✔ install / check / uninstall are idempotent and need no real registry (15.2009ms)
✔ native-messaging framing survives chunk boundaries (0.8024ms)
✔ relay discovery prefers an explicit URL, then the rendezvous file, then the port (4.7639ms)
✔ ticket values are redacted out of the log sink (2.4395ms)
✔ the host pairs against a live relay and never logs the ticket (47.7603ms)
✔ the host refuses a bad mode, a non-ticket answer and an unreachable relay (17.3601ms)
✔ the vendored host behaves exactly like the transport workstream host (661.3413ms)
✔ an unarmed session rejects everything (1.0108ms)
✔ arming grants exactly the selected tabs (0.2855ms)
✔ pause stops commands, resume restores them (0.1714ms)
✔ kill is terminal and outranks every other state (0.4164ms)
✔ clearKill is the only way back, and it requires a fresh arm (0.1953ms)
✔ live revocation drops the tab immediately and bumps the revision (0.8933ms)
✔ revoking the pinned active tab narrows active-tab mode (0.1683ms)
✔ tab-group mode needs the group id to match (0.2513ms)
✔ arm rejects an unknown mode (0.4456ms)
ℹ tests 60
ℹ suites 0
ℹ pass 60
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1014.645
✔ deny-list blocks email providers (3.2301ms)
✔ deny-list blocks banking, crypto, password managers, health, tax, checkout (0.6136ms)
✔ deny-list leaves ordinary sites alone (0.208ms)
✔ evaluateTargetUrl fails closed on a bad or unparseable target (0.32ms)
✔ gate allows a fresh operation on an ordinary site (0.2825ms)
✔ gate denies a sensitive target even with a fresh lease (0.1699ms)
✔ gate fails closed on a stale profile (0.1859ms)
✔ gate fails closed on a stale port (0.1489ms)
✔ gate fails closed on a stale document generation (0.1668ms)
✔ gate fails closed when the lease, the live binding, or the profile/port is missing (0.2535ms)
✔ live admission guard blocks commands on a denied page (MVP enforcement point) (0.8897ms)
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 124.1325
```

## `npm run scan:secrets`

```
scan-secrets: scanned 79 files under %USERPROFILE%\projects\hermes-browser-extension\mvp
scan-secrets: OK — no secret-shaped literals found.
```

## `npm run test:e2e` — real Chrome, driven over the worker's message surface

```
chrome: %USERPROFILE%\.cache\puppeteer\chrome\win64-154.0.8037.57\chrome-win64\chrome.exe
browser: Chrome/154.0.8037.57
PASS  extension service worker target found  — nlndgnbmggihcbifhbdhmdaecmhbnhml (Chrome/154.0.8037.57)
PASS  service worker exposes the controller test surface
PASS  service worker keep-alive alarm is registered  — ["hermes-keepalive"]
PASS  the harness keeps its own transport off the live relay  — phase=fatal
PASS  the control page boots and talks to the service worker  — control page tab #612541977
PASS  the agent opens its own tab over the session surface  — {"ok":true,"tabId":612541978}
PASS  the agent tab is a real Chrome tab  — [{"id":612541978,"groupId":750833056,"url":"http://127.0.0.1:51053/"}]
PASS  the agent tab is placed in its own tab group  — groupId=750833056
PASS  session is armed in tab-group mode after opening the tab  — {"armed":true,"mode":"tab-group"}
PASS  the content script is live in the agent tab  — {"ok":true,"url":"http://127.0.0.1:51053/","title":"Hermes CDP fixture","readyState":"complete"}
PASS  the control page renders the live session state  — #stateArmed=armed
PASS  readDom succeeds on the banner-free path  — {"ok":true,"url":"http://127.0.0.1:51053/","title":"Hermes CDP fixture","readyState":"complete","html":"<html lang=\"en\"><head>\n    <meta charset=\"utf-8\">\n    <title>Hermes CDP fixture</title>\n    <style>\n      body { font: 14px/1.4 -apple-system, \"Segoe UI\", sans-serif; margin: 16px; }\n      #box { margin-top: 12px; padding: 8px; border: 1px solid #ccc; }\n      button, input { font: in…[+1078 chars]
PASS  no debugger is attached for the banner-free path  — []
PASS  type (content path) succeeds  — {"ok":true,"selector":"#name","value":"Ada Lovelace"}
PASS  click (content path) succeeds  — {"ok":true,"selector":"#inc","tag":"button","text":"increment"}
PASS  the banner-free click really hit the page handler  — {"ok":true,"selector":"#count","text":"1"}
PASS  click (forced CDP) succeeds  — {"selector":"#inc","tag":"button","x":55,"y":89}
PASS  the debugger is attached on the CDP path  — [612541978]
PASS  chrome.debugger reports the tab as attached  — [null,612541977,612541978]
PASS  the CDP click really hit the page handler  — {"ok":true,"selector":"#count","text":"2"}
PASS  type (forced CDP, insertText) succeeds  — {"selector":"#name","value":"Grace Hopper"}
PASS  Runtime.evaluate reads the typed value back  — {"value":"Grace Hopper"}
PASS  Page.captureScreenshot returns a real PNG  — {"bytes":15923,"width":1084,"height":609,"png":true,"digest":"a26c9f6d9c17a0eb"}
PASS  the screenshot artifact is written to disk  — %USERPROFILE%\projects\hermes-browser-extension\mvp\test\e2e\artifacts\screenshot.png
PASS  console logs are captured through Runtime.consoleAPICalled  — HERMES_E2E_CLICK 1 | HERMES_E2E_CLICK 2
PASS  response text is captured through Network.*  — [{"requestId":"28712.3","url":"http://127.0.0.1:51053/data.json","status":200,"mimeType":"application/json","fromCache":false,"at":1791487545233,"bodyFetched":true,"body":"{\"value\":\"hermes-payload\",\"ok\":true}"}]
PASS  the response body artifact holds the real payload  — [{"url":"http://127.0.0.1:51053/data.json","status":200,"text":"{\"value\":\"hermes-payload\",\"ok\":true}"}]
PASS  DOM.getDocument + DOM.getOuterHTML produce a DOM artifact  — {"htmlLength":88392,"digest":"15eab0e5c00357d1"}
PASS  element badges are drawn on the page  — {"ok":true,"count":2,"selector":"button"}
PASS  the on-page agent layer is present in the target tab  — {"ok":true,"url":"http://127.0.0.1:51053/","title":"Hermes CDP fixture","readyState":"complete"}
PASS  artifacts are shipped to the runtime sink (relay adapter)  — ["dom","text","text","text","screenshot","console","response","dom"]
PASS  the artifact ring buffer holds every kind  — ["dom","text","screenshot","console","response"]
PASS  the artifact feed is served on the message surface  — 8 rows
PASS  a tab outside the agent tab group is refused  — {"ok":false,"code":"tab-not-allowed","message":"tab 612541979 is not in the agent's access set","revision":1}
PASS  live revocation stops commands on that tab  — {"ok":false,"code":"tab-not-allowed","message":"tab 612541978 was revoked by the user","revision":2}
PASS  revocation detaches the debugger from the revoked tab  — []
PASS  re-arming the tab restores access (selected-tabs mode)  — {"ok":true,"command":"readDom","path":"content","tabId":612541978,"result":{"ok":true,"url":"http://127.0.0.1:51053/","title":"Hermes CDP fixture","readyState":"complete","html":"<html lang=\"en\"><head>\n    <meta charset=\"utf-8\">\n    <title>Hermes CDP fixture</title>\n    <style>\n      body { font: 14px/1.4 -apple-system, \"Segoe UI\", sans-serif; margin: 16px; }\n      #box { margin-top: 12…[+110143 chars]
PASS  the kill switch refuses further commands immediately  — {"ok":false,"code":"killed","message":"agent killed by kill-switch","revision":4}
PASS  the kill switch detaches every debugger session  — {"attached":[],"killed":true}
PASS  chrome.debugger has no live attach after the kill switch  — still attached: [null,612541977]
PASS  the kill switch tears the on-page indicator down  — true
PASS  the kill switch stays terminal until explicitly cleared  — {"ok":false,"code":"killed","message":"agent killed by kill-switch","revision":4}

42/42 checks passed
report: %USERPROFILE%\projects\hermes-browser-extension\mvp\test\e2e\artifacts\last-run.json
```

## `npm run test:relay` — real Chrome + the real loopback relay

The session is established over the message surface (`hermes/relay` `settings` →
`pairingString`), then read back from the control page: the page renders the
`connected` phase it polls from the worker. The whole downstream suite
(navigate / readDom / screenshot over the relay, the deny-list, the freshness
lease, the no-ticket-leak checks) runs on that session, and Pause / Resume / Kill
are pressed on the control page as a human would.

```
chrome: %USERPROFILE%\.cache\puppeteer\chrome\win64-154.0.8037.57\chrome-win64\chrome.exe
relay: http://127.0.0.1:51897  (log %USERPROFILE%\projects\hermes-browser-extension\mvp\test\e2e\artifacts\relay.log)
browser: Chrome/154.0.8037.57
PASS  extension service worker found  — globalThis.__hermesTest present
PASS  the agent opens a tab before the relay connects  — {"ok":true,"tabId":1318962989,"groupId":1472704539}
PASS  the relay mints a one-time pairing ticket  — expiresIn=120000ms
PASS  the control page is open and booted  — control page tab #1318962990
PASS  pairing over the message surface reaches `connected`  — #relayPhase=connected
PASS  the worker transport agrees it is connected  — phase=connected
PASS  worker relay status snapshot  — {"phase":"connected","mode":"local","attempt":0,"sessionId":"7d64d005-6b7f-4581-a09f-21632f81b6eb","queueSize":0,"droppedFromQueue":0,"lastError":null,"hasTicket":true,"url":"ws://127.0.0.1:51897/browser/extension","everConnected":true,"clientId":"ext-dmzvclh3"}
PASS  no pairing string / ticket appears in the control page DOM or log  — chars=515
PASS  the pairing string is not folded into the worker settings  — {"mode":"local","port":51897,"baseUrl":""}
PASS  the worker reports a live session ticket from status()  — hasTicket=true
PASS  the relay snapshot reports listening / runtimePeers / outstandingTickets  — {"ok":true,"listening":true,"port":51897,"extension":{"clientId":"ext-dmzvclh3","mode":"local","sessionId":"7d64d005-6b7f-4581-a09f-21632f81b6eb","connectedAt":1791487550589,"remoteAddress":"127.0.0.1","protocolVersion":1},"runtimePeers":0,"outstandingTickets":0}
PASS  the relay snapshot sees the live extension session  — {"clientId":"ext-dmzvclh3","mode":"local","sessionId":"7d64d005-6b7f-4581-a09f-21632f81b6eb","connectedAt":1791487550589,"remoteAddress":"127.0.0.1","protocolVersion":1}
PASS  the relay reports a live extension session  — {"clientId":"ext-dmzvclh3","mode":"local","sessionId":"7d64d005-6b7f-4581-a09f-21632f81b6eb","connectedAt":1791487550589,"remoteAddress":"127.0.0.1","protocolVersion":1}
PASS  runtime -> relay -> extension round trip answers  — {"echo":{"hello":"runtime"},"at":1791487550900}
PASS  navigate over the relay succeeds  — {"ok":true,"command":"navigate","path":"content","tabId":1318962989,"result":{"url":"http://127.0.0.1:51895/page2","state":"navigating","loaded":true}}
PASS  the real Chrome tab navigated  — url=http://127.0.0.1:51895/page2
PASS  readDom over the relay returns the live DOM  — htmlLength=206
PASS  screenshot over the relay returns a real PNG  — bytes=11140
PASS  navigate over the relay reaches a real internet site  — {"url":"https://example.com/","loaded":true}
PASS  the live tab is on https://example.com/  — url=https://example.com/
PASS  the real page DOM is read back through CDP  — title="Example Domain" htmlLength=1974 readyState=complete
PASS  a screenshot of the real page is captured  — bytes=38825
PASS  the agent returns to the fixture page  — ok=true url=http://127.0.0.1:51895/page2 ""
PASS  the deny-list refuses a sensitive target over the relay  — {"code":"sensitive-domain","message":"The target is a sensitive domain (banking); operations here are blocked."}
PASS  the refused command never navigated the tab  — before=http://127.0.0.1:51895/page2 after=http://127.0.0.1:51895/page2
PASS  the deny-list refuses a sensitive target on the worker path too  — {"ok":false,"code":"sensitive-domain","message":"The target is a sensitive domain (payments); operations here are blocked.","command":"navigate","guard":{"decision":"deny","code":"sensitive_domain","reason":"The target is a sensitive domain (payments); operations here are blocked."}}
PASS  the armed session holds a connection lease  — {"profileId":"profile-dfdxokm4-muzxfkfr","port":51897,"documentGeneration":1}
PASS  the lease is bound to the live relay port  — lease.port=51897 relayPort=51897
PASS  a stale port under an armed session is refused, not re-targeted  — {"code":"stale-port","message":"Stale port: the lease was minted for port 51897 but the live connection is on port 1."}
PASS  a stale profile under an armed session is refused  — {"code":"stale-profile","message":"Stale profile: the lease was minted for \"profile-dfdxokm4-muzxfkfr\" but the live connection is \"someone-else\"."}
PASS  restoring the binding restores relay commands  — "ok"
PASS  no ticket value in storage or transport status  — keys=hermes.browser.profileId,hermes.relay.settings
PASS  the relay log carries no ticket value  — bytes=12565
PASS  the control page pause button pauses the transport  — phase=paused
PASS  a paused transport has no live extension session at the relay  — null
PASS  the control page resume button re-arms the transport, but the spent ticket cannot reconnect it  — phase=reconnecting
PASS  the transport reconnects with a fresh pairing string  — phase=connected
PASS  the control page kill switch refuses commands at the extension immediately  — {"ok":false,"code":"killed","message":"agent killed by kill-switch","revision":7}
PASS  the control page kill switch also tears the transport session down  — phase=fatal
PASS  the relay has no live extension session after the kill switch  — {"code":"no_extension","message":"no extension connected"}
PASS  the relay reports the extension session gone  — null

41/41 checks passed
```

## Control page redesign (monochrome, 0.3.0)

The page is now black on white with two greys and no cards: rows separated by hairline rules,
one segmented control grid, a monospaced log. Both entries (toolbar popup and options page)
load the same markup and CSS.

| Check | Result |
| --- | --- |
| `bash release/scripts/capture-screenshots.sh` | `control/control.html` 1280×800 `fits=true`; `control/popup.html` 336×432 `fits=true` (432 = measured `scrollHeight`, so the real Chrome popup neither clips nor scrolls) |
| Rendered proof | `release/assets/render-proof/screenshot-control-1280x800.png`, `screenshot-popup-336x432.png` |
| `npm run test:all` | 60 unit + 11 security pass, 42/42 e2e, 41/41 relay |
| `bash release/scripts/smoke-load.sh` | exit 0 — both pages render inside the extension origin from the packaged build |
| `verify-package.sh` / `check_permissions.py` | OK (the redesign needs no permission and no manifest change) |

Notes on what the redesign touched: the control ids the tests drive (`stateArmed`,
`stateMode`, `stateRev`, `relayPhase`, `relayUrl`, `pause`, `resume`, `reconnect`, `kill`,
`clearKill`, `log`) are unchanged, and the log still prints `control page ready`, so no test
needed editing. The log timestamps remain ISO-derived (`HH:MM:SS`).

## Notes on what is no longer covered (and why that is fine)

* The pairing **form** is gone, so there is no longer a check that a typed pairing
  string is wiped from a password field. The property that mattered is still
  checked: no `hbr1:` / `hbrt_` value reaches the page DOM, the worker's log, the
  worker settings, `chrome.storage.local`, or the relay log — and the page a human
  opens never receives the string at all.
* Arm-by-click checks (active tab / checked tabs / as group) are gone with the tab
  grant list: the session auto-arms (`agent-all` over the relay, `tab-group` when
  the agent opens its own tab) and the explicit arm path is still exercised
  (`selected-tabs` re-arm after a live revocation).
* `npm run test:relay:native` was **not** re-run in this pass (it rewrites the
  machine's HKCU native-host registration); it is not part of `test:all` and this
  rework does not touch the native host, the launcher or the ticket protocol.
