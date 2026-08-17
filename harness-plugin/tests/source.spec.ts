import { describe, expect, it } from 'vitest'
import { findSessionAttachment } from '../src/source.js'
import type { Message } from '@deepseek-ai/dsh-llm'

describe('session attachment authorization', () => {
  it('finds only a referenced attachment, including nested tool results', () => {
    const messages = [{
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        content: [{
          type: 'image',
          attachment: { attachmentId: 'authorized', mediaType: 'image/png' },
        }],
      }],
    }] as unknown as Message[]

    expect(findSessionAttachment(messages, 'authorized')).toMatchObject({ attachmentId: 'authorized' })
    expect(findSessionAttachment(messages, 'forged')).toBeUndefined()
  })
})
