# Release checklist — Hermes Browser Control (MVP)

Repeat top to bottom for every release. Nothing here is optional for a **stable** promotion;
items marked `[beta-ok]` may be deferred for a beta push.

Run everything from the repo root (`cd <path-to-this-repo>`).

---

## 0. Preconditions (gate before you start)

- [ ] CI green on the release commit: unit + security tests, secret scan, E2E, relay suite
      (`.github/workflows/ci.yml`; locally `npm run test:all` + `npm run scan:secrets`).
- [ ] MVP smoke passes by hand: the control popup opens from the toolbar and shows the live
      state, and the agent (driven over the relay) opens its own tab, navigates a site,
      clicks, types and reads the DOM back — recorded in `release/dist/smoke-<version>.md`.
- [ ] `release/store/permission-justifications.md` reviewed against the live
      `extension/manifest.json` — **no permission added without a matching justification
      line**. Automate it: `python release/scripts/check_permissions.py` must exit 0.
- [ ] `bash release/scripts/hosts-inventory.sh` — no outbound host the privacy policy does
      not document, no tracking SDK.
- [ ] `node security/scan-secrets.mjs` — no secret-shaped literals in the tree.

## 1. Version

- [ ] Decide the version: patch = fixes only, minor = new capability, major = breaking
      scope/permission change. Permission changes are *always* at least minor.
- [ ] Write it to `release/VERSION` (single source of truth).
- [ ] `extension/manifest.json` version is stamped from `release/VERSION` at build time;
      never edit it by hand for a build. Verify: `chrome://extensions` shows the expected
      version.
- [ ] Move `CHANGELOG.md` `[Unreleased]` → `[x.y.z] - YYYY-MM-DD` and leave a fresh
      `[Unreleased]` heading. Every user-visible change has a line.

## 2. Build

- [ ] `bash release/scripts/build-release.sh --allow-dirty` → produces, in `release/dist/`:
      `hermes-browser-extension-<version>.zip`, `unpacked/`, `release-manifest.json`,
      `SHA256SUMS`.
- [ ] `bash release/scripts/verify-package.sh` → all checks pass (manifest parses, every
      referenced path exists inside the zip, no dev-only files, no remote-code patterns,
      size under the store limit).
- [ ] `[beta-ok]` `bash release/scripts/build-release.sh --crx` for the self-hosted channel
      (needs `release/keys/*.pem`; back it up offline — a lost key means existing installs
      cannot be updated).
- [ ] Load `release/dist/unpacked/` in Chrome, confirm the service worker is alive and the
      control page renders (toolbar action → options page).
- [ ] `bash release/scripts/smoke-load.sh` → `ok:true` (the automated loadability gate; it
      probes both entry points — `control/control.html` and `control/popup.html` — and the
      raw `--load-extension` flag does **not** work on branded Chrome ≥ 137).
- [ ] Confirm the zip contains **no**: `release/`, `node_modules/`, `.git/`, `*.map`,
      `*.pem`, `.env*`, test fixtures.
- [ ] Confirm the zip **does** contain `security/operation-guard.mjs` (runtime dependency of
      `src/admission.js`) — a package without it is broken.

## 3. Store assets

- [ ] `store/listing.md` — description current (short ≤132 chars, no keyword stuffing).
- [ ] Screenshots regenerated at 1280×800 from the *release build*
      (`store/screenshots.md`), no personal data, no debug UI, no other tabs visible.
- [x] **Icon set present** — `extension/icons/icon-{16,32,48,128}.png` plus the `icons` block
      in `manifest.json` (and `action.default_icon` for the toolbar). Regenerate with
      `python tools/make-icons.py` after changing `release/assets/icon-source.png`.
- [ ] Small promo tile 440×280 present (`release/assets/`).
- [ ] `store/privacy-policy.md` rendered to `store/privacy-policy.html` and reachable at the
      public URL in the store listing. **A dead privacy-policy URL is an automatic
      rejection.**
- [ ] `store/data-usage-disclosure.md` answers pasted into the CWS **Privacy practices** tab;
      every claim still true of the build.
- [ ] Permission justifications pasted into the CWS permission-justification fields.
- [ ] `[beta-ok]` Review demo video / written walkthrough for `debugger` recorded if the
      attach flow changed (`store/permission-justifications.md` → "Reviewer demo").

## 4. Publish

- [ ] **Beta first.** Upload the zip to the beta (or unlisted) listing, publish, install it
      from the store into a clean profile, run the MVP smoke on the *store-installed* copy.
- [ ] Soak ≥ 24 h on beta with no new console errors.
- [ ] Promote: upload the identical zip to the stable listing, fill in "What's new" with the
      changelog for this version.
- [ ] Set rollout: 10 % → 50 % → 100 %.
- [ ] Auto-update: force an update at `chrome://extensions` → Developer mode → **Update**,
      check the version badge.
- [ ] Tag the commit `v<version>` and attach `hermes-browser-extension-<version>.zip` +
      `SHA256SUMS`.

## 5. After

- [ ] Update `release/CHANGELOG.md` if the store review forced any change.
- [ ] File follow-ups for anything deferred with `[beta-ok]`.
- [ ] Announce: release notes in `store/listing.md`, support inbox has the known-issues list.

---

## Rollback

- Store: **do not** unpublish. Upload a fixed build as a new patch version; Google review for
  a fix is expedited.
- If a bad build reached 100 %: stop the rollout in the CWS dashboard, ship the previous zip
  with a `+1` patch version.
- Self-hosted `.crx`: push the previous `.crx` again via policy; clients downgrade on the
  next policy refresh. Keep the last two `.crx` files and their `.pem` forever.

## Channel map

| Channel | Listing | Source of the zip | Cadence |
| --- | --- | --- | --- |
| dev | none — loaded unpacked | any branch | every push |
| beta | unlisted listing | `release/dist/*.zip` from the release branch | per milestone, soak ≥ 24 h |
| stable | public listing | same zip as beta, promoted | monthly at most |
