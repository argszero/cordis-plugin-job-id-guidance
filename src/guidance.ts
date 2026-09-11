/**
 * The decision rule for `job-id-guidance`, kept free of Cordis and of the tools
 * layer so it is testable as a pure function.
 *
 * The gap (Discussion #6367): the `subagent` tool has two async shapes that hand
 * the model different id namespaces, and both render as a short opaque string.
 *
 * - one-shot `run_in_background: true` registers a **job** and returns a
 *   `jobId` — "collect with `job_output`";
 * - a continuable background delegation registers **no job** and returns a
 *   durable `subagentId`, driven by `send_message` / `interrupt_agent`.
 *
 * Passing the second kind to a job control fails with the registry's bare
 * `unknown job <id>` (`jobs-local` `expect()`), which is textually identical to
 * a fabricated id. The model cannot tell "wrong tool" from "typo", so it retries
 * the control instead of switching tools.
 *
 * The rule appends one pointing sentence to that exact failure. It uses only
 * observations that are local and version-stable:
 *
 * 1. the failure is this call's own `unknown job <requested id>` — matched on
 *    the id, so an unrelated message that merely mentions jobs is untouched;
 * 2. the id is not among the jobs the caller can see;
 * 3. **the id is not even shaped like a job id.**
 *
 * Point 3 is what makes the appended claim safe, and it is a *negative* test on
 * purpose. Job ids are minted as `<kind>-<counter>` (`jobs-local` `start()`:
 * ``JobId(`${spec.kind}-${count}`)``, counter from 1, kinds are lowercase words
 * such as `bash`, `pwsh`, `subagent`, `pty-send`). Anything carrying other
 * characters — notably the uuid a continuable delegation returns — was never
 * minted by this registry.
 *
 * The hint says only what the id is **not** and points at the two ways to make
 * progress. It deliberately does **not** claim the id belongs to a subagent, for
 * two reasons: the id is not always a session id (`subagent-in-process-driver`
 * mints the child id as a bare `randomUUID()`, which no listing can resolve), and
 * a confident-looking wrong claim is the one outcome this rule must never
 * produce. If the minting format ever changes, the shape test simply stops
 * matching and the bare failure passes through unchanged.
 */

/** The registry's own failure wording (`jobs-local` `expect()`). */
const UNKNOWN_JOB = 'unknown job '

/**
 * The shape of a job id this registry could have minted: `<kind>-<counter>`,
 * where every segment is a lowercase word and the counter is a positive
 * integer. Anchored on both ends, so an id that merely ends in `-<digits>`
 * (a session id, a path, an arbitrary handle) is not mistaken for a job id.
 */
const JOB_ID_SHAPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d+$/

/** Escape a literal for use inside a regular expression. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether a text block is this call's own failure to resolve `id`. The registry
 * interpolates the caller's id verbatim, so matching on the id (rather than on
 * the bare wording) keeps the rule immune to unrelated job-flavoured messages.
 *
 * The trailing boundary matters: a substring test would let the failure of
 * `bash-12` answer for a request for `bash-1`, and the failure of job `11`
 * answer for a request for job `1` — either would append a sentence about the
 * wrong id. A following word character or dash means the message names a longer
 * id, so this is not our call.
 * @param text - one text block's content from the failed result.
 * @param id - the id this call passed.
 * @returns true when this block is the unknown-job failure for `id`.
 */
export function isUnknownJobFailure(text: string, id: string): boolean {
  if (id === '') return false
  return new RegExp(`${UNKNOWN_JOB}${escapeRegExp(id)}(?![\\w-])`).test(text)
}

/**
 * Whether an id could have been minted as a job id by this registry. Used as a
 * guard, not as a classification: when it is true the rule stays silent.
 * @param id - the id the caller passed.
 * @returns true when the id has the `<kind>-<counter>` shape.
 */
export function looksLikeJobId(id: string): boolean {
  return JOB_ID_SHAPE.test(id)
}

/**
 * The appended sentence: state only what was observed, then point at the two
 * ways forward.
 * @returns the guidance text.
 */
function pointingHint(): string {
  return 'That id is not one of your background job ids — those look like '
    + '`bash-1`. `job_list` shows the job ids you can read. If this id came from '
    + '`subagent`, it is a durable subagent id rather than a job; drive it with '
    + '`send_message` / `interrupt_agent`.'
}

/** Minimal view of one visible job. */
export interface JobRef {
  /** The job id as the model would pass it. */
  readonly id: string
}

/** The observations a decision needs; every accessor must be total. */
export interface JobIdProbe {
  /** The id the model passed, or undefined when the call carried none. */
  readonly requestedId: string | undefined
  /** True when the failed result is this call's own `unknown job <id>`. */
  readonly unknownJob: boolean
  /** The ids of every job the caller can see (owned by it, plus unowned ones). */
  visibleJobIds(): readonly JobRef[]
}

/** The text to append, or undefined to leave the result exactly as it was. */
export interface Guidance {
  /** The message appended to the failing result. */
  readonly text: string
}

/**
 * Decide whether to enrich one failed job-control result.
 * @param probe - the observations described by {@link JobIdProbe}.
 * @returns the text to append, or undefined when the result must pass through untouched.
 */
export function decide(probe: JobIdProbe): Guidance | undefined {
  const id = probe.requestedId
  if (id === undefined || !probe.unknownJob) return undefined

  // A job the caller can see is never unknown; if the registry said so anyway,
  // the id reached the lookup differently than it reached us and any hint would
  // be wrong. Defer to the registry.
  if (probe.visibleJobIds().some(job => job.id === id)) return undefined

  // Stay silent for anything this registry could have minted: the hint's only
  // claim is "not a job id", so a job-shaped id must never receive it.
  if (looksLikeJobId(id)) return undefined

  return { text: pointingHint() }
}
