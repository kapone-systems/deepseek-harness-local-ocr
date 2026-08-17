import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable, model-visible plugin failures without leaking image or credential data. */
export class LocalOcrError extends HarnessError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, code, options)
  }
}

export function abortError(): LocalOcrError {
  return new LocalOcrError('OCR_ABORTED', 'The local OCR request was cancelled.')
}
