# dsh-local-ocr-runtime

The runtime owns the Python virtual environment, PaddleOCR model cache, service
logs, and process state. Nothing is written into the repository by default.

```powershell
npx dsh-local-ocr-runtime doctor
npx dsh-local-ocr-runtime setup --yes
npx dsh-local-ocr-runtime start
npx dsh-local-ocr-runtime status --json
npx dsh-local-ocr-runtime stop
```

`setup` prints the locked PaddleOCR `3.7.0` / PaddlePaddle `3.3.1` model source,
model family, estimated size, cache path, and local-only privacy behavior before asking for consent. `--yes` is the
explicit consent flag for unattended setup. `--skip-model-download` records
consent but leaves models deferred; `start` will then return
`OCR_MODEL_NOT_READY` until setup is rerun.

The npm package carries the verified `local_ocr_service` source under
`service/`, so a published install does not require a source checkout or a
separately published Python package. The command also accepts `--service-dir`
for a repository development checkout. The service always binds to
`http://127.0.0.1:<port>` and rejects path-bearing or non-loopback URLs.

Stable error codes include `OCR_RUNTIME_NOT_INSTALLED`,
`OCR_RUNTIME_NOT_RUNNING`, `OCR_MODEL_NOT_READY`, `OCR_VERSION_MISMATCH`, and
`OCR_RUNTIME_PROCESS_CONFLICT`. Error output includes a command that can fix
the condition. `stop` verifies the recorded PID command line before sending a
signal, so it will not terminate an unrelated process that reused a stale PID.

`doctor` also warns about the V2 preview profile patch that forced
`deepseek-local-ocr/deepseek-v4-flash`. Run the suggested
`scripts/install-plugin.ps1` migration and restart Harness; the current bundle
never chooses a provider or model.

Use this Runtime lifecycle consistently. A repository checkout's
`scripts/start-ocr-service.ps1` launches a separate development service and is
not owned by this CLI; do not run both against the same `127.0.0.1` port.
