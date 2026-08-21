/**
 * Durable note domain: the ONE home of the `note/add` event payload type,
 * free of this package's host-side value imports (dsh-tools, schemastery).
 *
 * @module @deepseek-ai/dsh-tool-notes/types
 */

import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'

export type { SessionEventMap }

/**
 * The durable payload of one note. `id` is NOT stored — it is the owning
 * `note/add` event's sequence number, so the log order itself is the identity.
 */
export interface NoteData {
  /** The note content, already trimmed to a non-empty string. */
  text: string
  /** Normalized tags: trimmed, deduplicated, empty entries dropped. */
  tags: string[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One appended scratch note. Append-only (notes are never edited or
     * removed — a later turn appends a new note instead), so the fold is a
     * simple accumulate; the event's `seq` is the note's stable id.
     */
    'note/add': NoteData
  }
}
