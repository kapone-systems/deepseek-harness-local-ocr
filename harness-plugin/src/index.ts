import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import { registerLocalOcrBridge } from './bridge.js'
import {
  normalizePluginConfig,
  type LocalOcrPluginConfig,
} from './plugin-config.js'
import { registerVisionTools } from './tools.js'

export const name = 'dsh-plugin-local-ocr'

export const inject = ['tools', 'attachments', 'fs', 'llm'] as const

/** Cordis schema for the bundle patch and user profile overrides. */
export const Config = z.object({
  serviceUrl: z.string().default('http://127.0.0.1:8765'),
  // The environment-variable name is safe to display; its value is resolved per request.
  tokenEnv: z.string().default('OCR_SERVICE_TOKEN').role('credential-ref'),
  timeout: z.number().default(30),
  maxFile: z.number().default(15),
  minConfidence: z.number().default(0.5),
  maxConcurrency: z.number().step(1).default(2),
  allowedDirectories: z.array(z.string()).default([]),
  maxEdge: z.number().step(1).default(12_000),
  maxPixels: z.number().step(1).default(40_000_000),
  bridgeProvider: z.string().default('deepseek-local-ocr'),
  upstreamProvider: z.string().default('deepseek-official'),
  rewriteImageAttachments: z.boolean().default(true),
})

export function apply(ctx: Context, config: LocalOcrPluginConfig): void {
  const normalized = normalizePluginConfig(config)
  registerVisionTools(ctx, normalized)
  registerLocalOcrBridge(ctx, normalized)
}
