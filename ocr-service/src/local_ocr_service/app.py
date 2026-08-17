"""FastAPI application for loopback-only local OCR."""

from __future__ import annotations

import asyncio
import json
import logging
import math
import secrets
import time
import uuid
from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, FastAPI, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from PIL import features
from starlette.concurrency import run_in_threadpool

from .config import Settings
from .engine import OcrEngine, PaddleOcrEngine
from .errors import EngineUnavailableError, ServiceError
from .models import EngineBlock, ImageInfo, OcrBlock, OcrResponse
from .validation import DecodedImage, decode_upload


logger = logging.getLogger("local_ocr_service")


class LocalOcrRequestGuardMiddleware:
    """Reject unauthorized or oversized OCR uploads before multipart parsing.

    Starlette otherwise parses multipart uploads before ``UploadFile`` reaches
    the endpoint. This guard limits both declared and chunked request bodies,
    so an oversized upload cannot first consume an unbounded spool file.
    """

    def __init__(
        self,
        app: Callable,
        *,
        max_request_bytes: int,
        bearer_token: str,
    ) -> None:
        self.app = app
        self.max_request_bytes = max_request_bytes
        self.bearer_token = bearer_token

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope.get("type") != "http" or scope.get("path") not in {"/v1/ocr", "/v1/ocr/region"}:
            await self.app(scope, receive, send)
            return

        request_id = str(uuid.uuid4())
        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        if self.bearer_token and not _valid_bearer(headers.get("authorization", ""), self.bearer_token):
            await self._send_error(
                send,
                request_id,
                "UNAUTHORIZED",
                "A valid local OCR service Bearer token is required.",
                401,
                {"WWW-Authenticate": "Bearer"},
            )
            return

        content_length = _content_length(headers.get("content-length"))
        if content_length is not None and content_length > self.max_request_bytes:
            await self._send_error(
                send,
                request_id,
                "IMAGE_TOO_LARGE",
                "Image exceeds the configured upload-size limit.",
                413,
            )
            return

        received = 0

        async def receive_limited() -> dict:
            nonlocal received
            message = await receive()
            if message.get("type") == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_request_bytes:
                    raise ServiceError(
                        "IMAGE_TOO_LARGE",
                        "Image exceeds the configured upload-size limit.",
                        413,
                    )
            return message

        response_started = False

        async def guarded_send(message: dict) -> None:
            nonlocal response_started
            if message.get("type") == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, receive_limited, guarded_send)
        except ServiceError as exc:
            if response_started:
                raise
            await self._send_error(send, request_id, exc.code, exc.message, exc.status_code, exc.headers)

    @staticmethod
    async def _send_error(
        send: Callable,
        request_id: str,
        code: str,
        message: str,
        status_code: int,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(
            {"error": {"code": code, "message": message, "request_id": request_id}},
            separators=(",", ":"),
        ).encode("utf-8")
        headers = [
            (b"content-type", b"application/json"),
            (b"cache-control", b"no-store"),
            (b"x-request-id", request_id.encode("ascii")),
            (b"content-length", str(len(body)).encode("ascii")),
        ]
        if extra_headers:
            headers.extend(
                (name.lower().encode("ascii"), value.encode("latin-1"))
                for name, value in extra_headers.items()
            )
        await send({"type": "http.response.start", "status": status_code, "headers": headers})
        await send({"type": "http.response.body", "body": body})


def _content_length(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


class OcrCoordinator:
    """Bounds concurrent work while allowing an HTTP timeout to return early."""

    def __init__(
        self,
        engine: OcrEngine,
        *,
        concurrency: int,
        timeout_seconds: float,
        queue_timeout_seconds: float,
    ) -> None:
        self.engine = engine
        self.timeout_seconds = timeout_seconds
        self.queue_timeout_seconds = queue_timeout_seconds
        self._semaphore = asyncio.Semaphore(concurrency)

    async def recognize(
        self,
        image: object,
        language: str,
        timeout_seconds: float | None = None,
    ) -> list[EngineBlock]:
        loop = asyncio.get_running_loop()
        budget = self.timeout_seconds if timeout_seconds is None else min(timeout_seconds, self.timeout_seconds)
        deadline = loop.time() + budget
        try:
            await asyncio.wait_for(self._semaphore.acquire(), min(self.queue_timeout_seconds, budget))
        except TimeoutError as exc:
            raise ServiceError(
                "OCR_BUSY",
                "Local OCR is busy; retry after an in-progress request completes.",
                429,
                headers={"Retry-After": "1"},
            ) from exc

        remaining = deadline - loop.time()
        if remaining <= 0:
            self._semaphore.release()
            raise self._timeout_error()
        task = asyncio.create_task(run_in_threadpool(self.engine.recognize, image, language))
        try:
            result = await asyncio.wait_for(asyncio.shield(task), remaining)
        except TimeoutError as exc:
            self._release_when_finished(task)
            raise self._timeout_error() from exc
        except BaseException:
            if task.done():
                self._semaphore.release()
            else:
                self._release_when_finished(task)
            raise
        else:
            self._semaphore.release()
            return result

    def _release_when_finished(self, task: asyncio.Task[list[EngineBlock]]) -> None:
        def release(done: asyncio.Task[list[EngineBlock]]) -> None:
            try:
                done.exception()
            except asyncio.CancelledError:
                pass
            self._semaphore.release()

        task.add_done_callback(release)

    @staticmethod
    def _timeout_error() -> ServiceError:
        return ServiceError(
            "OCR_TIMEOUT",
            "Local OCR processing exceeded the configured timeout.",
            504,
        )


def create_app(
    settings: Settings | None = None,
    engine: OcrEngine | None = None,
) -> FastAPI:
    configured = settings or Settings()
    configured_engine = engine or PaddleOcrEngine(
        language=configured.language,
        use_gpu=configured.use_gpu,
        model_cache_dir=configured.model_cache_dir,
    )

    application = FastAPI(
        title="DeepSeek Harness Local OCR Service",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    application.state.settings = configured
    application.state.engine = configured_engine
    application.state.coordinator = OcrCoordinator(
        configured_engine,
        concurrency=configured.max_concurrency,
        timeout_seconds=configured.timeout_seconds,
        queue_timeout_seconds=configured.queue_timeout_seconds,
    )
    application.add_middleware(
        LocalOcrRequestGuardMiddleware,
        max_request_bytes=configured.max_request_bytes,
        bearer_token=configured.bearer_token,
    )

    @application.middleware("http")
    async def assign_request_id(request: Request, call_next: Callable):
        request.state.request_id = str(uuid.uuid4())
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["Cache-Control"] = "no-store"
        return response

    @application.exception_handler(ServiceError)
    async def service_error_handler(request: Request, exc: ServiceError) -> JSONResponse:
        return _error_response(request, exc.code, exc.message, exc.status_code, exc.headers)

    @application.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        del exc
        return _error_response(
            request,
            "INVALID_REQUEST",
            "Required multipart fields are missing or invalid.",
            422,
        )

    @application.exception_handler(Exception)
    async def unexpected_error_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.error(
            "Unhandled OCR service error request_id=%s error_type=%s",
            _request_id(request),
            type(exc).__name__,
        )
        return _error_response(
            request,
            "INTERNAL_ERROR",
            "The local OCR service encountered an internal error.",
            500,
        )

    @application.get("/health")
    async def health(request: Request) -> dict[str, object]:
        current_engine: OcrEngine = request.app.state.engine
        try:
            engine_status = current_engine.status()
        except Exception:
            engine_status = {"name": "unknown", "initialized": False}
        return {
            "status": "ok",
            "service": "deepseek-harness-local-ocr",
            "engine": engine_status,
            "ready": bool(engine_status.get("initialized", False)),
            "capabilities": {
                "ocr": True,
                "region": True,
                "layout_analysis": False,
                "webp": bool(features.check("webp")),
            },
        }

    @application.post("/v1/ocr", response_model=OcrResponse)
    async def ocr(
        request: Request,
        file: UploadFile,
        _: None = Depends(_authorize),
    ) -> OcrResponse:
        return await _handle_ocr(request, file)

    @application.post("/v1/ocr/region", response_model=OcrResponse)
    async def ocr_region(
        request: Request,
        file: UploadFile,
        x: Annotated[int, Form()],
        y: Annotated[int, Form()],
        width: Annotated[int, Form()],
        height: Annotated[int, Form()],
        _: None = Depends(_authorize),
    ) -> OcrResponse:
        return await _handle_ocr(request, file, region=(x, y, width, height))

    return application


async def _authorize(request: Request) -> None:
    settings: Settings = request.app.state.settings
    expected = settings.bearer_token
    if not expected:
        return
    supplied = request.headers.get("authorization", "")
    if not _valid_bearer(supplied, expected):
        raise ServiceError(
            "UNAUTHORIZED",
            "A valid local OCR service Bearer token is required.",
            401,
            headers={"WWW-Authenticate": "Bearer"},
        )


def _valid_bearer(supplied: str, expected: str) -> bool:
    scheme, separator, token = supplied.partition(" ")
    return separator == " " and scheme.lower() == "bearer" and secrets.compare_digest(token, expected)


async def _handle_ocr(
    request: Request,
    upload: UploadFile,
    region: tuple[int, int, int, int] | None = None,
) -> OcrResponse:
    started = time.perf_counter()
    settings: Settings = request.app.state.settings
    decoded = await decode_upload(upload, settings)

    offset_x = 0
    offset_y = 0
    processing_image = decoded.image
    if region is not None:
        offset_x, offset_y, width, height = _validate_region(region, decoded)
        processing_image = decoded.image.crop(
            (offset_x, offset_y, offset_x + width, offset_y + height)
        )

    coordinator: OcrCoordinator = request.app.state.coordinator
    remaining_seconds = settings.timeout_seconds - (time.perf_counter() - started)
    if remaining_seconds <= 0:
        raise OcrCoordinator._timeout_error()
    try:
        raw_blocks = await coordinator.recognize(
            processing_image,
            settings.language,
            timeout_seconds=remaining_seconds,
        )
    except ServiceError:
        raise
    except EngineUnavailableError as exc:
        logger.warning(
            "OCR engine unavailable request_id=%s error_type=%s",
            _request_id(request),
            type(exc).__name__,
        )
        raise ServiceError(
            "OCR_ENGINE_UNAVAILABLE",
            "The local PaddleOCR engine is unavailable or misconfigured.",
            503,
        ) from exc
    except Exception as exc:
        logger.error(
            "OCR inference failed request_id=%s error_type=%s",
            _request_id(request),
            type(exc).__name__,
        )
        raise ServiceError(
            "OCR_PROCESSING_FAILED",
            "The local OCR engine failed to process the image.",
            500,
        ) from exc

    bounds_width = processing_image.width
    bounds_height = processing_image.height
    blocks, response_warnings = _normalize_blocks(
        raw_blocks,
        min_confidence=settings.min_confidence,
        offset_x=offset_x,
        offset_y=offset_y,
        bounds_width=bounds_width,
        bounds_height=bounds_height,
    )
    elapsed_ms = max(0, round((time.perf_counter() - started) * 1000))
    return OcrResponse(
        request_id=_request_id(request),
        image=ImageInfo(width=decoded.width, height=decoded.height),
        blocks=blocks,
        full_text="\n".join(block.text for block in blocks),
        warnings=response_warnings,
        elapsed_ms=elapsed_ms,
    )


def _validate_region(
    region: tuple[int, int, int, int], decoded: DecodedImage
) -> tuple[int, int, int, int]:
    x, y, width, height = region
    if x < 0 or y < 0 or width <= 0 or height <= 0:
        raise ServiceError(
            "INVALID_REGION",
            "Region x/y must be non-negative and width/height must be positive.",
            422,
        )
    if x + width > decoded.width or y + height > decoded.height:
        raise ServiceError(
            "REGION_OUT_OF_BOUNDS",
            "The requested region must fit entirely inside the source image.",
            422,
        )
    return region


def _normalize_blocks(
    raw_blocks: list[EngineBlock],
    *,
    min_confidence: float,
    offset_x: int,
    offset_y: int,
    bounds_width: int,
    bounds_height: int,
) -> tuple[list[OcrBlock], list[str]]:
    output: list[OcrBlock] = []
    low_confidence_count = 0
    invalid_count = 0
    for raw in raw_blocks:
        confidence = float(raw.confidence)
        if not math.isfinite(confidence) or confidence < 0 or confidence > 1:
            invalid_count += 1
            continue
        if confidence < min_confidence:
            low_confidence_count += 1
            continue
        if not raw.text.strip() or len(raw.bbox) != 4:
            invalid_count += 1
            continue

        points: list[list[float]] = []
        valid = True
        for x, y in raw.bbox:
            if not math.isfinite(x) or not math.isfinite(y):
                valid = False
                break
            local_x = min(max(float(x), 0.0), float(bounds_width))
            local_y = min(max(float(y), 0.0), float(bounds_height))
            points.append([local_x + offset_x, local_y + offset_y])
        if not valid:
            invalid_count += 1
            continue
        output.append(
            OcrBlock(
                text=raw.text,
                bbox=points,
                confidence=confidence,
                line=len(output) + 1,
            )
        )

    response_warnings: list[str] = []
    if low_confidence_count:
        response_warnings.append(
            f"{low_confidence_count} block(s) below the minimum confidence were omitted."
        )
    if invalid_count:
        response_warnings.append(f"{invalid_count} invalid OCR block(s) were omitted.")
    return output, response_warnings


def _error_response(
    request: Request,
    code: str,
    message: str,
    status_code: int,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "error": {
                "code": code,
                "message": message,
                "request_id": _request_id(request),
            }
        },
        headers=headers,
    )


def _request_id(request: Request) -> str:
    return getattr(request.state, "request_id", str(uuid.uuid4()))


app = create_app()
