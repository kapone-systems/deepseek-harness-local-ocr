# DeepSeek Harness Local OCR

让纯文本 DeepSeek 模型通过 Harness 工具读取本地图片、截图和扫描文档中的文字。

> 这是 **本地 OCR 插件**，不是通用图片理解模型：图片字节在本机由 PaddleOCR 处理，模型收到的是 OCR 结果和坐标。

[GitHub 仓库](https://github.com/kapone-systems/dsh-vision-local-ocr) · [架构说明](ARCHITECTURE.md) · [Harness 兼容性记录](HARNESS_COMPATIBILITY.md) · [本机验证记录](VERIFICATION.md)

## 一眼看懂

| 项目 | 内容 |
| --- | --- |
| 解决的问题 | 给文本模型增加“读取图片文字”的工具能力 |
| Harness 基线 | `@deepseek-ai/dsh@0.1.0-rc.6` |
| OCR 引擎 | PaddleOCR 3（FastAPI + Uvicorn） |
| 插件语言 | TypeScript / ESM |
| 支持格式 | PNG、JPEG、WebP |
| 工具 | `vision_read`、`vision_read_region` |
| 输出模式 | `text`、`structured`、`markdown` |
| 默认设备 | CPU；兼容的 Paddle CUDA 环境可手动启用 GPU |
| OCR 地址 | `http://127.0.0.1:8765` |
| Harness Web 地址 | `http://127.0.0.1:3081` |
| 默认限制 | 15 MiB、最大边 12,000 px、总像素 40,000,000 |
| 许可证 | MIT |

## 能做什么

- 读取当前 Harness 会话中已授权的图片附件。
- 在显式配置允许目录后读取本地图片文件；服务端永远只接收图片二进制，不接收文件路径。
- 返回识别文字、原图像素坐标、置信度、图片尺寸、请求 ID 和耗时。
- 对指定矩形区域重新 OCR，返回的坐标仍对应原图。
- 通过 `deepseek-local-ocr` bridge provider 让用户选定的上游模型先接收图片附件，再调用 OCR 工具；上游可来自官方、OpenCode Go 或其他已配置来源。
- OCR 结果标记为不可信外部证据，图片里的“忽略规则”“发送密钥”等文字不会获得工具权限。

## 不是什么

本项目不提供通用图片描述、物体识别、UI 元素检测、PDF 分页、表格/复杂版面分析、多图片比较、OCR 缓存或本地视觉语言模型降级。首版目标只有一件事：**可靠地把图片文字变成模型可读的结构化文本**。

如果 bridge 的上游 provider 使用云端 DeepSeek，图片二进制仍不会上传到云端，但 OCR 文字会像普通工具结果一样进入上游模型上下文；需要文字也完全不离机时，请使用受支持的本地文本模型。

## 工作方式

~~~mermaid
flowchart LR
    U[浏览器上传图片] --> H["Harness local-ocr profile<br/>127.0.0.1:3081"]
    H --> P["TypeScript 插件<br/>工具 + 附件校验"]
    P -->|multipart 图片二进制| S["FastAPI OCR 服务<br/>127.0.0.1:8765"]
    S --> O["PaddleOCR<br/>CPU / 可选 GPU"]
    O --> R["结构化 OCR JSON<br/>不可信外部证据"]
    R --> P
    P --> M["DeepSeek 文本模型<br/>仅接收 OCR 文本"]
~~~

插件和 OCR 服务是两个独立进程。服务固定监听 `127.0.0.1`，不会默认暴露到局域网；服务 API 不接受任意路径或 URL。

## 10 分钟安装（无需 clone）

新机器可直接使用公开 npm 包安装，不需要复制源码、创建 Junction 或手工维护 `.venv`。需要 Node.js `^22.19.0` 或 `>=24.0.0`、64 位 Python 3.10/3.11/3.12，以及可写的本地磁盘。

### 1. 安装 Runtime 和模型

~~~powershell
npx dsh-local-ocr-runtime setup
~~~

命令会显示 PaddleOCR/PaddlePaddle 版本、模型来源、预计大小、缓存目录和隐私说明，并要求明确确认下载。无人值守场景必须显式传入 `--yes`；CPU 是默认设备，确认 CUDA 环境后才使用 `--gpu`：

~~~powershell
npx dsh-local-ocr-runtime setup --cpu --yes
~~~

`--skip-model-download` 只创建隔离环境并暂缓模型下载，模型未就绪前 `start` 会返回 `OCR_MODEL_NOT_READY`。

### 2. 安装 Harness 插件和 profile

~~~powershell
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile local-ocr add @deepseek-ai/dsh-web-app@0.1.0-rc.6
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile local-ocr add dsh-plugin-local-ocr
npx dsh-local-ocr-runtime doctor
~~~

第一条命令为自定义 profile 添加 Harness Web bundle；新 profile 默认只有基础 bundle，缺少它就不能提供 3081 的浏览器界面。插件是公开 npm 包，不依赖源码路径、Junction 或 `link:`。`deepseek-local-ocr` bridge 只把图片降级成附件句柄，底层仍委派给已配置的纯文本 provider。

插件不会设置或覆盖 Harness 的默认模型。需要上传图片时，在模型选择器中手动选择 `Local OCR Bridge`，再从其模型列表中选择所需的 DeepSeek 来源和模型（官方、OpenCode Go 或其他已配置 provider）。bridge 只会把图片降级为本地附件句柄，底层仍使用你选定来源的凭据与模型；它不代表原模型具有原生视觉能力。

### 3. 启动 Runtime 和 Harness Web

~~~powershell
npx dsh-local-ocr-runtime start
npx dsh-local-ocr-runtime status
npx @deepseek-ai/dsh@0.1.0-rc.6 --profile local-ocr --port 3081
~~~

然后打开 **<http://127.0.0.1:3081>**。Runtime 的 `start` 幂等且只管理自己记录的 OCR 进程，`stop` 不会终止其他程序。

### 4. 在页面中使用

先在模型选择器中选择 `Local OCR Bridge` 下的目标模型，再上传图片并明确要求模型调用 `vision_read`；区域读取使用 `vision_read_region`。工具调用会显示在会话中。

## 源码开发流程（仅用于本仓库）

> **不要混用两种生命周期。** 公开安装使用 `npx dsh-local-ocr-runtime` 的独立 venv、状态目录和受控进程；本仓库开发使用下面的 `scripts\*.ps1`、`.venv` 和源码服务。二者都可能占用 `127.0.0.1:8765`，且 Runtime 不会接管由源码脚本启动的 Python 进程。选定一种后，用同一种方式执行启动、停止和诊断。

需要：Windows PowerShell 7+、64 位 Python 3.10/3.11/3.12、Node.js `^22.19.0` 或 `>=24.0.0`、pnpm 11。脚本会优先使用 PATH 中的 Node/pnpm，也会尝试 Harness 自带的 runtime。

### 1. 下载并安装

~~~powershell
git clone https://github.com/kapone-systems/dsh-vision-local-ocr.git
Set-Location .\dsh-vision-local-ocr

Copy-Item .env.example .env
.\scripts\install.ps1 -Profile local-ocr
~~~

`install.ps1` 会创建 `.venv`、安装 FastAPI/Pillow/测试依赖、安装 PaddleOCR（默认），然后把插件安装到 `$DSH_HOME\profiles\local-ocr`；未设置时默认使用 `D:\.dsh`。它会同时清理旧预览版写入的强制 bridge 默认模型。仅需安装 OCR 服务时传入 `-SkipPlugin`；需要单独重装或迁移 profile 时，仍可运行 `install-plugin.ps1 -Profile local-ocr`。

如果 PowerShell 禁止运行脚本，只在当前窗口执行：

~~~powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
~~~

如果 Node/pnpm 不在 PATH，在 `.env` 中设置包含 `node\node.exe` 和 `pnpm\pnpm.cmd` 的目录：

~~~dotenv
HARNESS_RUNTIME_DIR=D:\\Program Files\\deepseek-harness\\runtime
~~~

### 2. 启动 OCR 服务

在第一个 PowerShell 窗口：

~~~powershell
.\scripts\start-ocr-service.ps1
~~~

保持窗口运行。首次真实 OCR 会初始化 PaddleOCR 并下载公开模型到 `OCR_MODEL_CACHE_DIR`；默认示例位置是 `D:\Program Files\local model\paddleocr`。也可以使用不受 PowerShell 执行策略影响的启动器：

~~~powershell
.\scripts\start-ocr-service.cmd
~~~

### 3. 启动 Harness Web

在第二个 PowerShell 窗口：

~~~powershell
.\scripts\check-health.ps1
.\scripts\start-harness-local-ocr.ps1 -Profile local-ocr -Port 3081
~~~

然后打开 **<http://127.0.0.1:3081>**。

不要使用旧启动器打开的 `http://127.0.0.1:3080`：它通常使用旧版 Harness 或 `web` profile，不会加载 `local-ocr`。受执行策略限制时可运行：

~~~powershell
.\scripts\start-harness-local-ocr.cmd -Port 3081
~~~

### 4. 在页面中使用

1. 关闭此前运行在 3081 的 Harness 后重新执行上面的启动命令，确认 profile 是 `local-ocr`。
2. 在模型选择器中选 `Local OCR Bridge`，然后选择所需的上游 DeepSeek 来源和模型。
3. 点击上传按钮，或把 PNG/JPEG/WebP 拖入对话。
4. 明确要求模型调用 `vision_read`，例如：

~~~text
请调用 vision_read，读取这张截图中的报错内容，用 text 模式简洁说明。
~~~

区域示例：

~~~text
请调用 vision_read_region，读取当前图片 x=500、y=0、width=500、height=600 的文字，返回 markdown。
~~~

页面没有单独的“OCR 插件”按钮；工具调用会显示在会话中。如果模型没有自动调用工具，直接补充“必须调用 `vision_read`”。

## 直接交给 AI 部署

把下面的指令连同仓库地址交给可以操作本机终端的 AI，即可让它按项目约定完成部署。它包含了本项目最重要的兼容性约束：

~~~text
请在 Windows PowerShell 中部署 DeepSeek Harness 的本地 OCR：

目标：让 DeepSeek Harness 的 local-ocr profile 在本机通过 PaddleOCR 读取 PNG/JPEG/WebP 图片文字。

必须遵守：
1. 运行 `npx dsh-local-ocr-runtime setup --cpu --yes`；不要把 venv、模型缓存、日志或凭据写入仓库。
2. 运行 `npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile local-ocr add @deepseek-ai/dsh-web-app@0.1.0-rc.6`，再运行 `npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile local-ocr add dsh-plugin-local-ocr`。
3. 保持 `OCR_SERVICE_URL=http://127.0.0.1:8765`，先完成 CPU 验收；GPU 只有在 doctor 通过后才启用。
4. 运行 `npx dsh-local-ocr-runtime start` 和 `npx dsh-local-ocr-runtime doctor`。
5. 运行 `npx @deepseek-ai/dsh@0.1.0-rc.6 --profile local-ocr --port 3081`，不要使用旧的 `3080` web profile。
6. 上传 PNG/JPEG/WebP 后明确要求模型调用 `vision_read`，再用 `status` 检查 Runtime。
7. 上传图片前在模型选择器中手动选择 `Local OCR Bridge` 下的目标模型；模型来源可为 DeepSeek 官方、OpenCode Go 或任一已配置的 provider。不要把 bridge 当作原生视觉模型。
8. 交付时报告：实际 Python/Node/Harness/Paddle 版本、OCR 地址、profile、doctor/测试结果和未解决问题。

验收标准：浏览器能打开 3081；上传测试图片后模型实际调用 vision_read；OCR 返回文字、坐标和置信度；空白图返回空 blocks；服务停止时插件返回可理解的错误，而不是让 Harness 无限等待。
~~~

## 工具接口

### `vision_read`

读取一张当前会话附件，或读取允许目录中的本地图片。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `attachment_id` | string | 二选一 | 当前 Harness 会话中真实出现过的图片附件 ID |
| `file_path` | string | 二选一 | 仅当 `OCR_ALLOWED_DIRECTORIES` 显式允许时可用 |
| `question` | string | 否 | 例如“读取报错内容”；只影响结果整理，不改变 OCR |
| `mode` | `text\|structured\|markdown` | 否 | 默认 `text` |

### `vision_read_region`

先在原图上裁剪，再重新 OCR。`x`、`y`、`width`、`height` 都是原图像素，必须完全落在图片边界内。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `attachment_id` / `file_path` | string | 是 | 与 `vision_read` 相同的来源规则 |
| `x`、`y` | integer | 是 | 左上角坐标，必须 `>= 0` |
| `width`、`height` | integer | 是 | 正整数，不能越界 |
| `question` | string | 否 | 对裁剪区域的整理要求 |
| `mode` | `text\|structured\|markdown` | 否 | 默认 `text` |

模型只能使用当前 agent/session 中真实存在的附件 ID；伪造 ID 会被插件拒绝。

## 输出模式与响应

- `text`：按阅读顺序拼接文字，适合快速回答。
- `structured`：返回完整 JSON，包含坐标、置信度和耗时。
- `markdown`：按识别行和段落整理，适合复制到文档。

核心响应格式：

~~~json
{
  "response_version": "2",
  "request_id": "uuid",
  "image": { "width": 1920, "height": 1080 },
  "blocks": [
    {
      "text": "连接服务器失败",
      "bbox": [[420, 310], [665, 310], [665, 348], [420, 348]],
      "confidence": 0.96,
      "block_index": 0,
      "line_index": 0,
      "reading_order": 0,
      "line": 1
    }
  ],
  "full_text": "连接服务器失败",
  "warnings": [],
  "elapsed_ms": 380
}
~~~

没有识别到文字时是成功响应：`blocks: []`、`full_text: ""`，并在 `warnings` 中返回明确提示，不会生成伪造内容。`block_index`、`line_index`、`reading_order` 都是从 `0` 开始的稳定字段；`line` 是保留给 V1 的一基 detector/block 序号，不能当作真实行号。坐标始终使用原图像素，`confidence` 始终在 `0` 到 `1` 之间。

## 配置

把 `.env.example` 复制为 `.env` 后按需修改。`.env` 不应提交到 Git。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OCR_SERVICE_URL` | `http://127.0.0.1:8765` | 只允许无路径的 IPv4 回环 HTTP URL |
| `OCR_SERVICE_TOKEN` | 空 | 可选 Bearer Token；服务与插件必须一致 |
| `OCR_LANGUAGE` | `ch` | PaddleOCR 语言配置 |
| `OCR_USE_GPU` | `false` | 只有确认 Paddle CUDA 运行时兼容后才启用 |
| `OCR_MODEL_CACHE_DIR` | 由 Paddle 决定 | 模型缓存绝对路径；本机示例为 `D:\Program Files\local model\paddleocr` |
| `OCR_MAX_FILE_MB` | `15` | 单张编码文件上限 |
| `OCR_TIMEOUT_SECONDS` | `90` | 插件和服务端 OCR 总超时预算；CPU 复杂截图建议保持此值或更高 |
| `OCR_MIN_CONFIDENCE` | `0.50` | 低于此值的识别块会被过滤 |
| `OCR_MAX_CONCURRENCY` | `1` | CPU 默认串行，避免超时任务未结束时引发 `OCR_BUSY` 连锁 |
| `OCR_QUEUE_TIMEOUT_SECONDS` | `5` | 排队超时后返回 `429 OCR_BUSY` |
| `OCR_MAX_IMAGE_EDGE` | `12000` | 最大宽或高 |
| `OCR_MAX_PIXELS` | `40000000` | 解码后的总像素上限 |
| `OCR_ALLOWED_DIRECTORIES` | 空 | 分号分隔的绝对路径根；空值关闭 `file_path` |
| `HARNESS_RUNTIME_DIR` | 空 | 可选 Harness runtime，需包含 `node\node.exe` 和 `pnpm\pnpm.cmd` |

Runtime 状态和修复命令：

| 错误码 | 修复 |
| --- | --- |
| `OCR_RUNTIME_NOT_INSTALLED` | `npx dsh-local-ocr-runtime setup --yes` |
| `OCR_RUNTIME_NOT_RUNNING` | `npx dsh-local-ocr-runtime start` |
| `OCR_MODEL_NOT_READY` | `npx dsh-local-ocr-runtime setup --yes`，确认模型下载完成 |
| `OCR_VERSION_MISMATCH` | `npx dsh-local-ocr-runtime doctor`，更新插件和 Runtime |

服务端和插件都会拒绝非 `127.0.0.1`、带路径/查询串/凭据的 OCR URL。GPU、限制和允许目录属于受控部署配置，放宽前应重新评估风险。

## API 服务

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/health` | 轻量 liveness 检查；不会因为探活强制加载模型 |
| `POST` | `/v1/ocr` | multipart 上传图片并执行 OCR |
| `POST` | `/v1/ocr/region` | 上传图片、校验区域、裁剪后执行 OCR |

示例健康检查：

~~~powershell
.\scripts\check-health.ps1
~~~

示例直接调用服务（不经过 Harness）：

~~~powershell
. .\scripts\common.ps1
Import-LocalOcrEnv
Invoke-LocalOcrMultipart -Uri 'http://127.0.0.1:8765/v1/ocr' -ImagePath '.\tests\fixtures\english-screenshot.png'
~~~

## 安全与隐私

- OCR 服务只绑定 `127.0.0.1`，默认不暴露局域网。
- 插件只读取 Harness 授权附件，或 `ctx.fs` 允许根目录内的文件；不使用原生 Node `fs` 绕过授权。
- 扩展名、MIME、文件头、文件大小、图片尺寸、总像素和 Pillow 完整解码都会校验，防止损坏文件和解压炸弹。
- 服务在 multipart 解析前检查请求体大小；支持可选 Bearer Token、超时、并发限制和明确错误码。
- 日志不记录图片、Base64、Token 或完整敏感 OCR 文本。
- 图片内的文字是**不可信外部证据**，不会改变系统指令、工具权限或安全配置。
- 默认配置不会向外网发送图片或 OCR 请求；但 OCR 文字是否离机取决于你选择的上游文本模型。

## 测试与性能

完整本地测试：

~~~powershell
.\scripts\test.ps1
~~~

包含真实 CPU PaddleOCR 的中英文、空白图和区域坐标测试：

~~~powershell
.\scripts\test.ps1 -PaddleIntegration
~~~

对合成 1080p 图片测量服务耗时、往返耗时和进程 Working Set：

~~~powershell
.\scripts\benchmark.ps1
~~~

本机验证记录（Windows 11、Python 3.12、Node 24、PaddleOCR 3.7.0、CPU）见 [VERIFICATION.md](VERIFICATION.md)。一次热态 1920×1080 测试的记录值为：服务耗时约 `15.4 s`，往返约 `15.4 s`，进程生命周期峰值约 `1.9 GB`；首次模型加载和机器配置会显著影响结果。

## 排错速查

| 现象 | 处理 |
| --- | --- |
| 浏览器打开 `3080` 但没有插件 | 关闭旧 Harness，改用 `start-harness-local-ocr.ps1 -Port 3081` |
| `OCR_RUNTIME_NOT_INSTALLED` | 运行 `npx dsh-local-ocr-runtime setup --yes` |
| `OCR_RUNTIME_NOT_RUNNING` | 运行 `npx dsh-local-ocr-runtime start` |
| `OCR_MODEL_NOT_READY` | 运行 `npx dsh-local-ocr-runtime setup --yes`，确认模型下载完成 |
| `OCR_VERSION_MISMATCH` | 运行 `npx dsh-local-ocr-runtime doctor`，更新插件和 Runtime |
| `OCR_LEGACY_DEFAULT_MODEL` | 从项目目录运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-plugin.ps1 -Profile local-ocr -DshHome D:\.dsh`，然后重启 Harness |
| `OCR_SERVICE_UNAVAILABLE` | 检查 Runtime 状态并运行 `npx dsh-local-ocr-runtime start` |
| `OCR_ENGINE_UNAVAILABLE` | 运行 `npx dsh-local-ocr-runtime doctor`，先把 `OCR_USE_GPU=false` |
| `OCR_TIMEOUT` | 首次加载模型时重试，或提高超时/缩小图片 |
| `OCR_BUSY` | 等待当前请求完成，或在受控环境调整并发上限 |
| `OCR_LOCAL_FILES_DISABLED` | 设置 `OCR_ALLOWED_DIRECTORIES`，重启 Harness 后再传 `file_path` |
| `OCR_ATTACHMENT_NOT_AUTHORIZED` | 只能使用当前会话真实引用过的附件 ID |
| `MODEL_DOES_NOT_SUPPORT_IMAGES` | 当前选中的原始 provider 是纯文本路由。上传图片前在模型选择器中改选 `Local OCR Bridge` 下对应的上游模型 |
| `IMAGE_TOO_LARGE` / `IMAGE_PIXEL_LIMIT_EXCEEDED` | 压缩图片，或在受控部署中调整对应限制 |
| `ERR_PNPM_UNEXPECTED_STORE` | 旧 profile 的 `node_modules` 与当前 pnpm 使用了不同 store。重新运行 `install-plugin.ps1`；脚本会读取 profile 的 `.modules.yaml` 并复用原 store，不要先删除 `node_modules` |
| `pnpm` / Node 找不到 | 安装 Node.js + pnpm，或配置 `HARNESS_RUNTIME_DIR` |

## 项目结构

~~~text
.
├─ harness-plugin/       TypeScript 插件、工具、bridge provider 和 Vitest 测试
├─ ocr-service/          FastAPI 服务、PaddleOCR 封装和 pytest 测试
├─ runtime/              可公开安装的 dsh-local-ocr-runtime CLI
├─ scripts/              Windows 安装、启动、健康检查、测试和基准脚本
├─ tests/fixtures/       无敏感信息的中英文、空白和区域测试图片
├─ ARCHITECTURE.md       数据流、信任边界和扩展点
├─ HARNESS_COMPATIBILITY.md  官方接口调查与版本差异
└─ VERIFICATION.md       已执行的测试、profile 核验和性能记录
~~~

## 已知限制与后续扩展

首版暂不实现 PP-Structure 表格/复杂版面、PDF 分页、结果缓存、本地视觉语言模型降级、UI 元素检测和多图片比较。OCR HTTP 接口、结构化响应和插件工具参数已为后续能力保留扩展空间。

## 相关命令

| 目的 | 命令 |
| --- | --- |
| Runtime 诊断 | `npx dsh-local-ocr-runtime doctor` |
| Runtime 安装/模型下载 | `npx dsh-local-ocr-runtime setup --yes` |
| Runtime 启动/停止/状态 | `npx dsh-local-ocr-runtime start` / `stop` / `status` |
| npm Web bundle 安装 | `npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile local-ocr add @deepseek-ai/dsh-web-app@0.1.0-rc.6` |
| npm OCR 插件安装 | `npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile local-ocr add dsh-plugin-local-ocr` |
| 安装服务和插件依赖 | `.\scripts\install.ps1` |
| 单独安装/构建 Harness 插件 | `.\scripts\install-plugin.ps1 -Profile local-ocr` |
| 启动 OCR 服务 | `.\scripts\start-ocr-service.ps1` |
| 启动 Harness Web | `.\scripts\start-harness-local-ocr.ps1 -Port 3081` |
| 检查健康状态 | `.\scripts\check-health.ps1` |
| 运行全部测试 | `.\scripts\test.ps1 -PaddleIntegration` |
| 运行 1080p 基准 | `.\scripts\benchmark.ps1` |
