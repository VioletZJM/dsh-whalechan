/**
 * The places JavaScript and Python disagree about numbers and strings.
 *
 * Every function here exists because a naive JavaScript spelling produces a
 * *plausible* value that is not the one Python produces. In this project those
 * values are baked into frozen assignments and digests, so the drift does not
 * surface where the mistake is — it surfaces later, in another file, as a
 * mismatch against a frozen assignment.
 *
 * Three separate Python number spellings are involved and they are not
 * interchangeable:
 *
 * | Python | Here | `2.8` | `4.0` | `2800000.0` |
 * | --- | --- | --- | --- | --- |
 * | `repr(x)` | {@link pythonFloatRepr} | `2.8` | `4.0` | `2800000.0` |
 * | `f"{x:g}"` | {@link formatGeneral} | `2.8` | `4` | `2.8e+06` |
 * | `round(x)` | {@link pythonRound} | `3` | `4` | `2800000` |
 */

/**
 * Python's `repr(float)`, restricted to the band where it stays positional.
 *
 * Python writes `4.0` for an integral float and JavaScript writes `4`, which
 * alone would change every digest whose mean or bound happens to be integral —
 * and head ratios like 4.0 and 5.0 are ordinary values here, not edge cases.
 *
 * Outside `1e-4 <= |value| < 1e16` Python switches to exponent notation
 * (`1e+16`, `1e-05`), where reproducing it exactly is a different problem. Head
 * ratios never reach that band, so this refuses rather than emits a digest it
 * cannot vouch for.
 * @param value - the number to render.
 * @returns Python's positional `repr`, including the trailing `.0`.
 */
export function pythonFloatRepr(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`cannot hash a non-finite number: ${String(value)}`)
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0'
  const magnitude = Math.abs(value)
  if (magnitude < 1e-4 || magnitude >= 1e16) {
    throw new RangeError(
      `cannot hash ${String(value)}: Python renders it in exponent form, outside the positional range this port reproduces`,
    )
  }
  const rendered = String(value)
  return rendered.includes('.') ? rendered : `${rendered}.0`
}

/** Drop a fractional part that is only zeros. */
function stripTrailingZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

/**
 * Format a number the way Python's `%g` does at its default precision of 6.
 *
 * This matters more than it looks: `f"{heads:g}"` is how the heads value enters
 * the prompt, so a naive `String(value)` would emit `2.8000000000000003` for a
 * value that Python prints as `2.8` — one character of drift, silently.
 */
export function formatGeneral(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  if (value === 0) return '0'
  const magnitude = Math.abs(value)
  const exponent = Math.floor(Math.log10(magnitude))
  if (exponent < -4 || exponent >= 6) {
    const [mantissa = '', rawExponent = ''] = value.toExponential(5).split('e')
    const trimmed = stripTrailingZeros(mantissa)
    const sign = rawExponent.startsWith('-') ? '-' : '+'
    const digits = rawExponent.replace(/^[+-]/, '').padStart(2, '0')
    return `${trimmed}e${sign}${digits}`
  }
  return stripTrailingZeros(value.toPrecision(6))
}

/**
 * Round the way Python's built-in `round` does: half-to-even.
 *
 * `Math.round` is half-away-from-zero, so `Math.round(2.5) === 3` while
 * `round(2.5) == 2`. The difference is invisible for the five built-in presets
 * and visible for a custom ratio that lands exactly on a half — exactly the
 * kind of drift a byte-identical port cannot afford.
 * @param value - the number to round.
 * @returns the nearest integer, ties to even.
 */
export function pythonRound(value: number): number {
  const floor = Math.floor(value)
  const fraction = value - floor
  if (fraction > 0.5) return floor + 1
  if (fraction < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/** Lowercase, zero-padded, four hex digits — Python's `\u` form. */
function hex4(code: number): string {
  return code.toString(16).padStart(4, '0')
}

/**
 * JSON string escaping as `json.dumps` does it with its default
 * `ensure_ascii=True`: everything outside `0x20`–`0x7E` becomes `\uXXXX`, and
 * astral code points become a surrogate pair.
 * @param value - the string to escape.
 * @returns the quoted, escaped JSON string.
 */
export function pythonJsonString(value: string): string {
  let out = '"'
  for (const character of value) {
    switch (character) {
      case '"': out += '\\"'; continue
      case '\\': out += '\\\\'; continue
      case '\n': out += '\\n'; continue
      case '\r': out += '\\r'; continue
      case '\t': out += '\\t'; continue
      case '\b': out += '\\b'; continue
      case '\f': out += '\\f'; continue
      default: break
    }
    const code = character.codePointAt(0) ?? 0
    if (code >= 0x20 && code < 0x7f) {
      out += character
    } else if (code > 0xffff) {
      const offset = code - 0x10000
      out += `\\u${hex4(0xd800 + (offset >> 10))}\\u${hex4(0xdc00 + (offset & 0x3ff))}`
    } else {
      out += `\\u${hex4(code)}`
    }
  }
  return `${out}"`
}

/**
 * Python's `math.isclose(a, b, rel_tol, abs_tol)`.
 *
 * Python's spelling is `abs(a-b) <= max(rel_tol * max(|a|,|b|), abs_tol)`, which
 * is not JavaScript's usual epsilon comparison. Note that the two tolerances are
 * used differently by different callers: the catalog check passes only
 * `abs_tol=0.0005`, while the output-geometry check passes only `rel_tol=0.02`
 * and leaves `abs_tol` at zero.
 * @param left - one value.
 * @param right - the other value.
 * @param absoluteTolerance - the `abs_tol` argument.
 * @param relativeTolerance - the `rel_tol` argument.
 * @returns whether Python would call the two close.
 */
export function isClose(
  left: number,
  right: number,
  absoluteTolerance = 0,
  relativeTolerance = 1e-9,
): boolean {
  return Math.abs(left - right)
    <= Math.max(relativeTolerance * Math.max(Math.abs(left), Math.abs(right)), absoluteTolerance)
}
