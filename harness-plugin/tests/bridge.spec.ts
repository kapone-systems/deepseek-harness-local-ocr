import { describe, expect, it, vi } from 'vitest'
import {
  decodeBridgeModelId,
  encodeBridgeModelId,
  LocalOcrBridgeAdapter,
  rewriteImagesToAttachmentHandles,
} from '../src/bridge.js'
import type { GenerateOptions, LlmResolvedModelInfo, Message } from '@deepseek-ai/dsh-llm'

describe('image-admission bridge', () => {
  it('rewrites direct and nested tool-result image blocks without losing the attachment ID', () => {
    const messages = [{
      role: 'user',
      content: [
        {
          type: 'image',
          attachment: { attachmentId: 'top-level-image' },
        },
        {
          type: 'tool-result',
          toolCallId: 'tool-1',
          content: [{
            type: 'image',
            attachment: { attachmentId: 'nested-image' },
          }],
        },
      ],
    }] as unknown as Message[]

    const rewritten = rewriteImagesToAttachmentHandles(messages)
    const serialized = JSON.stringify(rewritten)

    expect(serialized).not.toContain('"type":"image"')
    expect(serialized).toContain('top-level-image')
    expect(serialized).toContain('nested-image')
    expect(serialized).toContain('text-only')
  })
})

describe('multi-provider bridge routing', () => {
  it('encodes distinct upstream provider/model pairs without collisions', () => {
    const official = encodeBridgeModelId({ provider: 'deepseek-official', model: 'deepseek-chat' })
    const opencode = encodeBridgeModelId({ provider: 'opencode-go', model: 'deepseek-chat' })
    const unicode = encodeBridgeModelId({ provider: 'custom/deepseek', model: 'deepseek-\u6df1\u5ea6' })

    expect(official).not.toBe(opencode)
    expect(decodeBridgeModelId(official)).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect(decodeBridgeModelId(opencode)).toEqual({ provider: 'opencode-go', model: 'deepseek-chat' })
    expect(decodeBridgeModelId(unicode)).toEqual({ provider: 'custom/deepseek', model: 'deepseek-\u6df1\u5ea6' })
    expect(() => decodeBridgeModelId('local-ocr-v1:not-valid!')).toThrow(/invalid/i)
  })

  it('discovers all active upstreams, advertises image admission, and delegates to the selected source', async () => {
    const bridgeProvider = 'deepseek-local-ocr'
    const streamed: GenerateOptions[] = []
    const providers = [
      { id: 'deepseek-official', name: 'DeepSeek Official' },
      { id: 'opencode-go', name: 'OpenCode Go' },
      { id: bridgeProvider, name: 'Local OCR Bridge' },
    ]
    const resolved: Record<string, LlmResolvedModelInfo> = {
      'deepseek-official/deepseek-chat': {
        provider: 'deepseek-official',
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        inputModalities: ['text'],
      },
      'opencode-go/deepseek-chat': {
        provider: 'opencode-go',
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        inputModalities: ['text'],
      },
    }
    const llm = {
      listProviders: vi.fn(() => providers),
      listModels: vi.fn(async (provider: string) => [{
        provider,
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
      }]),
      resolveModelInfo: vi.fn(async (provider: string, model: string) => {
        const value = resolved[`${provider}/${model}`]
        if (value === undefined) throw new Error('unavailable upstream model')
        return value
      }),
      stream: vi.fn((options: GenerateOptions): AsyncIterable<never> => {
        streamed.push(options)
        return (async function* () {})()
      }),
    }
    const adapter = new LocalOcrBridgeAdapter({ llm } as never, bridgeProvider, [])

    const models = await adapter.listModels(bridgeProvider)
    expect(models).toHaveLength(2)
    expect(models.every(model => model.provider === bridgeProvider)).toBe(true)
    expect(models.every(model => model.inputModalities?.includes('image'))).toBe(true)
    expect(models.map(model => model.name)).toEqual([
      'DeepSeek Chat (DeepSeek Official)',
      'DeepSeek Chat (OpenCode Go)',
    ])

    const selected = models.find(model => model.name.includes('OpenCode Go'))
    expect(selected).toBeDefined()
    const info = await adapter.resolveModel(bridgeProvider, selected!.id)
    expect(info).toMatchObject({
      provider: bridgeProvider,
      id: selected!.id,
      name: 'DeepSeek Chat (OpenCode Go)',
      inputModalities: ['text', 'image'],
    })

    const messages = [{
      role: 'user',
      content: [{ type: 'image', attachment: { attachmentId: 'attachment-1' } }],
    }] as unknown as Message[]
    for await (const _ of adapter.stream({
      provider: bridgeProvider,
      model: selected!.id,
      messages,
    })) {
      // The fake upstream stream completes immediately.
    }

    expect(streamed).toHaveLength(1)
    expect(streamed[0]).toMatchObject({ provider: 'opencode-go', model: 'deepseek-chat' })
    expect(JSON.stringify(streamed[0]?.messages)).not.toContain('"type":"image"')
    expect(JSON.stringify(streamed[0]?.messages)).toContain('attachment-1')
  })

  it('rejects a bridge model that targets itself or a removed upstream provider', async () => {
    const bridgeProvider = 'deepseek-local-ocr'
    const llm = {
      listProviders: () => [{ id: bridgeProvider, name: 'Local OCR Bridge' }],
      listModels: async () => [],
      resolveModelInfo: async () => {
        throw new Error('should not resolve')
      },
      stream: (): AsyncIterable<never> => (async function* () {})(),
    }
    const adapter = new LocalOcrBridgeAdapter({ llm } as never, bridgeProvider, [])
    await expect(adapter.resolveModel(
      bridgeProvider,
      encodeBridgeModelId({ provider: bridgeProvider, model: 'deepseek-chat' }),
    )).rejects.toThrow(/cannot use itself/)
    await expect(adapter.resolveModel(
      bridgeProvider,
      encodeBridgeModelId({ provider: 'opencode-go', model: 'deepseek-chat' }),
    )).rejects.toThrow(/no longer available/)
  })
})
