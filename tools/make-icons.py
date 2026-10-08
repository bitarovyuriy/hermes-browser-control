#!/usr/bin/env python3
"""Make the extension icon set from the source artwork.

Source: `release/assets/icon-source.png` — the black-on-white illustration (a hand with a
bird in the negative space). The script:

  * lifts the ink off the white background into an alpha channel (no hard threshold, so the
    anti-aliasing survives);
  * crops to the ink and re-centres it on a square canvas with a small margin;
  * keeps the artwork black on white (`--ink-mode paper`, the default — the icon stays
    black-and-white as drawn) and writes it out as
    `extension/icons/icon-{16,32,48,128}.png`. The white plate is opaque on purpose: bare
    black ink on transparency disappears on a dark toolbar;
  * boosts ink density at 16/32 px: at that size thin line art dissolves into grey, and
    Chrome renders the toolbar icon at 16.

Usage: python tools/make-icons.py [--ink-mode paper|tile|dark]

  --ink-mode paper  black ink on an opaque white plate (default, black-and-white as drawn)
  --ink-mode tile   white ink on the project's palette tile (#2b6ea8 → #16324f → #0d2135)
  --ink-mode dark   white ink on transparency (dark themes only)
"""

import argparse
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "release", "assets", "icon-source.png")
OUT_DIR = os.path.join(ROOT, "extension", "icons")
SIZES = (16, 32, 48, 128)

# Palette stops, top-right to bottom-left (matches the promo tile and the control page).
STOPS = ((43, 110, 168), (22, 50, 79), (13, 33, 53))
INK = (223, 230, 243)  # #dfe6f3 — white ink for the tile / dark modes
PAPER_INK = (12, 16, 22)  # near-black ink for the black-and-white plate


def load_alpha(source: str) -> Image.Image:
    """Ink coverage as an L-mode alpha mask, cropped to the ink and squared."""
    grey = Image.open(source).convert("L")
    ink = Image.eval(grey, lambda v: 255 - v)
    bbox = ink.point(lambda v: 255 if v > 60 else 0).getbbox()
    if bbox is None:
        raise SystemExit(f"no ink found in {source}")
    art = grey.crop(bbox)
    width, height = art.size
    side = max(width, height)
    pad = int(side * 0.06)
    canvas = Image.new("L", (side + 2 * pad, side + 2 * pad), 255)
    canvas.paste(art, ((side - width) // 2 + pad, (side - height) // 2 + pad))
    return Image.eval(canvas, lambda v: min(255, int((255 - v) * 1.08)))


def boost(alpha: Image.Image, size: int) -> Image.Image:
    """Thicken the ink at small sizes so the strokes do not wash out to grey."""
    if size > 32:
        return alpha
    floor, gain = (30, 1.35) if size == 32 else (40, 1.5)
    return alpha.point(lambda v: 0 if v <= floor else min(255, int((v - floor) * gain)))


def tile(size: int) -> Image.Image:
    """The palette tile: the same diagonal gradient the store tile uses."""
    back = Image.new("RGB", (size, size))
    px = back.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * max(1, size - 1))
            if t < 0.5:
                u, c0, c1 = t / 0.5, STOPS[0], STOPS[1]
            else:
                u, c0, c1 = (t - 0.5) / 0.5, STOPS[1], STOPS[2]
            px[x, y] = tuple(int(c0[i] + (c1[i] - c0[i]) * u) for i in range(3))
    return back.convert("RGBA")


def render(alpha: Image.Image, size: int, ink_mode: str) -> Image.Image:
    scaled = boost(alpha, size).resize((size, size), Image.LANCZOS)
    if ink_mode == "paper":
        out = Image.new("RGBA", (size, size), (255, 255, 255, 255))
        ink_rgb = PAPER_INK
    elif ink_mode == "dark":
        out = Image.new("RGBA", (size, size), (11, 15, 22, 0))
        ink_rgb = INK
    else:  # tile
        out = tile(size)
        ink_rgb = INK
    ink = Image.new("RGBA", (size, size), ink_rgb + (0,))
    ink.putalpha(scaled)
    return Image.alpha_composite(out, ink)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ink-mode", choices=("paper", "tile", "dark"), default="paper")
    parser.add_argument("--source", default=SOURCE)
    args = parser.parse_args()

    if not os.path.exists(args.source):
        print(f"missing source artwork: {args.source}", file=sys.stderr)
        return 2
    alpha = load_alpha(args.source)
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, f"icon-{size}.png")
        render(alpha, size, args.ink_mode).save(path)
        print(f"wrote {os.path.relpath(path, ROOT)}")
    print(f"ink-mode={args.ink_mode}, source={os.path.relpath(args.source, ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
