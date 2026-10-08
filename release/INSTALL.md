# Install & run — Hermes Browser Control (MVP)

Three ways to get the extension running, plus troubleshooting. Paths are Windows
(the repo root).

## 1. Dev — load unpacked (fastest loop)

```bash
cd <path-to-this-repo>
bash release/scripts/build-release.sh --unpacked-only --allow-dirty   # -> release/dist/unpacked
```

Start the relay (it is what pairs the extension with your runtime):

```
cd relay && npm install && npm start -- --port 47317
```

Then in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** →
select `release/dist/unpacked` (or the source dir `extension/` for live editing).
Click the toolbar action to open the control popup — the human stop. The agent itself is
driven by your Hermes runtime over the loopback relay; the same page opens as a tab from
the extension's options (or from the popup's "Open as a full page" link).

> Chrome ≥ 137 ignores the `--load-extension` command-line flag in branded builds. To
> automate this, use `bash release/scripts/smoke-load.sh`, which loads the build through the
> CDP `Extensions.loadUnpacked` command.

## 2. CLI automation (headless loadability gate)

```bash
bash release/scripts/smoke-load.sh            # headless
bash release/scripts/smoke-load.sh --headed   # visible window (debugging)
bash release/scripts/smoke-load.sh --legacy   # Chromium / Chrome-for-Testing path
```

Writes `release/dist/smoke-load-result.json`; exit 0 means the build loaded and the control
page rendered inside the extension origin.

## 3. Store install

Upload `release/dist/hermes-browser-extension-0.3.0.zip` in the CWS dashboard (or install the
`.crx` via enterprise policy). Store builds are signed by Google; self-hosted builds are
signed by `pack-crx.sh` with `release/keys/hermes-browser-extension.pem`.

## Using it

The extension is a bridge: the Hermes runtime drives it, and the only page it ships is the
human stop.

1. Start your Hermes runtime, then click the toolbar action: the control popup (336 px,
   next to the icon) shows the session state, the relay phase it reads back from the
   worker, and Pause / Resume / Reconnect / Kill switch / Clear kill.
2. `local` mode pairs through the native host `com.hermes.browser_relay` once the Hermes
   installer registers it — nothing to paste. Without that host, hand the worker a pairing
   string over `hermes/relay` (tooling path; there is no form in the UI).
3. Let the agent work: the session auto-arms (`agent-all` when the relay reports
   `connected`), and the agent opens its own tab inside its own tab group. Explicit arming
   stays available on the message surface for tooling.
4. The agent issues its verbs over the relay — `navigate`, `click`, `type`, `readDom`,
   `screenshot`, … — as `{type: 'hermes/command', command, opts}` on the worker's message
   surface (the same entry point the E2E harness uses).
5. **Kill** on the control page tears the agent session and the relay down at once; nothing
   runs until it is cleared and re-armed.

The operation guard refuses sensitive domains (banking, crypto, password managers, email,
government/tax, medical, checkout) and fails the relay path closed when the connection lease
is stale — a denied command never reaches the browser.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `debugger-busy` on arm | DevTools is already attached to that tab — close DevTools and retry. |
| Nothing happens on a normal site | The content-script path is loopback-only; arbitrary tabs use the CDP path, which needs `debugger` and an armed tab. |
| Relay stays `reconnecting` | No runtime reachable at the configured address; check the URL/port and that the Hermes runtime is running. |
| `sensitive-domain` refusal | The target URL is on the guard's deny-list by design. |
| `no-lease` / `stale-port` refusal | The relay binding moved (or was never registered) — re-arm the session. |
| Firefox | Chat only; no `chrome.debugger` equivalent, so no tab attach. |
