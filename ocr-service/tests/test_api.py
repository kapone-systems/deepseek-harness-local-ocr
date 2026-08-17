from __future__ import annotations

import asyncio
import io
import threading
import time
from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient
from PIL import Image, features

from local_ocr_service.app import LocalOcrRequestGuardMiddleware, OcrCoordinator, create_app
from local_ocr_service.config import Settings
from local_ocr_service.errors import EngineUnavailableError, ServiceError
from local_ocr_service.models import EngineBlock


class FakeEngine:
    def __init__(
        self,
        blocks: list[EngineBlock] | None = None,
        callback: Callable[[Image.Image, str], list[EngineBlock]] | None = None,
    ) -> None:
        self.blocks = blocks or []
        self.callback = callback
        self.calls: list[tuple[tuple[int, int], str]] = []

    def recognize(self, image: Image.Image, language: str) -> list[EngineBlock]:
        self.calls.append((image.size, language))
        if self.callback is not None:
            return self.callback(image, language)
        return self.blocks

    def status(self) -> dict[str, object]:
        return {"name": "fake", "initialized": True, "device": "cpu"}


def settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "service_token": "",
        "language": "ch",
        "use_gpu": False,
        "max_file_mb": 15,
        "timeout_seconds": 1,
        "min_confidence": 0.5,
        "max_concurrency": 2,
        "queue_timeout_seconds": 0.05,
        "max_image_edge": 12_000,
        "max_pixels": 40_000_000,
    }
    values.update(overrides)
    return Settings(**values)


def image_bytes(
    format_name: str = "PNG",
    *,
    size: tuple[int, int] = (40, 20),
) -> bytes:
    image = Image.new("RGB", size, "white")
    output = io.BytesIO()
    image.save(output, format=format_name)
    return output.getvalue()


def upload(
    data: bytes | None = None,
    *,
    filename: str = "sample.png",
    mime: str = "image/png",
) -> dict[str, tuple[str, bytes, str]]:
    return {"file": (filename, data if data is not None else image_bytes(), mime)}


def error_code(response) -> str:
    return response.json()["error"]["code"]


def test_health_does_not_run_inference() -> None:
    engine = FakeEngine()
    with TestClient(create_app(settings(), engine)) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["ready"] is True
    assert response.json()["capabilities"]["layout_analysis"] is False
    assert engine.calls == []
    assert response.headers["cache-control"] == "no-store"


def test_full_image_response_and_confidence_filtering() -> None:
    engine = FakeEngine(
        [
            EngineBlock(
                text="连接服务器失败",
                bbox=((1, 2), (20, 2), (20, 8), (1, 8)),
                confidence=0.96,
            ),
            EngineBlock(
                text="not retained",
                bbox=((1, 10), (20, 10), (20, 16), (1, 16)),
                confidence=0.2,
            ),
        ]
    )
    with TestClient(create_app(settings(), engine)) as client:
        response = client.post("/v1/ocr", files=upload())

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "request_id",
        "image",
        "blocks",
        "full_text",
        "warnings",
        "elapsed_ms",
    }
    assert body["image"] == {"width": 40, "height": 20}
    assert body["full_text"] == "连接服务器失败"
    assert body["blocks"][0] == {
        "text": "连接服务器失败",
        "bbox": [[1.0, 2.0], [20.0, 2.0], [20.0, 8.0], [1.0, 8.0]],
        "confidence": 0.96,
        "line": 1,
    }
    assert "1 block(s)" in body["warnings"][0]
    assert engine.calls == [((40, 20), "ch")]


def test_blank_image_returns_success_with_empty_blocks() -> None:
    with TestClient(create_app(settings(), FakeEngine())) as client:
        response = client.post("/v1/ocr", files=upload())

    assert response.status_code == 200
    assert response.json()["blocks"] == []
    assert response.json()["full_text"] == ""
    assert response.json()["warnings"] == []


def test_region_crop_and_coordinate_translation() -> None:
    engine = FakeEngine(
        [
            EngineBlock(
                text="region",
                bbox=((0, 0), (8, 0), (8, 4), (0, 4)),
                confidence=0.9,
            )
        ]
    )
    with TestClient(create_app(settings(), engine)) as client:
        response = client.post(
            "/v1/ocr/region",
            files=upload(),
            data={"x": "10", "y": "5", "width": "12", "height": "8"},
        )

    assert response.status_code == 200
    assert engine.calls == [((12, 8), "ch")]
    assert response.json()["image"] == {"width": 40, "height": 20}
    assert response.json()["blocks"][0]["bbox"] == [
        [10.0, 5.0],
        [18.0, 5.0],
        [18.0, 9.0],
        [10.0, 9.0],
    ]


