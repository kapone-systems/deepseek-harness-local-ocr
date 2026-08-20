# Performance Baseline

The benchmark is intentionally reproducible and does not send fixture pixels
to a remote service:

```powershell
.\scripts\benchmark.ps1 -ImagePath .\tests\fixtures\benchmark-1080p.png
.\scripts\benchmark.ps1 -Matrix -Requests 2
```

The V1 Windows CPU observation (Python 3.12, PaddleOCR 3.7.0) was about
15.4 seconds for a warm 1920x1080 request and about 1.9 GB process-lifetime
peak working set. The result varies with model cache, CPU, and Paddle build.
V2 keeps CPU as the conservative default and reports the actual device/model
in `doctor`; GPU mode must be explicitly selected and is not claimed as
verified until the local CUDA stack passes the same benchmark.

Before a release, record cold start, warm single request, region OCR, Chinese
and English fixtures, multi-column fixture, and concurrency runs in this file
along with Python, Paddle, device, elapsed time, and peak memory.
