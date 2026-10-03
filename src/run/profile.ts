/**
 * Which profile this process was booted with, read from the command line.
 *
 * **Not from the environment.** `DSH_PROFILE` is inherited by the shells the host
 * spawns, so inside a plugin it reports whatever the launching shell happened to
 * carry — the same trap that made a load receipt record another host's address. The
 * launcher takes the profile name as a positional argument (`dsh web`), so that is
 * what is read here.
 *
 * It is a diagnostic, not a switch: everything the plugin does is profile-agnostic,
 * and this exists so the status route and the load receipt can say *where* they are
 * running instead of leaving a reader to guess.
 */

/** What was decided about the profile, and how. */
export interface BootedProfile {
  /** The profile name, or empty when the command line does not name one. */
  readonly profile: string
  /** `argv` when the command line named it, `default` when nothing did. */
  readonly source: 'argv' | 'default'
}

/** Flags whose *next* argument is a value rather than a positional. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--import',
  '--profile',
  '--patch',
  '--from-default-profile',
  '--require',
  '-r',
])

/** Does this token look like a path or a script rather than a profile name? */
function looksLikePath(token: string): boolean {
  return token.includes('/') || token.includes('\\') || /\.(?:js|mjs|cjs|ts|exe)$/i.test(token)
}

/**
 * Read the profile name out of an argv vector.
 * @param argv - the process's own `argv`.
 * @returns the name, or an empty one with source `default`.
 */
export function bootedProfile(argv: readonly string[]): BootedProfile {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? ''
    if (token === '--profile') {
      const name = (argv[index + 1] ?? '').trim()
      return name === '' ? { profile: '', source: 'default' } : { profile: name, source: 'argv' }
    }
    if (VALUE_FLAGS.has(token)) {
      index += 1
      continue
    }
    if (token.startsWith('-')) continue
    // argv[0] is the interpreter and the entry script is a path; neither is a profile.
    if (index === 0 || looksLikePath(token)) continue
    return { profile: token, source: 'argv' }
  }
  return { profile: '', source: 'default' }
}
