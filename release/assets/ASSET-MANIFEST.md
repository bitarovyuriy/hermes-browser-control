# Asset manifest — MVP store artwork

Everything the Chrome Web Store dashboard asks for, and where it stands for the MVP build
(`mvp/extension`, version 0.3.0).

| Asset | Required size | File | Status |
| --- | --- | --- | --- |
| Store icon | 128×128 PNG | `extension/icons/icon-128.png` (with 16/32/48) | ✅ in package — generated from `release/assets/icon-source.png` by `tools/make-icons.py` |
| Screenshot 1 (hero) | 1280×800 | `screenshot-1-…1280x800.png` | ❌ not captured (needs a live runtime) |
| Screenshot 2 (arm) | 1280×800 | `screenshot-2-…1280x800.png` | ❌ not captured |
| Screenshot 3 (acting) | 1280×800 | `screenshot-3-…1280x800.png` | ❌ not captured |
| Screenshot 4 (reading) | 1280×800 | `screenshot-4-…1280x800.png` | ❌ not captured |
| Screenshot 5 (safety) | 1280×800 | `screenshot-5-…1280x800.png` | ❌ not captured |
| Small promo tile | 440×280 | `promo-tile-440x280.png` | ✅ ready |
| Promo tile source | — | `promo-tile-source.html` | ✅ (re-render source) |
| Marquee promo | 1400×560 | — | optional, not shipped |
| YouTube video | URL | — | optional, not shipped |

Shot list, captions and the capture recipe (including the live-slot staging steps):
`../store/screenshots.md`.

## Notes

- The promo tile was rendered from `promo-tile-source.html`; keep the source next to the PNG
  so it can be re-rendered at an exact size after a wordmark change.
- The render proofs of both control-page entries (`control/control.html` at 1280×800 and
  `control/popup.html` at 336×432 — the toolbar popup, at its measured content height) are
  produced by
  `bash release/scripts/capture-screenshots.sh` into `render-proof/`; they are proof that the
  packaged pages render inside the extension origin, **not** store art.
- The icon set (`extension/icons/icon-{16,32,48,128}.png`) is generated, not hand-cut:
  `python tools/make-icons.py` lifts the ink off the white source artwork, re-centres it on a
  square canvas and keeps it **black on white** — the artwork stays black-and-white as drawn.
  The white plate is opaque on purpose: bare black ink on transparency would disappear on a
  dark toolbar. Regenerate the set with that script after any change to
  `release/assets/icon-source.png`; `--ink-mode tile` / `dark` render the same art white on the
  palette tile or on transparency instead.
- Note: the artwork is line art, so at 16 px it reads as the hand's silhouette rather than its
  details; the small sizes get an ink-density boost in the same script for that reason.
