"""Environment-backed service settings."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuration shared by the HTTP layer and OCR adapter."""

    model_config = SettingsConfigDict(
        env_prefix="OCR_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    service_url: str = "http://127.0.0.1:8765"
    service_token: SecretStr | None = None
    language: str = Field(default="ch", min_length=1, max_length=32)
    use_gpu: bool = False
    # PaddleOCR 3's model assets are cached locally. Keep this optional so a
    # controlled deployment can still use PaddleOCR's vendor default.
    model_cache_dir: Path | None = None
    max_file_mb: float = Field(default=15.0, gt=0, le=512)
    timeout_seconds: float = Field(default=30.0, gt=0, le=600)
    min_confidence: float = Field(default=0.50, ge=0, le=1)
    max_concurrency: int = Field(default=2, ge=1, le=32)
    queue_timeout_seconds: float = Field(default=5.0, gt=0, le=60)

    # These defensive limits may be overridden for controlled deployments.
    max_image_edge: int = Field(default=12_000, ge=1, le=100_000)
    max_pixels: int = Field(default=40_000_000, ge=1, le=500_000_000)

    @field_validator("service_url")
    @classmethod
    def validate_service_url(cls, value: str) -> str:
        parsed = urlparse(value)
        if (
            parsed.scheme != "http"
            or parsed.hostname != "127.0.0.1"
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.params
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("OCR_SERVICE_URL must be a pathless http://127.0.0.1 URL")
        try:
            port = parsed.port
        except ValueError as exc:
            raise ValueError("OCR_SERVICE_URL must contain a valid port") from exc
        if port is None or port < 1 or port > 65_535:
            raise ValueError("OCR_SERVICE_URL must include a port")
        return value

    @field_validator("model_cache_dir")
    @classmethod
    def validate_model_cache_dir(cls, value: Path | None) -> Path | None:
        if value is None:
            return None
        expanded = value.expanduser()
        if not expanded.is_absolute():
            raise ValueError("OCR_MODEL_CACHE_DIR must be an absolute path")
        return expanded

    @property
    def max_file_bytes(self) -> int:
        return int(self.max_file_mb * 1024 * 1024)

    @property
    def max_request_bytes(self) -> int:
        """Allow a small multipart envelope in addition to the file limit."""

        return self.max_file_bytes + 64 * 1024

    @property
    def bearer_token(self) -> str:
        if self.service_token is None:
            return ""
        return self.service_token.get_secret_value()

    @property
    def service_port(self) -> int:
        port = urlparse(self.service_url).port
        assert port is not None
        return port
