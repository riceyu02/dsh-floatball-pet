"""Turn the supplied JPEG into transparent PNG assets for the floating ball.

The source is a flat illustration on a near-white sheet. A plain "white -> alpha"
key would also punch holes in the character's white headdress, so the background
is found by flood-filling the near-white region inwards from the border: only
white that is actually connected to the edge counts as background.

Edge quality comes from two steps: character colours are bled outwards over the
background before resizing (otherwise the LANCZOS kernel averages the white sheet
into the silhouette and leaves a light halo), and the hard alpha mask is then
downsampled, which anti-aliases it naturally.
"""
from collections import deque

import os

import numpy as np
from PIL import Image, ImageFilter

# Paths are derived from this file so the project can live anywhere.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "whale-girl-src.jpg")
OUT = os.path.join(ROOT, "src", "renderer", "assets")

WHITE_MIN = 238  # a pixel counts as "sheet" when every channel is at least this


def background_mask(rgb: np.ndarray) -> np.ndarray:
    h, w, _ = rgb.shape
    sheet = rgb.min(axis=2) >= WHITE_MIN
    bg = np.zeros((h, w), dtype=bool)
    queue = deque()

    def push(y, x):
        if sheet[y, x] and not bg[y, x]:
            bg[y, x] = True
            queue.append((y, x))

    for x in range(w):
        push(0, x)
        push(h - 1, x)
    for y in range(h):
        push(y, 0)
        push(y, w - 1)

    while queue:
        y, x = queue.popleft()
        if y > 0:
            push(y - 1, x)
        if y < h - 1:
            push(y + 1, x)
        if x > 0:
            push(y, x - 1)
        if x < w - 1:
            push(y, x + 1)
    return bg


def to_rgba(img: Image.Image) -> Image.Image:
    rgb = np.asarray(img.convert("RGB")).astype(np.uint8)
    bg = background_mask(rgb)

    # Bleed character colour into the background so the resize kernel never
    # samples the white sheet.
    blurred = np.asarray(
        Image.fromarray(rgb).filter(ImageFilter.GaussianBlur(5))
    ).astype(np.uint8)
    bled = np.where(bg[:, :, None], blurred, rgb)

    alpha = np.where(bg, 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([bled, alpha]), "RGBA")


def trim(img: Image.Image, pad: int = 8) -> Image.Image:
    box = img.split()[-1].getbbox()
    if box is None:
        return img
    left, top, right, bottom = box
    left = max(0, left - pad)
    top = max(0, top - pad)
    right = min(img.width, right + pad)
    bottom = min(img.height, bottom + pad)
    return img.crop((left, top, right, bottom))


def square(img: Image.Image, size: int) -> Image.Image:
    """Fit the artwork into a centred square canvas without distortion."""
    side = max(img.width, img.height)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    src = Image.open(SRC)
    print(f"source {src.width}x{src.height}")

    cut = to_rgba(src)
    trimmed = trim(cut)
    print(f"trimmed character {trimmed.width}x{trimmed.height}")

    full = square(trimmed, 512)
    full.save(os.path.join(OUT, "whale-girl.png"))
    print("wrote whale-girl.png (full character)")

    # A circular 56px ball cannot resolve the whole illustration, so also publish
    # a head crop: the face is the only part that still reads at that size, and
    # this box deliberately excludes the "哈!" lettering in the top-left corner.
    fw, fh = trimmed.width, trimmed.height
    head = trimmed.crop(
        (int(fw * 0.20), int(fh * 0.36), int(fw * 0.74), int(fh * 0.96))
    )
    head = trim(head, pad=2)
    square(head, 512).save(os.path.join(OUT, "whale-girl-face.png"))
    print(f"wrote whale-girl-face.png (head crop {head.width}x{head.height})")


if __name__ == "__main__":
    main()
