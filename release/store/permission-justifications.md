# Permission justifications (Chrome Web Store review)

Rendered against the **MVP build (`mvp/extension`)** — version `0.3.0`. Copy the "paste"
block for each permission into the matching field of the CWS **Privacy practices →
Permission justification** form. Wording lives here so it is reviewable in git and diffable
when the manifest changes.

Grounding: every claim was checked against the shipped bundle — `extension/manifest.json`,
`background.js`, `src/*`, `content/content-script.js`, `security/operation-guard.mjs`.
Re-run `python release/scripts/check_permissions.py` after any permission change; it diffs
this file against the built manifest **in both directions**.

Declared set in the 0.3.0 build:

```
permissions:      debugger, tabs, tabGroups, storage, alarms, nativeMessaging
host_permissions: http://127.0.0.1/*, http://localhost/*
```

There is **no** `activeTab`, `unlimitedStorage`, `contextMenus`, `scripting`,
`downloads`, `offscreen` or `declarativeNetRequestWithHostAccess` in this build, and no
`<all_urls>`-style host permission. A block exists below for every declared permission and
for nothing else — that is what the drift gate enforces.

---

## `debugger` — the one that gets extensions rejected

### Paste this

```
Why the debugger permission is required

The extension's single purpose is to let the user's own Hermes agent act on the browser
tab the user attaches. Performing that requires two things a content script cannot do
reliably:

1. Sending TRUSTED input. Real clicks and keystrokes must be dispatched as trusted events
   (Input.dispatchMouseEvent / Input.dispatchKeyEvent over the Chrome DevTools Protocol).
   Content scripts can only synthesize events, which many sites ignore, and which can be
   spoofed by page script. chrome.debugger is the only Manifest V3 mechanism that
   produces trusted input.
2. Reading the page as the browser sees it (accessibility tree, DOM, layout and, on the
   user's request, a screenshot of the tab) so the agent can identify the right element
   before acting.

How it is used, precisely
- A debugging session is opened ONLY on a user-attached tab. Tabs are leased: the agent
  sees the URL, title and content of leased tabs only, never of other tabs.
- The extension talks to the debugger over the extension's own service worker
  (background.js -> src/controller.js -> src/cdp-methods.js, which is a fail-closed
  allowlist of CDP commands and validates every parameter).
- Restricted pages (chrome://, the Web Store, other extensions' pages) are refused before
  attach.
- While a session is live, Chrome itself displays "Hermes Browser Control is debugging
  this browser"; the user can cancel that banner at any time, which detaches instantly.
  The extension also ships a kill switch that tears the session and the relay down.
- The permission is NOT used to debug other extensions, to inspect chrome:// pages, to read
  network traffic for advertising, or for any purpose other than the tab the user attached.
- No data from the debugger session is sent to the publisher. It is sent only to the Hermes
  runtime the user configured (a loopback address on the user's own machine by default) to
  answer the user's own instruction.

On Firefox (which has no chrome.debugger equivalent) the extension uses the content-script
snapshot mode only and disables attach; the debugger path is Chromium-only.
```

### Why this survives review (internal note)

- **Necessity is provable:** the CDP path is the *only* implementation of trusted input in
  the extension; the content-script path is explicitly the fallback for pages where the
  debugger is unavailable.
- **Least scope:** leased-tab model (`src/access-policy.js`), restricted-URL refusal,
  fail-closed CDP method allowlist (`src/cdp-methods.js`).
- **User control:** Chrome's own infobar + the extension's control page (the toolbar
  popup, or the same page as the extension's options), which carries the kill switch.
- **No data exfiltration:** the only outbound host in the build is the user's own loopback
  gateway (`http://127.0.0.1/*`, `http://localhost/*`); the publisher has no endpoint.

### Reviewer demo (attach a link or a screen recording)

Chrome review for `debugger` is often decided by the demo. Record 60–90 s, no cuts:

1. Open a neutral page (e.g. a public form). Click the toolbar action to open the control
   popup — that page is the only UI: state, relay phase, Pause / Kill.
2. Start the agent: the Hermes runtime on the same machine drives the tab over the
   loopback relay, and the session auto-arms (the agent gets its own tab group). Point out
   Chrome's "is debugging this browser" banner appearing.
3. Ask it to "fill the search box with 'hello' and submit".
4. Show the agent doing it, then the result in the page.
5. Press Kill on the control page — show the banner disappearing and the page no longer
   controlled.
6. Optionally show the fallback: a loopback page where the content-script path is used.

Narration must state the two things a reviewer listens for: *user-initiated* and
*detached/stopped when the session ends*.

---

## `tabs`

```
Used to enumerate, focus and hand tabs to the agent, and to read the URL/title of leased
tabs so the agent knows what it is working on. Tab content is never read through this
permission — only URL/title metadata. Only tabs the user has leased to the agent are
visible to it.
```

## `tabGroups`

```
The user can arm a whole tab group (not just one tab) for the agent. Reading the group the
user selected lets the agent treat that group as its scope and keeps the attach surface
bounded to what the user chose, instead of every tab in the window.
```

## `storage`

```
Saves the user's own settings and small caches locally with chrome.storage: access mode,
session state, relay settings and remembered pairings. Nothing in the cache leaves the
device.
```

## `alarms`

```
Manifest V3 terminates an idle service worker after ~30 seconds. A heartbeat alarm keeps
the agent's relay connection alive and reconnects it, so a backgrounded worker does not
silently stop responding to the user's runtime.
```

## `nativeMessaging`

```
Pairs the extension with the local Hermes runtime through a native-messaging host
(com.hermes.browser_relay), so the one-time pairing ticket can be handed to the extension
without the user pasting a string. Messages are exchanged only with that local host; no
remote endpoint is involved.
```

---

## Host permissions — the second review risk

```
http://127.0.0.1/* , http://localhost/*
  These are the ONLY host permissions. They cover the Hermes runtime the user runs on
  their own machine (loopback only), and the banner-free content-script path, which is
  declared for those loopback origins and nothing else.

The extension does NOT request http://*/*, https://*/* or file:///*. Arbitrary user sites
are reached through the debugger permission on the tab the user attaches, not through a
standing host grant, so there is no broad-host-permission question to answer.
```

**Assessment:** no action required. The broad-host item that blocked stable promotion in
the reference build does not exist in this manifest.

---

## Review log

| Date | Reviewer | Verdict |
| --- | --- | --- |
| 2026-10-08 | MVP packaging pass | Rewritten against the MVP manifest (`debugger, tabs, tabGroups, storage, alarms, nativeMessaging, sidePanel`; loopback-only hosts). Every declared permission has exactly one block here; no block exists for a permission that is not declared. `release/scripts/check_permissions.py` exits 0. |
| 2026-10-08 | 0.3.0 rework | The side panel was cut (see CHANGELOG): `sidePanel` is no longer requested, the UI is the control page, and the demo steps now describe the relay-driven flow. `check_permissions.py` exits 0 against the 0.3.0 manifest. |
| 2026-10-08 | 0.3.0 popup | The toolbar click opens `control/popup.html` (`action.default_popup`) instead of a tab; no new permission is involved (the popup page and `window.close()` need none), so the declared set is unchanged and `check_permissions.py` still exits 0. |

Open items to re-check before submitting:

- [ ] Reviewer demo recorded with the narration points above.
- [ ] Justification wording re-diffed against the final `manifest.json`
      (`python release/scripts/check_permissions.py` → 0).
