/**
 * Single source of truth for the reported plugin version.
 *
 * Kept in step with `package.json` by a test, because an installer resolves the
 * manifest while the host reports this constant: two literals with no guard name
 * two different builds the first time one of them is bumped.
 */
export const VERSION = '0.5.0'
