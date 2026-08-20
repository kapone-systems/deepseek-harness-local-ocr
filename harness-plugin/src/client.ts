import { abortError, LocalOcrError } from './errors.js'
import { extensionForMediaType } from './image.js'
import type { OcrBlock, OcrResponse, Region, ResolvedImage } from './types.js'

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export interface OcrClientOptions {
  serviceUrl: string
  getToken: () => string
  timeoutMs: number
  maxConcurrency: number
  maxResponseBytes?: number
}

export class OcrHttpClient {
  private readonly baseUrl: URL
  private readonly semaphore: Semaphore
  private readonly maxResponseBytes: number

  constructor(private readonly options: OcrClientOptions) {
    this.baseUrl = assertLoopbackServiceUrl(options.serviceUrl)
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600_000) {
      throw new LocalOcrError('OCR_INVALID_CONFIGURATION', 'OCR timeout must be between 1 ms and 600 seconds.')
    }
    if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1 || options.maxConcurrency > 32) {
      throw new LocalOcrError('OCR_INVALID_CONFIGURATION', 'OCR maxConcurrency must be an integer between 1 and 32.')
    }
    this.semaphore = new Semaphore(options.maxConcurrency)
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) {
      throw new LocalOcrError('OCR_INVALID_CONFIGURATION', 'OCR response-size limit must be a positive integer.')
    }
  }

  async recognize(image: ResolvedImage, callerSignal: AbortSignal, region?: Region): Promise<OcrResponse> {
    const deadline = new AbortController()
    const deadlineHandle = setTimeout(() => deadline.abort(), this.options.timeoutMs)
    const signal = AbortSignal.any([callerSignal, deadline.signal])
    try {
      return await this.semaphore.run(signal, () => this.request(image, signal, deadline.signal, region))
    } catch (error: unknown) {
      if (callerSignal.aborted) throw abortError()
      if (deadline.signal.aborted && isAbortError(error)) {
        throw new LocalOcrError(
          'OCR_TIMEOUT',
          `The local OCR service did not respond within ${this.options.timeoutMs / 1000} seconds.`,
          { cause: error },
        )
      }
      throw error
    } finally {
      clearTimeout(deadlineHandle)
    }
  }

  private async request(
    image: ResolvedImage,
    signal: AbortSignal,
    deadlineSignal: AbortSignal,
    region?: Region,
  ): Promise<OcrResponse> {
    const form = new FormData()
    const uploadBytes = image.data.slice().buffer
    form.append(
      'file',
      new Blob([uploadBytes], { type: image.mediaType }),
      `upload${extensionForMediaType(image.mediaType)}`,
    )
    if (region !== undefined) {
      form.append('x', String(region.x))
      form.append('y', String(region.y))
      form.append('width', String(region.width))
      form.append('height', String(region.height))
    }

    let response: Response
    try {
      const token = this.options.getToken()
      const request: RequestInit = {
        method: 'POST',
        body: form,
        signal,
      }
      if (token.length > 0) request.headers = { authorization: `Bearer ${token}` }
      response = await fetch(
        endpoint(this.baseUrl, region === undefined ? 'v1/ocr' : 'v1/ocr/region'),
        request,
      )
    } catch (error: unknown) {
      if (deadlineSignal.aborted) {
        throw new LocalOcrError(
          'OCR_TIMEOUT',
          `The local OCR service did not respond within ${this.options.timeoutMs / 1000} seconds.`,
          { cause: error },
        )
      }
      if (signal.aborted) throw abortError()
      throw new LocalOcrError(
        'OCR_RUNTIME_NOT_RUNNING',
        'The local OCR Runtime is not running. Run `npx dsh-local-ocr-runtime start` and retry.',
        { cause: error },
      )
    }

    const body = await readBoundedBody(response, this.maxResponseBytes, signal)
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch (error: unknown) {
      throw new LocalOcrError(
        'OCR_INVALID_SERVICE_RESPONSE',
        'The local OCR service returned malformed JSON.',
        { cause: error },
      )
    }
    if (!response.ok) throw serviceHttpError(response.status, parsed)
    return validateOcrResponse(parsed)
  }
}

export function assertLoopbackServiceUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch (error: unknown) {
    throw new LocalOcrError('OCR_INVALID_SERVICE_URL', 'OCR serviceUrl must be a valid loopback HTTP URL.', { cause: error })
  }
  const port = Number(url.port)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username.length > 0 || url.password.length > 0
    || url.port.length === 0 || !Number.isSafeInteger(port) || port < 1 || port > 65_535
    || url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0) {
    throw new LocalOcrError(
      'OCR_NON_LOOPBACK_SERVICE_URL',
      'OCR serviceUrl must use plain HTTP on 127.0.0.1 with an explicit port and no path, query, or credentials.',
    )
  }
  return url
}

export function filterByConfidence(response: OcrResponse, minimum: number): OcrResponse {
  const blocks = response.blocks.filter(block => block.confidence >= minimum)
  if (blocks.length === response.blocks.length) return response
  const omitted = response.blocks.length - blocks.length
  return {
    ...response,
    blocks,
    full_text: blocks.map(block => block.text).join('\n'),
    warnings: [...response.warnings, `${omitted} block(s) below the plugin minimum confidence were omitted.`],
  }
}

function endpoint(base: URL, path: string): URL {
  const normalized = new URL(base.href)
  if (!normalized.pathname.endsWith('/')) normalized.pathname += '/'
  return new URL(path, normalized)
}

