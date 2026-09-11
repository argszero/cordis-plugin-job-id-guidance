/**
 * `job-id-guidance`: make an unresolvable background-job id say what actually
 * went wrong instead of the registry's bare `unknown job <id>`.
 *
 * The gap (Discussion #6367): the `subagent` tool has two async shapes that hand
 * the model different id namespaces. One-shot `run_in_background: true` returns
 * a **job id** ("collect with `job_output`"). A continuable background
 * delegation returns a **durable subagent id** and registers no job at all —
 * its result is `{ kind: 'continuable', subagentId }` and its lifecycle is
 * `send_message` / `interrupt_agent`. Both render as a short opaque string, so a
 * model that reaches for `job_output` on a subagent id gets a failure that is
 * textually identical to a fabricated id, and retries the wrong tool.
 *
 * This plugin listens on `tools/post-execute` and appends one clarifying
 * sentence to that specific failure. It never vetoes a call, never rewrites a
 * successful result, and never touches a failure it does not recognize.
 *
 * Design constraints, in priority order:
 *
 * - **Never break a call.** The listener delegates first (`next()`), only then
 *   considers enriching, and any internal error is swallowed: a diagnostic must
 *   not become a second failure.
 * - **Never guess.** The rule uses only local, version-stable observations: the
 *   caller's own visible job ids, and the fact that job ids are minted as
 *   `<kind>-<counter>`. The hint is therefore *negative* — "that is not one of
 *   your job ids" — and never claims what the id *is*. Anything shaped like a
 *   job id passes through untouched, so a job-shaped handle this plugin cannot
 *   resolve is never given a confident-looking wrong explanation.
 * - **Never change control flow.** The append is a content replacement on an
 *   already-failed result, so the model still sees an error.
 *
 * @module @argszero/cordis-plugin-job-id-guidance
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
// Side-effect type import: declaration-merges `ctx.jobs` onto Context.
import type {} from '@deepseek-ai/dsh-jobs'
import { decide, isUnknownJobFailure } from './guidance.js'

export const name = 'job-id-guidance'

/** The tool registry (`tools/post-execute`) and the job list this rule reads. */
export const inject = ['tools', 'jobs']

/** Configures which job controls the guidance covers. */
export interface Config {
  /**
   * Tool names treated as job controls. Defaults to the shipped `tool-jobs`
   * registrations. A deployment that renames them (a wrapper plugin) can list
   * its own names.
   */
  tools?: string[]
}

/** The shipped `tool-jobs` registrations that take a `job_id`. */
const DEFAULT_TOOLS = ['job_output', 'job_kill']

/**
 * `job_list` takes no id and so never fails this way; listing it keeps the
 * default set aligned with the shipped tool names.
 * @param config - the plugin config.
 * @returns the set of guarded tool names.
 */
function resolveTools(config: Config): ReadonlySet<string> {
  return new Set(config.tools ?? DEFAULT_TOOLS)
}

/** One plain-text block off a failed result. */
interface TextBlockLike {
  readonly type: 'text'
  readonly text: string
}

/**
 * The text blocks of a failed result, if it is a failure carrying content.
 * @param result - the post-execute result view.
 * @returns the text blocks, or an empty array for anything else.
 */
function textBlocks(result: Readonly<ToolExecutionResult>): TextBlockLike[] {
  if (!result.isError) return []
  const content: readonly ContentBlock[] | undefined = result.content
  if (!Array.isArray(content)) return []
  return content.filter((block): block is ContentBlock & TextBlockLike => block.type === 'text')
}

/**
 * Preserve the original error text and append the guidance as its own line, so
 * the model still reads the authoritative failure first.
 * @param texts - the original failed result's text blocks.
 * @param guidance - the sentence to append.
 * @returns the replacement content blocks.
 */
function appendGuidance(texts: TextBlockLike[], guidance: string): ContentBlock[] {
  const lastIndex = texts.length - 1
  return texts.map((block, index): ContentBlock => index === lastIndex
    ? { type: 'text', text: `${block.text}\n\n${guidance}` }
    : block)
}

/**
 * Read the `job_id` the model passed, if it passed one as a string.
 * @param args - the losslessly JSON-serializable parsed arguments.
 * @returns the requested id, or undefined.
 */
function requestedJobId(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as { job_id?: unknown }).job_id
  return typeof value === 'string' ? value : undefined
}

/**
 * Register the guidance listener.
 * @param ctx - context carrying the tool registry and job service.
 * @param config - resolved options for guarded tool names.
 */
export function apply(ctx: Context, config: Config): void {
  const tools = resolveTools(config)

  ctx.on(
    'tools/post-execute',
    async (
      exec: ToolExecution,
      result: Readonly<ToolExecutionResult>,
      next: () => Promise<PostToolDecision>,
    ): Promise<PostToolDecision> => {
      // Delegate first: this listener observes, it does not decide. A later
      // listener still owns the outcome.
      const downstream = await next()

      try {
        if (!tools.has(exec.name)) return downstream
        // A blocked result is a policy outcome, not a lookup failure.
        if (downstream.kind === 'block') return downstream
        if (!result.isError) return downstream

        const requested = requestedJobId(exec.arguments)
        if (requested === undefined) return downstream

        // Only this call's own failure to resolve this id is a candidate;
        // anything else the tool said for itself is already deliberate.
        const texts = textBlocks(result)
        if (!texts.some(block => isUnknownJobFailure(block.text, requested))) return downstream

        const agent = exec.agent
        const guidance = decide({
          requestedId: requested,
          unknownJob: true,
          visibleJobIds: () => (agent === undefined ? [] : ctx.jobs.list(agent)),
        })
        if (guidance === undefined) return downstream

        // Rebuild rather than spread: `PostToolDecision`'s accept arm is a union
        // that forbids carrying both `content` and `value`, and a failed result
        // can never have been replaced by a value.
        return {
          kind: 'accept',
          content: appendGuidance(texts, guidance.text),
          ...downstream.additionalContexts !== undefined
            ? { additionalContexts: downstream.additionalContexts }
            : {},
        }
      } catch (error: unknown) {
        // A diagnostic must never become a second failure: report and defer.
        ctx.logger.warn(`job-id-guidance: guidance skipped: ${String(error)}`)
        return downstream
      }
    },
  )
}
