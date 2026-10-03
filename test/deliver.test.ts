/**
 * The delivery seam: how a paid picture reaches the user without the agent.
 *
 * The measurement that forced this module (§73): four model steps and 28 s after the
 * drawing existed, spent fetching, measuring and re-reading a file the plugin already
 * had in hand — because the old result text handed the model a path and told it to go
 * and present the image. The agent is out of that loop now; this is the replacement.
 *
 * Three things carry the weight:
 *   - it appends the **host's own** event, in the host's own shape, exactly once;
 *   - it reads the open turn from the same projection the built-in `present` tool
 *     reads, so a delivered file lands on the right turn;
 *   - it never throws: by the time this runs the money is spent, so a refusal has to
 *     come back as an explanation the result text can print, not as a failed call.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDelivery, type DeliverableFile, type ProjectionsLike } from '../src/run/deliver.ts'

/** One drawn file. */
const FILES: readonly DeliverableFile[] = [
  { path: 'C:\\Users\\x\\.dsh\\dsh-whalechan\\images\\drawing-01.png', description: 'whale-chan · semi-chibi · 1:1' },
]

/** A session that records what was appended to it. */
function fakeSession(): { appends: Array<{ type: string; data: unknown }>; append: (type: string, data: unknown) => void } {
  const appends: Array<{ type: string; data: unknown }> = []
  return { appends, append: (type, data) => { appends.push({ type, data }) } }
}

/** An execution as the host hands it to a tool. */
function fakeExec(session: unknown, callId = 'call-1'): unknown {
  return { callId, agent: { session } }
}

/** The projection service, answering with whatever the test wants. */
function fakeProjections(state: unknown): ProjectionsLike {
  return { stateOf: () => state }
}

/** The projection state of a normal, open turn. */
const OPEN = { lastTurn: 79, openTurnStartSeq: 13720 }

test('delivery: the drawn file is declared on the open turn, in the host’s own event shape', async () => {
  const session = fakeSession()
  const deliver = createDelivery(() => fakeProjections(OPEN))
  const outcome = await deliver(FILES, fakeExec(session))
  assert.deepEqual(outcome, { delivered: 1, error: '' })
  assert.equal(session.appends.length, 1)
  assert.equal(session.appends[0]!.type, 'deliverables/presented')
  assert.deepEqual(session.appends[0]!.data, {
    turn: 79,
    callId: 'call-1',
    files: [{ path: FILES[0]!.path, description: FILES[0]!.description }],
  })
})

test('delivery: two drawings are one event carrying both, in order', async () => {
  const session = fakeSession()
  const deliver = createDelivery(() => fakeProjections({ lastTurn: 3, openTurnStartSeq: 30 }))
  const both = [FILES[0]!, { path: 'C:\\x\\two.png', description: 'two' }]
  assert.equal((await deliver(both, fakeExec(session))).delivered, 2)
  assert.equal(session.appends.length, 1)
  assert.deepEqual((session.appends[0]!.data as { files: unknown[] }).files, [
    { path: both[0]!.path, description: both[0]!.description },
    { path: both[1]!.path, description: both[1]!.description },
  ])
})

test('delivery: nothing drawn declares nothing, and does not touch the session', async () => {
  const session = fakeSession()
  const deliver = createDelivery(() => fakeProjections({ lastTurn: 1, openTurnStartSeq: 10 }))
  assert.deepEqual(await deliver([], fakeExec(session)), { delivered: 0, error: '' })
  assert.equal(session.appends.length, 0)
})

test('delivery: NEGATIVE — every missing host fact is refused with a readable reason, never a throw', async () => {
  const session = fakeSession()
  const files = FILES
  const cases: Array<[string, () => Promise<{ delivered: number; error: string }>]> = [
    ['no projections service', () => createDelivery(() => undefined)(files, fakeExec(session))],
    ['no session on the call', () => createDelivery(() => fakeProjections({ lastTurn: 1, openTurnStartSeq: 10 }))(files, { callId: 'c' })],
    ['no call id', () => createDelivery(() => fakeProjections({ lastTurn: 1, openTurnStartSeq: 10 }))(files, fakeExec(session, ''))],
    ['no projected state', () => createDelivery(() => fakeProjections(undefined))(files, fakeExec(session))],
    ['state without a turn', () => createDelivery(() => fakeProjections({ openTurnStartSeq: 1 }))(files, fakeExec(session))],
    ['a turn that is not a number', () => createDelivery(() => fakeProjections({ lastTurn: '79', openTurnStartSeq: 1 }))(files, fakeExec(session))],
    ['no open turn', () => createDelivery(() => fakeProjections({ lastTurn: 79, openTurnStartSeq: null }))(files, fakeExec(session))],
    ['no execution at all', () => createDelivery(() => fakeProjections({ lastTurn: 1, openTurnStartSeq: 10 }))(files, undefined)],
  ]
  for (const [what, run] of cases) {
    const outcome = await run()
    assert.equal(outcome.delivered, 0, `${what} must deliver nothing`)
    assert.ok(outcome.error.length > 0, `${what} must say why`)
  }
  assert.equal(session.appends.length, 0, 'no refused case may leave an event behind')
})

test('delivery: NEGATIVE — a session that refuses the append is reported, not thrown', async () => {
  const deliver = createDelivery(() => fakeProjections({ lastTurn: 5, openTurnStartSeq: 50 }))
  const outcome = await deliver(FILES, fakeExec({ append: () => { throw new Error('session is read-only') } }))
  assert.deepEqual(outcome, { delivered: 0, error: 'session is read-only' })
})

test('delivery: NEGATIVE — a projection that throws is reported, not thrown', async () => {
  const deliver = createDelivery(() => ({ stateOf: () => { throw new Error('no fold registered') } }))
  const outcome = await deliver(FILES, fakeExec(fakeSession()))
  assert.equal(outcome.delivered, 0)
  assert.match(outcome.error, /no fold registered/)
})

test('delivery: the projection service is read per delivery, so a late bind still works', async () => {
  const session = fakeSession()
  let service: ProjectionsLike | undefined
  const deliver = createDelivery(() => service)
  assert.equal((await deliver(FILES, fakeExec(session))).delivered, 0, 'nothing bound yet')
  service = fakeProjections({ lastTurn: 7, openTurnStartSeq: 70 })
  assert.deepEqual(await deliver(FILES, fakeExec(session)), { delivered: 1, error: '' })
})
