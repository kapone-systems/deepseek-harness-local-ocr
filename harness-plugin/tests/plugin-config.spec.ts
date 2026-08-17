import { describe, expect, it } from 'vitest'
import { normalizePluginConfig } from '../src/plugin-config.js'
import type { LocalOcrPluginConfig } from '../src/plugin-config.js'

const config: LocalOcrPluginConfig = {
  serviceUrl: 'http://127.0.0.1:8765',
  tokenEnv: 'OCR_SERVICE_TOKEN',
  timeout: 30,
  maxFile: 15,
  minConfidence: 0.5,
  maxConcurrency: 2,
  allowedDirectories: ['C:\\workspace', 'C:\\workspace'],
  maxEdge: 12_000,
  maxPixels: 40_000_000,
  bridgeProvider: 'deepseek-local-ocr',
  upstreamProvider: 'deepseek-official',
  rewriteImageAttachments: true,
}

describe('plugin configuration', () => {
  it('normalizes limits without resolving the token value', () => {
    const normalized = normalizePluginConfig(config)
    expect(normalized.timeoutMs).toBe(30_000)
    expect(normalized.maxBytes).toBe(15 * 1024 * 1024)
    expect(normalized.allowedDirectories).toEqual(['C:\\workspace'])
    expect(normalized.tokenEnv).toBe('OCR_SERVICE_TOKEN')
  })

  it('rejects recursive image bridges and disabled image rewriting', () => {
    expect(() => normalizePluginConfig({ ...config, upstreamProvider: 'deepseek-local-ocr' })).toThrow(/different/)
    expect(() => normalizePluginConfig({ ...config, rewriteImageAttachments: false })).toThrow(/must remain enabled/)
  })
})
