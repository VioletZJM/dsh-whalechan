/**
 * The settings schema is a user interface, and every field in it is a promise.
 *
 * The host renders one control per declared field. So a field that no line of code
 * reads is a **lie with a switch on it**: the user flips it, nothing happens, and they
 * are right to conclude the plugin is broken. `announceToAgent` lived here for three
 * versions exactly like that — declared, defaulted to true, and read by nothing — and
 * the reason it survived is that no test could see it.
 *
 * This file makes it visible: each declared field must appear as a property access
 * somewhere in `src/` outside its own declaration.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_FIELDS, Config } from '../src/settings.ts'
import { REPO_ROOT } from '../src/run/vendor.ts'

/** Every `.ts` file under `src/`. */
function sourceFiles(directory: string = join(REPO_ROOT, 'src')): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

/** Which of these field names never appears as a property access in `src/`. */
function unreadFields(fields: readonly string[]): string[] {
  const declaration = join(REPO_ROOT, 'src', 'settings.ts')
  const sources = sourceFiles()
    .filter(file => file !== declaration)
    .map(file => readFileSync(file, 'utf8'))
  return fields.filter(field => (
    !sources.some(text => text.includes(`.${field}`) || text.includes(`['${field}']`))
  ))
}

test('settings: the schema declares exactly the fields the plugin publishes', () => {
  // The schema is the host's only source of truth for the card, so the two lists have
  // to agree — this is what a reader of either one will believe.
  const declared = Object.keys((Config as unknown as { dict?: Record<string, unknown> }).dict ?? {})
  if (declared.length > 0) {
    assert.deepEqual(declared.sort(), [...CONFIG_FIELDS].sort())
  }
  assert.deepEqual([...CONFIG_FIELDS], ['enabled', 'imagegenBaseUrl', 'defaultModel', 'dataRoot'])
})

test('settings: every declared field is read somewhere in src/', () => {
  const unread = unreadFields(CONFIG_FIELDS)
  assert.deepEqual(
    unread,
    [],
    `these settings fields are declared but never read, so their controls do nothing: ${unread.join(', ')}. `
      + 'Either wire them or delete them — a switch that does nothing is worse than no switch.',
  )
})

test('NEGATIVE: the guard above actually fails on an unread field', () => {
  // Pinned rather than checked by hand once. `announceToAgent` is the field that lived
  // here for three versions doing nothing, so it is the fixture: a guard that silently
  // passes is indistinguishable from a guard that works.
  assert.deepEqual(unreadFields([...CONFIG_FIELDS, 'announceToAgent']), ['announceToAgent'])
})
