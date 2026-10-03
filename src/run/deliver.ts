/**
 * Declaring the drawing as this turn's deliverable — the plugin's own hand-off.
 *
 * **Why this module exists** (§73 of the charter). The first real delivery spent
 * four model steps and 28 s *after* the picture existed: the tool result printed the
 * path, and the agent went and found the file, measured it, and read its own sidecar
 * before finally calling `present` to hand it over. The picture was never the agent's
 * to fetch; the plugin had it in hand. So the plugin now declares it itself.
 *
 * The mechanism is the host's own, not a private one: `deliverables/presented` is the
 * event the built-in `present` tool appends, and it is what the client's deliverables
 * card folds into "files this turn produced". This module copies that call shape
 * exactly — the same event type, the same `{turn, callId, files}` payload, read from
 * the same `turnBoundary` projection.
 *
 * **What did NOT work, and is recorded here so it is not tried again.** The obvious
 * design — put the image in the tool result's `presentationMeta` and render it with
 * `presentResult` — is a dead end on this client. `packages/core/tools/README.md` says
 * it plainly: "A tool can retain pure `presentCall()` and `presentResult()` methods for
 * Host-local consumers. The built-in Web Client does not consume those values." The
 * client picks a renderer through the `tool.call.toolview` slot and derives its props
 * from raw call arguments, result content, failure state and persisted metadata. An
 * image block in the result content does not help either: the built-in image card is
 * gated on `call.name === 'read_image'` (`image-card-model.ts`), so a `whalechan_image`
 * result falls back to the generic row, which flattens the image block into a JSON
 * dump of the attachment. Showing the pixels inline needs a client half registered in
 * that slot; declaring the file needs only this event.
 *
 * **Failure policy.** The money is already spent by the time this runs, so a refusal
 * here must never fail the call. It returns why instead, and the tool's rendered text
 * falls back to naming the file — a paid picture the user cannot find is the only real
 * failure in this module.
 */
import type { Context } from '@deepseek-ai/cordis'

/** One drawn file, on its way to the user. */
export interface DeliverableFile {
  /** Absolute path of the file that already exists on disk. */
  readonly path: string
  /** One short label for the card; the client strips a trailing `(…)` from it. */
  readonly description: string
}

/** What the delivery reported back, for the tool to put in its result. */
export interface DeliveryOutcome {
  /** How many files the session accepted as this turn's deliverables. */
  readonly delivered: number
  /** Why nothing was delivered, or `''` when everything was. */
  readonly error: string
}

/** Declare files as this turn's deliverables. */
export type DeliverFiles = (
  files: readonly DeliverableFile[],
  /** The executing tool call; opaque to the tool, read here. */
  exec: unknown,
) => Promise<DeliveryOutcome>

/** The `sessionProjections` operation this module needs, structurally. */
export interface ProjectionsLike {
  /** Fold state for one session and projection key, or `undefined` when absent. */
  stateOf(session: unknown, key: string): unknown
}

/** The session operation this module needs, structurally. */
interface SessionLike {
  append(type: string, data: unknown): unknown
}

/** The execution facts this module reads, structurally. */
interface ExecLike {
  readonly callId?: unknown
  readonly agent?: { readonly session?: unknown } | undefined
}

/** A message from an unknown throwable. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A refusal, in the shape the tool renders. */
function refused(error: string): DeliveryOutcome {
  return { delivered: 0, error }
}

/**
 * Build the delivery seam.
 *
 * Bound once at mount and given to the tool, so the tool itself never touches a
 * session, a projection or a call id: it hands over paths and gets back an outcome.
 * @param projections - live getter for the host's projection service, which may bind
 *   after this plugin mounts.
 * @returns the seam, which never throws.
 */
export function createDelivery(projections: () => ProjectionsLike | undefined): DeliverFiles {
  return async (files, exec) => {
    if (files.length === 0) return { delivered: 0, error: '' }
    const target = exec as ExecLike | undefined
    const callId = target?.callId
    if (typeof callId !== 'string' || callId === '') return refused('this call has no id')
    const session = target?.agent?.session
    if (session === undefined) return refused('this call has no session')
    const service = projections()
    if (service === undefined) return refused('this host has no session projections')
    let state: { lastTurn?: unknown; openTurnStartSeq?: unknown } | undefined
    try {
      state = service.stateOf(session, 'turnBoundary') as typeof state
    } catch (error) {
      return refused(`the open turn could not be read: ${reasonOf(error)}`)
    }
    // The same precondition the built-in `present` tool enforces: a delivery belongs
    // to an **open** turn, and a stale `lastTurn` from a closed one would hang the card
    // on the wrong turn.
    if (state === undefined) return refused('this session has no turn projection')
    if (state.openTurnStartSeq === null || state.openTurnStartSeq === undefined) return refused('this call is not inside an open turn')
    if (typeof state.lastTurn !== 'number' || !Number.isInteger(state.lastTurn)) return refused('the open turn has no number')
    try {
      ;(session as SessionLike).append('deliverables/presented', {
        turn: state.lastTurn,
        callId,
        files: files.map(file => ({ path: file.path, description: file.description })),
      })
    } catch (error) {
      return refused(reasonOf(error))
    }
    return { delivered: files.length, error: '' }
  }
}

/**
 * Register the delivery seam against a host context.
 *
 * A **soft** injection: `sessionProjections` is what the built-in `present` tool uses,
 * but a host that composes none must still get the tool — it degrades to naming the
 * file. The value is read per delivery, never cached at mount.
 * @param ctx - host context.
 * @param onSettle - called when the injection settles, so the load receipt can record
 *   whether this host delivers by itself.
 * @returns the seam, plus a live answer to "did it bind?" for the status route.
 */
export function registerDelivery(ctx: Context, onSettle?: () => void): {
  deliver: DeliverFiles
  bound: () => boolean
} {
  let service: ProjectionsLike | undefined
  ctx.inject(['sessionProjections'], sctx => {
    service = sctx.get('sessionProjections') as ProjectionsLike | undefined
    onSettle?.()
    return () => {
      service = undefined
    }
  })
  return {
    deliver: createDelivery(() => service),
    bound: () => service !== undefined,
  }
}
