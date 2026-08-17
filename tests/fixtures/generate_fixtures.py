"""Generate deterministic, non-sensitive OCR fixtures with Pillow."""

from __future__ import annotations

from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent


def first_font(candidates: list[Path], size: int) -> ImageFont.FreeTypeFont:
    for candidate in candidates:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size=size)
    raise RuntimeError(
        "No suitable TrueType font found. Pass a system with Microsoft YaHei, "
        "Noto Sans CJK, or DejaVu Sans installed."
    )


def fonts(size: int) -> tuple[ImageFont.FreeTypeFont, ImageFont.FreeTypeFont]:
    windows = Path("C:/Windows/Fonts")
    linux = Path("/usr/share/fonts/truetype")
    latin = first_font(
        [
            windows / "segoeui.ttf",
            windows / "arial.ttf",
            linux / "dejavu/DejaVuSans.ttf",
        ],
        size,
    )
    cjk = first_font(
        [
            windows / "msyh.ttc",
            windows / "simhei.ttf",
            linux / "noto/NotoSansCJK-Regular.ttc",
            linux / "wqy/wqy-zenhei.ttc",
        ],
        size,
    )
    return latin, cjk


def canvas(width: int, height: int, color: str = "white") -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGB", (width, height), color)
    return image, ImageDraw.Draw(image)


def save(image: Image.Image, name: str) -> None:
    image.save(ROOT / name, format="PNG", optimize=False)


def english_fixture() -> None:
    image, draw = canvas(1200, 500, "#f7f8fa")
    title, _ = fonts(62)
    body, _ = fonts(48)
    draw.rectangle((45, 40, 1155, 460), fill="white", outline="#30343b", width=3)
    draw.text((95, 95), "LOCAL OCR TEST", font=title, fill="#111111")
    draw.text((95, 215), "Build status: PASSED", font=body, fill="#146b3a")
    draw.text((95, 320), "Error code: 503", font=body, fill="#a12622")
    save(image, "english-screenshot.png")


def chinese_fixture() -> None:
    image, draw = canvas(1200, 500, "#f5f7fb")
    latin, cjk = fonts(58)
    _, cjk_body = fonts(52)
    draw.rectangle((45, 40, 1155, 460), fill="white", outline="#273142", width=3)
    draw.text((95, 85), "本地 OCR 测试", font=cjk, fill="#111111")
    draw.text((95, 205), "连接服务器失败", font=cjk_body, fill="#a12622")
    draw.text((95, 325), "Retry after 30 seconds", font=latin, fill="#273142")
    save(image, "chinese-screenshot.png")


def region_fixture() -> None:
    image, draw = canvas(1000, 600, "white")
    latin, cjk = fonts(54)
    draw.rectangle((0, 0, 499, 599), fill="#eef6ff", outline="#1f4b73", width=4)
    draw.rectangle((500, 0, 999, 599), fill="#fff4ec", outline="#8a3f16", width=4)
    draw.text((80, 110), "LEFT PANEL", font=latin, fill="#111111")
    draw.text((80, 255), "订单 1024", font=cjk, fill="#111111")
    draw.text((570, 110), "RIGHT PANEL", font=latin, fill="#111111")
    draw.text((570, 255), "状态 正常", font=cjk, fill="#111111")
    save(image, "region-grid.png")


def blank_fixture() -> None:
    image, _ = canvas(640, 360, "white")
    save(image, "blank.png")


def benchmark_fixture() -> None:
    image, draw = canvas(1920, 1080, "#eef1f5")
    title, cjk_title = fonts(64)
    body, cjk_body = fonts(42)
    draw.rectangle((70, 60, 1850, 1020), fill="white", outline="#252a31", width=3)
    draw.text((125, 105), "DeepSeek Harness - Local OCR", font=title, fill="#111111")
    draw.text((125, 230), "OCR 全程在本机运行", font=cjk_title, fill="#111111")
    rows = [
        ("Service", "127.0.0.1:8765", "READY"),
        ("Engine", "PaddleOCR CPU", "LOADED"),
        ("Document", "synthetic screenshot", "SAFE"),
        ("Result", "English + 中文", "PASSED"),
    ]
    y = 390
    for label, value, state in rows:
        draw.line((125, y - 25, 1785, y - 25), fill="#d3d7dd", width=2)
        draw.text((145, y), label, font=body, fill="#2d333b")
        value_font = cjk_body if any(ord(ch) > 127 for ch in value) else body
        draw.text((590, y), value, font=value_font, fill="#111111")
        draw.text((1450, y), state, font=body, fill="#146b3a")
        y += 135
    draw.text((125, 930), "No cloud vision API is used.", font=body, fill="#5b6470")
    save(image, "benchmark-1080p.png")


def main() -> int:
    english_fixture()
    chinese_fixture()
    region_fixture()
    blank_fixture()
    benchmark_fixture()
    print(f"Generated OCR fixtures in {ROOT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
