# 本机验证记录

验证日期：2026-08-16（Asia/Shanghai）

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
- 使用 `pnpm dlx --package '@deepseek-ai/dsh@0.1.0-rc.6' dsh --profile local-ocr --port 3081` 启动 Web profile 后，`http://127.0.0.1:3081/` 返回 HTTP 200 和 Harness HTML。该 profile 的 bundle 顺序为 `dsh-base`、`dsh-web-app`、`dsh-plugin-local-ocr`。

## 测试结果

在仓库根目录执行：

```powershell
.\scripts\test.ps1 -PaddleIntegration
```

结果：Python `36 passed`（其中包括真实 CPU PaddleOCR 的中英文、空白图片和区域坐标集成测试）；
TypeScript typecheck 通过；Vitest `12 passed`；生产构建通过。

测试输出包含两个不影响结果的上游警告：Starlette `TestClient` 对当前 httpx 兼容层的弃用警告，以及
Paddle 缺少 `ccache` 的性能提示。

已对运行中的服务进行额外 HTTP 验证：

- `english-screenshot.png` 返回 3 个块和文本 `LOCAL OCR TEST`、`Build status: PASSED`、`Error code: 503`。
- 区域端点会拒绝越界区域并返回 `422 REGION_OUT_OF_BOUNDS`；有效区域返回的 bbox 保持原图坐标。
- 单元测试和真实 Paddle 集成测试分别验证空白图返回 `blocks=[]`、非图片/损坏图片/超限图片被拒绝、
  Bearer Token、超时和并发限制。

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
- 已验证 Harness bundle、配置导出、模块导入和工具注册；未使用真实 DeepSeek 凭据手工完成一条交互式
  附件上传到模型工具调用的完整会话。
- `deepseek-local-ocr` 仅做附件准入与句柄降级。必须选择该 provider；默认的
  `deepseek-official` 文本 provider 仍可能拒绝图片。
- 图片字节和 OCR 推理保持本机，但如果 bridge 的上游是云端 DeepSeek，OCR 文本会作为常规工具结果进入
  上游模型上下文。需要文字也不离机时，必须改用受支持的本地文本模型。
