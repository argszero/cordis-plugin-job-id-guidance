import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Context, Service } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import toolsPlugin from '@deepseek-ai/dsh-tools'
import systemPromptPlugin from '@deepseek-ai/dsh-system-prompt'

/**
 * Integration: mount the plugin on a REAL Cordis context together with the REAL
 * `dsh-tools` registry and a real `ctx.jobs` service, register a tool whose body
 * throws exactly what `tool-jobs` produces, then assert on the result the
 * registry materialises. This is the only shape that proves the listener is
 * actually wired into `tools/post-execute` and that its replacement survives the
 * pipeline (`tools/result` observers, materialisation, canonical marking).
 */

/** The shipped failure text: `jobs-local` `expect()` wording, wrapped by the registry. */
const unknownJob = id => `Error: unknown job ${id}`

/** A minimal JobRegistry: the plugin reads only `list(caller)`. */
class FakeJobs extends Service {
  constructor(ctx, jobs) {
    super(ctx, 'jobs')
    this.store = jobs
  }

  list(caller) {
    const session = caller?.id
    return this.store
      .filter(job => job.owner === undefined || job.owner.id === session)
      .map(job => ({ id: job.id }))
  }
}

/** A stand-in agent: the plugin touches only `.id`. */
const fakeAgent = id => ({ id, session: { id } })

/**
 * Mount a context with the real tool registry, a fake jobs service, and the
 * plugin, then register one tool whose body throws.
 * @param options - the failing tool name, the thrown id, and the visible jobs.
 * @returns the context, captured logs, and the failing tool's name.
 */
async function mount({ toolName = 'job_output', thrownId = 'x', jobs = [] } = {}) {
  const ctx = new Context()
  const logged = []
  ctx.logger = { info: () => {}, debug: () => {}, warn: m => logged.push(m), error: () => {} }
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(toolsPlugin)
  new FakeJobs(ctx, jobs)
  await ctx.plugin({ name: 'job-id-guidance', apply: c => plugin.apply(c, {}) })
  ctx.tools.register(failingFixture(toolName, thrownId))
  return { ctx, logged, toolName }
}

/**
 * A registry-legal failing fixture: the real registry requires an explicit
 * output contract, so declare a text output and throw from the body.
 * @param name - the tool name to register.
 * @param thrownId - the id the registry-style failure will name.
 * @returns the tool definition.
 */
function failingFixture(name, thrownId) {
  return {
    name,
    description: 'test fixture',
    parameters: { job_id: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      throw new Error(`unknown job ${thrownId}`)
    },
  }
}

/** A registry-legal succeeding fixture. */
function succeedingFixture(name) {
  return {
    name,
    description: 'test fixture',
    parameters: { job_id: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return 'ok'
    },
  }
}

/** Run one call through the real registry pipeline. */
/** A fresh caller signal: the registry fuses it and requires one. */
const callerSignal = () => new AbortController().signal

function call(ctx, name, args, agent) {
  return ctx.tools.execute({ name, arguments: args, signal: callerSignal(), ...agent ? { agent } : {} })
}

test('exposes the documented plugin surface', () => {
  assert.equal(plugin.name, 'job-id-guidance')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['tools', 'jobs'])
})

test('appends the pointing hint to an unknown non-job id', async () => {
  const uuid = '3e9f0a1b-4c2d-4e6f-8a90-1234567890ab'
  const { ctx } = await mount({ thrownId: uuid })
  const result = await call(ctx, 'job_output', { job_id: uuid }, fakeAgent('s1'))
  assert.equal(result.isError, true)
  const text = result.content.map(block => block.text).join('\n')
  // The authoritative failure still leads.
  assert.match(text, /^Error: unknown job 3e9f0a1b-4c2d-4e6f-8a90-1234567890ab/)
  assert.match(text, /not one of your background job ids/)
  assert.match(text, /send_message/)
  assert.match(text, /interrupt_agent/)
})

test('a job-shaped id never receives the hint', async () => {
  // `bash-9` could have been minted by this registry, so "not one of your job
  // ids" is not established and the failure must pass through verbatim.
  const { ctx } = await mount({ thrownId: 'bash-9' })
  const result = await call(ctx, 'job_output', { job_id: 'bash-9' }, fakeAgent('s1'))
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].text, unknownJob('bash-9'))
})

