"""Strict image upload validation and decoding."""

from __future__ import annotations

import io
import warnings
from dataclasses import dataclass
from pathlib import PurePath

from fastapi import UploadFile
from PIL import Image, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

from .config import Settings
from .errors import ServiceError


_FORMATS = {
    "PNG": ({".png"}, {"image/png"}),
    "JPEG": ({".jpg", ".jpeg"}, {"image/jpeg"}),
    "WEBP": ({".webp"}, {"image/webp"}),
}


@dataclass(frozen=True, slots=True)
class DecodedImage:
    image: Image.Image
    width: int
    height: int
    format: str


def _detect_magic(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "PNG"
    if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    return None


async def decode_upload(upload: UploadFile, settings: Settings) -> DecodedImage:
    """Read a bounded upload, verify all type signals, then decode one image."""

    filename = upload.filename or ""
    extension = PurePath(filename).suffix.lower()
    content_type = (upload.content_type or "").split(";", 1)[0].strip().lower()

    if not any(extension in extensions for extensions, _ in _FORMATS.values()):
        raise ServiceError(
            "UNSUPPORTED_EXTENSION",
            "Only .png, .jpg, .jpeg, and .webp uploads are accepted.",
            415,
        )
    if not any(content_type in mime_types for _, mime_types in _FORMATS.values()):
        raise ServiceError(
            "UNSUPPORTED_MEDIA_TYPE",
            "Only image/png, image/jpeg, and image/webp are accepted.",
            415,
        )

    chunks: list[bytes] = []
    total = 0
    try:
        while True:
            chunk = await upload.read(64 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > settings.max_file_bytes:
                raise ServiceError(
                    "IMAGE_TOO_LARGE",
                    f"Image exceeds the configured {settings.max_file_mb:g} MB limit.",
                    413,
                )
            chunks.append(chunk)
    finally:
        await upload.close()

    data = b"".join(chunks)
    if not data:
        raise ServiceError("EMPTY_UPLOAD", "The uploaded image is empty.", 400)

    magic_format = _detect_magic(data)
    if magic_format is None:
        raise ServiceError(
            "INVALID_IMAGE_SIGNATURE",
            "The upload does not have a supported image signature.",
            415,
        )

    expected_extensions, expected_mime_types = _FORMATS[magic_format]
    if extension not in expected_extensions or content_type not in expected_mime_types:
        raise ServiceError(
            "IMAGE_TYPE_MISMATCH",
            "The filename, MIME type, and image signature do not agree.",
            415,
        )

    return await run_in_threadpool(_decode_image_bytes, data, magic_format, settings)


def _decode_image_bytes(data: bytes, magic_format: str, settings: Settings) -> DecodedImage:
    """Run CPU-heavy Pillow decode outside FastAPI's event loop."""

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as probe:
                decoded_format = (probe.format or "").upper()
                width, height = probe.size
                if decoded_format != magic_format:
                    raise ServiceError(
                        "IMAGE_TYPE_MISMATCH",
                        "The decoded image format does not match its signature.",
                        415,
                    )
                _validate_dimensions(width, height, settings)
                probe.verify()

            with Image.open(io.BytesIO(data)) as source:
                _validate_dimensions(source.width, source.height, settings)
                source.load()
                image = _to_rgb(source)
    except ServiceError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ServiceError(
            "IMAGE_PIXEL_LIMIT_EXCEEDED",
            "The image exceeds the safe decoded-pixel limit.",
            413,
        ) from None
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
        raise ServiceError(
            "CORRUPT_IMAGE",
            "The upload could not be decoded as a complete image.",
            400,
        ) from None

    return DecodedImage(image=image, width=width, height=height, format=magic_format)


def _validate_dimensions(width: int, height: int, settings: Settings) -> None:
    if width < 1 or height < 1:
        raise ServiceError("INVALID_IMAGE_DIMENSIONS", "Image dimensions are invalid.", 400)
    if width > settings.max_image_edge or height > settings.max_image_edge:
        raise ServiceError(
            "IMAGE_EDGE_LIMIT_EXCEEDED",
            f"Image width and height must not exceed {settings.max_image_edge} pixels.",
            413,
        )
    if width * height > settings.max_pixels:
        raise ServiceError(
            "IMAGE_PIXEL_LIMIT_EXCEEDED",
            "The image exceeds the safe decoded-pixel limit.",
            413,
        )


def _to_rgb(source: Image.Image) -> Image.Image:
    if source.mode in {"RGBA", "LA"} or "transparency" in source.info:
        rgba = source.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(background, rgba).convert("RGB")
    return source.convert("RGB")
