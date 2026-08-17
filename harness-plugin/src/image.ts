import { extname } from 'node:path'
import { LocalOcrError } from './errors.js'
import type { ImageLimits, ResolvedImage, SupportedImageMediaType } from './types.js'

const MIME_BY_EXTENSION: Readonly<Record<string, SupportedImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

export function extensionForMediaType(mediaType: SupportedImageMediaType): string {
  switch (mediaType) {
    case 'image/png': return '.png'
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
  }
}

export function mediaTypeForExtension(name: string): SupportedImageMediaType | undefined {
  return MIME_BY_EXTENSION[extname(name).toLowerCase()]
}

export function detectImageMediaType(data: Uint8Array): SupportedImageMediaType | undefined {
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    return 'image/png'
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  if (data.length >= 12
    && ascii(data, 0, 4) === 'RIFF'
    && ascii(data, 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return undefined
}

export function validateImage(
  data: Uint8Array,
  claimedMediaType: string,
  name: string | undefined,
  limits: ImageLimits,
  requireExtension: boolean,
): ResolvedImage {
  if (data.byteLength === 0) {
    throw new LocalOcrError('OCR_EMPTY_IMAGE', 'The selected image is empty.')
  }
  if (data.byteLength > limits.maxBytes) {
    throw new LocalOcrError(
      'OCR_IMAGE_TOO_LARGE',
      `The selected image exceeds the configured ${formatMiB(limits.maxBytes)} MiB limit.`,
    )
  }

  const mediaType = detectImageMediaType(data)
  if (mediaType === undefined) {
    throw new LocalOcrError(
      'OCR_INVALID_IMAGE_SIGNATURE',
      'The selected file does not have a PNG, JPEG, or WebP signature.',
    )
  }
  if (claimedMediaType !== mediaType) {
    throw new LocalOcrError(
      'OCR_IMAGE_TYPE_MISMATCH',
      'The selected image MIME type does not match its file signature.',
    )
  }

  const extensionMediaType = name === undefined ? undefined : mediaTypeForExtension(name)
  const suppliedExtension = name === undefined ? '' : extname(name)
  if ((requireExtension || suppliedExtension.length > 0) && extensionMediaType === undefined) {
    throw new LocalOcrError(
      'OCR_UNSUPPORTED_EXTENSION',
      'Local OCR only accepts .png, .jpg, .jpeg, and .webp files.',
    )
  }
  if (extensionMediaType !== undefined && extensionMediaType !== mediaType) {
    throw new LocalOcrError(
      'OCR_IMAGE_TYPE_MISMATCH',
      'The selected image extension, MIME type, and file signature do not agree.',
    )
  }

  const { width, height } = dimensions(data, mediaType)
  if (width < 1 || height < 1) {
    throw new LocalOcrError('OCR_INVALID_IMAGE_DIMENSIONS', 'The selected image has invalid dimensions.')
  }
  if (width > limits.maxEdge || height > limits.maxEdge) {
    throw new LocalOcrError(
      'OCR_IMAGE_EDGE_LIMIT_EXCEEDED',
      `Image width and height must not exceed ${limits.maxEdge} pixels.`,
    )
  }
  if (width * height > limits.maxPixels) {
    throw new LocalOcrError(
      'OCR_IMAGE_PIXEL_LIMIT_EXCEEDED',
      'The selected image exceeds the configured decoded-pixel safety limit.',
    )
  }
  return { data, mediaType, width, height }
}

function dimensions(data: Uint8Array, mediaType: SupportedImageMediaType): { width: number; height: number } {
  switch (mediaType) {
    case 'image/png': return pngDimensions(data)
    case 'image/jpeg': return jpegDimensions(data)
    case 'image/webp': return webpDimensions(data)
  }
}

function pngDimensions(data: Uint8Array): { width: number; height: number } {
  if (data.length < 24 || ascii(data, 12, 16) !== 'IHDR') return corruptDimensions('PNG')
  return { width: uint32be(data, 16), height: uint32be(data, 20) }
}

function jpegDimensions(data: Uint8Array): { width: number; height: number } {
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset < data.length) {
    while (offset < data.length && data[offset] === 0xff) offset += 1
    if (offset >= data.length) break
    const marker = data[offset]!
    offset += 1
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (marker === 0xda || offset + 2 > data.length) break
    const segmentLength = uint16be(data, offset)
    if (segmentLength < 2 || offset + segmentLength > data.length) break
    if (startOfFrame.has(marker)) {
      if (segmentLength < 7) break
      return { height: uint16be(data, offset + 3), width: uint16be(data, offset + 5) }
    }
    offset += segmentLength
  }
  return corruptDimensions('JPEG')
}

function webpDimensions(data: Uint8Array): { width: number; height: number } {
  let chunk = 12
  while (chunk + 8 <= data.length) {
    const kind = ascii(data, chunk, chunk + 4)
    const size = uint32le(data, chunk + 4)
    const payload = chunk + 8
    if (payload + size > data.length) break
    if (kind === 'VP8X' && size >= 10) {
      return {
        width: 1 + uint24le(data, payload + 4),
        height: 1 + uint24le(data, payload + 7),
      }
    }
    if (kind === 'VP8L' && size >= 5 && data[payload] === 0x2f) {
      const b1 = data[payload + 1]!
      const b2 = data[payload + 2]!
      const b3 = data[payload + 3]!
      const b4 = data[payload + 4]!
      return {
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
      }
    }
    if (kind === 'VP8 ' && size >= 10
      && data[payload + 3] === 0x9d && data[payload + 4] === 0x01 && data[payload + 5] === 0x2a) {
      return {
        width: uint16le(data, payload + 6) & 0x3fff,
        height: uint16le(data, payload + 8) & 0x3fff,
      }
    }
    chunk = payload + size + (size % 2)
  }
  return corruptDimensions('WebP')
}

function corruptDimensions(format: string): never {
  throw new LocalOcrError(
    'OCR_CORRUPT_IMAGE',
    `The selected ${format} image does not contain a valid dimension header.`,
  )
}

function ascii(data: Uint8Array, start: number, end: number): string {
  let value = ''
  for (let index = start; index < end; index += 1) value += String.fromCharCode(data[index] ?? 0)
  return value
}

function uint16be(data: Uint8Array, offset: number): number {
  return ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0)
}

function uint16le(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8)
}

function uint24le(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0)
    + ((data[offset + 1] ?? 0) << 8)
    + ((data[offset + 2] ?? 0) << 16)
}

function uint32be(data: Uint8Array, offset: number): number {
  return (((data[offset] ?? 0) * 0x1000000)
    + ((data[offset + 1] ?? 0) << 16)
    + ((data[offset + 2] ?? 0) << 8)
    + (data[offset + 3] ?? 0)) >>> 0
}

function uint32le(data: Uint8Array, offset: number): number {
  return (((data[offset + 3] ?? 0) * 0x1000000)
    + ((data[offset + 2] ?? 0) << 16)
    + ((data[offset + 1] ?? 0) << 8)
    + (data[offset] ?? 0)) >>> 0
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toLocaleString('en-US', { maximumFractionDigits: 2 })
}
