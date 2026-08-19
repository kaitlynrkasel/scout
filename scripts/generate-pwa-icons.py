#!/usr/bin/env python3
"""Generate the PWA / home-screen icon set from the one master logo.

The Scout mark lives at app/icon.png (2048x2048, transparent). Home-screen
icons can't be transparent — iOS composites transparency onto black, and
Android's maskable shapes crop the edges — so every output here is flattened
onto the cream canvas and inset so the mark survives whatever mask the
platform applies.

Run this after replacing app/icon.png:

    pip install pillow && python3 scripts/generate-pwa-icons.py

Outputs:
  app/apple-icon.png          180x180  iOS home screen (Next serves it as apple-touch-icon)
  public/icons/icon-192.png   192x192  manifest, purpose "any"
  public/icons/icon-512.png   512x512  manifest, purpose "any" + install prompt
  public/icons/icon-maskable-512.png   manifest, purpose "maskable" (Android adaptive)
"""

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "app" / "icon.png"
CREAM = (248, 247, 245, 255)  # --c-cream, the app's light canvas

# Fraction of the tile the mark is allowed to occupy. Maskable icons are cropped
# to a circle of ~80% diameter on some launchers, so the mark stays well inside.
SCALES = {"standard": 0.78, "apple": 0.72, "maskable": 0.58}


def render(size: int, scale: float, out: Path) -> None:
    mark = Image.open(SRC).convert("RGBA")
    mark = mark.crop(mark.getbbox())  # trim the transparent margin first
    box = int(size * scale)
    ratio = min(box / mark.width, box / mark.height)
    mark = mark.resize(
        (max(1, round(mark.width * ratio)), max(1, round(mark.height * ratio))),
        Image.LANCZOS,
    )
    tile = Image.new("RGBA", (size, size), CREAM)
    tile.alpha_composite(mark, ((size - mark.width) // 2, (size - mark.height) // 2))
    out.parent.mkdir(parents=True, exist_ok=True)
    tile.convert("RGB").save(out, "PNG", optimize=True)
    print(f"{out.relative_to(ROOT)}  {size}x{size}")


if __name__ == "__main__":
    render(180, SCALES["apple"], ROOT / "app" / "apple-icon.png")
    render(192, SCALES["standard"], ROOT / "public" / "icons" / "icon-192.png")
    render(512, SCALES["standard"], ROOT / "public" / "icons" / "icon-512.png")
    render(512, SCALES["maskable"], ROOT / "public" / "icons" / "icon-maskable-512.png")
