# @deepseek-ai/dsh-tool-notes

Model-facing persistent scratch notes over the DeepSeek Harness event-sourced session log.

A `dsh` tool plugin that gives the agent a **durable, append-only scratch pad** for the current session: it records facts, decisions, and open questions it must not lose, then reads them back with optional tag filtering. Unlike `todo_write` (whole-list replacement, cleared each turn), notes survive turn boundaries for the whole session.

## Why

Long agent runs lose track of the small but load-bearing facts — a base URL, a constraint the user stated once, a decision already made. Re-deriving them wastes turns and tokens. `note_add` / `note_list` give the model a bounded, explicit memory it controls.

## Tools

### `note_add`

Record one note. Append-only: notes are never edited or removed.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `text` | string | yes | The note content — a single concise, self-contained fact/decision/question. |
| `tags` | string[] | no | Optional grouping tags for later filtered retrieval (trimmed, deduplicated, empties dropped). |

Returns `{ id, text, tags, total }` — `id` is the event sequence number, `total` the note count after the append.

### `note_list`

Read back notes, optionally filtered to one exact tag.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `tag` | string | no | Exact tag to filter by. |

Returns `{ notes: [{ id, text, tags }], total }` in append order.

## Event model

Each note is a `note/add` session event `{ text, tags }`; the event's `seq` is the note's stable id. Notes are log-only UI state (never derived history), so they do not enter model context except through `note_list`'s own result.

## Configuration

```ts
interface Config {
  /** Per-session note cap; an append that would exceed it is rejected. */
  maxNotes: number
}
```

The cap is the tool's deployment policy, deliberately not a durable-shape invariant: a log written while the cap was looser still replays after the cap tightens.

## Composition

```yaml
- name: '@deepseek-ai/dsh-system-prompt'
- name: '@deepseek-ai/dsh-tools'
- name: '@deepseek-ai/dsh-tool-notes'
  config:
    maxNotes: 100
```

## Invariant companion

`@deepseek-ai/dsh-tool-notes/invariant` registers `tool-notes-invariant`, which validates every `note/add` snapshot (non-empty trimmed `text`, string-array `tags`, no duplicates) before it reaches the durable log.

## Develop

```sh
pnpm vitest run packages/notes/tool-notes/tests/tool-notes.spec.ts
pnpm exec tsx packages/notes/tool-notes/demo/notes-demo.ts
```