async function readBoundedBody(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel()
    throw new LocalOcrError('OCR_RESPONSE_TOO_LARGE', 'The local OCR service response exceeded its safety limit.')
  }
  if (response.body === null) {
    throw new LocalOcrError('OCR_INVALID_SERVICE_RESPONSE', 'The local OCR service returned no response body.')
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      if (signal.aborted) throw abortError()
      const item = await reader.read()
      if (item.done) break
      total += item.value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new LocalOcrError('OCR_RESPONSE_TOO_LARGE', 'The local OCR service response exceeded its safety limit.')
      }
      chunks.push(item.value)
    }
  } catch (error: unknown) {
    if (signal.aborted) throw abortError()
    throw error
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new LocalOcrError(
      'OCR_INVALID_SERVICE_RESPONSE',
      'The local OCR service returned a non-UTF-8 response.',
      { cause: error },
    )
  }
}

function serviceHttpError(status: number, parsed: unknown): LocalOcrError {
  const error = record(parsed)?.error
  const detail = record(error)
  const rawCode = detail?.code
  const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode)
    ? rawCode
    : `OCR_HTTP_${status}`
  const rawMessage = detail?.message
  const message = typeof rawMessage === 'string' && rawMessage.length > 0
    ? rawMessage.slice(0, 500)
    : `The local OCR service rejected the request (HTTP ${status}).`
  return new LocalOcrError(code, `Local OCR service error: ${message}${remediationForCode(code)}`)
}

export function validateOcrResponse(value: unknown): OcrResponse {
  const root = record(value)
  if (root === undefined
    || typeof root.response_version !== 'string'
    || typeof root.request_id !== 'string' || root.request_id.length === 0
    || typeof root.full_text !== 'string'
    || !Array.isArray(root.blocks)
    || !Array.isArray(root.warnings) || !root.warnings.every(item => typeof item === 'string')
    || !isNonNegativeInteger(root.elapsed_ms)) {
    return invalidResponse()
  }
  if (!isResponseVersion(root.response_version)) {
    throw new LocalOcrError(
      'OCR_VERSION_MISMATCH',
      `The OCR Runtime returned response version ${root.response_version}; run \`npx dsh-local-ocr-runtime doctor\` and update the plugin/runtime pair.`,
    )
  }
  const image = record(root.image)
  if (image === undefined || !isPositiveInteger(image.width) || !isPositiveInteger(image.height)) {
    return invalidResponse()
  }
  const blocks: OcrBlock[] = []
  for (const candidate of root.blocks) {
    const block = record(candidate)
    if (block === undefined
      || typeof block.text !== 'string'
      || !isConfidence(block.confidence)
      || !isNonNegativeInteger(block.block_index)
      || !isNonNegativeInteger(block.line_index)
      || !isNonNegativeInteger(block.reading_order)
      || !isPositiveInteger(block.line)
      || !isBbox(block.bbox, image.width, image.height)) {
      return invalidResponse()
    }
    blocks.push({
      text: block.text,
      bbox: block.bbox,
      confidence: block.confidence,
      block_index: block.block_index,
      line_index: block.line_index,
      reading_order: block.reading_order,
      line: block.line,
    })
  }
  const canonicalText = blocks.map(block => block.text).join('\n')
  if (root.full_text !== canonicalText) return invalidResponse()
  return {
    response_version: root.response_version,
    request_id: root.request_id,
    image: { width: image.width, height: image.height },
    blocks,
    full_text: root.full_text,
    warnings: [...root.warnings],
    elapsed_ms: root.elapsed_ms,
  }
}

function isResponseVersion(value: unknown): value is string {
  return value === '2' || value === '2.0'
}

function remediationForCode(code: string): string {
  switch (code) {
    case 'OCR_MODEL_NOT_READY':
    case 'OCR_ENGINE_UNAVAILABLE':
      return ' Run `npx dsh-local-ocr-runtime setup` and then `npx dsh-local-ocr-runtime start`.'
    case 'OCR_RUNTIME_NOT_INSTALLED':
      return ' Run `npx dsh-local-ocr-runtime setup`.'
    case 'OCR_RUNTIME_NOT_RUNNING':
    case 'OCR_SERVICE_UNAVAILABLE':
      return ' Run `npx dsh-local-ocr-runtime start`.'
    case 'OCR_VERSION_MISMATCH':
      return ' Run `npx dsh-local-ocr-runtime doctor` and update the plugin/runtime pair.'
    default:
      return ''
  }
}

function isBbox(value: unknown, width: number, height: number): value is OcrBlock['bbox'] {
  return Array.isArray(value) && value.length === 4 && value.every((point) => (
    Array.isArray(point) && point.length === 2
    && typeof point[0] === 'number' && Number.isFinite(point[0]) && point[0] >= 0 && point[0] <= width
    && typeof point[1] === 'number' && Number.isFinite(point[1]) && point[1] >= 0 && point[1] <= height
  ))
}

function isConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function invalidResponse(): never {
  throw new LocalOcrError(
    'OCR_INVALID_SERVICE_RESPONSE',
    'The local OCR service response did not match the expected OCR schema.',
  )
}

function isAbortError(error: unknown): boolean {
  return error instanceof LocalOcrError && error.code === 'OCR_ABORTED'
}

interface Waiter {
  signal: AbortSignal
  resolve: () => void
  reject: (error: LocalOcrError) => void
  onAbort: () => void
}

class Semaphore {
  private active = 0
  private readonly waiters: Waiter[] = []

  constructor(private readonly limit: number) {}

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await this.acquire(signal)
    try {
      return await operation()
    } finally {
      this.release()
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError())
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(abortError())
        },
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private release(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal.aborted) continue
      waiter.resolve()
      return
    }
    this.active -= 1
  }
}
