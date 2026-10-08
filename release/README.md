# `release/` — packaging and store-submission toolkit (MVP build)

Everything needed to turn the MVP extension source into a signed package and a Chrome Web
Store submission. Read this first; it is the map.

**This toolkit lives inside the MVP tree and packages the MVP only.** The thing that ships
is `mvp/extension/` — one loadable MV3 extension. The reference fork
An earlier reference fork and a TypeScript scaffold are **not** packaged and are kept as
references only.

## One-minute path

```bash
cd <path-to-this-repo>
bash release/scripts/build-release.sh          # zip + unpacked build (version from VERSION)
bash release/scripts/verify-package.sh         # gate: manifest, references, leaks, remote code
bash release/scripts/smoke-load.sh             # gate: actually loads in Chrome and renders
bash release/scripts/capture-screenshots.sh    # proof/artwork renders at exact viewports
bash release/scripts/pack-crx.sh               # optional: signed .crx for the self-hosted channel
```

## Layout

| Path | What it is |
| --- | --- |
| `VERSION` | Single source of truth for the version stamped into the build (`0.3.0`) |
| `CHANGELOG.md` | Keep-a-Changelog; every user-visible change gets a line |
| `RELEASE-CHECKLIST.md` | The release + promotion + rollback procedure, start to finish |
| `INSTALL.md` | Dev "load unpacked", CLI automation, store install, troubleshooting |
| `RELEASE-0.2.0.md` | The record for the current release: hashes, IDs, open blockers |
| `store/listing.md` | Store copy: short/long description (EN + RU), assets, review risks |
| `store/screenshots.md` | Shot list, sizes, capture recipe |
| `store/privacy-policy.md` / `.html` | Privacy policy draft (the `.html` is what you host) |
| `store/permission-justifications.md` | Per-permission text for review, incl. `debugger` |
| `store/data-usage-disclosure.md` | Answers for the CWS "Privacy practices" form |
| `assets/` | Promo tile (ready) + capture output |
| `scripts/` | Build, verify, smoke, capture, sign, host-inventory |
| `dist/` | Build output: `unpacked/`, `*.zip`, `*.crx`, `release-manifest.json`, `SHA256SUMS` |
| `keys/` | Signing keys. **Never commit, never send anywhere.** |

## Scripts

| Script | Purpose | Exit codes |
| --- | --- | --- |
| `build-release.sh` | Stage + version-stamp + zip; `--unpacked-only`, `--crx`, `--allow-dirty`, `--source DIR`, `--version X.Y.Z` | 0 ok, 2 refused (dirty tree, bad manifest) |
| `verify_package.py` (via `verify-package.sh`) | Static gate on the artifact: root manifest, valid MV3 manifest, all references present, no dev/secret files, no remote-code patterns, size sanity | 0 upload-safe, 2 findings |
| `smoke-load.sh` | Loads the built extension in Chrome over CDP and probes the control page (`panel/panel.html`) | 0 loaded, 2 failed, 3 no Chrome/node |
| `capture-screenshots.sh` | Renders extension pages at exact sizes; prints title + body text so a bad render is visible | 0 exact, 2 mismatch |
| `pack-crx.sh` | Signs a CRX3 with `keys/*.pem`, prints the extension ID and SHA-256 | 0 ok, 1 pack failed |
| `check_permissions.py` | Diffs `manifest.json` permissions against `store/permission-justifications.md` (both directions) | 0 match, 2 drift |
| `hosts-inventory.sh` | Lists every outbound host in the bundle — keeps the privacy policy honest | 1 if a tracking SDK appears |

`_chrome-session.sh` is a sourced helper (Chrome discovery, throwaway profile, CDP websocket
URL, cleanup); it is not meant to be run directly.

## Things that will bite you

- **Chrome ≥ 137 ignores `--load-extension`** in branded builds. Use `smoke-load.sh`
  (`Extensions.loadUnpacked`) or a Chromium/Chrome-for-Testing binary with `--legacy`.
- **`security/` must be packaged.** The extension imports `security/operation-guard.mjs` at
  runtime (`src/admission.js`); `build_release.py` deliberately does **not** exclude the
  `security` directory. Do not re-add it to `EXCLUDE_DIRS` / `FORBIDDEN_PATH_PARTS` or the
  shipped extension will be broken.
- **The build refuses a dirty git tree** unless `--allow-dirty`. The MVP tree is inside the
  user's home git repo, which is never clean — pass `--allow-dirty` on this machine and rely
  on the per-file hashes in `release-manifest.json`.
- **The signing key is irreplaceable.** Losing `keys/hermes-browser-extension.pem` changes the
  extension ID and strands every existing self-hosted install.
- **Version is stamped at build time**, from `VERSION`, into the packaged copy only — never
  hand-edit `manifest.json`'s version for a build.
