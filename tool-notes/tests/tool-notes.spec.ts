import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal

/**
 * Drives the REAL plugin body: mounts `dsh-tool-notes` on a real `ToolRuntime`
 * and invokes the registered tools through `ctx.tools.execute`, with a fake
 * parent Agent carrying a real `Session` — so the `note/add` append the tool
 * makes is observable on a genuine session log (only the agent wrapper is a
 * stand-in; the session and the tools are the shipping code).
 */

/** A parent Agent backed by a real Session — the tool reads `agent.session`. */
function agentWithSession(id = 'parent-1'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

async function setup(maxNotes = 100): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool, { maxNotes })
  return ctx
}

let callCounter = 0
function callTool(ctx: Context, name: string, args: unknown, over: { agent?: Agent | undefined } = {}) {
  const agent = 'agent' in over ? over.agent : agentWithSession()
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    ...agent ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

/** Fold the current notes from a session log, mirroring `note_list`'s read path. */
function notesOf(session: Session) {
  return session.events
    .filter(e => e.type === 'note/add')
    .map(e => ({ id: e.seq, text: e.data.text, tags: e.data.tags }))
}

describe('dsh-tool-notes', () => {
  it('registers `note_add` and `note_list` tools', async () => {
    const ctx = await setup()
    const names = ctx.tools.schemas().map(s => s.name).sort()
    expect(names).toEqual(['note_add', 'note_list'])
  })

  it('note_add exposes a {text, tags?} parameter schema', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'note_add')!
    const props = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['tags', 'text'])
    expect(props.text).toMatchObject({ type: 'string' })
    expect(props.tags).toMatchObject({ type: 'array' })
  })

  it('note_add appends a `note/add` event and returns id/text/tags/total', async () => {
    const ctx = await setup()
    const agent = agentWithSession('writer')
    const result = await callTool(ctx, 'note_add', { text: 'the API base URL is https://api.deepseek.com', tags: ['infra'] }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected note_add success')
    expect(result.value).toEqual({
      id: expect.any(Number),
      text: 'the API base URL is https://api.deepseek.com',
      tags: ['infra'],
      total: 1,
    })

    const event = agent.session.events.findLast(e => e.type === 'note/add')!
    expect(event.data).toEqual({ text: 'the API base URL is https://api.deepseek.com', tags: ['infra'] })
  })

  it('assigns monotonically increasing ids (event seq) across appends', async () => {
    const ctx = await setup()
    const agent = agentWithSession('seq')
    const r1 = await callTool(ctx, 'note_add', { text: 'first' }, { agent })
    const r2 = await callTool(ctx, 'note_add', { text: 'second' }, { agent })
    const v1 = (r1 as { value: { id: number } }).value
    const v2 = (r2 as { value: { id: number } }).value
    expect(v2.id).toBeGreaterThan(v1.id)
  })

  it('note_list returns all notes in append order', async () => {
    const ctx = await setup()
    const agent = agentWithSession('reader')
    await callTool(ctx, 'note_add', { text: 'decision: use sqlite', tags: ['decision'] }, { agent })
    await callTool(ctx, 'note_add', { text: 'open question: retention policy', tags: ['question'] }, { agent })

    const result = await callTool(ctx, 'note_list', {}, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected note_list success')
    expect(result.value).toEqual({
      notes: [
        { id: expect.any(Number), text: 'decision: use sqlite', tags: ['decision'] },
        { id: expect.any(Number), text: 'open question: retention policy', tags: ['question'] },
      ],
      total: 2,
    })
  })

  it('note_list filters by tag', async () => {
    const ctx = await setup()
    const agent = agentWithSession('filter')
    await callTool(ctx, 'note_add', { text: 'a', tags: ['x', 'y'] }, { agent })
    await callTool(ctx, 'note_add', { text: 'b', tags: ['y'] }, { agent })
    await callTool(ctx, 'note_add', { text: 'c', tags: ['z'] }, { agent })

    const result = await callTool(ctx, 'note_list', { tag: 'y' }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected note_list success')
    const v = result.value as { notes: { text: string }[]; total: number }
    expect(v.notes.map(n => n.text)).toEqual(['a', 'b'])
    expect(v.total).toBe(2)
  })

  it('note_add normalizes text and tags (trim, dedupe, drop empties)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('normalize')
    const result = await callTool(ctx, 'note_add', {
      text: '  remember this  ',
      tags: [' x ', 'x', '', '  ', 'y'],
    }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected note_add success')

    const event = agent.session.events.findLast(e => e.type === 'note/add')!
    expect(event.data).toEqual({ text: 'remember this', tags: ['x', 'y'] })
  })

  it('rejects empty (whitespace-only) text', async () => {
    const ctx = await setup()
    const result = await callTool(ctx, 'note_add', { text: '   ' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('non-empty')
  })

  it('rejects non-array tags', async () => {
    const ctx = await setup()
    const result = await callTool(ctx, 'note_add', { text: 'x', tags: 'not-an-array' })
    expect(result.isError).toBe(true)
  })

  it('rejects an append that would exceed maxNotes', async () => {
    const ctx = await setup(2)
    const agent = agentWithSession('bounded')
    await callTool(ctx, 'note_add', { text: 'one' }, { agent })
    await callTool(ctx, 'note_add', { text: 'two' }, { agent })
    const result = await callTool(ctx, 'note_add', { text: 'three' }, { agent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('maxNotes')
    // The rejected call must not reach the durable log.
    expect(notesOf(agent.session)).toHaveLength(2)
  })

  it('rejects a non-agent caller (no owning session to write/read)', async () => {
    const ctx = await setup()
    const add = await callTool(ctx, 'note_add', { text: 'x' }, { agent: undefined })
    expect(add.isError).toBe(true)
    expect(text(add)).toContain('owning agent session')

    const list = await callTool(ctx, 'note_list', {}, { agent: undefined })
    expect(list.isError).toBe(true)
    expect(text(list)).toContain('owning agent session')
  })

  it('presents note_add with a stable title', async () => {
    const ctx = await setup()
    const def = ctx.tools.get('note_add')!
    expect(def.presentCall?.({ text: 'a', tags: [] })).toEqual({
      card: 'generic',
      title: 'Add note',
      kind: 'other',
      rawInput: { text: 'a', tags: [] },
    })
  })

  it('unregisters both tools when its fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(tool, { maxNotes: 100 })
    expect(ctx.tools.schemas().some(s => s.name === 'note_add')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'note_add')).toBe(false)
    expect(ctx.tools.schemas().some(s => s.name === 'note_list')).toBe(false)
    expect(ctx.commands.find(agentWithSession('hmr'), 'notes')).toBeUndefined()
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-notes')
    expect(tool.inject).toEqual(['tools', 'commands'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tool) as Record<string, unknown>
    expect(unwrapped).toBe(tool)
    expect(unwrapped.name).toBe('tool-notes')
    expect(unwrapped.inject).toEqual(['tools', 'commands'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('registers the `/notes` human command over the same note/add log', async () => {
    const ctx = await setup()
    const agent = agentWithSession('cmd')
    await callTool(ctx, 'note_add', { text: 'the API base URL is https://api.deepseek.com', tags: ['infra'] }, { agent })
    await callTool(ctx, 'note_add', { text: 'open question: retention', tags: ['question'] }, { agent })

    const all = await ctx.commands.execute(agent, '/notes', [], testToolSignal)
    expect(all?.result.kind).toBe('success')
    expect(all?.result.text).toContain('the API base URL is https://api.deepseek.com')
    expect(all?.result.text).toContain('open question: retention')

    const filtered = await ctx.commands.execute(agent, '/notes infra', [], testToolSignal)
    expect(filtered?.result.text).toContain('the API base URL is https://api.deepseek.com')
    expect(filtered?.result.text).not.toContain('open question: retention')

    const unknown = await ctx.commands.execute(agent, '/nope', [], testToolSignal)
    expect(unknown).toBeUndefined()
  })
})
