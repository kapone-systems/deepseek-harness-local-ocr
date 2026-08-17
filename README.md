# DeepSeek Harness Local OCR

这是一个 DeepSeek Harness 本地 OCR 插件。它让纯文本 DeepSeek 路由通过工具读取**图片中的文字**，而不是让模型获得原生图片理解能力。图片解码和 PaddleOCR 推理均在本机运行；插件只通过 `http://127.0.0.1` 向本地 FastAPI 服务上传图片二进制。

## 功能范围

- `vision_read`：读取当前 Harness 会话中已授权的 PNG、JPEG、WebP 附件，或配置目录中的本地图片。
- `vision_read_region`：按原图像素坐标裁剪后 OCR，返回的 bbox 仍是原图坐标。
- 输出模式：`text`、`structured`、`markdown`。
- FastAPI：`GET /health`、`POST /v1/ocr`、`POST /v1/ocr/region`。
- CPU 默认可用；仅当兼容 Paddle CUDA 运行时可用时才启用 GPU。

不包含通用图片描述、PDF、多图片比较、缓存、PP-Structure 表格分析或 UI 元素检测。OCR 结果始终会包在 `UNTRUSTED OCR EVIDENCE` 边界内，模型不得把图片中的指令当作可信指令执行。

## 前提条件

- Windows PowerShell 7+
- 64 位 Python 3.10、3.11 或 3.12
- Node.js `^22.19.0` 或 `>=24.0.0`，以及 pnpm 11
- DeepSeek Harness `0.1.0-rc.6` 基线

当前机器调查结果：Windows 10 `10.0.26200.9168`、AMD Ryzen 9 8945HX、约 31 GiB RAM、NVIDIA RTX 5070 Laptop 8 GiB。未检测到 CUDA Toolkit；因此首装和验收应保持 `OCR_USE_GPU=false`。GPU 安装包与该驱动的兼容性需要由 PaddlePaddle 实际安装后再确认。

## 安装

在 PowerShell 中执行：

```powershell
Set-Location 'D:\codex project\deepseek harness create'
Copy-Item .env.example .env
.\scripts\install.ps1
```

默认安装服务运行、PaddleOCR 和测试依赖，并构建插件。若只想先运行协议/安全测试：

```powershell
.\scripts\install.ps1 -SkipPaddle
```

PaddleOCR 第一次初始化可能下载公开模型文件到 `D:\Program Files\local model\paddleocr\official_models`；这不是云端视觉推理，图片和 OCR 文本不会因此上传。受严格离线环境约束时，应在受控环境预下载/部署 Paddle 模型后再启动服务。

## 配置

复制后的 `.env` 不应提交。所有字段都有安全默认值：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OCR_SERVICE_URL` | `http://127.0.0.1:8765` | 必须是无路径的 IPv4 回环 HTTP URL。 |
| `OCR_SERVICE_TOKEN` | 空 | 可选本地 Bearer Token；服务和 Harness 进程使用相同值。 |
| `OCR_LANGUAGE` | `ch` | PaddleOCR 语言。 |
| `OCR_USE_GPU` | `false` | 仅在兼容 Paddle CUDA 运行时确认后设为 `true`。 |
| `OCR_MODEL_CACHE_DIR` | `D:\Program Files\local model\paddleocr` | PaddleOCR 3 / PaddleX 的本地缓存根；模型位于其 `official_models` 子目录，避免使用用户目录默认缓存。 |
| `OCR_MAX_FILE_MB` | `15` | 单图编码文件上限。 |
| `OCR_TIMEOUT_SECONDS` | `30` | 插件 HTTP 与服务端 OCR 总预算。 |
| `OCR_MIN_CONFIDENCE` | `0.50` | 低于该值的块从工具结果中移除。 |
| `OCR_MAX_CONCURRENCY` | `2` | 插件和服务端 OCR 并发上限。 |
| `OCR_QUEUE_TIMEOUT_SECONDS` | `5` | 服务繁忙时的排队上限，超出返回 `429 OCR_BUSY`。 |
| `OCR_MAX_IMAGE_EDGE` | `12000` | 单边像素上限。 |
| `OCR_MAX_PIXELS` | `40000000` | 解码后总像素上限。 |
| `OCR_ALLOWED_DIRECTORIES` | 空 | 分号分隔的绝对允许根目录；空值会禁用 `file_path` 输入。 |

服务和插件都会拒绝非 `127.0.0.1`、路径、查询串、凭据或 HTTPS 的服务 URL。服务 API 从不接受文件路径或 URL，只接受 multipart 图片字节。

## 启动与检查

