# OCR test fixtures

These synthetic images contain no personal or production data. Regenerate them
with `python tests/fixtures/generate_fixtures.py` when the fixture text changes.

- `english-screenshot.png`: high-contrast English application text.
- `chinese-screenshot.png`: high-contrast Simplified Chinese and English text.
- `region-grid.png`: spatially separated labels for region-coordinate tests.
- `blank.png`: an empty image that must produce zero OCR blocks.
- `benchmark-1080p.png`: a synthetic 1920x1080 screenshot for local benchmarks.