@pytest.mark.parametrize(
    ("format_name", "filename", "mime"),
    [
        ("PNG", "sample.png", "image/png"),
        ("JPEG", "sample.jpeg", "image/jpeg"),
    ],
)
def test_supported_formats(format_name: str, filename: str, mime: str) -> None:
    with TestClient(create_app(settings(), FakeEngine())) as client:
        response = client.post(
            "/v1/ocr",
            files=upload(image_bytes(format_name), filename=filename, mime=mime),
        )
    assert response.status_code == 200


def test_webp_format() -> None:
    assert features.check("webp"), "Pillow was installed without required WebP decoder support."
    with TestClient(create_app(settings(), FakeEngine())) as client:
        response = client.post(
            "/v1/ocr",
            files=upload(image_bytes("WEBP"), filename="sample.webp", mime="image/webp"),
        )
    assert response.status_code == 200


@pytest.mark.parametrize(
    ("files", "expected_status", "expected_code"),
    [
        (upload(b"plain text", filename="sample.txt", mime="text/plain"), 415, "UNSUPPORTED_EXTENSION"),
        (upload(b"plain text"), 415, "INVALID_IMAGE_SIGNATURE"),
        (upload(b"\x89PNG\r\n\x1a\ntruncated"), 400, "CORRUPT_IMAGE"),
        (upload(image_bytes("JPEG")), 415, "IMAGE_TYPE_MISMATCH"),
        (upload(filename="sample.bmp", mime="image/png"), 415, "UNSUPPORTED_EXTENSION"),
        (upload(filename="sample.png", mime="application/octet-stream"), 415, "UNSUPPORTED_MEDIA_TYPE"),
        (upload(b""), 400, "EMPTY_UPLOAD"),
    ],
)
def test_rejects_invalid_uploads(files, expected_status: int, expected_code: str) -> None:
    with TestClient(create_app(settings(), FakeEngine())) as client:
        response = client.post("/v1/ocr", files=files)

    assert response.status_code == expected_status
    assert error_code(response) == expected_code
    assert "request_id" in response.json()["error"]


def test_rejects_encoded_file_over_limit() -> None:
    tiny_limit = settings(max_file_mb=0.00001)
    with TestClient(create_app(tiny_limit, FakeEngine())) as client:
        response = client.post("/v1/ocr", files=upload())

    assert response.status_code == 413
    assert error_code(response) == "IMAGE_TOO_LARGE"


def test_rejects_declared_request_over_limit_before_multipart_parsing() -> None:
    configured = settings(max_file_mb=0.00001)
    with TestClient(create_app(configured, FakeEngine())) as client:
        response = client.post(
            "/v1/ocr",
            content=b"not-a-multipart-body",
            headers={
                "content-type": "multipart/form-data; boundary=test",
                "content-length": str(configured.max_request_bytes + 1),
            },
        )

    assert response.status_code == 413
    assert error_code(response) == "IMAGE_TOO_LARGE"
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
async def test_guard_rejects_chunked_body_before_downstream_can_spool_it() -> None:
    incoming = iter(
        [
            {"type": "http.request", "body": b"123456", "more_body": True},
            {"type": "http.request", "body": b"789012", "more_body": False},
        ]
    )
    sent: list[dict] = []

    async def receive() -> dict:
        return next(incoming)

    async def send(message: dict) -> None:
        sent.append(message)

    async def downstream(scope: dict, receive, send) -> None:
        del scope, send
        while True:
            event = await receive()
            if not event.get("more_body"):
                return

    middleware = LocalOcrRequestGuardMiddleware(
        downstream,
        max_request_bytes=10,
        bearer_token="",
    )
    await middleware(
        {"type": "http", "path": "/v1/ocr", "headers": []},
        receive,
        send,
    )

    assert sent[0]["status"] == 413
    assert b"IMAGE_TOO_LARGE" in sent[1]["body"]


def test_rejects_edge_and_pixel_limits_before_ocr() -> None:
    edge_engine = FakeEngine()
    with TestClient(create_app(settings(max_image_edge=9), edge_engine)) as client:
        edge_response = client.post(
            "/v1/ocr", files=upload(image_bytes(size=(10, 2)))
        )
    assert error_code(edge_response) == "IMAGE_EDGE_LIMIT_EXCEEDED"
    assert edge_engine.calls == []

    pixel_engine = FakeEngine()
    with TestClient(create_app(settings(max_pixels=19), pixel_engine)) as client:
        pixel_response = client.post(
            "/v1/ocr", files=upload(image_bytes(size=(10, 2)))
        )
    assert error_code(pixel_response) == "IMAGE_PIXEL_LIMIT_EXCEEDED"
    assert pixel_engine.calls == []


