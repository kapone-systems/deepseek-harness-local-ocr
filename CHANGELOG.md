# Changelog

## Unreleased

- Removed the V2 bundle's forced `deepseek-local-ocr/deepseek-v4-flash`
  selection. The plugin now leaves model selection to the user and migrates
  the exact legacy profile override during source installs.
- Changed the bridge from one hard-coded `deepseek-official` upstream to a
  dynamic catalog of all currently registered providers. The selected upstream
  provider and model are encoded in the bridge model identity, so same-named
  models from official, OpenCode Go, or other sources remain distinct.
- Raised the CPU OCR timeout default to 90 seconds and changed the default
  concurrency to one request to avoid timeout-to-busy cascades on slow images.

## 0.2.0

- Added the independently installable `dsh-local-ocr-runtime` CLI with
  `doctor`, `setup`, `start`, `status`, and `stop`.
- Added explicit model-download consent, isolated runtime state, PID ownership
  checks, loopback enforcement, and actionable runtime error codes.
- Made model-cache readiness recursive and made `status` distinguish incomplete
  setup/model-not-ready states from a stopped service.
- Versioned OCR responses and added `block_index`, `line_index`, and
  `reading_order` while retaining the V1 `line` field.
- Added row clustering, coordinate-preserving region OCR, rotation/blank
  warnings, pinned Python constraints, and release-oriented documentation.

## 0.1.0

- Initial local PaddleOCR Harness plugin and loopback OCR service release.
