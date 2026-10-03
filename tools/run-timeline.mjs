#!/usr/bin/env node
/**
 * Where did the last run go? A timeline built from DSH's own session transcript.
 *
 * This exists because the numbers that matter are not visible from inside the
 * plugin. A run that "took fifteen minutes" turns out to spend 6.7% of that in the
 * plugin and 93% in the agent around it, and a run that "burned 12.7M tokens"
 * turns out to have handed the model 7.9 KB — 1.1% of the conversation. Both
 * impressions are corrected by the same artifact: the transcript.
 *
 * It answers three questions with measurements:
 *   - how much wall-clock was model steps versus tool execution;
 *   - which tools and which results carry the weight (results are re-read by every
 *     later step, so their size is multiplied by the number of steps left);
 *   - how much of every request is the fixed tool-schema prefix.
 *
 * Notes on the format, both learned the hard way:
 *   - transcripts are a chain of independently flushed zstd frames, so they must be
 *     split at the frame magic — `zstdDecompressSync` returns after the **first**
 *     frame and reports a 208-character file where 11 MB is on disk;
 *   - a tool result's call id lives on `data.message.toolCallId`, not on
 *     `data.toolCallId`; pairing on the latter silently matches nothing and reports
 *     every tool as instantaneous.
 *
 * Usage:
 *   node tools/run-timeline.mjs                       # newest session of any workspace
 *   node tools/run-timeline.mjs <session-id-fragment>
 *   node tools/run-timeline.mjs <full path to session.v4.jsonl.zstd>
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESSIONS = join(process.env['USERPROFILE'] ?? '', '.dsh', 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Every transcript under `~/.dsh/sessions`, newest first. */
function transcripts() {
  const found = []
  for (const workspace of readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    const directory = join(SESSIONS, workspace.name)
    for (const session of readdirSync(directory, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const file = join(directory, session.name, 'session.v4.jsonl.zstd')
      try {
        const info = statSync(file)
        found.push({ workspace: workspace.name, session: session.name, file, size: info.size, mtime: info.mtimeMs })
      } catch {
        // Not every directory holds a transcript.
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)
}

/** Decode every concatenated frame in the file. */
function decode(file) {
  const buffer = readFileSync(file)
  const offsets = []
  for (let at = buffer.indexOf(MAGIC); at !== -1; at = buffer.indexOf(MAGIC, at + 4)) offsets.push(at)
  const parts = []
  let skipped = 0
  for (let index = 0; index < offsets.length; index += 1) {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offsets[index], end)).toString('utf8'))
    } catch {
      skipped += 1
    }
  }
  const records = []
  for (const line of parts.join('').split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // A record split across a skipped frame.
    }
  }
  return { records, frames: offsets.length, skipped }
}

const argv = process.argv.slice(2)
const lastTurn = argv.includes('--last-turn')
const turnFlagAt = argv.indexOf('--turn')
const wantedTurn = turnFlagAt === -1 ? undefined : Number(argv[turnFlagAt + 1])
const argument = argv.find((value, index) => !value.startsWith('-')
  && (turnFlagAt === -1 || index !== turnFlagAt + 1))
const chosen = argument === undefined
  ? transcripts()[0]
  : (argument.includes('session.v4.jsonl.zstd')
      ? { workspace: '(given)', session: '(given)', file: argument, size: statSync(argument).size, mtime: statSync(argument).mtimeMs }
      : transcripts().find(entry => entry.file.includes(argument) || entry.session.includes(argument)))

if (chosen === undefined) {
  process.stderr.write('no transcript matched\n')
  process.exit(1)
}

const decoded = decode(chosen.file)
const bytes = JSON.stringify(decoded.records).length
const t = ms => `${(ms / 1000).toFixed(1)}s`
const kb = n => `${(n / 1024).toFixed(1)} KB`

