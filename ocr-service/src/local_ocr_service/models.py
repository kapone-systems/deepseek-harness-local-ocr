"""Public response models and the engine-neutral OCR representation."""

from __future__ import annotations

import math
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field, field_validator


Point = tuple[float, float]
Quad = tuple[Point, Point, Point, Point]


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

    request_id: str
    image: ImageInfo
    blocks: list[OcrBlock]
    full_text: str
    warnings: list[str]
    elapsed_ms: int = Field(ge=0)
