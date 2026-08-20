"""Run the OCR API on the loopback interface only."""

from __future__ import annotations

import uvicorn

from .config import Settings


def main() -> None:
    settings = Settings()
    uvicorn.run(
        "local_ocr_service.app:app",
        host="127.0.0.1",
        port=settings.service_port,
        access_log=True,
    )


if __name__ == "__main__":
    main()
