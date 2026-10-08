# Privacy Policy — Hermes Browser Extension

**Effective date:** 2026-10-08
**Last updated:** 2026-10-08
**Applies to:** Hermes Browser Extension, version 0.3.0 and later, distributed through
the Chrome Web Store and as a signed self-hosted package.

> Draft for review. Items marked **[CONFIRM]** must be verified against the shipped
> build and against the legal entity details before this page goes public. A privacy
> policy with a dead link, or with an unverifiable claim, is a rejection (and a legal
> liability). The technical statements below were derived from the package itself
> (`extension/manifest.json`, source host inventory) — see "How to verify these claims".

---

## 1. Who we are

The Hermes Browser Extension is published by **[CONFIRM: legal entity name, registered
address]**. Contact for privacy questions and data requests:
**[CONFIRM: privacy@…]**. We are the "publisher"; the "runtime" is the Hermes agent
instance *you* run or connect to, which is operated by you.

## 2. The short version

- We do **not** run a server that receives your browsing data.
- We do **not** include analytics, advertising, fingerprinting or crash-reporting SDKs.
- The extension has **no user accounts** and does not ask for credentials.
- Browsing content moves only between your browser and the Hermes runtime **you**
  configure — by default a loopback address on your own machine. If you point the
  extension at someone else's runtime, that operator is responsible for that data — not us.
- Settings live in your browser's own extension storage and never leave the device.

## 3. What the extension handles, and why

| Data | When | Where it goes | Purpose |
| --- | --- | --- | --- |
| Page content — DOM text, HTML, form field values, screenshot pixels of the attached tab | Only while you have a tab armed and the agent is working | To the Hermes runtime you configured (by default `127.0.0.1` / `localhost` on your machine); to the model endpoint that runtime uses | To answer your instruction ("read this page", "click this", "type this") |
| The URL and title of tabs you attach | While attached | Same as above | To show the agent and you which tab is in scope |
| The agent's verbs and their results (navigate, click, type, DOM reads, screenshots) | Only while your runtime is connected and the session is armed | Same as above | Executing the instruction you gave your agent |
| Settings — relay address, access mode | On change | `chrome.storage` on your device only | Remembering your configuration |

The extension ships **no other outbound host**. The only network endpoints in the
package are the loopback gateway you configure (`http://127.0.0.1/*`,
`http://localhost/*`) and whatever remote relay URL you configure yourself (there is no URL
field in the UI: it is set over the extension's own message surface).
There is no update-check phone-home, no model catalog fetch and no avatar/theme fetch in
this build.

We do not collect: name, email, address, payment data, health data, personal
communications, location, keystroke logs, browsing history dumps, or a list of your
installed extensions.

## 4. The `chrome.debugger` permission — what it means for your data

The extension asks for the `debugger` permission so it can send *trusted* input (real
clicks and keystrokes) and read the DOM in a tab **you explicitly attach** — synthetic
events from a content script are ignored by many sites, so this is the only reliable
mechanism in Manifest V3.

- Attaching happens only while **your** runtime is connected and the session is armed — you
  start it by connecting your own runtime, and you can stop it at any moment.
- While attached, Chrome shows a banner: "Hermes Browser Control is debugging this
  browser." That banner is the control surface: **Cancel** on it detaches immediately,
  as does the kill switch on the extension's control page (the toolbar popup).
- The debugger session is scoped to the attached (leased) tab. We never attach silently,
  never attach in the background, and never use it to debug other extensions or the
  browser itself.
- Nothing captured through the debugger session is sent to the publisher. It is sent
  only to the runtime you configured, for the task you asked for.

## 5. Where your data is processed

- **On your device** — settings, session state, the control page.
- **Your Hermes runtime** — by default a loopback address on your own machine. If you
  configure a remote relay, page content travels to that remote endpoint, and its
  operator becomes a controller of that data. Check their policy before pointing the
  extension at a remote endpoint.
- **Your model provider** — the runtime decides which model endpoint handles a request.
  That is governed by *your* contract with the provider, not by us.
- **Us** — no processing. We operate no ingestion endpoint for extension data.

## 6. Sharing, selling, transferring

We do not sell or share personal data with third parties. There is no advertising, no
data brokerage, and no "sale" as defined by the CCPA/CPRA. Data is not used for credit,
insurance, employment or lending decisions. We do not use your data to train models.

## 7. Retention

On-device data lives until you delete it: **chrome://extensions → Hermes Browser Control →
Details → Remove** clears extension storage, including settings. Attached-session data
exists only in memory for the duration of the session. We retain nothing, because we
receive nothing.

## 8. Your rights

Because we hold no personal data about you, there is no data for us to export, correct
or erase on your behalf — the copy on your device is under your control (see §7). If you
believe we hold data about you, write to **[CONFIRM: privacy@…]** and we will respond
within 30 days. If your data reached a runtime or a model provider you configured,
exercise your rights with that operator.

## 9. Security

- The extension is a Manifest V3 package. **No remote code** is executed: every script is
  shipped inside the package, verified by the Chrome Web Store at review time, and the
  extension's content security policy allows no remote script sources.
- The operation guard (`extension/security/operation-guard.mjs`) refuses sensitive
  domains (banking, crypto, password managers, email, government/tax, medical, checkout)
  and fails closed on a stale or missing connection lease, before any command reaches the
  browser.
- Self-hosted builds are signed with our key; store builds are signed by Google.
- Traffic to a remote relay is expected to be TLS (`wss://`); loopback traffic never
  leaves the machine.
- Reporting a vulnerability: **[CONFIRM: security contact / advisory URL]**.

## 10. Children

The extension is a developer/productivity tool and is not directed at children under 13.
We do not knowingly process data from children.

## 11. Changes to this policy

We will publish the updated policy at this URL with a new "Last updated" date, and note
material changes in the release notes. Continued use after a material change means you
accept the update.

## 12. Limited use

Our use of information received from Google APIs adheres to the Chrome Web Store User
Data Policy, including the Limited Use requirements. In particular, data obtained through
the extension's permissions is used only to provide or improve the single purpose of the
extension — agent-driven browser control that the user initiates — and is not transferred
to third parties except as needed for that purpose (the user's own configured runtime).

---

## How to verify these claims

Every factual claim above is checkable from the shipped package:

```bash
bash release/scripts/hosts-inventory.sh          # every outbound host in the bundle
grep -rn "analytics\|telemetry\|sentry\|segment\|amplitude\|posthog" extension/
python -c "import json;print(json.load(open('extension/manifest.json'))['permissions'])"
```

If any of those produce a new host or a tracking SDK that is not listed in §3, **update
this policy before shipping** — and if the host cannot be justified, remove the code
instead.
