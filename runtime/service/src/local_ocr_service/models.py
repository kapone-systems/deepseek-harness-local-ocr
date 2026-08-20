"""Public response models and the engine-neutral OCR representation."""

from __future__ import annotations

import math
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field, field_validator


Point = tuple[float, float]
Quad = tuple[Point, Point, Point, Point]

# The wire contract is versioned independently from the service package. Keep
# the value short so clients can compare it without parsing semver metadata.
OCR_RESPONSE_VERSION = "2"


@dataclass(frozen=True, slots=True)
class EngineBlock:
    """A text block returned by an OCR engine in input-image coordinates."""

    text: str
    bbox: Quad
    confidence: float


class ImageInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    width: int = Field(ge=1)
    height: int = Field(ge=1)


class OcrBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    bbox: list[list[float]]
    confidence: float = Field(ge=0, le=1)
    block_index: int = Field(ge=0)
    line_index: int = Field(ge=0)
    reading_order: int = Field(ge=0)
    # V1 compatibility alias. It is the one-based block ordinal, not a true
    # visual line number. New clients should use line_index instead.
    line: int = Field(ge=1)

    @field_validator("bbox")
    @classmethod
    def validate_bbox(cls, value: list[list[float]]) -> list[list[float]]:
        if len(value) != 4 or any(len(point) != 2 for point in value):
            raise ValueError("bbox must contain four x/y points")
        if any(not math.isfinite(coordinate) for point in value for coordinate in point):
            raise ValueError("bbox coordinates must be finite")
        return value


class OcrResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    response_version: str = Field(default=OCR_RESPONSE_VERSION, min_length=1, max_length=16)
    request_id: str
    image: ImageInfo
    blocks: list[OcrBlock]
    full_text: str
    warnings: list[str]
    elapsed_ms: int = Field(ge=0)
