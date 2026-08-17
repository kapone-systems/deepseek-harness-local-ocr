import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { LocalOcrError } from './errors.js'
import { mediaTypeForExtension, validateImage } from './image.js'
import type {
  ImageLimits,
  ResolvedImage,
  SupportedImageMediaType,
  VisionSourceArguments,
} from './types.js'

export interface SourcePolicy extends ImageLimits {
  allowedDirectories: readonly string[]
}

/** Resolve only session-authorized attachments or files inside explicit configured roots. */
export async function resolveVisionImage(
  ctx: Context,
  args: VisionSourceArguments,
  exec: ToolRunContext,
  policy: SourcePolicy,
): Promise<ResolvedImage> {
  const attachmentId = args.attachment_id?.trim()
  const filePath = args.file_path?.trim()
  if ((attachmentId === undefined || attachmentId.length === 0)
    === (filePath === undefined || filePath.length === 0)) {
    throw new LocalOcrError(
      'OCR_INVALID_SOURCE',
      'Provide exactly one of attachment_id or file_path.',
    )
  }
  if (exec.agent === undefined) {
    throw new LocalOcrError(
      'OCR_AGENT_REQUIRED',
      'Local OCR sources can only be read from an Agent-backed Harness session.',
    )
  }
  if (attachmentId !== undefined && attachmentId.length > 0) {
    return resolveAttachment(ctx, attachmentId, exec, policy)
  }
  return resolveAllowedFile(ctx, filePath!, exec, policy)
}

export function findSessionAttachment(messages: readonly Message[], attachmentId: string): ImageAttachmentRef | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const found = findInBlocks(messages[messageIndex]!.content, attachmentId)
    if (found !== undefined) return found
  }
  return undefined
}

function findInBlocks(blocks: readonly ContentBlock[], attachmentId: string): ImageAttachmentRef | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!
    if (block.type === 'image' && String(block.attachment.attachmentId) === attachmentId) {
      return block.attachment
    }
    if (block.type === 'tool-result') {
      const nested = findInBlocks(block.content, attachmentId)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

async function resolveAttachment(
  ctx: Context,
  attachmentId: string,
  exec: ToolRunContext,
  policy: SourcePolicy,
): Promise<ResolvedImage> {
  const ref = findSessionAttachment(exec.agent!.session.deriveMessages(), attachmentId)
  if (ref === undefined) {
    throw new LocalOcrError(
      'OCR_ATTACHMENT_NOT_AUTHORIZED',
      'That attachment is not present in the current Harness session.',
    )
  }
  const mediaType = supportedMediaType(ref.mediaType)
  preflightRecordedAttachment(ref, policy)
  const stored = await ctx.attachments.readImage(ref, exec.signal)
  const image = validateImage(stored.data, mediaType, ref.name, policy, false)
  if (image.width !== ref.width || image.height !== ref.height || image.data.byteLength !== ref.bytes) {
    throw new LocalOcrError(
      'OCR_ATTACHMENT_METADATA_MISMATCH',
      'The stored attachment no longer matches its authorized session metadata.',
    )
  }
  return image
}

async function resolveAllowedFile(
  ctx: Context,
  filePath: string,
  exec: ToolRunContext,
  policy: SourcePolicy,
): Promise<ResolvedImage> {
  if (policy.allowedDirectories.length === 0) {
    throw new LocalOcrError(
      'OCR_LOCAL_FILES_DISABLED',
      'Local file OCR is disabled because allowedDirectories is empty; use a Harness attachment.',
    )
  }
  const mediaType = mediaTypeForExtension(filePath)
  if (mediaType === undefined) {
    throw new LocalOcrError(
      'OCR_UNSUPPORTED_EXTENSION',
      'Local OCR only accepts .png, .jpg, .jpeg, and .webp files.',
    )
  }

  const cwd = exec.agent!.session.header.cwd
  const resolveOptions = { ...(cwd === undefined ? {} : { cwd }), signal: exec.signal }
  const target = await ctx.fs.resolve(filePath, resolveOptions)
  let contained = false
  for (const directory of policy.allowedDirectories) {
    const root = await ctx.fs.resolve(directory, resolveOptions)
    const rootInfo = await ctx.fs.stat(root, exec.signal)
    if (rootInfo?.type === 'directory' && ctx.fs.contains(root, target)) {
      contained = true
      break
    }
  }
  if (!contained) {
    throw new LocalOcrError(
      'OCR_PATH_NOT_ALLOWED',
      'The selected file is outside the configured OCR allowedDirectories.',
    )
  }

  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    throw new LocalOcrError('OCR_FILE_NOT_FOUND', 'The selected local image does not exist.')
  }
  if (info.type !== 'file') {
    throw new LocalOcrError('OCR_NOT_A_FILE', 'The selected local OCR source is not a regular file.')
  }
  if (info.size !== undefined && info.size > policy.maxBytes) {
    throw new LocalOcrError(
      'OCR_IMAGE_TOO_LARGE',
      'The selected image exceeds the configured file-size limit.',
    )
  }
  const data = await ctx.fs.readBytes(target, exec.signal, policy.maxBytes)
  return validateImage(data, mediaType, filePath, policy, true)
}

function supportedMediaType(mediaType: string): SupportedImageMediaType {
  if (mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp') return mediaType
  throw new LocalOcrError(
    'OCR_UNSUPPORTED_MEDIA_TYPE',
    'Local OCR only accepts PNG, JPEG, and WebP attachments.',
  )
}

function preflightRecordedAttachment(ref: ImageAttachmentRef, policy: SourcePolicy): void {
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > policy.maxBytes) {
    throw new LocalOcrError('OCR_IMAGE_TOO_LARGE', 'The attachment exceeds the configured OCR file-size limit.')
  }
  if (!Number.isSafeInteger(ref.width) || !Number.isSafeInteger(ref.height)
    || ref.width < 1 || ref.height < 1 || ref.width > policy.maxEdge || ref.height > policy.maxEdge) {
    throw new LocalOcrError(
      'OCR_IMAGE_EDGE_LIMIT_EXCEEDED',
      `Image width and height must not exceed ${policy.maxEdge} pixels.`,
    )
  }
  if (ref.width * ref.height > policy.maxPixels) {
    throw new LocalOcrError(
      'OCR_IMAGE_PIXEL_LIMIT_EXCEEDED',
      'The attachment exceeds the configured decoded-pixel safety limit.',
    )
  }
}
