from __future__ import annotations

import math
import os

from local_ocr_service.engine import (
    _create_v3_backend,
    configure_paddle_model_cache,
    parse_paddle_result,
)


def test_configures_paddle_model_cache_before_backend_import(tmp_path) -> None:
    target = tmp_path / "paddleocr"

    configure_paddle_model_cache(target)

    assert target.is_dir()
    assert os.environ["PADDLE_PDX_CACHE_HOME"] == str(target.resolve())


def test_v3_cpu_backend_disables_mkldnn() -> None:
    captured: dict[str, object] = {}

    def factory(**kwargs):
        captured.update(kwargs)
        return object()

    _create_v3_backend(factory, "ch", use_gpu=False)

    assert captured["device"] == "cpu"
    assert captured["enable_mkldnn"] is False


def test_parses_paddleocr_2_nested_result() -> None:
    raw = [
        [
            [
                [[1, 2], [11, 2], [11, 8], [1, 8]],
                ("legacy text", 0.93),
            ]
        ]
    ]

    blocks = parse_paddle_result(raw)

    assert len(blocks) == 1
    assert blocks[0].text == "legacy text"
    assert blocks[0].confidence == 0.93
    assert blocks[0].bbox[2] == (11.0, 8.0)


def test_parses_paddleocr_3_result_mapping() -> None:
    raw = [
        {
            "res": {
                "rec_texts": ["first", "second"],
                "rec_scores": [0.99, 0.81],
                "rec_polys": [
                    [[0, 0], [10, 0], [10, 5], [0, 5]],
                    [[2, 8], [12, 8], [12, 14], [2, 14]],
                ],
            }
        }
    ]

    blocks = parse_paddle_result(raw)

    assert [block.text for block in blocks] == ["first", "second"]
    assert blocks[1].bbox[0] == (2.0, 8.0)


def test_parses_v3_rectangular_rec_boxes() -> None:
    raw = {
        "rec_texts": ["box"],
        "rec_scores": [0.75],
        "rec_boxes": [[3, 4, 13, 9]],
    }

    [block] = parse_paddle_result(raw)

    assert block.bbox == ((3.0, 4.0), (13.0, 4.0), (13.0, 9.0), (3.0, 9.0))


def test_ignores_malformed_engine_entries() -> None:
    raw = {
        "rec_texts": ["valid shape, invalid score", "missing box"],
        "rec_scores": [math.nan, 0.9],
        "rec_polys": [[[0, 0], [1, 0], [1, 1], [0, 1]]],
    }

    assert parse_paddle_result(raw) == []


class JsonResult:
    @property
    def json(self) -> dict[str, object]:
        return {
            "res": {
                "rec_texts": ["property"],
                "rec_scores": [0.88],
                "rec_polys": [[[1, 1], [2, 1], [2, 2], [1, 2]]],
            }
        }


def test_reads_paddle_result_json_property() -> None:
    [block] = parse_paddle_result([JsonResult()])
    assert block.text == "property"


class JsonStringResult:
    @property
    def json(self) -> str:
        return '{"res":{"rec_texts":["json string"],"rec_scores":[0.91],"rec_polys":[[[1,1],[3,1],[3,2],[1,2]]]}}'


def test_reads_paddle_result_json_string_property() -> None:
    [block] = parse_paddle_result([JsonStringResult()])
    assert block.text == "json string"
    assert block.confidence == 0.91
