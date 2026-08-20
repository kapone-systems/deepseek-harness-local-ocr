import { afterEach, describe, expect, it, vi } from 'vitest'
import { rewriteImagesToAttachmentHandles } from '../src/bridge.js'
import { OcrHttpClient } from '../src/client.js'
import { renderOcrEvidence } from '../src/format.js'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { ResolvedImage } from '../src/types.js'

const image: ResolvedImage = {
  data: new Uint8Array([137, 80, 78, 71]),
  mediaType: 'image/png',
  width: 1,
  height: 1,
}

class FakeTextModel {
  async answer(messages: Message[], client: OcrHttpClient): Promise<string> {
    const prompt = JSON.stringify(messages)
    const attachmentId = /attachment-e2e/.test(prompt) ? 'attachment-e2e' : undefined
    if (attachmentId === undefined) throw new Error('Fake model did not receive an OCR attachment handle')
    const result = await client.recognize(image, new AbortController().signal)
    return `Answer for ${attachmentId}: ${result.full_text}`
  }
}

describe('local OCR attachment chain', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('carries an authorized attachment handle through the text-only bridge to OCR evidence', async () => {
    const messages = [{
      role: 'user',
      content: [{ type: 'image', attachment: { attachmentId: 'attachment-e2e' } }],
    }] as unknown as Message[]
    const rewritten = rewriteImagesToAttachmentHandles(messages)
    const bridgePrompt = JSON.stringify(rewritten)
    expect(bridgePrompt).toContain('vision_read')
    expect(bridgePrompt).toContain('attachment-e2e')
    expect(bridgePrompt).not.toContain('"type":"image"')

    const response = {
      response_version: '2',
      request_id: 'e2e-request',
      image: { width: 1, height: 1 },
      blocks: [{
        text: 'OCR answer',
        bbox: [[0, 0], [1, 0], [1, 1], [0, 1]],
        confidence: 0.99,
        block_index: 0,
        line_index: 0,
        reading_order: 0,
        line: 1,
      }],
      full_text: 'OCR answer',
      warnings: [],
      elapsed_ms: 2,
    }
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(response), {
      headers: { 'content-type': 'application/json' },
    })))
    vi.stubGlobal('fetch', fetchMock)

    const client = new OcrHttpClient({
      serviceUrl: 'http://127.0.0.1:8765',
      getToken: () => '',
      timeoutMs: 2_000,
      maxConcurrency: 1,
    })
    const answer = await new FakeTextModel().answer(rewritten, client)
    const ocr = await client.recognize(image, new AbortController().signal)
    const evidence = renderOcrEvidence(ocr, 'text', 'answer the user')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(answer).toBe('Answer for attachment-e2e: OCR answer')
    expect(evidence).toContain('OCR answer')
    expect(evidence).toContain('UNTRUSTED OCR EVIDENCE')
    expect(evidence).not.toContain('image/png')
  })

  it('never presents the bridge as native vision', () => {
    const messages = [{
      role: 'user',
      content: [{ type: 'image', attachment: { attachmentId: 'opaque-id' } }],
    }] as unknown as Message[]
    const text = JSON.stringify(rewriteImagesToAttachmentHandles(messages))
    expect(text).toContain('text-only')
    expect(text).toContain('Do not claim visual details')
  })
})
