/**
 * End-to-end demo of `@deepseek-ai/dsh-tool-notes`: mounts the REAL plugin on a
 * REAL ToolRuntime (plus the system-prompt provider it depends on), drives
 * `note_add` / `note_list` through the actual `ctx.tools.execute` pipeline, and
 * prints the model-facing results — no model call, no API key.
 *
 * Run from the repo root:
 *   pnpm exec tsx packages/notes/tool-notes/demo/notes-demo.ts
 */

import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

import * as notes from '../src/index.ts'

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(notes, { maxNotes: 10 })

  const session = Session.create(SessionId('demo-session'))
  const agent = { id: SessionId('demo-session'), session } as unknown as Agent
  const signal = new AbortController().signal
  let n = 0
  const run = (name: string, args: unknown) => ctx.tools.execute({
    signal,
    callId: CallId(`demo-${++n}`),
    name,
    arguments: args,
    agent,
  })

  const add1 = await run('note_add', { text: 'the API base URL is https://api.deepseek.com', tags: ['infra'] })
  const add2 = await run('note_add', { text: 'decision: use sqlite for durable persistence', tags: ['decision', 'infra'] })
  const add3 = await run('note_add', { text: 'open question: what is the retention policy?', tags: ['question'] })
  const list = await run('note_list', {})
  const filtered = await run('note_list', { tag: 'infra' })

  const renderText = (r: { content: { type: string; text?: string }[] }): string =>
    r.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')

  console.log('== note_add #1 ==')
  console.log(JSON.stringify(add1.value, null, 2))
  console.log('\n== note_add #2 (two tags) ==')
  console.log(JSON.stringify(add2.value, null, 2))
  console.log('\n== note_add #3 ==')
  console.log(JSON.stringify(add3.value, null, 2))
  console.log('\n== note_list (all) ==')
  console.log(JSON.stringify(list.value, null, 2))
  console.log('\n== note_list (tag=infra) ==')
  console.log(JSON.stringify(filtered.value, null, 2))
  console.log('\n== note_list rendered for the model ==')
  console.log(renderText(list))

  // Demonstrate the bounded-memory guard: cap is 10, so an 11th would be rejected.
  console.log('\n== maxNotes guard (cap 10) ==')
  for (let i = 0; i < 8; i++) await run('note_add', { text: `filler note ${i}` })
  const over = await run('note_add', { text: 'this one exceeds the cap' })
  console.log(`isError: ${over.isError}`)
  console.log(renderText(over))
}

void main()
