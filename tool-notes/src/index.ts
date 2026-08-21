/**
 * Model-facing persistent scratch notes over the event-sourced session log.
 * Unlike `todo_write` (whole-list replacement, cleared each turn), notes are
 * append-only and survive turn boundaries for the whole session: the model
 * records facts, decisions, and open questions it must not lose, then reads
 * them back with optional tag filtering. Named exports preserve loader
 * injection metadata.
 * @module @deepseek-ai/dsh-tool-notes
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'

// Type-only: the `note/add` event payload lives in src/types.ts (its one home);
// this re-export keeps the SessionEventMap merge visible to aggregate programs
// that consume only this package's declarations.
export type * from './types.ts'

export const name = 'tool-notes'
export const inject = ['tools', 'commands']

/** Model-facing notes tool configuration. */
export interface Config {
  /**
   * The maximum number of notes one session may hold. The model is told to
   * stop adding (or to reuse existing notes) at the cap; a call that would
   * exceed it is rejected rather than silently dropping the oldest.
   */
  maxNotes: number
}

/** Schemastery configuration for the notes tool consumer. */
export const Config: z<Config> = z.object({
  maxNotes: z.number().required(),
})

const NOTE_ADD_DESCRIPTION =
  'Record a durable scratch note for the current session — a fact, decision, or '
  + 'open question you must not lose later in this work. Notes are append-only and '
  + 'survive across turns; use tags to group them for later retrieval with '
  + 'note_list. Write one concise note per call (do not batch unrelated facts).'

const NOTE_LIST_DESCRIPTION =
  'Read back the notes recorded so far in this session, optionally filtered to '
  + 'one tag. Use it to recall decisions, constraints, or facts you saved earlier '
  + 'instead of guessing or re-deriving them.'

/**
 * Normalize user-supplied tags: trim each, drop empties, and dedupe while
 * preserving first-seen order.
 * @param raw - the raw tag strings (possibly untrimmed/duplicated).
 * @returns the canonical tag list.
 */
function normalizeTags(raw: readonly string[]): string[] {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const tag of raw) {
    const t = tag.trim()
    if (t.length === 0 || seen.has(t)) continue
    seen.add(t)
    tags.push(t)
  }
  return tags
}

/**
 * Validate and canonicalize a note payload. The registry has already enforced
 * `text` is a string and `tags` is a string array; this enforces the
 * value constraints the schema cannot express (non-empty content, trimmed
 * canonical form).
 * @param text - the raw model-supplied text.
 * @param tags - the raw model-supplied tags (already schema-checked as strings).
 * @returns the canonical `{ text, tags }`.
 */
function toNote(text: string, tags: readonly string[]): { text: string; tags: string[] } {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    throw new Error('invalid note: `text` must be a non-empty string')
  }
  return { text: trimmed, tags: normalizeTags(tags) }
}

/** A read-back note: the durable fields plus the event's seq as its stable id. */
export interface Note {
  id: number
  text: string
  tags: string[]
}

/**
 * Fold the current notes from a session log (the `note_list` read path).
 * A `for` loop + `if` narrows the `SessionEvent` discriminated union, which
 * `Array.filter`'s predicate signature would not.
 */
function readNotes(session: Session): Note[] {
  const notes: Note[] = []
  for (const event of session.events) {
    if (event.type === 'note/add') {
      notes.push({ id: event.seq, text: event.data.text, tags: event.data.tags })
    }
  }
  return notes
}

/** The human-command invocation fields this plugin reads (structural, no import). */
interface NotesCommandInvocation {
  agent?: { session?: Session } | null
  rawInput: string
}

/**
 * Render the `/notes` human command: fold the session's `note/add` events into
 * a chat message, optionally filtered by one exact tag. This is the
 * user-facing read entry over the same durable source `note_list` reads.
 * @param invocation - the human-command invocation carrying the owning agent.
 * @returns a `{ kind, text }` command result shown in the WebUI.
 */
function renderNotesCommand(invocation: NotesCommandInvocation): { kind: 'success' | 'error'; text: string } {
  const session = invocation.agent?.session
  if (!session) return { kind: 'error', text: '/notes requires an owning agent session.' }

  const tag = invocation.rawInput.trim()
  let notes = readNotes(session)
  if (tag) notes = notes.filter(n => n.tags.includes(tag))

  if (notes.length === 0) {
    return {
      kind: 'success',
      text: tag === '' ? 'No notes recorded yet.' : `No notes with tag "${tag}" yet.`,
    }
  }
  const lines = notes.map(n => `${n.id}. ${n.tags.length > 0 ? `[${n.tags.join(', ')}] ` : ''}${n.text}`)
  const header = tag === ''
    ? `Session notes (${notes.length}):`
    : `Session notes tagged "${tag}" (${notes.length}):`
  return { kind: 'success', text: `${header}\n${lines.join('\n')}` }
}

/**
 * Register the user-facing `/notes` command on `ctx.commands`.
 * @param ctx - registrant context carrying the command registry.
 */
function registerNotesCommand(ctx: Context): void {
  ctx.effect(() => ctx.commands.register({
    name: 'notes',
    description: 'Show the notes recorded in this session (optionally filter by one tag)',
    handler: renderNotesCommand,
  }), 'tool-notes: /notes command')
}

/**
 * Register the `note_add` and `note_list` tools on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's note policy (the per-session cap).
 */
export function apply(ctx: Context, config: Config): void {
  const maxNotes = config.maxNotes

  ctx.tools.register(defineTool({
    name: 'note_add',
    description: NOTE_ADD_DESCRIPTION,
    parameters: {
      text: { type: 'string', required: true, description: 'The note content — a single concise, self-contained fact/decision/question.' },
      tags: {
        type: 'array',
        description: 'Optional grouping tags for later filtered retrieval.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer', required: true },
          text: { type: 'string', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Noted (${value.total} total): ${value.text}`,
      }],
    },
    execute(args, exec) {
      if (!exec.agent) {
        // Notes are per-agent-session state; a non-agent caller (no owning
        // session) has nowhere to write them. Reject rather than no-op.
        throw new Error('note_add requires an owning agent session')
      }
      const { text, tags } = toNote(args.text, args.tags ?? [])
      const session = exec.agent.session
      const current = readNotes(session)
      if (current.length >= maxNotes) {
        throw new Error(`note limit reached: this session already holds ${current.length} notes (maxNotes ${maxNotes})`)
      }
      const event = session.append('note/add', { text, tags })
      return Promise.resolve({ id: event.seq, text, tags, total: current.length + 1 })
    },
    presentCall: args => ({ card: 'generic', title: 'Add note', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'note_list',
    description: NOTE_LIST_DESCRIPTION,
    parameters: {
      tag: { type: 'string', description: 'Optional exact tag to filter by.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          notes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer', required: true },
                text: { type: 'string', required: true },
                tags: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.notes.length === 0
          ? 'No notes recorded yet.'
          : value.notes.map((n: { id: number; text: string; tags: string[] }) =>
            `${n.id}. ${n.tags.length > 0 ? `[${n.tags.join(', ')}] ` : ''}${n.text}`).join('\n'),
      }],
    },
    execute(args, exec) {
      if (!exec.agent) {
        throw new Error('note_list requires an owning agent session')
      }
      const tag = args.tag?.trim()
      let notes = readNotes(exec.agent.session)
      if (tag) notes = notes.filter(n => n.tags.includes(tag))
      return Promise.resolve({ notes, total: notes.length })
    },
  }))

  registerNotesCommand(ctx)
}
