"""PaddleOCR adapter with 2.x and 3.x result compatibility."""

from __future__ import annotations

import inspect
import json
import math
import os
import threading
from collections.abc import Mapping, Sequence
from importlib import metadata
from pathlib import Path
from typing import Any, Protocol

from PIL import Image

from .errors import EngineUnavailableError
from .models import EngineBlock, Quad


class OcrEngine(Protocol):
    def recognize(self, image: Image.Image, language: str) -> list[EngineBlock]: ...

    def status(self) -> dict[str, object]: ...


class PaddleOcrEngine:
    """Lazily creates a local PaddleOCR predictor and normalizes its output."""

    def __init__(
        self,
        *,
        language: str,
        use_gpu: bool = False,
        model_cache_dir: Path | None = None,
    ) -> None:
        self.language = language
        self.use_gpu = use_gpu
        self.model_cache_dir = model_cache_dir
        self._backend: Any | None = None
        self._major_version: int | None = None
        self._initialization_lock = threading.Lock()
        # Paddle predictors are not guaranteed to be thread-safe.
        self._inference_lock = threading.Lock()

    def status(self) -> dict[str, object]:
        return {
            "name": "paddleocr",
            "initialized": self._backend is not None,
            "device": "gpu" if self.use_gpu else "cpu",
            "layout_analysis": False,
        }

    def recognize(self, image: Image.Image, language: str) -> list[EngineBlock]:
        if language != self.language:
            raise EngineUnavailableError("The configured engine language cannot change at runtime.")
        backend = self._get_backend()
        try:
            import numpy as np
        except ImportError as exc:  # pragma: no cover - declared runtime dependency
            raise EngineUnavailableError("NumPy is required by PaddleOCR.") from exc

        image_array = np.asarray(image)
        with self._inference_lock:
            if self._major_version is not None and self._major_version >= 3:
                raw_result = backend.predict(image_array)
            else:
                raw_result = backend.ocr(image_array, cls=True)
            # PaddleOCR 3 may return a lazy iterable, so consume it while the
            # shared predictor remains protected by the inference lock.
            return parse_paddle_result(raw_result)

    def _get_backend(self) -> Any:
        if self._backend is not None:
            return self._backend
        with self._initialization_lock:
            if self._backend is None:
                self._backend, self._major_version = self._create_backend()
        return self._backend

    def _create_backend(self) -> tuple[Any, int]:
        if self.use_gpu:
            _verify_gpu_available()
        configure_paddle_model_cache(self.model_cache_dir)
        try:
            from paddleocr import PaddleOCR
        except Exception as exc:
            raise EngineUnavailableError(
                "PaddleOCR is not installed. Install the service OCR dependencies first."
            ) from exc

        try:
            version = metadata.version("paddleocr")
            major = int(version.split(".", 1)[0])
        except (metadata.PackageNotFoundError, ValueError):
            major = 3 if hasattr(PaddleOCR, "predict") else 2

        try:
            if major >= 3:
                backend = _create_v3_backend(PaddleOCR, self.language, self.use_gpu)
            else:
                backend = PaddleOCR(
                    lang=self.language,
                    use_gpu=self.use_gpu,
                    use_angle_cls=True,
                    show_log=False,
                )
        except Exception as exc:
            raise EngineUnavailableError("PaddleOCR could not initialize on the requested device.") from exc
        return backend, major


def configure_paddle_model_cache(model_cache_dir: Path | None) -> None:
    """Configure PaddleOCR 3's current local PaddleX model cache.

    This runs before importing ``paddleocr`` because PaddleX reads its cache
    setting while locating or downloading official model artifacts.
    """

    if model_cache_dir is None:
        return
    try:
        resolved = model_cache_dir.expanduser().resolve(strict=False)
        if resolved.exists() and not resolved.is_dir():
            raise OSError("configured model cache is not a directory")
        resolved.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise EngineUnavailableError(
            "The configured local OCR model cache cannot be created or used."
        ) from exc
    # PaddleX 3.7 reads this while importing its cache module, and stores
    # downloaded PaddleOCR artifacts under ``official_models`` below it.
    os.environ["PADDLE_PDX_CACHE_HOME"] = str(resolved)


def _create_v3_backend(factory: Any, language: str, use_gpu: bool) -> Any:
    kwargs: dict[str, object] = {
        "lang": language,
        "device": "gpu:0" if use_gpu else "cpu",
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": True,
    }
    # PaddlePaddle 3.3's Windows CPU oneDNN path can reject some PP-OCRv6
    # attributes at inference time. PaddleOCR exposes this documented switch;
    # use the portable Paddle backend for the CPU-first service.
    if not use_gpu:
        kwargs["enable_mkldnn"] = False
    try:
        parameters = inspect.signature(factory).parameters
    except (TypeError, ValueError):
        parameters = {}
    if parameters and not any(p.kind == inspect.Parameter.VAR_KEYWORD for p in parameters.values()):
        kwargs = {name: value for name, value in kwargs.items() if name in parameters}
    return factory(**kwargs)


