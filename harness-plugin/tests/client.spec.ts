import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OcrHttpClient,
  assertLoopbackServiceUrl,
  filterByConfidence,
  validateOcrResponse,
} from '../src/client.js'
import type { OcrResponse, ResolvedImage } from '../src/types.js'

const image: ResolvedImage = {
  data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  mediaType: 'image/png',
  width: 10,
  height: 10,
}

const response: OcrResponse = {
  response_version: '2',
  request_id: 'request-1',
  image: { width: 10, height: 10 },
  blocks: [{
    text: 'hello',
    bbox: [[0, 0], [5, 0], [5, 4], [0, 4]],
    confidence: 0.9,
    block_index: 0,
    line_index: 0,
    reading_order: 0,
    line: 1,
  }],
  full_text: 'hello',
  warnings: [],
  elapsed_ms: 3,
}

afterEach(() => vi.unstubAllGlobals())

describe('OCR HTTP client', () => {
  it('allows only a pathless IPv4 loopback URL', () => {
    expect(assertLoopbackServiceUrl('http://127.0.0.1:8765').href).toBe('http://127.0.0.1:8765/')
    expect(() => assertLoopbackServiceUrl('http://127.0.0.1')).toThrow(/explicit port/)
    expect(() => assertLoopbackServiceUrl('http://localhost:8765')).toThrow(/127\.0\.0\.1/)
    expect(() => assertLoopbackServiceUrl('https://127.0.0.1:8765')).toThrow(/plain HTTP/)
    expect(() => assertLoopbackServiceUrl('http://127.0.0.1:8765/api')).toThrow(/no path/)
  })

  it('maps an unreachable service to a safe tool error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network unavailable')))
    const client = new OcrHttpClient({
      serviceUrl: 'http://127.0.0.1:8765',
      getToken: () => '',
      timeoutMs: 1_000,
      maxConcurrency: 1,
    })

    await expect(client.recognize(image, new AbortController().signal)).rejects.toMatchObject({
      code: 'OCR_RUNTIME_NOT_RUNNING',
    })
  })

  it('sends the current optional bearer token without exposing it in results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)))
    vi.stubGlobal('fetch', fetchMock)
    let token = 'first-token'
    const client = new OcrHttpClient({
      serviceUrl: 'http://127.0.0.1:8765',
      getToken: () => token,
      timeoutMs: 1_000,
      maxConcurrency: 1,
    })
    token = 'second-token'

    await expect(client.recognize(image, new AbortController().signal)).resolves.toEqual(response)
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer second-token')
  })

  it('rejects malformed responses and filters confidence consistently', () => {
    expect(() => validateOcrResponse({ ...response, full_text: 'different' })).toThrow(/expected OCR schema/)
    expect(() => validateOcrResponse({ ...response, response_version: '1' })).toThrow(/response version 1/)
    expect(() => validateOcrResponse({ ...response, response_version: '1' })).toThrow(/response version/)
    expect(() => validateOcrResponse({
      ...response,
      blocks: [{ ...response.blocks[0]!, reading_order: -1 }],
    })).toThrow(/expected OCR schema/)
    const filtered = filterByConfidence({
      ...response,
      blocks: [
        ...response.blocks,
        {
          text: 'low',
          bbox: [[0, 5], [5, 5], [5, 8], [0, 8]],
          confidence: 0.2,
          block_index: 1,
          line_index: 1,
          reading_order: 1,
          line: 2,
        },
      ],
      full_text: 'hello\nlow',
    }, 0.5)
    expect(filtered.full_text).toBe('hello')
    expect(filtered.blocks).toHaveLength(1)
    expect(filtered.blocks[0]?.reading_order).toBe(0)
    expect(filtered.warnings.join(' ')).toMatch(/omitted/)
  })
})
