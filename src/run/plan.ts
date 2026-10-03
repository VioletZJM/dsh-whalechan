/**
 * Canonical JSON: the serialization every digest in this plugin is taken over.
 *
 * The digest has to be stable across processes and platforms, so it cannot rely on
 * `JSON.stringify`'s key order or on how it spells a number. Both are real risks
 * here: Python wrote the frozen artefacts, so `4.0` must not become `4`, and a key
 * order that followed insertion order would make the same plan hash differently
 * depending on how it was built.
 *
 * This used to live beside a whole plan compiler. That compiler is gone — v0.3 draws
 * from a description rather than from a frozen assignment document — and the
 * serialization is the part that had to survive: `whalechan_image`'s `plan_id` is
 * taken over it.
 */
import { WhalechanError } from '../domain/errors.ts'
import { pythonFloatRepr, pythonJsonString } from '../domain/python-compat.ts'

/**
 * Render a JSON value the way Python's `json.dumps(..., sort_keys=True)` renders it,
 * with numbers spelled as Python spells them.
 * @param value - any JSON value.
 * @returns the canonical text.
 * @throws WhalechanError when a value cannot be canonicalized at all.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record).sort()
      .map(key => `${pythonJsonString(key)}:${canonicalJson(record[key])}`)
    return `{${entries.join(',')}}`
  }
  if (typeof value === 'string') return pythonJsonString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : pythonFloatRepr(value)
  }
  throw new WhalechanError(`cannot canonicalize a ${typeof value}`, 'service')
}
