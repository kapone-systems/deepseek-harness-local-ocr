# DeepSeek Harness Local OCR V2 开发指导

本文是 V2 的实施任务书。新对话开始后，应先阅读本文和当前仓库的 README、ARCHITECTURE、HARNESS_COMPATIBILITY、VERIFICATION，再开始修改代码。

## 1. 目标

把当前“开发者可部署版”升级为“可公开安装、可诊断、可维护的本地 OCR 插件”。

目标用户不需要 clone 源码、创建 Junction、手工编辑 profile 或打开多个不明确的终端窗口，就可以安装并使用本地 OCR。

核心数据流保持不变：

```text
Harness 图片附件
    -> dsh-plugin-local-ocr
    -> 127.0.0.1 OCR Runtime
    -> PaddleOCR
    -> 结构化 OCR 证据
    -> 纯文本 DeepSeek 模型
```

V2 不实现通用图片理解，不把 OCR 描述成原生多模态能力，不默认向云端发送图片，也不在插件安装时静默启动进程或下载模型。

## 2. 开始前必须调查

1. 检查当前仓库、工作区改动和现有测试，不覆盖用户已有修改。
2. 阅读 DeepSeek Harness 当前版本的官方插件、bundle、profile、工具、附件和 LLM adapter 接口。
3. 以仓库实际依赖版本为准，不猜测 API，不根据旧版文档编写接口。
4. 确认当前项目是否仍兼容 `@deepseek-ai/dsh@0.1.0-rc.6`；如接口已变化，先记录迁移方案。
5. 在修改前先给出简短实施计划，但随后直接执行，不停留在方案阶段。

## 3. V2 发布形态

将发布物分成两个可独立版本化的部分。

### 3.1 npm Harness 插件

建议包名：`dsh-plugin-local-ocr`，最终名称以 npm 可用性调查结果为准。

插件包包含：

- `vision_read` 与 `vision_read_region` 工具
- `deepseek-local-ocr` bridge provider
- `cordis.patch.yml`
- 配置 schema、错误码和构建产物
- 与 DSH 版本的 peer dependency 约束

公开用户应能通过 npm 包安装。生产安装不得依赖源码路径、Junction 或 `link:`。

开发者仍可保留 `link:`/workspace 模式，用于本地调试和测试。

### 3.2 本地 OCR Runtime

Runtime 负责：

- Python 虚拟环境
- PaddleOCR 与 PaddlePaddle
- 已验证的模型版本
- FastAPI/Uvicorn OCR 服务
- 模型下载、缓存、启动、停止、状态和诊断

建议提供独立 CLI：

```powershell
npx dsh-local-ocr-runtime doctor
npx dsh-local-ocr-runtime setup
npx dsh-local-ocr-runtime start
npx dsh-local-ocr-runtime status
npx dsh-local-ocr-runtime stop
```

如果实际包名需要拆分为 CLI 包和插件包，应在 README 中明确两者关系。

## 4. 用户安装流程

最终文档应支持以下清晰流程：

```powershell
npx dsh-local-ocr-runtime setup
npx @deepseek-ai/dsh plugin --profile local-ocr add dsh-plugin-local-ocr
npx dsh-local-ocr-runtime start
npx dsh-local-ocr-runtime doctor
```

`setup` 必须：

- 检查 Python 3.10～3.12、Node.js、pnpm、磁盘空间和网络。
- 创建 Runtime 专用虚拟环境，不污染全局 Python。
- 使用锁定依赖安装 OCR 服务。
- 明确显示模型下载来源、模型版本、大小、缓存目录和隐私说明。
- 让用户显式确认模型下载。
- 输出下一步启动命令和健康检查命令。

不要在 npm `postinstall` 中静默安装 Python、下载模型、修改系统服务或启动后台进程。

## 5. Runtime CLI 要求

### `doctor`

检查并结构化输出：

