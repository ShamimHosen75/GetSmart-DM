"""Generate the GetSmart DM extension icons.

Design: rounded purple square, white down-arrow, mint "tray" line under it.
Drawn at 8x and downsampled so the edges stay smooth at every size.

Usage:  python scripts/make_icons.py
Needs:  Pillow (pip install pillow). Dev-time only, not shipped.
Output: extension/icons/icon16.png, icon32.png, icon48.png, icon128.png
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZES = (16, 32, 48, 128)
SCALE = 8  # supersampling factor

PURPLE_TOP = (124, 77, 255)     # #7C4DFF
PURPLE_BOTTOM = (94, 53, 177)   # #5E35B1
WHITE = (255, 255, 255, 255)
MINT = (61, 220, 151, 255)      # #3DDC97

OUT_DIR = Path(__file__).resolve().parent.parent / "extension" / "icons"


def vertical_gradient(size: int) -> Image.Image:
    grad = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / max(size - 1, 1)
        color = tuple(round(a + (b - a) * t) for a, b in zip(PURPLE_TOP, PURPLE_BOTTOM))
        draw.line([(0, y), (size, y)], fill=color + (255,))
    return grad


def draw_icon(size: int) -> Image.Image:
    s = size * SCALE
    u = s / 128  # design grid: 128 units

    # Rounded square background (small inset so the corners are not clipped).
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [2 * u, 2 * u, 126 * u, 126 * u], radius=28 * u, fill=255
    )
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    img.paste(vertical_gradient(s), (0, 0), mask)

    draw = ImageDraw.Draw(img)

    # Small sizes get a bolder glyph so it stays readable.
    bold = 1.25 if size <= 16 else (1.12 if size <= 32 else 1.0)

    # Down-arrow: shaft + head.
    cx = 64 * u
    shaft_w = 16 * u * bold
    draw.rounded_rectangle(
        [cx - shaft_w / 2, 24 * u, cx + shaft_w / 2, 66 * u],
        radius=shaft_w / 2,
        fill=WHITE,
    )
    head_half = 27 * u * bold
    draw.polygon(
        [(cx - head_half, 56 * u), (cx + head_half, 56 * u), (cx, 86 * u)],
        fill=WHITE,
    )

    # Mint tray line.
    tray_h = 10 * u * bold
    draw.rounded_rectangle(
        [30 * u, 98 * u, 98 * u, 98 * u + tray_h],
        radius=tray_h / 2,
        fill=MINT,
    )

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT_DIR / f"icon{size}.png"
        draw_icon(size).save(path, optimize=True)
        print(f"wrote {path.relative_to(OUT_DIR.parent.parent)}")


if __name__ == "__main__":
    main()
