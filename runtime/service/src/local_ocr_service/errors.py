"""Errors that are safe to expose to a local HTTP caller."""

from __future__ import annotations


class ServiceError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        status_code: int,
        *,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.headers = headers or {}


class EngineUnavailableError(RuntimeError):
    """Raised when PaddleOCR cannot be loaded with the requested device."""
