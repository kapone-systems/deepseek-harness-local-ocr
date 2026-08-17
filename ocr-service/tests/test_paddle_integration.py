"""Optional live PaddleOCR smoke test.

The test is intentionally opt-in because PaddleOCR may download its public
model files on first initialization. It never sends fixture pixels to a
vision API.
"""

from __future__ import annotations

import os
from importlib.util import find_spec
from pathlib import Path

import pytest


pytestmark = pytest.mark.skipif(
    os.getenv("RUN_PADDLE_OCR_TESTS") != "1",
    reason="set RUN_PADDLE_OCR_TESTS=1 to run live PaddleOCR integration tests",
)


def test_paddleocr_cpu_end_to_end_fixtures() -> None:
    if find_spec("paddleocr") is None:
        pytest.fail("PaddleOCR is not installed; rerun scripts/install.ps1 without -SkipPaddle.")
    from fastapi.testclient import TestClient

    from local_ocr_service.app import create_app
    from local_ocr_service.config import Settings

    fixtures = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
    settings = Settings(
        service_token="",
        language="ch",
        use_gpu=False,
        timeout_seconds=120,
        queue_timeout_seconds=5,
    )
    with TestClient(create_app(settings)) as client:
        def post(name: str, path: str = "/v1/ocr", data: dict[str, str] | None = None):
            fixture = fixtures / name
            with fixture.open("rb") as handle:
                return client.post(
                    path,
                    files={"file": (fixture.name, handle.read(), "image/png")},
                    data=data,
                )

        english = post("english-screenshot.png")
        chinese = post("chinese-screenshot.png")
        blank = post("blank.png")
        region = post(
            "region-grid.png",
            "/v1/ocr/region",
            {"x": "500", "y": "0", "width": "500", "height": "600"},
        )

    assert english.status_code == 200, english.text
    assert "LOCAL" in english.json()["full_text"].upper()
    assert chinese.status_code == 200, chinese.text
    assert "连接" in chinese.json()["full_text"]
    assert blank.status_code == 200, blank.text
    assert blank.json()["blocks"] == []
    assert region.status_code == 200, region.text
    assert region.json()["blocks"]
    assert all(point[0] >= 500 for block in region.json()["blocks"] for point in block["bbox"])