@pytest.mark.parametrize(
    ("region", "expected_code"),
    [
        ({"x": "-1", "y": "0", "width": "1", "height": "1"}, "INVALID_REGION"),
        ({"x": "0", "y": "0", "width": "0", "height": "1"}, "INVALID_REGION"),
        ({"x": "39", "y": "0", "width": "2", "height": "1"}, "REGION_OUT_OF_BOUNDS"),
    ],
)
def test_rejects_invalid_regions(region: dict[str, str], expected_code: str) -> None:
    with TestClient(create_app(settings(), FakeEngine())) as client:
        response = client.post("/v1/ocr/region", files=upload(), data=region)
    assert response.status_code == 422
    assert error_code(response) == expected_code


def test_missing_region_field_has_structured_error() -> None:
    with TestClient(create_app(settings(), FakeEngine())) as client:
        response = client.post(
            "/v1/ocr/region",
            files=upload(),
            data={"x": "0", "y": "0", "width": "10"},
        )
    assert response.status_code == 422
    assert error_code(response) == "INVALID_REQUEST"


def test_optional_bearer_authentication() -> None:
    secured = settings(service_token="local-secret")
    with TestClient(create_app(secured, FakeEngine())) as client:
        missing = client.post("/v1/ocr", files=upload())
        invalid = client.post(
            "/v1/ocr",
            files=upload(),
            headers={"Authorization": "Bearer wrong"},
        )
        valid = client.post(
            "/v1/ocr",
            files=upload(),
            headers={"Authorization": "Bearer local-secret"},
        )

    assert missing.status_code == 401
    assert invalid.status_code == 401
    assert missing.headers["www-authenticate"] == "Bearer"
    assert valid.status_code == 200


def test_engine_unavailable_is_safe_and_structured() -> None:
    def unavailable(image: Image.Image, language: str) -> list[EngineBlock]:
        del image, language
        raise EngineUnavailableError("sensitive backend detail")

    with TestClient(create_app(settings(), FakeEngine(callback=unavailable))) as client:
        response = client.post("/v1/ocr", files=upload())

    assert response.status_code == 503
    assert error_code(response) == "OCR_ENGINE_UNAVAILABLE"
    assert "sensitive" not in response.text


def test_timeout_returns_without_waiting_for_full_inference() -> None:
    def slow(image: Image.Image, language: str) -> list[EngineBlock]:
        del image, language
        time.sleep(0.15)
        return []

    app = create_app(settings(timeout_seconds=0.02), FakeEngine(callback=slow))
    with TestClient(app) as client:
        started = time.perf_counter()
        response = client.post("/v1/ocr", files=upload())
        elapsed = time.perf_counter() - started
        # Let the worker finish so its semaphore callback executes before loop teardown.
        time.sleep(0.18)

    assert response.status_code == 504
    assert error_code(response) == "OCR_TIMEOUT"
    assert elapsed < 0.12


@pytest.mark.asyncio
async def test_coordinator_enforces_concurrency_limit() -> None:
    state_lock = threading.Lock()
    active = 0
    maximum_active = 0

    def measured(image: Image.Image, language: str) -> list[EngineBlock]:
        nonlocal active, maximum_active
        del image, language
        with state_lock:
            active += 1
            maximum_active = max(maximum_active, active)
        time.sleep(0.04)
        with state_lock:
            active -= 1
        return []

    coordinator = OcrCoordinator(
        FakeEngine(callback=measured),
        concurrency=1,
        timeout_seconds=1,
        queue_timeout_seconds=0.1,
    )
    image = Image.new("RGB", (2, 2), "white")

    await asyncio.gather(
        coordinator.recognize(image, "ch"),
        coordinator.recognize(image, "ch"),
    )

    assert maximum_active == 1


@pytest.mark.asyncio
async def test_coordinator_returns_busy_when_queue_wait_expires() -> None:
    started = threading.Event()
    release = threading.Event()

    def blocked(image: Image.Image, language: str) -> list[EngineBlock]:
        del image, language
        started.set()
        release.wait(1)
        return []

    coordinator = OcrCoordinator(
        FakeEngine(callback=blocked),
        concurrency=1,
        timeout_seconds=1,
        queue_timeout_seconds=0.01,
    )
    image = Image.new("RGB", (2, 2), "white")
    first = asyncio.create_task(coordinator.recognize(image, "ch"))
    assert await asyncio.to_thread(started.wait, 0.5)
    with pytest.raises(ServiceError) as raised:
        await coordinator.recognize(image, "ch")
    release.set()
    await first

    assert raised.value.code == "OCR_BUSY"
    assert raised.value.status_code == 429