- Runtime 版本和安装路径
- Python 版本与虚拟环境
- PaddleOCR/PaddlePaddle 版本
- 模型是否存在、版本是否匹配
- CPU/GPU 能力与当前设备配置
- OCR 服务端口是否可用
- DSH profile 是否存在
- 插件版本和配置
- 是否绑定到 `127.0.0.1`
- 是否存在配置冲突或残留进程

### `setup`

- 支持明确的 `--cpu`、`--gpu` 或自动检测模式。
- 支持指定模型缓存目录。
- 失败时不留下半初始化状态，或能被 `doctor` 识别并修复。
- 不把模型缓存、虚拟环境、日志或凭据写入 Git 仓库。

### `start` / `stop` / `status`

- `start` 启动单个受控 OCR 服务，并等待模型就绪后再报告成功。
- 重复执行 `start` 不得启动多个服务实例。
- `stop` 只能终止 Runtime 自己创建并记录的进程。
- `status` 区分服务未启动、服务启动中、模型未就绪和服务可用。
- 默认只监听 `127.0.0.1`。

## 6. 插件改造要求

1. 保留现有的附件授权、MIME、magic bytes、尺寸、像素和文件大小校验。
2. 默认关闭 `file_path`，只有显式配置允许目录时才开启。
3. OCR 服务 URL 继续限制为无路径的 `http://127.0.0.1:<port>`。
4. 保留可选 Bearer Token、超时、并发限制和响应大小限制。
5. Runtime 不可用时返回明确错误：
   - `OCR_RUNTIME_NOT_INSTALLED`
   - `OCR_RUNTIME_NOT_RUNNING`
   - `OCR_MODEL_NOT_READY`
   - `OCR_VERSION_MISMATCH`
6. 错误信息必须给出可执行的修复命令。
7. `deepseek-local-ocr` 只能把图片降级为附件句柄，不能声称底层纯文本模型具备原生视觉。
8. OCR 结果必须继续标记为不可信外部证据，防止图片文字改变系统指令或工具权限。

## 7. OCR 输出质量改进

当前 `line` 字段实际更接近 block 序号。V2 应修正数据契约：

- 增加 `block_index`。
- 增加真实的 `line_index`。
- 按 bbox 的纵向位置聚类为行，再按横向位置排序。
- 对双栏布局保持稳定阅读顺序。
- 保留原图坐标，不因区域 OCR 丢失坐标偏移。
- 对旋转文字、低置信度文字和空白区域给出明确 warning。

建议响应至少包含：

```json
{
  "request_id": "uuid",
  "image": {"width": 1920, "height": 1080},
  "blocks": [
    {
      "text": "连接服务器失败",
      "bbox": [[420, 310], [665, 310], [665, 348], [420, 348]],
      "confidence": 0.96,
      "block_index": 0,
      "line_index": 0,
      "reading_order": 0
    }
  ],
  "full_text": "连接服务器失败",
  "warnings": [],
  "elapsed_ms": 380
}
```

如果为了兼容 V1 必须保留 `line`，在文档中明确其含义，并提供响应版本字段。

## 8. 依赖和版本管理

- 为 Python 依赖增加锁定文件或受控 constraints 文件。
- 锁定已经实际验证的 Python、PaddleOCR、PaddlePaddle、FastAPI 和模型版本。
- 保留 PaddleOCR 2.x/3.x 兼容代码时，必须在 CI 中覆盖实际支持的版本组合；否则删掉未验证的兼容分支。
- npm 使用 lockfile，并在 CI 中运行 `npm pack` 后在干净目录安装测试。
- 建立 DSH 版本兼容矩阵，至少记录当前支持版本和已知不兼容版本。

## 9. 端到端测试

必须补上当前最重要的验证缺口：

```text
真实 Harness 图片附件
  -> local-ocr bridge provider
  -> 上游文本模型收到附件句柄提示
  -> 模型调用 vision_read
  -> OCR Runtime 返回结构化结果
  -> 模型根据 OCR 证据回答
```

