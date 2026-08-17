import { LocalOcrError } from './errors.js'

export interface LocalOcrPluginConfig {
  serviceUrl: string
  tokenEnv: string
  timeout: number
  maxFile: number
  minConfidence: number
  maxConcurrency: number
  allowedDirectories: string[]
  maxEdge: number
  maxPixels: number
  bridgeProvider: string
  upstreamProvider: string
  rewriteImageAttachments: boolean
}

export interface NormalizedPluginConfig {
  serviceUrl: string
  tokenEnv: string
  timeoutMs: number
  maxBytes: number
  minConfidence: number
  maxConcurrency: number
  allowedDirectories: readonly string[]
  maxEdge: number
  maxPixels: number
  bridgeProvider: string
  upstreamProvider: string
}

const MAX_FILE_MB = 512
const MAX_EDGE = 100_000
const MAX_PIXELS = 500_000_000
const TOKEN_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Validate configuration again at runtime instead of trusting profile patches. */
export function normalizePluginConfig(config: LocalOcrPluginConfig): NormalizedPluginConfig {
  const serviceUrl = nonEmpty(config.serviceUrl, 'serviceUrl')
  const tokenEnv = nonEmpty(config.tokenEnv, 'tokenEnv')
  if (!TOKEN_ENV_NAME.test(tokenEnv)) {
    throw new LocalOcrError('OCR_INVALID_CONFIGURATION', 'tokenEnv must be a valid environment-variable name.')
  }
  const timeout = boundedNumber(config.timeout, 'timeout', 0.001, 600)
  const maxFile = boundedNumber(config.maxFile, 'maxFile', 0.001, MAX_FILE_MB)
  const minConfidence = boundedNumber(config.minConfidence, 'minConfidence', 0, 1)
  const maxConcurrency = boundedInteger(config.maxConcurrency, 'maxConcurrency', 1, 32)
  const maxEdge = boundedInteger(config.maxEdge, 'maxEdge', 1, MAX_EDGE)
  const maxPixels = boundedInteger(config.maxPixels, 'maxPixels', 1, MAX_PIXELS)
  const bridgeProvider = providerName(config.bridgeProvider, 'bridgeProvider')
  const upstreamProvider = providerName(config.upstreamProvider, 'upstreamProvider')
  if (bridgeProvider === upstreamProvider) {
    throw new LocalOcrError(
      'OCR_INVALID_CONFIGURATION',
      'bridgeProvider and upstreamProvider must be different to prevent recursive model streaming.',
    )
  }
  if (config.rewriteImageAttachments !== true) {
    throw new LocalOcrError(
      'OCR_INVALID_CONFIGURATION',
      'rewriteImageAttachments must remain enabled because the upstream DeepSeek route is text-only.',
    )
  }
  if (!Array.isArray(config.allowedDirectories) || !config.allowedDirectories.every(directory => typeof directory === 'string')) {
    throw new LocalOcrError('OCR_INVALID_CONFIGURATION', 'allowedDirectories must be an array of directory paths.')
  }
  const allowedDirectories = [...new Set(config.allowedDirectories.map(directory => directory.trim()).filter(Boolean))]
  const maxBytes = Math.floor(maxFile * 1024 * 1024)

  return {
    serviceUrl,
    tokenEnv,
    timeoutMs: Math.round(timeout * 1000),
    maxBytes,
    minConfidence,
    maxConcurrency,
    allowedDirectories,
    maxEdge,
    maxPixels,
    bridgeProvider,
    upstreamProvider,
  }
}

/** Resolve the optional secret at request time so profile dumps cannot reveal it. */
export function readServiceToken(tokenEnv: string): string {
  return process.env[tokenEnv] ?? ''
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 512) {
    throw new LocalOcrError('OCR_INVALID_CONFIGURATION', `${name} must be a non-empty string.`)
  }
  return value.trim()
}

function providerName(value: unknown, name: string): string {
  const normalized = nonEmpty(value, name)
  if (/\s/.test(normalized)) {
    throw new LocalOcrError('OCR_INVALID_CONFIGURATION', `${name} must not contain whitespace.`)
  }
  return normalized
}

function boundedNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new LocalOcrError(
      'OCR_INVALID_CONFIGURATION',
      `${name} must be a number between ${minimum} and ${maximum}.`,
    )
  }
  return value
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new LocalOcrError(
      'OCR_INVALID_CONFIGURATION',
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    )
  }
  return value as number
}
