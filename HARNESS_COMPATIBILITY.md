# DeepSeek Harness 兼容性记录

调查日期：2026-08-16（Asia/Shanghai）

本插件以 DeepSeek Harness 官方仓库
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)
的提交
[`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/commit/47f943859bef60e4160492346772ded9b24f765a)
最初完成接口调查；但该提交对应的 `0.1.0-rc.5` 包已经无法从 npm 注册表安装。当前可安装的
官方预发布包为 `0.1.0-rc.6`，因此本项目的构建与验证基线已更新为 `rc.6`。官方项目仍标记为
developer preview，并明确提示会有破坏性变更。

## 官方真实接口

任务书中的“插件目录 / manifest”与当前官方实现不同：

| 项目 | 官方 `0.1.0-rc.6` 实现 | 本项目采用方式 |
| --- | --- | --- |
| 插件本体 | ESM/TypeScript 模块，导出 `apply(ctx)`，可导出 `name`、`inject`、`Config` | `harness-plugin/src/index.ts` |
| 安装 manifest | npm `package.json` 中的 `dsh.bundle.patch`，不是独立 `manifest.json` | `harness-plugin/package.json` |
| 组合配置 | bundle 的 `cordis.patch.yml`；profile 位于 `$DSH_HOME/profiles/<name>` | `harness-plugin/cordis.patch.yml` |
| 工具注册 | `ctx.tools.register(defineTool({...}))` | 注册 `vision_read` 与 `vision_read_region` |
| 附件读取 | `ctx.attachments.readImage(ImageAttachmentRef, signal)` | 先在当前 agent/session 中解析真实引用，再读取字节 |
| 本地文件 | `ctx.fs` 服务；`cwd` 本身不自动形成 containment | 默认禁用；只有 profile 显式设置 `allowedDirectories` 后，才以 session workspace + 允许目录两层校验读取 |
| 配置校验 | 同名 TypeScript `Config` 与 Schemastery schema | 插件加载时失败，而不是首个调用时静默降级 |

官方依据：

- [插件入门](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md)
- [工具入门](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.md)
- [bundle 与 profile](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
- [工具契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md)
- [附件服务](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/attachment/attachment/src/index.ts)
- [DeepSeek 文本序列化](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/src/serialize.ts)
- [Web prompt 图片准入](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/apiproxy/src/api-proxy.ts)

## 图片附件的上游限制

官方 `deepseek-official` adapter 明确返回 `inputModalities: ['text']`，其序列化器遇到
`ImageBlock` 会抛出 `UNSUPPORTED_CONTENT`。Web Host 还会在图片进入 session 之前执行能力检查，
并以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝该 prompt。因此，仅增加一个 OCR 工具无法让纯文本
DeepSeek 先收到附件 ID；模型调用工具之前，图片已经被 Host 拒绝。

本项目为此注册 `deepseek-local-ocr` 桥接 provider：

1. 桥接 provider 向 Harness 声明它能**接收**图片，以通过 Host 的附件准入。
2. 图片仍由官方 `ctx.attachments` 在本地持久化与校验。
3. 桥接 adapter 在委派请求前把 `ImageBlock` 改写为不含字节的附件句柄提示。
4. 纯文本模型调用 `vision_read`；工具只接受当前 session 中确实引用的附件。
5. 插件把 OCR 文字作为不可信证据返回，然后将纯文本调用委派给 `deepseek-official`。

这里的 `image` 声明描述的是桥接 provider 的输入能力，不代表底层 DeepSeek 模型具有原生视觉。
任何文档、工具描述和错误信息都不得把该能力称为图片理解或原生视觉。

## 兼容范围

- 目标兼容基线：`@deepseek-ai/dsh*` `0.1.0-rc.6`、Cordis `4.0.1`、Node
  `^22.19.0 || >=24.0.0`。安装依赖后必须用 `scripts/test.ps1`、bundle 配置导出和实际附件会话复核。
- Harness 官方附件服务还接受 GIF；本插件首版按任务范围只允许 PNG、JPEG、WebP。
- bundle 将官方附件单图默认上限从 5 MiB 提高到 15 MiB；用户的后置 profile patch
  仍可收紧此值。
- `allowedDirectories` 的 bundle 默认值为 `[]`。在启动/安装 Harness 的同一进程环境中设置
  `OCR_ALLOWED_DIRECTORIES`（分号分隔绝对根目录）会填充该配置；仍应通过配置导出确认结果。
- 插件会在上传前执行大小、签名、尺寸和像素预检；服务还会在 multipart 解析前限制请求体。服务
  排队超出 `OCR_QUEUE_TIMEOUT_SECONDS` 时返回 `429 OCR_BUSY` 与 `Retry-After: 1`。
- 升级 Harness 前必须重新执行插件 typecheck、Vitest、bundle `--dump-config` 和实际附件测试。

## 自定义 profile 的 Web bundle

官方自定义 profile 的初始 bundle 只有 `@deepseek-ai/dsh-base`，因此不能仅安装 OCR bundle 后就期待浏览器界面出现。`@deepseek-ai/dsh-web-app` 负责 Web Host、静态前端、API gateway 和 `--port` 参数。此项目的 `scripts/install-plugin.ps1` 会确保 profile bundle 顺序为：

```json
[
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dsh-plugin-local-ocr"
]
```

必须使用 `scripts/start-harness-local-ocr.ps1`（固定 `@deepseek-ai/dsh@0.1.0-rc.6`）启动该 profile。`dsh web` 是硬编码 `--profile web` 的别名，旧版桌面启动器也可能硬编码自己的 `DSH_HOME`；两者都不会载入 `local-ocr` profile。

## Windows 安装路径兼容性

Harness `rc.6` 的 `dsh plugin` 命令在 Windows 上会经过 `cmd.exe` 转发 link spec。直接把含空格的
绝对工作区路径传给 `plugin add` 时，路径可能被拆分为多个参数。因此
`scripts/install-plugin.ps1` 不会注册绝对路径，而是：

1. 初始化指定 Harness profile；
2. 在 `<DSH_HOME>\\profiles\\<profile>\\plugins` 下创建一个只指向当前 `harness-plugin` 目录的
   NTFS Junction；
3. 用没有空格的 `link:plugins/dsh-plugin-local-ocr` 规格注册 bundle。

脚本只会复用指向同一工作区的既有 Junction；遇到普通目录或指向其他目标的 Junction 会拒绝覆盖。
这既保留了本地开发时的链接更新能力，也避免因为路径转义导致安装到错误的位置。当前 PowerShell
不要求全局安装 `dsh`：脚本会在缺少该命令时使用 `pnpm dlx` 固定到 `0.1.0-rc.6`。
