# Compatibility Matrix

| Component | Supported/verified version | Notes |
| --- | --- | --- |
| DeepSeek Harness | `@deepseek-ai/dsh@0.1.0-rc.6` | Current plugin API baseline |
| Node.js | `22.19+` or `24+` | Required by Harness and Runtime CLI |
| Python | `3.10`-`3.12` | 3.12.13 used for the verification run |
| PaddleOCR | `3.7.0` | Locked by `ocr-service/pyproject.toml` |
| PaddlePaddle | `3.3.1` | CPU build verified; CUDA build is not CI-verified |
| FastAPI | `0.141.1` | Locked by the Python constraints file |
| TypeScript plugin | `dsh-plugin-local-ocr@0.2.0` | Peer dependencies target Harness rc.6 |
| Runtime CLI | `dsh-local-ocr-runtime@0.2.0` | Bundles the service source for npm installs |

Older Harness releases and PaddleOCR 2.x are not part of the V2 support
matrix. A mismatch should be resolved with `dsh-local-ocr-runtime doctor` and
matching plugin/runtime versions.
