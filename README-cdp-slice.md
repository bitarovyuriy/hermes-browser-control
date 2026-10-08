# CDP browser control slice

Agent-driven browser control for the Hermes browser extension: `chrome.debugger`
+ CDP forwarding for the heavy verbs, and a banner-free content-script path for
everything a page can do for itself.

This directory is a **self-contained, graftable slice**: it is a loadable MV3
extension of its own (carrier) plus a unit suite and a real-Chrome E2E harness,
so the rest of the extension workstreams can lift `extension/src/*` and
`extension/content/*` into the scaffold without untangling test scaffolding.

    extension/                 loadable unpacked MV3 extension (the carrier)
      manifest.json            permissions: debugger, tabs, tabGroups, storage, alarms, nativeMessaging
      background.js            service worker: controller wiring, message router, relay port, keep-alive
      src/
        access-policy.js       which tabs the agent may touch (pure)
        session-state.js       armed / paused / killed, grant, revocation, revision counter (pure)
        cdp-methods.js         CDP allowlist + param validation (fail-closed)
        command-router.js      agent verb -> {content path | CDP path} (pure)
        artifacts.js           artifact store: normalize, ring buffer, sink, PNG metadata (pure)
        fallback.js            content-script bridge (chrome.tabs.sendMessage)
        controller.js          the chrome-shaped glue: attach, forward, gate, indicators
      content/content-script.js  DOM verbs + HUD / element badges / agent pointer
      control/                 the control page — popup.html (toolbar popup) and control.html
                               (options page): live state, Pause / Resume / Reconnect /
                               Kill switch — the human stop
    test/unit/                 node --test, no browser, no dependencies
    test/e2e/                  real Chrome + unpacked extension, driven over the worker's own
                               message surface (the control page only for the human stop)
    test/e2e/artifacts/        screenshot.png + last-run.json from the last E2E run

## Run it

    npm test          # unit suite (no browser)
    npm run test:e2e  # launches Chrome with the extension loaded
    npm run test:all

Chrome is discovered from `CHROME_PATH`, then the local puppeteer cache, then the
usual install locations. Nothing is downloaded. `HEADED=1 npm run test:e2e` runs
the browser windowed; the default is `--headless=new`.

Load it by hand: `chrome://extensions` → Developer mode → *Load unpacked* →
pick `extension/`. Click the toolbar action to open the control popup (the same page opens
as a tab from the extension's options, or via the popup's "Open as a full page" link).

## Verb routing

| verb | banner-free path | CDP path |
| --- | --- | --- |
| `navigate` | `location.href` in the content script | `Page.navigate` + load wait |
| `click` | `el.click()` | `Input.dispatchMouseEvent` press/release at the element centre |
| `type` | native value setter + `input`/`change` | click → Ctrl+A → `Input.insertText` |
| `hover` / `scroll` | synthetic events / `scrollIntoView` | `Input.dispatchMouseEvent` (mouseMoved / mouseWheel) |
| `readDom` / `getText` | content script | `Runtime.evaluate` |
| `waitFor` | content script polling | `Runtime.evaluate` polling |
| `responseText` | in-page `fetch` | `Network.*` + `Network.getResponseBody` |
| `badge` / `pointer` / `hud` | content script only | — |
| `screenshot` | — | `Page.captureScreenshot` |
| `evaluate` | — | `Runtime.evaluate` |
| `consoleLogs` | — | `Runtime.consoleAPICalled` buffer |
| `networkBodies` | — | `Network.loadingFinished` → `Network.getResponseBody` |
| `domSnapshot` | — | `DOM.getDocument` + `DOM.getOuterHTML` |

Everything in the first block runs **without attaching the debugger**, so no
"Chrome is being debugged" infobar appears. `forceCdp` moves a banner-free verb
onto the CDP path when the caller wants real input events.

## Access, pause, kill

* Modes: `active-tab` (pinned when armed), `selected-tabs`, `tab-group`.
  Group mode creates a `tabGroups` group titled *Hermes agent* so the agent's
  session is visually isolated in the tab strip.
* `pause()` freezes commands but keeps the debugger session for a fast resume.
* `kill()` is terminal: state cleared, every debugger session detached, HUD torn
  down, buffers dropped, and every later command fails with `killed` until an
  explicit `clearKill()` + re-arm.
* `revokeTab(tabId)` is sticky: the tab is dropped from the grant, detached,
  HUD-hidden, and blocked even if it later becomes the active tab again.

## Security posture of this slice

* Only allowlisted CDP methods are forwarded (`src/cdp-methods.js`) — no
  `Storage.*`, `Browser.*`, `Target.*`, no raw CDP escape hatch.
* Host permissions are an explicit loopback allowlist, not `<all_urls>`;
  `activeTab`, `scripting` and `contextMenus` are not requested at all.
* The content script is manifest-declared only — nothing is injected by hand.

## Integration contract for the other workstreams

* **Transport (WS relay).** Connect a port named `hermes-relay`
  (`chrome.runtime.connect({ name: 'hermes-relay' })`) and send
  `{id, type: 'hermes/command', command, opts}` or `{id, type: 'hermes/session', payload}`;
  responses come back as `{id, response}`. To push artifacts out, set
  `globalThis.hermesRelay = { send(message) {...} }` in the worker — the artifact
  sink already calls it.
* **Pages.** Send `{type: 'hermes/command' | 'hermes/session' | 'hermes/state' | 'hermes/tabs' | 'hermes/artifacts'}`.
  The worker broadcasts `{type: 'hermes/event', event}` (state changes, attach/detach,
  console lines, artifacts) and `{type: 'hermes/artifact', record}`.
* **Scaffold.** `manifest.json` here requests exactly what this slice needs; merge
  the permissions, the `content_scripts` block and the `options_ui` /
  `action.default_popup` blocks into the scaffold manifest, then point the scaffold's
  worker at `src/controller.js`.
* **Artifacts.** Records are `{id, kind, tabId, at, source, ...}` with
  `screenshot` (bytes/width/height/png/digest, base64 discarded),
  `dom` (html/text), `console` (entries), `response` (url/status/text), `text`.

## Known limits

* Firefox has no `chrome.debugger` equivalent — chat only, no attach.
* The content path needs the declared content script, so `about:blank`,
  `data:` and `chrome://` pages are CDP-only (and `chrome://` is refused by Chrome
  for `chrome.debugger` anyway).
* `chrome.debugger.attach` fails with `debugger-busy` if DevTools (or another
  CDP client) is already attached to the same tab — surfaced as a clear error.
* `Page.captureScreenshot` captures the tab's surface; it is not a full-page
  capture unless `captureBeyondViewport` is requested.