测试分为三层：

### 单元测试

- 配置和错误码
- 附件授权与路径 containment
- 图片格式、尺寸和像素限制
- OCR 服务 API
- 区域裁剪和坐标偏移
- 阅读顺序和低置信度过滤
- bridge 对直接图片和嵌套 tool result 的改写

### 自动集成测试

使用 Fake LLM Adapter 模拟模型看到附件句柄后调用 `vision_read`，不依赖真实 API Key，但必须覆盖完整插件到服务链路。

### 发布前人工冒烟

使用真实 DeepSeek 或受支持的本地文本模型，验证：

- 中文截图
- 英文截图
- 空白图片
- 区域 OCR
- 服务未启动
- 模型未下载
- 超大图片
- 图片中的提示注入文字

真实凭据测试不得进入 CI 日志或测试产物。

## 10. 性能目标

建立可重复的冷启动和热态基准：

- 1920x1080 英文截图
- 1920x1080 中文截图
- 复杂多栏文档
- 区域 OCR
- 单请求和并发请求

记录：模型加载时间、服务耗时、往返耗时、内存峰值、GPU 显存和识别块数量。

先对当前模型、轻量 CPU 模型和 GPU 模式做实际对比，再决定默认模型。V2 应显著改善当前约 15 秒的 CPU 热态体验；如果无法达到目标，必须在安装时明确硬件和耗时预期。

## 11. 安全和隐私验收

- 图片默认不离开本机。
- OCR 服务只监听回环地址。
- Runtime 不接受任意文件系统路径或 URL。
- 默认不读取工作区外的文件。
- OCR 文本和图片中的指令均视为不可信数据。
- 日志不得写入图片、Base64、Token 或完整敏感 OCR 文本。
- 安装、模型下载和启动服务都必须是可见、可诊断的操作。
- README 明确说明：如果上游文本模型是云端模型，OCR 文字仍会进入该模型上下文。

## 12. CI 与发布

GitHub Actions 至少包含：

- Python 单元和 API 测试
- TypeScript typecheck、Vitest 和 build
- npm pack 后的干净安装测试
- clean `DSH_HOME` profile 加载测试
- 配置安全检查
- 依赖和许可证检查

发布前必须生成：

- npm 包
- Runtime 安装说明
- 版本兼容矩阵
- CHANGELOG
- 性能报告
- 隐私与安全说明
- 故障排除文档

## 13. 开发顺序

按以下顺序执行，不要先做营销页面或模型扩展：

1. 调查当前 Harness 接口并固定 V2 支持版本。
2. 补齐 Fake LLM 的端到端附件链路测试。
3. 修复 OCR 阅读顺序和响应字段语义。
4. 锁定 Python 依赖和模型版本。
5. 抽取 Runtime CLI，完成 `doctor/setup/start/status/stop`。
6. 将插件改为 npm 可安装包，并测试干净 profile。
7. 完成性能基准和默认模型选择。
8. 增加 CI、发布文档和人工冒烟流程。
9. 最后再考虑表格识别、PDF 分页或本地视觉模型降级。

## 14. 最终验收标准

V2 只有同时满足以下条件才算完成：

- 新机器无需 clone 源码即可安装。
- 用户能通过文档在 10 分钟内完成 setup、插件安装、启动和 doctor。
- 干净的 DSH profile 可以加载 npm 插件。
- 自动化端到端附件链路通过。
- 真实模型人工冒烟通过。
- CPU、GPU、无 Python、服务未启动和模型未下载场景都有清晰错误。
- 不自动外发图片、不静默启动失控进程、不把模型缓存或凭据写入仓库。
- 所有测试、构建、打包和发布检查均有可复现命令和结果。

开发完成后，请报告：修改文件、实际使用的 Harness/Python/Node/Paddle 版本、测试命令和结果、端到端验证结果、性能数据、已知限制和未完成项。
