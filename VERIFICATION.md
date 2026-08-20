# 本机验证记录

验证日期：2026-08-20（Asia/Shanghai）

本文件记录当前工作区在 Windows 本机完成的可复现验证。它不包含图片内容、Token 或其他密钥。

## 运行环境

| 项目 | 实测值 |
| --- | --- |
| 操作系统 | Windows 11 Home 64-bit，10.0.26200 |
| Python | 3.12.13 |
| Node.js / pnpm | 24.19.0 / 11.19.0 |
| DeepSeek Harness | 0.1.0-rc.6 |
| PaddlePaddle / PaddleOCR | 3.3.1 / 3.7.0 |
| OCR 设备 | CPU（`paddle.device.is_compiled_with_cuda() == false`） |
| 模型缓存 | `D:\\Program Files\\local model\\paddleocr\\official_models`，41 files，约 139.3 MB |

已下载的 PaddleOCR 公开模型为 `PP-LCNet_x1_0_textline_ori`、`PP-OCRv6_medium_det` 与
`PP-OCRv6_medium_rec`。图片和 OCR 推理结果不写入该目录。

## 服务与 Profile

- OCR 服务实际监听 `http://127.0.0.1:8765`；`GET /health` 返回 `status: ok`、`ready: true`、
  `device: cpu`、`ocr: true`、`region: true`、`webp: true`。
- `local-ocr` Harness profile 已包含 `@deepseek-ai/dsh-base` 和 `dsh-plugin-local-ocr`。
- `dsh --profile local-ocr --dump-config` 显示 `attachment-local.maxImageBytes: 15728640` 及 OCR bundle
  配置；默认 `allowedDirectories: []`，因此本地路径读取保持关闭。
- 动态加载 profile 中的构建产物后，`apply()` 实际注册 `vision_read`、`vision_read_region` 和
  `deepseek-local-ocr` bridge provider。`Config` 是 Schemastery 的可调用 schema 函数；它不是普通对象。
- 使用一个全新的临时 DSH profile 导出配置，确认 local OCR bundle **不会覆盖
  `agent-default-model`**，并将该 profile 的设置文件与常规 Harness 全局设置隔离；bridge 模型由用户在
  模型选择器中主动选择。
- 使用 `pnpm dlx --package '@deepseek-ai/dsh@0.1.0-rc.6' dsh --profile local-ocr --port 3081` 启动 Web profile 后，`http://127.0.0.1:3081/` 返回 HTTP 200 和 Harness HTML。该 profile 的 bundle 顺序为 `dsh-base`、`dsh-web-app`、`dsh-plugin-local-ocr`。

## 测试结果

在仓库根目录执行：

```powershell
.\scripts\test.ps1 -PaddleIntegration
```

结果：Python `38 passed, 1 skipped`（包含真实 Paddle CPU 集成、行/列阅读顺序、中文、空白图片和区域坐标测试）；
TypeScript typecheck 通过；Vitest `17 passed`（包括多来源 bridge 编码、发现、路由和递归保护）；生产构建通过；Runtime Node test `5 passed`。

Runtime 发布包 `dsh-local-ocr-runtime@0.2.0` 已通过 `npm pack --dry-run`，内容包含锁定的服务源码，
不包含 `__pycache__`、`.egg-info`、模型缓存或日志。插件 `dsh-plugin-local-ocr@0.2.0` 已通过
`pnpm pack` 构建检查。

测试输出包含两个不影响结果的上游警告：Starlette `TestClient` 对当前 httpx 兼容层的弃用警告，以及
Paddle 缺少 `ccache` 的性能提示。

已对运行中的服务进行额外 HTTP 验证：

- `english-screenshot.png` 返回 3 个块和文本 `LOCAL OCR TEST`、`Build status: PASSED`、`Error code: 503`。
- 区域端点会拒绝越界区域并返回 `422 REGION_OUT_OF_BOUNDS`；有效区域返回的 bbox 保持原图坐标。
- 单元测试和真实 Paddle 集成测试分别验证空白图返回 `blocks=[]`、非图片/损坏图片/超限图片被拒绝、
  Bearer Token、超时和并发限制。

## 真实凭据端到端冒烟

2026-08-20 在运行中的 `local-ocr` profile 使用本机已配置的 DeepSeek 官方凭据完成一条真实会话：

- `session.models` 同时列出官方 DeepSeek provider 与 `Local OCR Bridge`；bridge 目录中的模型由当前
  已注册 provider 动态生成，没有插件写入的强制默认模型。
- 上传实际 PNG 后，模型真实产生 `vision_read` 工具调用；插件通过当前会话附件句柄读取图片，OCR 服务
  返回版本化结果、文字、坐标、置信度和警告。
- OCR 结果随后进入上游文本模型上下文，最终助手消息返回成功，事件以 `turn/end: completed` 结束。
- 本次 profile 的 `opencode-go` provider 未激活，因此未伪造 OpenCode Go 测试；配置其凭据并启用 provider
  后，它会按同一动态目录规则出现，无需修改插件。

## 1080p 热态基准

在服务已完成模型预热后执行：

```powershell
.\scripts\benchmark.ps1
```

对 `tests\\fixtures\\benchmark-1080p.png`（1920 x 1080，15 个文本块）的本次结果：

```json
{
  "service_elapsed_ms": 15366,
  "round_trip_ms": 15373,
  "process_working_set_before_mb": 518.2,
  "process_working_set_after_mb": 520.1,
  "process_peak_working_set_mb": 1946.5
}
```

`PeakWorkingSet64` 是 Windows 进程生命周期峰值，不是本次单请求独占峰值。要取得干净的冷启动/热态
对比，应重启 OCR 服务、先做一次热身，再单独运行基准。当前 CPU 模式显式关闭 oneDNN/MKLDNN，避免
PaddlePaddle 3.3.1 Windows CPU 路径的运行时属性转换错误；性能会因此低于可用 oneDNN 的环境。

## 尚未覆盖的风险

- 当前安装的是 CPU Paddle 包，兼容 GPU 的安装、设备选择和性能尚未验证。
- `deepseek-local-ocr` 仅做附件准入与句柄降级，并不意味着上游文本模型具备原生视觉能力。
  插件不设置默认 provider/model；需要图片时必须在模型选择器中主动选择 bridge 下的目标上游模型。
  已经运行的 Harness 仍需要重启后才会载入新插件构建产物。
- CI 使用 Fake LLM/本地 HTTP 响应，不保存凭据；真实凭据冒烟只在本机完成，凭据未写入仓库或日志。
- 图片字节和 OCR 推理保持本机，但如果 bridge 的上游是云端 DeepSeek，OCR 文本会作为常规工具结果进入
  上游模型上下文。需要文字也不离机时，必须改用受支持的本地文本模型。
