"""Draws the extension icon and writes it at every size Chrome needs.

Usage: python3 scripts/make-icons.py   (needs Pillow: pip install pillow)

The icon is drawn once at 1024 px and scaled down, so small sizes stay crisp.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SIZE = 1024
TOP, BOTTOM = (251, 113, 36), (194, 65, 12)  # orange-500 → orange-700
WHITE = (255, 255, 255, 255)


def gradient(size: int) -> Image.Image:
    """Diagonal gradient from the top-left to the bottom-right corner."""
    img = Image.new("RGBA", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)) + (255,)
    return img


def draw_icon() -> Image.Image:
    small = 256  # the gradient is smooth, so build it small and scale it up
    background = gradient(small).resize((SIZE, SIZE), Image.BICUBIC)

    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=230, fill=255)
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(background, (0, 0), mask)

    draw = ImageDraw.Draw(icon)
    # Speech bubble: a thread of comments.
    draw.rounded_rectangle((210, 220, 814, 700), radius=130, fill=WHITE)
    draw.polygon([(300, 650), (270, 830), (470, 690)], fill=WHITE)
    # Download arrow inside the bubble.
    arrow = BOTTOM + (255,)
    draw.rounded_rectangle((466, 320, 558, 500), radius=30, fill=arrow)
    draw.polygon([(362, 470), (662, 470), (512, 620)], fill=arrow)
    return icon


def main() -> None:
    icon = draw_icon()
    out = ROOT / "icons"
    out.mkdir(exist_ok=True)
    for size in (16, 32, 48, 128):
        icon.resize((size, size), Image.LANCZOS).save(out / f"icon-{size}.png", optimize=True)
    icon.resize((512, 512), Image.LANCZOS).save(ROOT / "docs" / "images" / "logo.png", optimize=True)
    print("Wrote icons/icon-{16,32,48,128}.png and docs/images/logo.png")


if __name__ == "__main__":
    main()