test('a job the caller can see is left alone', async () => {
  // The registry claims unknown while this listener can see it: the two
  // disagree, so the plugin makes no claim rather than a wrong one.
  const { ctx } = await mount({ thrownId: 'bash-1', jobs: [{ id: 'bash-1' }] })
  const result = await call(ctx, 'job_output', { job_id: 'bash-1' }, fakeAgent('s1'))
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].text, unknownJob('bash-1'))
})

test('another session\'s job is invisible and still passes through', async () => {
  const { ctx } = await mount({ thrownId: 'bash-2', jobs: [{ id: 'bash-2', owner: { id: 'other' } }] })
  const result = await call(ctx, 'job_output', { job_id: 'bash-2' }, fakeAgent('s1'))
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].text, unknownJob('bash-2'))
})

test('enrichment is additive on a guarded tool', async () => {
  const { ctx } = await mount({ toolName: 'job_kill', thrownId: 'nope' })
  const result = await call(ctx, 'job_kill', { job_id: 'nope' }, fakeAgent('s1'))
  // job_kill IS guarded, so this one is enriched — the point is that the
  // enrichment is additive and the original text is preserved verbatim.
  const text = result.content.map(block => block.text).join('\n')
  assert.ok(text.startsWith(unknownJob('nope')))
})

test('a non-job tool name passes through untouched', async () => {
  const { ctx } = await mount({ toolName: 'job_list', thrownId: 'anything' })
  const result = await call(ctx, 'job_list', { job_id: 'anything' }, fakeAgent('s1'))
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].text, unknownJob('anything'))
})

test('a successful result is never rewritten', async () => {
  const ctx = new Context()
  ctx.logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(toolsPlugin)
  new FakeJobs(ctx, [])
  await ctx.plugin({ name: 'job-id-guidance', apply: c => plugin.apply(c, {}) })
  ctx.tools.register(succeedingFixture('job_output'))
  const result = await ctx.tools.execute({ name: 'job_output', arguments: { job_id: 'x' }, signal: callerSignal() })
  assert.equal(result.isError, false)
})

test('an id mismatch between arguments and the thrown message gets no hint', async () => {
  // The body threw for a different id than the caller passed (a wrapper, or a
  // tool that reinterprets its input). Matching on the id is what keeps the
  // rule from annotating a failure it did not diagnose.
  const { ctx } = await mount({ thrownId: 'other-id' })
  const result = await call(ctx, 'job_output', { job_id: '3e9f0a1b' }, fakeAgent('s1'))
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].text, unknownJob('other-id'))
})

test('a throwing jobs service degrades to the original failure', async () => {
  const ctx = new Context()
  const logged = []
  ctx.logger = { info: () => {}, debug: () => {}, warn: m => logged.push(m), error: () => {} }
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(toolsPlugin)
  class BrokenJobs extends Service {
    constructor(c) {
      super(c, 'jobs')
    }

    list() {
      throw new Error('jobs registry exploded')
    }
  }
  new BrokenJobs(ctx)
  await ctx.plugin({ name: 'job-id-guidance', apply: c => plugin.apply(c, {}) })
  ctx.tools.register(failingFixture('job_output', '3e9f'))
  const result = await ctx.tools.execute({
    name: 'job_output', arguments: { job_id: '3e9f' }, signal: callerSignal(), agent: fakeAgent('s1'),
  })
  // A diagnostic must never become a second failure.
  assert.equal(result.isError, true)
  assert.equal(result.content[0].text, unknownJob('3e9f'))
  assert.equal(logged.length, 1)
  assert.match(logged[0], /guidance skipped/)
})

test('a custom tool-name list overrides the defaults', async () => {
  const ctx = new Context()
  ctx.logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(toolsPlugin)
  new FakeJobs(ctx, [])
  await ctx.plugin({ name: 'job-id-guidance', apply: c => plugin.apply(c, { tools: ['my_job_read'] }) })
  for (const name of ['job_output', 'my_job_read']) {
    ctx.tools.register(failingFixture(name, name === 'job_output' ? 'aaa' : 'bbb'))
  }
  // The default name is no longer guarded...
  const skipped = await ctx.tools.execute({ name: 'job_output', arguments: { job_id: 'aaa' }, signal: callerSignal() })
  assert.equal(skipped.content.length, 1)
  // ...and the configured one is.
  const guarded = await ctx.tools.execute({ name: 'my_job_read', arguments: { job_id: 'bbb' }, signal: callerSignal() })
  assert.match(guarded.content.map(b => b.text).join('\n'), /not one of your background job ids/)
})
