# Chrome Web Store — Privacy practices tab (data-usage disclosure)

Answers for the dashboard's **Privacy practices** form, written for the MVP build
(`mvp/extension`, version 0.2.0). Re-check against `extension/manifest.json` and the
`release/scripts/hosts-inventory.sh` output after any change.

## Single purpose (≤ 1000 chars, shown to reviewers)

```
Give the user's own Hermes agent controlled access to the browser tab the user attaches,
so the agent can open tabs, navigate, click, type and read the DOM on the user's behalf,
from the extension's control page (options page) next to the agent's work.
```

## Data collection — declare exactly this

| Category | Declared? | Why |
| --- | --- | --- |
| Personally identifiable information | **No** | No accounts, no names/emails/IDs are collected. |
| Health information | No | |
| Financial and payment information | No | |
| Authentication information | No | We never ask for credentials or tokens. |
| Personal communications | No | Command text goes to the user's own runtime, not to us. |
| Location | No | Not requested, not derived. |
| Web history | **No — see note** | The extension reads the page **only in a tab the user attaches**, and only while attached. It does not collect or retain the user's browsing history. If the reviewer's form forces a choice because of `tabs`/`debugger`, select it and add the explanation below. |
| User activity | **No — see note** | Page content (DOM, form values, screenshots) is read on attach for the user's own instruction. Nothing is retained by the publisher. Same handling as web history. |
| Website content | **Yes** | This is the honest answer: page text/HTML/screenshots are read in the attached tab to perform the user's request. Destination: the runtime the user configured. |

Whatever the form forces you to tick, the **explanation field** is what the reviewer
reads. Use this:

```
The extension reads page content (DOM, form values, screenshots) ONLY inside a tab the
user explicitly attaches, only while that attach is live. The user initiates the attach;
Chrome shows its "is debugging this browser" banner while it is active, and the user can
detach at any time from that banner or with the kill switch on the extension's control
page.

That content is sent only to the Hermes runtime the user configured (by default a loopback
address on the user's own machine) in order to fulfil the user's own instruction, and to
the model endpoint that runtime uses. The publisher operates no server that receives this
data, has no analytics or telemetry, and retains nothing.

Permissions requested and why:
- debugger: to send trusted input (clicks/keystrokes) and read the DOM in the attached tab.
- tabs: to enumerate/focus tabs and read the URL/title of the tabs the user leased.
- tabGroups: to support arming a whole tab group as the agent's scope.
- storage: saving the user's own settings and small local state.
- alarms: keeping the MV3 service worker alive/reconnecting (MV3 idles workers after ~30s).
- nativeMessaging: pairing with the local Hermes runtime via the local native host.
- (no side panel: the only UI is the control page — the toolbar popup, or the same page as
  the extension's options page).

Host permissions: loopback only (http://127.0.0.1/*, http://localhost/*) — the user's own
runtime. The extension requests no broad site access and no file access.
```

## Data usage certification

Tick only the boxes you can defend:

- [x] I do not sell or transfer user data to third parties, **outside of the approved use
      cases** — the user's own runtime counts as the approved case.
- [x] I do not use or transfer user data for purposes unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending
      purposes.

Do **not** tick "collect" for anything not listed above; the store audits these answers.

## Privacy policy URL

Must be a public, live URL rendering `release/store/privacy-policy.html`. Verify it loads
while logged out before submitting.

## Remote code

Answer: **the extension does not use remote code.** All logic ships in the package. This is
enforced by MV3's default policy and checked by `release/scripts/verify_package.py`, which
scans the package for `eval`, `new Function` and remote script/import patterns.

## Permission justification

Per-permission text lives in `store/permission-justifications.md`; paste from there — do not
improvise in the dashboard, so the wording stays reviewable in git.

## Open items that block a clean review

1. None on the permission side — the manifest is already the narrow set
   (`debugger, tabs, tabGroups, storage, alarms, nativeMessaging`) with
   loopback-only hosts. Re-run `python release/scripts/check_permissions.py` to confirm no
   drift after a manifest edit.
