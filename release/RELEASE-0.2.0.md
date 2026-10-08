# Release record — 0.2.0 (MVP packaging pass)

| | |
| --- | --- |
| Version | `0.2.0` (stamped from `release/VERSION`) |
| Built | 2026-10-08 15:53–15:56 (+03:00) |
| Source | `extension/` (working tree — see "Caveats") |
| Package | 28 files, 156 489 bytes uncompressed / 53 320 bytes zipped |
| Permissions | `debugger, tabs, tabGroups, storage, alarms, nativeMessaging, sidePanel` + hosts `http://127.0.0.1/*`, `http://localhost/*` |

## Artifacts

| File | Size | SHA-256 |
| --- | --- | --- |
| `release/dist/hermes-browser-extension-0.2.0.zip` (store upload) | 53 320 | `a668cbe09668bd20b52ecedb81372e5600d641d87b145de55340427cc0989b49` |
| `release/dist/hermes-browser-extension-0.2.0.crx` (CRX3, signed with our key) | 55 141 | `a7cdd8983dfc121c3046c96a2bb8c7bcd0aae1fc216fa0a6780a9f003719f265` |
| `release/dist/release-manifest.json` | 3 492 | per-file SHA-256 for every packaged file |
| `release/dist/SHA256SUMS` | 2 838 | checksums of the zip + every staged file |
| `release/dist/smoke-load-result.json` | 281 | the loadability evidence (below) |

Signing key: `release/keys/hermes-browser-extension.pem` (same key as the reference fork, so
the self-hosted extension ID is unchanged). **Back it up offline** — losing it changes the
extension ID and strands existing self-hosted installs.

## Package contents (28 files)

```
manifest.json  background.js
src/  access-policy.js admission.js artifacts.js cdp-methods.js command-router.js
      controller.js fallback.js panel-commands.js relay-host.js session-state.js
lib/  sensitive-domains.mjs
security/operation-guard.mjs          <- runtime code (imported by src/admission.js)
content/content-script.js
panel/ panel.html panel.css panel.js
vendor/transport/ backoff.js client.js command-queue.js config.js connection-state.js
                  logger.js pairing.js socket.js storage.js types.js
```

## Extension IDs

| ID | Where it comes from | Use |
| --- | --- | --- |
| `iiccdciafnclegbhfnckejedemcbibfo` | hash of the absolute install path (no `key` in the manifest) | dev / "load unpacked" only — changes if the folder moves |
| `dgpifhibmckjkklmjioghjeakpfjdnoa` | SHA-256 of the public key in our CRX3 signature | self-hosted / enterprise policy channel |
| _assigned by Google_ | first store upload | stable + beta listings |

## Gates run (all green)

| Gate | Command | Result |
| --- | --- | --- |
| Unit + security tests | `npm test` | 54 unit + 11 security pass, 0 fail |
| Secret scan | `npm run scan:secrets` | 76 files scanned, 0 findings |
| E2E (real Chrome, from the side panel) | `npm run test:e2e` | 39/39 checks pass |
| Relay suite (real Chrome + real relay) | `npm run test:relay` | 38/38 checks pass |
| Full suite | `npm run test:all` | exit 0 (unit → scan:secrets → e2e → relay) |
| Build | `bash release/scripts/build-release.sh --allow-dirty` | 28 files, version stamped 0.2.0 |
| Package integrity | `bash release/scripts/verify-package.sh` | `OK: safe to upload` for both the zip and the unpacked tree (root manifest, MV3, all references present, no dev/secret files, no remote-code patterns) |
| Permission/doc drift | `python release/scripts/check_permissions.py` | `OK — the document matches the manifest in both directions` (7 permissions ↔ 7 blocks) |
| Outbound hosts | `bash release/scripts/hosts-inventory.sh` | no tracking SDK; shipped code references only loopback (`127.0.0.1`, `localhost`) |
| **Loadability** | `bash release/scripts/smoke-load.sh` | `{"ok":true,"id":"iiccdciafnclegbhfnckejedemcbibfo","page":{"title":"Hermes Browser Control","ready":"complete","scripts":1,"css":1,"bodyLength":3502}}` |
| Signing | `bash release/scripts/pack-crx.sh` | CRX3, `sha256=a7cdd898…`, `extension id=dgpifhibmckjkklmjioghjeakpfjdnoa` |

The loadability gate is real, not assumed: it launches Chrome with
`--enable-unsafe-extension-debugging`, installs the staged build through the CDP
`Extensions.loadUnpacked` command, opens `chrome-extension://<id>/panel/panel.html`, and reads
`document.title` / `readyState` / script and stylesheet counts back. The plain
`--load-extension` flag cannot be used for this — Chrome removed it from branded builds in 137
and ignores it silently.

## Acceptance criteria

| Criterion | Status |
| --- | --- |
| Signed release package produced | **done** — store zip + CRX3 signed with our key, both verified, plus the loadability proof |
| Store description, screenshot list, privacy policy and `debugger` justification updated to the MVP's real permission set | **done** — `store/listing.md`, `store/screenshots.md`, `store/privacy-policy.md`/`.html`, `store/permission-justifications.md`, `store/data-usage-disclosure.md`, all grounded in the 7-permission manifest and loopback-only hosts; drift gate passes |
| Release checklist (versioning, changelog, channel promotion) documented | **done** — `release/RELEASE-CHECKLIST.md`, `CHANGELOG.md`, `release/README.md`, `INSTALL.md` |
| `scan-secrets` a required CI check together with `npm test` | **done** — `.github/workflows/ci.yml` (both required) + `npm run scan:secrets` wired into `npm run test:all` |
| Reference fork + scaffold marked reference-only | **done** — `README.md` in each tree, plus a "SUPERSEDED" banner in the fork's `release/README.md` |
| Ready zip loads unpacked and passes `npm run test:all` | **done** — smoke-load `ok:true`; `npm run test:all` exit 0 |

## Open items (do not block the package; block a clean store submission)

1. **No icon set in the package.** `manifest.json` has no `icons` key and `extension/`
   contains no PNGs. The store requires a 128×128 store icon and the browser shows a default
   puzzle piece without one. Add 16/32/48/128 PNGs + an `icons` block before submitting.
2. **Store screenshots not captured.** Needs a live runtime + an armed tab; shot list and
   recipe are written (`store/screenshots.md`).
3. **Privacy-policy placeholders.** Legal entity, privacy contact, security contact and the
   hosted URL of `privacy-policy.html` are `[CONFIRM: …]`. A dead policy link is an automatic
   rejection.
4. **`debugger` reviewer demo** not recorded yet (script in
   `store/permission-justifications.md` → "Reviewer demo").
5. **Native-messaging host not registered** on this machine, so `local` pairing uses a manual
   string until the Hermes installer writes `native/com.hermes.browser_relay.json`.

## Caveats

- The build used `--allow-dirty` because the MVP directory sits inside the user's home git
  repository, which is never clean. The per-file hashes in
  `release/dist/release-manifest.json` are the authoritative record of *what* was packaged.
- `release/dist/` is a snapshot of the working tree, not of a released commit.
- An earlier reference fork and a TypeScript scaffold are **not** packaged.

## Reproduce

```bash
cd <path-to-this-repo>
npm run test:all
bash release/scripts/build-release.sh --allow-dirty
bash release/scripts/verify-package.sh
python release/scripts/check_permissions.py
bash release/scripts/hosts-inventory.sh
bash release/scripts/smoke-load.sh
bash release/scripts/pack-crx.sh
```
