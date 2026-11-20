"""生成扩展图标（渐变色圆角方块 + 白色「译」字）。"""

import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

C1 = np.array([59, 107, 255], dtype=np.float32)   # #3B6BFF
C2 = np.array([124, 92, 255], dtype=np.float32)   # #7C5CFF


def gradient(size):
    y, x = np.mgrid[0:size, 0:size].astype(np.float32) / (size - 1)
    t = np.clip(x * 0.55 + y * 0.45, 0.0, 1.0)[..., None]
    rgb = C1 * (1 - t) + C2 * t
    return Image.fromarray(rgb.astype(np.uint8), "RGB")


def rounded_mask(size, radius, inset):
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(
        [inset, inset, size - 1 - inset, size - 1 - inset],
        radius=radius,
        fill=255,
    )
    return mask


def find_font(size):
    for path in (
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
    ):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def build():
    base = gradient(SIZE)
    mask = rounded_mask(SIZE, radius=int(SIZE * 0.23), inset=int(SIZE * 0.03))
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(base, (0, 0), mask)

    draw = ImageDraw.Draw(icon)
    font = find_font(int(SIZE * 0.60))
    text = "译"
    box = draw.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    draw.text(
        ((SIZE - tw) / 2 - box[0], (SIZE - th) / 2 - box[1] - SIZE * 0.01),
        text,
        font=font,
        fill=(255, 255, 255, 255),
    )

    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        icon.resize((size, size), Image.LANCZOS).save(
            os.path.join(OUT_DIR, f"icon{size}.png"), optimize=True
        )
        print("wrote", os.path.join(OUT_DIR, f"icon{size}.png"))


if __name__ == "__main__":
    build()