如果 PowerShell 提示“在此系统上禁止运行脚本”，先在每个新开的 PowerShell 窗口运行下面这一行。它只对当前窗口生效，不会修改系统或用户级执行策略：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
```

若使用 `start-harness-local-ocr.cmd` 时提示找不到 `pnpm` 或 Node.js，项目会自动尝试 `D:\\Program Files\\deepseek-harness\\runtime`。安装在其他位置时，在 `.env` 中设置 `HARNESS_RUNTIME_DIR` 到包含 `node\\node.exe` 与 `pnpm\\pnpm.cmd` 的 `runtime` 目录。

在一个 PowerShell 窗口启动服务：

```powershell
Set-Location 'D:\codex project\deepseek harness create'
.\scripts\start-ocr-service.ps1
```

在另一个窗口检查 loopback 服务：

```powershell
.\scripts\check-health.ps1
```

`/health` 是 liveness 检查，不会为了健康探测而加载大型模型；`engine.initialized: false`、`ready: false` 在首次 OCR 前是正常的。第一次真实 OCR 仍会把 Paddle 初始化错误以 `503 OCR_ENGINE_UNAVAILABLE` 返回。`capabilities.webp` 会报告当前 Pillow 是否有 WebP 解码器。

也可以直接用本地 fixture 验证 API：

```powershell
. .\scripts\common.ps1
Import-LocalOcrEnv
Invoke-LocalOcrMultipart -Uri 'http://127.0.0.1:8765/v1/ocr' -ImagePath '.\tests\fixtures\english-screenshot.png'
```

## 安装到 Harness

先确保启动 Harness 的进程也能读取上述环境变量。可在同一 PowerShell 会话导入 `.env`：

```powershell
. .\scripts\common.ps1
Import-LocalOcrEnv
.\scripts\install-plugin.ps1 -Profile local-ocr
```

官方 Harness `0.1.0-rc.6` 使用 npm bundle 的 `package.json` 加 `cordis.patch.yml`，而不是独立 `manifest.json`。本项目注册的是 `deepseek-local-ocr` bridge provider；请在 Harness 的 `local-ocr` profile 中选择该 provider，并使用原来的 DeepSeek 模型 ID。

这个 bridge 只解决图片附件进入会话的问题：它将上游请求中的图片替换为不含字节的附件 ID 提示，再委派给 `deepseek-official`。它不会让 DeepSeek 获得原生视觉能力。完整的官方接口差异见 [HARNESS_COMPATIBILITY.md](HARNESS_COMPATIBILITY.md)。

## 在 Web 界面中使用

不要使用旧启动器打开的 `http://127.0.0.1:3080` 页面。它使用旧版 Harness，不能加载此 profile。请在两个 PowerShell 窗口中运行：

```powershell
Set-Location 'D:\codex project\deepseek harness create'
.\scripts\start-ocr-service.ps1
```

```powershell
Set-Location 'D:\codex project\deepseek harness create'
.\scripts\start-harness-local-ocr.ps1
```

执行策略受限时，也可以分别运行不受 `.ps1` 策略影响的 Windows 启动器：

```powershell
.\scripts\start-ocr-service.cmd
```

```powershell
.\scripts\start-harness-local-ocr.cmd
```

