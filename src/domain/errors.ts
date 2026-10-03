/** A classified plugin failure; `category` is the audit vocabulary shared with
 *  the run state machine and with `manage-run.py`'s `record-error`. */
export type ErrorCategory =
  | 'unavailable'
  | 'authentication'
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'service'
  | 'capability'
  | 'safety_rejection'

/** One error type for everything this plugin throws at the model or the user. */
export class WhalechanError extends Error {
  readonly category: ErrorCategory

  constructor(message: string, category: ErrorCategory = 'service') {
    super(message)
    this.name = 'WhalechanError'
    this.category = category
  }
}

/** Map an HTTP status from the dsh-imagegen route family onto a category. */
export function classifyHttp(status: number): ErrorCategory {
  if (status === 401 || status === 403) return 'authentication'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'service'
  return 'capability'
}

/** Substrings that mean "the upstream model refused this content". */
export const SAFETY_HINTS: readonly string[] = [
  'safety', 'blocked', 'moderation', 'content policy', '敏感', '违规', '不安全',
]

/** Endpoint error codes the adapter maps to `capability` rather than `service`. */
const CAPABILITY_CODES: ReadonlySet<string> = new Set([
  'bad-request',
  'image-model-not-configured',
  'no-models-configured',
  'model-choice-required',
  'edit-unsupported',
  'no-channels',
  'edit-image-missing',
  'edit-image-invalid',
  'edit-image-too-large',
])

/**
 * Classify one `{ok:false, code, message}` body from the dsh-imagegen routes.
 *
 * The route family answers HTTP 200 even for failures, so the status code is
 * useless here and the body carries the meaning.
 */
export function classifyEndpointError(code: string, message: string): ErrorCategory {
  const lowered = message.toLowerCase()
  // Python's original test is `hint in message or hint in lowered`; the hint
  // list is lowercase, so the second half is the case-insensitive path.
  for (const hint of SAFETY_HINTS) {
    if (message.includes(hint) || lowered.includes(hint)) return 'safety_rejection'
  }
  if (CAPABILITY_CODES.has(code)) return 'capability'
  if (code === 'upstream-timeout') return 'timeout'
  return 'service'
}
