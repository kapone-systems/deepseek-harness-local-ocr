import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import { OcrHttpClient, filterByConfidence } from './client.js'
import { LocalOcrError } from './errors.js'
import { renderOcrEvidence } from './format.js'
import { readServiceToken, type NormalizedPluginConfig } from './plugin-config.js'
import { resolveVisionImage } from './source.js'
import type { OutputMode, Region, VisionSourceArguments } from './types.js'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    request_id: { type: 'string', required: true },
    image: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
    blocks: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          bbox: {
            type: 'array',
            required: true,
            items: {
              type: 'array',
              items: { type: 'number' },
            },
          },
          confidence: { type: 'number', required: true },
          line: { type: 'integer', required: true },
        },
      },
    },
    full_text: { type: 'string', required: true },
    warnings: { type: 'array', required: true, items: { type: 'string' } },
    elapsed_ms: { type: 'integer', required: true },
  },
} as const

const SOURCE_PARAMETERS = {
  attachment_id: {
    type: 'string',
    description: 'An image attachment ID from the current Harness session.',
  },
  file_path: {
    type: 'string',
    description: 'A PNG, JPEG, or WebP path inside configured OCR allowedDirectories.',
  },
  question: {
    type: 'string',
    description: 'Optional OCR focus. It does not enable general image understanding.',
  },
  mode: {
    type: 'string',
    enum: ['text', 'structured', 'markdown'] as const,
    description: 'text for concise reading, structured for the full response, or markdown for line details.',
  },
} as const

export function registerVisionTools(ctx: Context, config: NormalizedPluginConfig): void {
  const client = new OcrHttpClient({
    serviceUrl: config.serviceUrl,
    getToken: () => readServiceToken(config.tokenEnv),
    timeoutMs: config.timeoutMs,
    maxConcurrency: config.maxConcurrency,
  })
  const sourcePolicy = {
    maxBytes: config.maxBytes,
    maxEdge: config.maxEdge,
    maxPixels: config.maxPixels,
    allowedDirectories: config.allowedDirectories,
  }

  ctx.tools.register(defineTool({
    name: 'vision_read',
    description: 'Extract printed or screen text from a current-session image attachment or configured local image. This is local OCR only, not general image understanding.',
    parameters: SOURCE_PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, result) => [{
        type: 'text',
        text: renderOcrEvidence(result, outputMode(args.mode), safeQuestion(args.question)),
      }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = sourceArguments(args)
      const image = await resolveVisionImage(ctx, input, exec, sourcePolicy)
      const response = await client.recognize(image, exec.signal)
      return filterByConfidence(response, config.minConfidence)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_read_region',
    description: 'Extract text from a rectangular pixel region of a current-session image attachment or configured local image. Returned coordinates remain in the original image coordinate system.',
    parameters: {
      ...SOURCE_PARAMETERS,
      x: { type: 'integer', required: true, description: 'Left edge in original-image pixels.' },
      y: { type: 'integer', required: true, description: 'Top edge in original-image pixels.' },
      width: { type: 'integer', required: true, description: 'Positive region width in pixels.' },
      height: { type: 'integer', required: true, description: 'Positive region height in pixels.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, result) => [{
        type: 'text',
        text: renderOcrEvidence(result, outputMode(args.mode), safeQuestion(args.question)),
      }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = sourceArguments(args)
      const region = validateRegion(args)
      const image = await resolveVisionImage(ctx, input, exec, sourcePolicy)
      const response = await client.recognize(image, exec.signal, region)
      return filterByConfidence(response, config.minConfidence)
    },
  }))
}

function sourceArguments(value: VisionSourceArguments): VisionSourceArguments {
  const output: VisionSourceArguments = { mode: outputMode(value.mode) }
  const attachmentId = stringOrUndefined(value.attachment_id)
  const filePath = stringOrUndefined(value.file_path)
  const question = safeQuestion(value.question)
  if (attachmentId !== undefined) output.attachment_id = attachmentId
  if (filePath !== undefined) output.file_path = filePath
  if (question !== undefined) output.question = question
  return output
}

function outputMode(value: unknown): OutputMode {
  if (value === undefined || value === 'text') return 'text'
  if (value === 'structured' || value === 'markdown') return value
  throw new LocalOcrError('OCR_INVALID_REQUEST', 'mode must be text, structured, or markdown.')
}

function safeQuestion(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > 1_000) {
    throw new LocalOcrError('OCR_INVALID_REQUEST', 'question must be a string of at most 1000 characters.')
  }
  return value
}

function stringOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > 4_096) {
    throw new LocalOcrError('OCR_INVALID_REQUEST', 'attachment_id and file_path must be strings of at most 4096 characters.')
  }
  return value
}

function validateRegion(value: { x?: unknown, y?: unknown, width?: unknown, height?: unknown }): Region {
  const x = integer(value.x, 'x')
  const y = integer(value.y, 'y')
  const width = integer(value.width, 'width')
  const height = integer(value.height, 'height')
  if (x < 0 || y < 0 || width <= 0 || height <= 0) {
    throw new LocalOcrError(
      'OCR_INVALID_REGION',
      'Region x/y must be non-negative and width/height must be positive integers.',
    )
  }
  return { x, y, width, height }
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new LocalOcrError('OCR_INVALID_REGION', `${name} must be a safe integer.`)
  }
  return value as number
}
