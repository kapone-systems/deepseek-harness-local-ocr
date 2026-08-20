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
import { LocalOcrError } from './errors.js'
import type { NormalizedPluginConfig } from './plugin-config.js'

const BRIDGE_MODEL_ID_PREFIX = 'local-ocr-v1:'

export interface UpstreamModelRoute {
  provider: string
  model: string
}

/**
 * Makes an attachment-capable Harness route while delegating only text to a
 * user-selected installed adapter. The upstream model never receives image
 * bytes. A bridge model ID encodes the selected upstream provider/model so
 * equally named models from separate sources cannot collide.
 */
export class LocalOcrBridgeAdapter extends LlmAdapter {
  constructor(
    private readonly ctx: Context,
    private readonly bridgeProvider: string,
    private readonly upstreamProviders: readonly string[],
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return {
      id: provider,
      name: 'Local OCR Bridge',
    }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const results = await Promise.allSettled(
      this.availableUpstreams().map(async (upstream) => ({
        upstream,
        models: await this.ctx.llm.listModels(upstream.id),
      })),
    )
    const catalogs = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    return catalogs.flatMap(({ upstream, models }) => models.map(model => ({
      provider,
      id: encodeBridgeModelId({ provider: upstream.id, model: model.id }),
      name: `${model.name} (${upstream.name})`,
      ...model.description === undefined
        ? { description: `Local OCR route via ${upstream.name}.` }
        : { description: `${model.description} Local OCR route via ${upstream.name}.` },
      inputModalities: ['text', 'image'] as const,
    })))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const route = this.decodeAndValidateRoute(model)
    const upstream = await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal)
    const upstreamName = this.upstreamDisplayName(route.provider)
    return {
      ...upstream,
      provider,
      id: model,
      name: `${upstream.name} (${upstreamName})`,
      ...upstream.description === undefined
        ? { description: `Local OCR route via ${upstreamName}.` }
        : { description: `${upstream.description} Local OCR route via ${upstreamName}.` },
      inputModalities: ['text', 'image'] as const,
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const route = this.decodeAndValidateRoute(options.model)
    yield* this.ctx.llm.stream({
      ...options,
      provider: route.provider,
      model: route.model,
      messages: rewriteImagesToAttachmentHandles(options.messages),
    })
  }

  private availableUpstreams(): LlmProviderInfo[] {
    return this.ctx.llm.listProviders().filter((provider) => (
      provider.id !== this.bridgeProvider
      && (this.upstreamProviders.length === 0 || this.upstreamProviders.includes(provider.id))
    ))
  }

  private decodeAndValidateRoute(model: string): UpstreamModelRoute {
    const route = decodeBridgeModelId(model)
    if (route.provider === this.bridgeProvider) {
      throw new LocalOcrError('OCR_INVALID_BRIDGE_MODEL', 'The local OCR bridge cannot use itself as an upstream provider.')
    }
    if (this.upstreamProviders.length > 0 && !this.upstreamProviders.includes(route.provider)) {
      throw new LocalOcrError('OCR_INVALID_BRIDGE_MODEL', 'This upstream provider is not enabled for the local OCR bridge.')
    }
    if (!this.ctx.llm.listProviders().some(provider => provider.id === route.provider)) {
      throw new LocalOcrError('OCR_UPSTREAM_UNAVAILABLE', 'The selected upstream provider is no longer available. Select another model.')
    }
    return route
  }

  private upstreamDisplayName(provider: string): string {
    return this.ctx.llm.listProviders().find(candidate => candidate.id === provider)?.name ?? provider
  }
}

export function registerLocalOcrBridge(ctx: Context, config: NormalizedPluginConfig): void {
  ctx.llm.registerAdapter(
    [config.bridgeProvider],
    new LocalOcrBridgeAdapter(ctx, config.bridgeProvider, config.upstreamProviders),
  )
}

/** Encode an upstream model identity into a canonical opaque bridge model ID. */
export function encodeBridgeModelId(route: UpstreamModelRoute): string {
  validateRoute(route)
  return `${BRIDGE_MODEL_ID_PREFIX}${Buffer.from(JSON.stringify([route.provider, route.model]), 'utf8').toString('base64url')}`
}

/** Decode only canonical bridge IDs so malformed/pasted values cannot reroute calls. */
export function decodeBridgeModelId(value: string): UpstreamModelRoute {
  if (typeof value !== 'string' || !value.startsWith(BRIDGE_MODEL_ID_PREFIX)) {
    throw invalidBridgeModelId()
  }
  const payload = value.slice(BRIDGE_MODEL_ID_PREFIX.length)
  if (payload.length === 0 || !/^[A-Za-z0-9_-]+$/.test(payload)) throw invalidBridgeModelId()
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw invalidBridgeModelId()
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
    throw invalidBridgeModelId()
  }
  const route = { provider: parsed[0], model: parsed[1] }
  try {
    if (encodeBridgeModelId(route) !== value) throw invalidBridgeModelId()
  } catch (error: unknown) {
    if (error instanceof LocalOcrError) throw error
    throw invalidBridgeModelId()
  }
  return route
}

function validateRoute(route: UpstreamModelRoute): void {
  if (typeof route.provider !== 'string' || route.provider.length === 0 || /\s/.test(route.provider)
    || typeof route.model !== 'string' || route.model.length === 0) {
    throw invalidBridgeModelId()
  }
}

function invalidBridgeModelId(): LocalOcrError {
  return new LocalOcrError('OCR_INVALID_BRIDGE_MODEL', 'The selected local OCR bridge model is invalid. Select a model again.')
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
