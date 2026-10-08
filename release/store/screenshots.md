# Screenshots and store artwork — Hermes Browser Control (MVP)

Chrome Web Store rules that shape this list:

- **1 to 5 screenshots**, each exactly **1280×800** (or 640×400) PNG or JPEG, square-pixel.
- Screenshots must show the extension **in use**, not a marketing poster: no device frames,
  no added text overlays, no collage, no misleading UI that does not exist.
- No personal data, no real account names, no third-party trademarks, no debug consoles.
- Small promo tile **440×280**; marquee **1400×560** (optional).

---

## Shot list (5 slots, priority order)

| # | Slot | What it shows | Caption (≤ 60 chars) |
| --- | --- | --- | --- |
| 1 | Hero / first slot | The control page open (state `armed`, relay `connected`) while the agent's own tab group is visible on a page it just acted on | `Your Hermes agent drives a tab of its own` |
| 2 | The agent's tab | Chrome's "is debugging this browser" infobar on the agent's tab, with the *Hermes agent* tab group visible in the tab strip | `The agent gets its own tab group` |
| 3 | Acting | Agent mid-task: a form on the page half-filled by the agent, the control page showing the session state beside it | `It clicks and types, it does not just talk` |
| 4 | Reading back | Agent's answer quoting content from the page (DOM read), page scrolled to the quoted section | `It reads the page and answers from it` |
| 5 | Safety / kill switch | The control page showing the relay phase and the kill switch, plus the guard rejecting a sensitive URL | `Loopback-only, with a kill switch` |

If only one screenshot can be produced, ship **#1**.

## Artwork inventory

| File | Size | Purpose | Status |
| --- | --- | --- | --- |
| `release/assets/screenshot-1-…1280x800.png` | 1280×800 | slot 1 | **not captured** — needs a live runtime |
| `release/assets/screenshot-2-…1280x800.png` | 1280×800 | slot 2 (needs a staged page) | not captured |
| `release/assets/screenshot-3-…1280x800.png` | 1280×800 | slot 3 (needs a staged page) | not captured |
| `release/assets/screenshot-4-…1280x800.png` | 1280×800 | slot 4 (needs a staged page) | not captured |
| `release/assets/screenshot-5-…1280x800.png` | 1280×800 | slot 5 | not captured |
| `release/assets/promo-tile-440x280.png` | 440×280 | small promo tile | **ready** |
| `release/assets/render-proof/screenshot-control-1280x800.png` | 1280×800 | render proof of the control page (re-captured for 0.3.0) | produced by `capture-screenshots.sh` |
| `release/assets/render-proof/screenshot-popup-336x432.png` | 336×432 | render proof of the toolbar popup (the primary entry point; 432 px is the measured content height) | produced by `capture-screenshots.sh` |

The five store slots need a staged session (a runtime, an armed tab, a harmless demo page) —
they are captured by hand. The control page inside the package shows only state and switches
until a runtime is connected, so nothing submittable can be captured from a cold profile.

**Missing asset (open item):** the package does **not** ship an icon set (`manifest.json` has
no `icons` key and `extension/` contains no PNGs). The Chrome Web Store requires a 128×128
store icon and the browser shows a default puzzle piece without it. Add an icon set
(16/32/48/128) to `extension/` and an `icons` block to `manifest.json` before submitting.

## Capture recipe

### Static slots (control page, no live runtime)

The packaged capture script loads the built extension through CDP and shoots each page at an
exact viewport, reporting the real pixel size, `readyState`, the title and the first 240
characters of body text:

```bash
bash release/scripts/capture-screenshots.sh                                # control/control.html @1280x800
bash release/scripts/capture-screenshots.sh control/control.html=1280x800
OUT=release/assets/out bash release/scripts/capture-screenshots.sh
```

Do **not** use `chrome --headless --screenshot`: Chrome ≥ 137 ignores `--load-extension` in
branded builds, so a raw `--screenshot` of a `file://` page renders the HTML *outside* the
extension origin — no `chrome.*` APIs, no extension CSP, i.e. not the real UI.

### Live slots (arm, acting, reading)

1. Use a **clean profile** so nothing personal is on screen:
   `chrome.exe --user-data-dir="$LOCALAPPDATA/Temp/hermes-shots" --load-extension=release/dist/unpacked`
2. Start the Hermes runtime; open the control page and let the agent work in its own tab on a
   neutral public page (e.g. a public form).
3. Stage the state you want, then take the shot with the OS screenshot tool cropped to the
   browser window — then **resize/pad to exactly 1280×800**.
4. Blur or avoid: bookmarks bar, other tabs' titles, timestamps, the account avatar.

### Promo tile (440×280)

Re-render from the source so it keeps an exact size:

```
chrome.exe --headless=new --disable-gpu --window-size=440,280 \
  --screenshot="release/assets/promo-tile-440x280.png" \
  "file:///<path-to-this-repo>/release/assets/promo-tile-source.html"
```

## Pre-upload check

- [ ] Every file is exactly the size in the table (`python -c "from PIL import Image; ..."`).
- [ ] No personal data, no other extensions' icons, no console output, no loopback URL with a
      secret in it.
- [ ] The UI in the shot exists in the shipped build — re-shoot after any UI change.
- [ ] A 128×128 store icon exists in the package.
- [ ] Captions are not baked into the image (the store renders its own).