/**
 * Scope the report to one turn, because **a session is not a delivery**.
 *
 * The acceptance number for this plugin is per delivery, and after a restart the
 * delivery happens inside a session that already holds hours of other work. Reporting
 * the whole session there would be a true number about the wrong thing.
 *
 * The context accounting is scoped honestly too: the first step of a later turn still
 * has to read everything that came before it, so those bytes are counted as the
 * starting point rather than dropped.
 */
const ranges = []
for (const record of decoded.records) {
  if (record.type === 'turn/start') ranges.push({ turn: record.data.turn, start: record.time, end: undefined })
  if (record.type === 'turn/end') {
    const open = ranges.find(range => range.turn === record.data.turn && range.end === undefined)
    if (open !== undefined) open.end = record.time
  }
}

let records = decoded.records
let scope = `whole session (${ranges.length} turn(s))`
let carriedBytes = 0
let openTurn = false
if (lastTurn || wantedTurn !== undefined) {
  const picked = wantedTurn !== undefined ? ranges.find(range => range.turn === wantedTurn) : ranges.at(-1)
  if (picked === undefined) {
    process.stderr.write(`no turn ${String(wantedTurn)} in a session with ${ranges.length} turn(s)\n`)
    process.exit(1)
  }
  // An in-flight turn has no `turn/end` yet — which is exactly the case when this is
  // run on the turn that is still happening. Measure it to the last record written and
  // say so, rather than reporting NaN.
  if (picked.end === undefined) {
    picked.end = decoded.records.at(-1)?.time ?? picked.start
    openTurn = true
  }
  const end = picked.end
  carriedBytes = decoded.records
    .filter(record => record.time < picked.start && ['assistant/message', 'tool/result', 'user/message'].includes(record.type))
    .reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record.data?.message ?? ''), 'utf8'), 0)
  records = decoded.records.filter(record => (
    ['turn/start', 'turn/end'].includes(record.type)
      ? record.data.turn === picked.turn
      : (record.data?.turn === picked.turn || (record.time >= picked.start && record.time <= end))
  ))
  scope = `turn ${picked.turn} of ${ranges.length}${openTurn ? ' (still open: measured to the last record written)' : ''}`
}

console.log(`session   ${chosen.workspace}\\${chosen.session}`)
console.log(`scope     ${scope}`)
console.log(`frames    ${decoded.frames} decoded, ${decoded.skipped} skipped as false-positive magic`)
console.log(`records   ${records.length} of ${decoded.records.length} (${kb(bytes)} whole session)\n`)

// --- wall clock ---
const turnStart = records.find(record => record.type === 'turn/start')?.time
// An open turn has no `turn/end`: fall back to the last record written, or the report
// prints NaN for the one number it exists to produce.
const turnEnd = records.filter(record => record.type === 'turn/end').at(-1)?.time
  ?? records.reduce((latest, record) => Math.max(latest, record.time ?? 0), turnStart ?? 0)
const calls = new Map()
for (const record of records) {
  if (record.type === 'tool/call') {
    calls.set(record.data.callId, { name: record.data.name, arguments: record.data.arguments, time: record.time, end: undefined, bytes: 0, isError: false, head: '' })
  }
  if (record.type === 'tool/result') {
    const call = calls.get(record.data?.message?.toolCallId)
    if (call === undefined) continue
    call.end = record.time
    const content = record.data.message.content
    const text = Array.isArray(content) ? content.map(part => part?.text ?? '').join('') : ''
    call.bytes = Buffer.byteLength(text, 'utf8')
    call.isError = record.data.message.isError === true
    call.head = text.slice(0, 160).replace(/\s+/g, ' ')
  }
}
const list = [...calls.values()].sort((a, b) => a.time - b.time)
const steps = records.filter(record => record.type === 'step/start').length
const toolTime = list.reduce((sum, call) => sum + Math.max(0, (call.end ?? call.time) - call.time), 0)