def _verify_gpu_available() -> None:
    try:
        import paddle
    except Exception as exc:
        raise EngineUnavailableError("PaddlePaddle is unavailable.") from exc

    try:
        compiled = bool(paddle.is_compiled_with_cuda())
        count = int(paddle.device.cuda.device_count()) if compiled else 0
    except Exception as exc:
        raise EngineUnavailableError("The Paddle GPU runtime could not be inspected.") from exc
    if not compiled or count < 1:
        raise EngineUnavailableError(
            "OCR_USE_GPU is enabled, but no compatible Paddle CUDA device is available."
        )


def parse_paddle_result(raw_result: Any) -> list[EngineBlock]:
    """Normalize PaddleOCR 3.x mappings or legacy 2.x nested lines."""

    v3_blocks: list[EngineBlock] = []
    for item in _top_level_items(raw_result):
        mapping = _coerce_mapping(item)
        if mapping is not None:
            v3_blocks.extend(_parse_v3_mapping(mapping))
    if v3_blocks:
        return v3_blocks

    legacy_blocks: list[EngineBlock] = []
    _collect_legacy_lines(raw_result, legacy_blocks)
    return legacy_blocks


def _top_level_items(value: Any) -> list[Any]:
    if isinstance(value, Mapping):
        return [value]
    if isinstance(value, (str, bytes, bytearray)):
        return [value]
    if isinstance(value, Sequence):
        return list(value)
    try:
        return list(value)
    except TypeError:
        return [value]


def _coerce_mapping(item: Any) -> Mapping[str, Any] | None:
    value = item
    if isinstance(value, Mapping):
        return value
    for attribute in ("json", "to_dict"):
        candidate = getattr(value, attribute, None)
        if candidate is None:
            continue
        try:
            converted = candidate() if callable(candidate) else candidate
        except Exception:
            continue
        if isinstance(converted, Mapping):
            return converted
        if isinstance(converted, str):
            try:
                parsed = json.loads(converted)
            except (TypeError, ValueError):
                continue
            if isinstance(parsed, Mapping):
                return parsed
    return None


def _parse_v3_mapping(mapping: Mapping[str, Any]) -> list[EngineBlock]:
    for wrapper in ("res", "result", "ocr_res"):
        nested = mapping.get(wrapper)
        if isinstance(nested, Mapping):
            parsed = _parse_v3_mapping(nested)
            if parsed:
                return parsed

    texts = _as_list(mapping.get("rec_texts"))
    scores = _as_list(mapping.get("rec_scores"))
    boxes_value = mapping.get("rec_polys")
    if boxes_value is None:
        boxes_value = mapping.get("dt_polys")
    if boxes_value is None:
        boxes_value = mapping.get("rec_boxes")
    boxes = _as_list(boxes_value)

    blocks: list[EngineBlock] = []
    for index, text in enumerate(texts):
        if index >= len(scores) or index >= len(boxes) or not isinstance(text, str):
            continue
        confidence = _finite_float(scores[index])
        bbox = _to_quad(boxes[index])
        if confidence is not None and bbox is not None:
            blocks.append(EngineBlock(text=text, bbox=bbox, confidence=confidence))
    return blocks


def _collect_legacy_lines(value: Any, output: list[EngineBlock]) -> None:
    if _looks_like_legacy_line(value):
        bbox = _to_quad(value[0])
        text = value[1][0]
        confidence = _finite_float(value[1][1])
        if bbox is not None and isinstance(text, str) and confidence is not None:
            output.append(EngineBlock(text=text, bbox=bbox, confidence=confidence))
        return
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for child in value:
            _collect_legacy_lines(child, output)


def _looks_like_legacy_line(value: Any) -> bool:
    return (
        isinstance(value, Sequence)
        and not isinstance(value, (str, bytes, bytearray))
        and len(value) >= 2
        and isinstance(value[1], Sequence)
        and not isinstance(value[1], (str, bytes, bytearray))
        and len(value[1]) >= 2
        and isinstance(value[1][0], str)
    )


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if hasattr(value, "tolist"):
        try:
            value = value.tolist()
        except Exception:
            return []
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return list(value)
    try:
        return list(value)
    except TypeError:
        return []


def _to_quad(value: Any) -> Quad | None:
    points = _as_list(value)
    if len(points) == 4 and all(_finite_float(item) is not None for item in points):
        left, top, right, bottom = (float(item) for item in points)
        return ((left, top), (right, top), (right, bottom), (left, bottom))
    if len(points) < 4:
        return None

    normalized: list[tuple[float, float]] = []
    for point in points[:4]:
        coordinates = _as_list(point)
        if len(coordinates) < 2:
            return None
        x = _finite_float(coordinates[0])
        y = _finite_float(coordinates[1])
        if x is None or y is None:
            return None
        normalized.append((x, y))
    return tuple(normalized)  # type: ignore[return-value]


def _finite_float(value: Any) -> float | None:
    try:
        converted = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return converted if math.isfinite(converted) else None
