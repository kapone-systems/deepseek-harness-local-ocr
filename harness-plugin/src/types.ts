export type SupportedImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp'
export type OutputMode = 'text' | 'structured' | 'markdown'

export interface ImageLimits {
  maxBytes: number
  maxEdge: number
  maxPixels: number
}

export interface ResolvedImage {
  data: Uint8Array
  mediaType: SupportedImageMediaType
  width: number
  height: number
}

export interface OcrImageInfo {
  width: number
  height: number
}

export interface OcrBlock {
  text: string
  bbox: number[][]
  confidence: number
  /** Zero-based ordinal in the response after reading-order normalization. */
  block_index: number
  /** Zero-based visual line index after bbox clustering. */
  line_index: number
  /** Zero-based ordinal in the final reading order. */
  reading_order: number
  /** V1 one-based block ordinal alias; use line_index for new integrations. */
  line: number
}

export interface OcrResponse {
  response_version: string
  request_id: string
  image: OcrImageInfo
  blocks: OcrBlock[]
  full_text: string
  warnings: string[]
  elapsed_ms: number
}

export interface VisionSourceArguments {
  attachment_id?: string
  file_path?: string
  question?: string
  mode?: OutputMode
}

export interface Region {
  x: number
  y: number
  width: number
  height: number
}
