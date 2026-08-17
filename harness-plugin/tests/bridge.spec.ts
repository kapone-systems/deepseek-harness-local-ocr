import { describe, expect, it } from 'vitest'
import { rewriteImagesToAttachmentHandles } from '../src/bridge.js'
import type { Message } from '@deepseek-ai/dsh-llm'

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
