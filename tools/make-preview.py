"""Render the ball artwork at the sizes the app actually uses, inside circles.

Preview sheets are a development aid only; they are written to the system temp
directory so the repository never accumulates them.
"""
import os
import tempfile

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src", "renderer", "assets")
OUT = tempfile.gettempdir()

SIZES = [40, 56, 72, 96]
PAD = 14

for name in ("whale-girl", "whale-girl-face"):
    art = Image.open(os.path.join(SRC, f"{name}.png")).convert("RGBA")
    width = sum(s + PAD for s in SIZES) + PAD
    height = max(SIZES) + PAD * 2
    sheet = Image.new("RGBA", (width, height), (16, 17, 22, 255))
    x = PAD
    for size in SIZES:
        circle = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        mask = Image.new("L", (size * 4, size * 4), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
        mask = mask.resize((size, size), Image.LANCZOS)
        circle.paste(art.resize((size, size), Image.LANCZOS), (0, 0), mask)
        sheet.alpha_composite(circle, (x, PAD + (max(SIZES) - size) // 2))
        x += size + PAD
    target = os.path.join(OUT, f"dsh-pet-preview-{name}.png")
    sheet.convert("RGB").save(target)
    print(f"{target}  ({width}x{height})")