console.log(`wall clock        ${t(turnEnd - turnStart)}   (${new Date(turnStart).toLocaleTimeString()} -> ${new Date(turnEnd).toLocaleTimeString()})`)
console.log(`model steps       ${steps}`)
console.log(`tool calls        ${list.length}, executing ${t(toolTime)}`)
console.log(`model + transport ${t(turnEnd - turnStart - toolTime)}\n`)

const byTool = new Map()
for (const call of list) {
  const entry = byTool.get(call.name) ?? { count: 0, time: 0, bytes: 0 }
  entry.count += 1
  entry.time += Math.max(0, (call.end ?? call.time) - call.time)
  entry.bytes += call.bytes
  byTool.set(call.name, entry)
}
console.log('by tool                          calls       time      results')
for (const [name, entry] of [...byTool.entries()].sort((a, b) => b[1].time - a[1].time)) {
  console.log(`  ${name.padEnd(24)} ${String(entry.count).padStart(5)} ${t(entry.time).padStart(10)} ${kb(entry.bytes).padStart(12)}`)
}

const pluginCalls = list.filter(call => call.name.startsWith('whalechan'))
const pluginTime = pluginCalls.reduce((sum, call) => sum + Math.max(0, (call.end ?? call.time) - call.time), 0)
const pluginBytes = pluginCalls.reduce((sum, call) => sum + call.bytes, 0)
console.log(`\nplugin share: ${pluginCalls.length} calls, ${t(pluginTime)} (${(pluginTime / (turnEnd - turnStart) * 100).toFixed(1)}% of wall clock), ${kb(pluginBytes)} returned`)

// --- context cost ---
const headers = records.filter(record => record.type === 'request/header')
const tools = headers
  .map(record => record.data?.header?.tools ?? record.data?.header?.config?.tools ?? [])
  .sort((a, b) => b.length - a.length)[0] ?? []
const sized = tools.map(tool => ({ name: tool.name, bytes: Buffer.byteLength(JSON.stringify(tool), 'utf8') }))
const toolBytes = sized.reduce((sum, tool) => sum + tool.bytes, 0)
const pluginSchemaBytes = sized.filter(tool => tool.name.startsWith('whalechan')).reduce((sum, tool) => sum + tool.bytes, 0)
console.log(`\ntool schemas      ${tools.length} tools, ${kb(toolBytes)} on every request; whalechan ${sized.filter(x => x.name.startsWith('whalechan')).length} tools = ${kb(pluginSchemaBytes)} (${(pluginSchemaBytes / toolBytes * 100).toFixed(1)}%)`)

// The system prompt is written once, at the first turn, and sent on every step of
// every turn — so it is read from the whole session even when the report is scoped to
// a later turn. Taking it from the scoped slice reported "0.0 KB per step".
const systemBytes = decoded.records
  .filter(record => record.type === 'system/message')
  .reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record.data?.message ?? ''), 'utf8'), 0)
// A later turn starts from everything the session already carried, so those bytes are
// the starting point rather than a hole in the arithmetic.
let cumulative = systemBytes + carriedBytes
let sent = 0
for (const record of records) {
  if (record.type === 'step/start') sent += cumulative
  if (['assistant/message', 'tool/result', 'user/message'].includes(record.type)) {
    cumulative += Buffer.byteLength(JSON.stringify(record.data?.message ?? ''), 'utf8')
  }
}
console.log(`context re-read   ${(sent / 1024 / 1024).toFixed(1)} MB summed over ${steps} steps  (~${(sent / 3.5 / 1e6).toFixed(1)}M tokens at bytes/3.5)`)
console.log(`  system prompt   ${kb(systemBytes)} per step`)
console.log(`  carried in      ${kb(carriedBytes)} of earlier turns${carriedBytes === 0 ? ' (none: this is the first turn)' : ''}`)
console.log(`  at the end      ${kb(cumulative)}`)
console.log(`  of which whalechan returned ${kb(pluginBytes)} (${(pluginBytes / cumulative * 100).toFixed(2)}%)`)