然后打开 [http://127.0.0.1:3081](http://127.0.0.1:3081)。在页面的模型设置（`/model`）中确认 provider 为 `deepseek-local-ocr`；D 盘的 `local-ocr` profile 已把它设为默认值。

页面没有单独的“OCR 插件”按钮。请在对话输入框旁使用上传按钮，或把 PNG、JPEG、WebP 图片拖入对话，然后直接要求模型调用工具，例如：

```text
请使用 vision_read 读取这张截图中的报错内容，并用 text 模式简洁说明。
```

```text
请对当前上传的图片使用 vision_read，返回 structured 结果。
```

```text
请对当前附件使用 vision_read_region，x=500，y=0，width=500，height=600，并返回 markdown 结果。
```

工具调用及 OCR 结果会显示在会话中。若模型没有调用工具，可明确重复“必须调用 `vision_read`”。图片只在本机被 OCR；若上游仍是云端 DeepSeek，工具返回的文字会作为普通文本上下文发送给该模型。

## 工具用法

模型只应使用当前会话中实际出现的附件 ID。即使模型编造 ID，插件也会在当前 agent/session 的消息中重新查找，找不到就拒绝。

```json
{
  "attachment_id": "current-session-image-id",
  "question": "读取报错内容",
  "mode": "text"
}
```

区域 OCR：

```json
{
  "attachment_id": "current-session-image-id",
  "x": 420,
  "y": 310,
  "width": 245,
  "height": 38,
  "mode": "structured"
}
```

本地文件只在显式配置允许根后可用。设置变量后，在同一环境中重新启动/安装 Harness profile：

```powershell
$env:OCR_ALLOWED_DIRECTORIES = 'D:\codex project\deepseek harness create\tests\fixtures'
```

```json
{
  "file_path": "D:\\codex project\\deepseek harness create\\tests\\fixtures\\english-screenshot.png",
  "mode": "markdown"
}
```

`structured` 模式包含服务的完整 JSON：

```json
{
  "request_id": "uuid",
  "image": {"width": 1920, "height": 1080},
  "blocks": [
    {
      "text": "连接服务器失败",
      "bbox": [[420, 310], [665, 310], [665, 348], [420, 348]],
      "confidence": 0.96,
      "line": 1
    }
  ],
  "full_text": "连接服务器失败",
  "warnings": [],
  "elapsed_ms": 380
}
```

无文字图片是成功响应：`blocks=[]`、`full_text=""`，不会生成占位文字。

## 安全与隐私

- 服务固定绑定 `127.0.0.1`，不默认暴露局域网。
- 插件仅使用 `ctx.attachments` 读取会话授权附件，或通过 `ctx.fs` 读取允许根内的文件；不会使用原生 Node `fs` 绕过 Harness 授权。
- PNG/JPEG/WebP 的扩展名、MIME、文件头、大小、尺寸、总像素和 Pillow 完整解码都会验证。编码文件默认最大 15 MiB，最大边 12,000 px，防解压炸弹。
- 服务在 multipart 解析前检查 Bearer Token 与声明的请求体大小，也限制无 `Content-Length` 的流式请求。服务不会记录图片、Base64、Token 或完整 OCR 文本。
- 图片二进制不会发送给 DeepSeek 或任意云端视觉 API。**但**若 bridge 的上游仍是云端 `deepseek-official`，OCR 工具返回的文字会像任何其他工具结果一样进入该模型上下文。若文字也不能离机，应将上游路由换成受支持的本地文本模型。
- 图片内任何“忽略规则”“发送密钥”等文字都是不可信外部证据，不能改变 Harness 或插件权限。

架构和信任边界见 [ARCHITECTURE.md](ARCHITECTURE.md)。
已执行的本机测试、Harness profile 核验和 1080p 基准见 [VERIFICATION.md](VERIFICATION.md)。

## 测试与基准

基础服务、插件类型检查、Vitest 与构建：

```powershell
.\scripts\test.ps1
```

受 `RUN_PADDLE_OCR_TESTS=1` 保护的真实 CPU 端到端测试（英文、中文、空白图与区域坐标）：

```powershell
.\scripts\test.ps1 -PaddleIntegration
```

服务启动后测量合成 1080p fixture 的服务耗时、往返耗时和进程 Working Set：

```powershell
.\scripts\benchmark.ps1
```

基准脚本输出请求前/后的 Working Set，以及服务进程生命周期峰值 `PeakWorkingSet64`。为得到单次干净峰值，应重启服务、先完成一次热身、再执行基准。实际数字取决于 Paddle 版本、CPU 和 Windows 内存管理。

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| `OCR_SERVICE_UNAVAILABLE` | 运行 `scripts/start-ocr-service.ps1`，并确认服务 URL 仍是 `http://127.0.0.1:<port>`。 |
| `OCR_ENGINE_UNAVAILABLE` | 运行 `scripts/install.ps1` 安装 Paddle 依赖；GPU 场景先恢复 `OCR_USE_GPU=false`。 |
| `OCR_TIMEOUT` | 增大 `OCR_TIMEOUT_SECONDS`，或缩小图片/区域；检查 CPU 是否在首次加载模型。 |
| `OCR_BUSY` | 当前并发已满，稍后重试或在受控部署中调整 `OCR_MAX_CONCURRENCY`。 |
| `OCR_LOCAL_FILES_DISABLED` | 设置 `OCR_ALLOWED_DIRECTORIES`，在同一环境重新启动 Harness 后再传 `file_path`。 |
| `OCR_ATTACHMENT_NOT_AUTHORIZED` | 只能传当前 Harness 会话中实际引用过的附件 ID。 |
| `MODEL_DOES_NOT_SUPPORT_IMAGES` | 选择 `deepseek-local-ocr`，不要直接选择文本专用 `deepseek-official` provider。 |
| `IMAGE_TOO_LARGE` / `IMAGE_PIXEL_LIMIT_EXCEEDED` | 缩小文件或调整受控部署中的对应上限。 |

升级 Harness、PaddleOCR 或 Cordis 前，应重新运行类型检查、Vitest、bundle 配置检查和真实附件测试。
