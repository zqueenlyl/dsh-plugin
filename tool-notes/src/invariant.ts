/** Package-owned durable note-snapshot invariants. @module @deepseek-ai/dsh-tool-notes/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-notes'

/** Cordis companion plugin name. */
export const name = 'tool-notes-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Validate one note snapshot before it reaches the durable log. Deliberately
 * silent on the note count — the per-deployment cap (`Config.maxNotes`) is the
 * tool's policy, not a durable-shape rule: a log written while the cap was
 * looser must still replay after the deployment tightens it, so tying the
 * invariant to the current config would reject history that was valid when it
 * was written.
 */
function validateNote(value: unknown, fail: InvariantFailure): void {
  if (typeof value !== 'object' || value === null) fail('note/add data must be an object')
  const { text, tags } = value as Record<string, unknown>
  if (typeof text !== 'string' || text.length === 0 || text.trim() !== text) {
    fail('note/add text must be non-empty and already trimmed')
  }
  if (!Array.isArray(tags)) fail('note/add tags must be an array')
  const seen = new Set<string>()
  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.length === 0 || tag.trim() !== tag) {
      fail('note/add tags must be non-empty and already trimmed strings')
    }
    if (seen.has(tag)) fail(`note/add repeats tag ${JSON.stringify(tag)}`)
    seen.add(tag)
  }
}

/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'note/add') validateNote(event.data, fail)
}

/** Install validation for loaded and newly appended note snapshots. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the note invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
