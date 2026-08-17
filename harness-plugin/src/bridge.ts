import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import type { NormalizedPluginConfig } from './plugin-config.js'

/**
 * Makes an attachment-capable Harness route while delegating only text to the
 * installed DeepSeek adapter. The upstream model never receives image bytes.
 */
export class LocalOcrBridgeAdapter extends LlmAdapter {
  constructor(
    private readonly ctx: Context,
    private readonly bridgeProvider: string,
    private readonly upstreamProvider: string,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return {
      id: provider,
      name: 'DeepSeek Local OCR Bridge',
    }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.ctx.llm.listModels(this.upstreamProvider)
    return models.map(model => ({
      ...model,
      provider,
      inputModalities: ['text', 'image'] as const,
    }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const upstream = await this.ctx.llm.resolveModelInfo(this.upstreamProvider, model, signal)
    return {
      ...upstream,
      provider,
      inputModalities: ['text', 'image'] as const,
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.ctx.llm.stream({
      ...options,
      provider: this.upstreamProvider,
      messages: rewriteImagesToAttachmentHandles(options.messages),
    })
  }
}

export function registerLocalOcrBridge(ctx: Context, config: NormalizedPluginConfig): void {
  ctx.llm.registerAdapter(
    [config.bridgeProvider],
    new LocalOcrBridgeAdapter(ctx, config.bridgeProvider, config.upstreamProvider),
  )
}

/** Replace all image blocks, including nested tool results, with opaque IDs. */
export function rewriteImagesToAttachmentHandles(messages: readonly Message[]): Message[] {
  return messages.map(message => ({
    ...message,
    content: rewriteContent(message.content),
  }))
}

function rewriteContent(content: readonly ContentBlock[]): ContentBlock[] {
  return content.map((block) => {
    if (block.type === 'image') {
      const attachmentId = String(block.attachment.attachmentId)
      return {
        type: 'text',
        text: [
          'A local image attachment is available, but this upstream route is text-only and cannot inspect image bytes.',
          `Use the local OCR tool only when text is needed: vision_read({ attachment_id: ${JSON.stringify(attachmentId)} }).`,
          'Do not claim visual details that are not returned by OCR.',
        ].join(' '),
      }
    }
    if (block.type === 'tool-result') {
      return {
        ...block,
        content: rewriteContent(block.content),
      }
    }
    return block
  })
}
