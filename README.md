# @argszero/cordis-plugin-job-id-guidance

Make an unresolvable background-job id say **what actually went wrong**, instead
of the job registry's bare `unknown job <id>`.

`dsh` plugin (bundle patch). Watches the `tools/post-execute` seam; enriches one
specific failure and nothing else.

## The problem

The `subagent` tool has two asynchronous shapes, and each hands the model a
different id namespace — both rendered as a short opaque string:

| how you asked | what comes back | how you drive it |
|---|---|---|
| `run_in_background: true` (one-shot) | `{ kind: 'background', jobId }` | `job_output` / `job_kill` |
| continuable background delegation | `{ kind: 'continuable', subagentId }` | `send_message` / `interrupt_agent` |

A continuable delegation registers **no job at all** — it is a durable child
agent, not a tracked task. So passing its id to a job control fails with the
registry's own wording:

```
Error: unknown job 3e9f0a1b-4c2d-4e6f-8a90-1234567890ab
```

That is textually identical to the failure for an id the model simply made up.
The model has no way to tell "wrong tool" from "typo", so it retries
`job_output` instead of switching to `send_message` — and burns the turn.

## What the plugin does

Appends one sentence to that exact failure:

```
Error: unknown job 3e9f0a1b-4c2d-4e6f-8a90-1234567890ab

That id is not one of your background job ids — those look like `bash-1`.
`job_list` shows the job ids you can read. If this id came from `subagent`, it
is a durable subagent id rather than a job; drive it with `send_message` /
`interrupt_agent`.
```

The authoritative failure still leads. The original text is preserved verbatim.

## Install

```sh
npm install @argszero/cordis-plugin-job-id-guidance
```

The package ships a `dsh.bundle` patch, so mounting it is the whole setup:

```sh
dsh plugin add @argszero/cordis-plugin-job-id-guidance
```

or add it to your configuration directly:

```yaml
- insert:
    - id: job-id-guidance
      name: '@argszero/cordis-plugin-job-id-guidance'
```

## Design: what it refuses to do

The plugin is deliberately narrow, because a diagnostic that lies is worse than
no diagnostic.

- **Only this call's own failure.** The failure must name *the id the call
  passed*, matched with a trailing boundary: the failure of `bash-12` does not
  answer for a request for `bash-1`, and job `11` does not answer for job `1`.
- **Never for a job-shaped id.** Job ids are minted as `<kind>-<counter>`
  (`jobs-local`: ``JobId(`${spec.kind}-${count}`)``, counter from 1, lowercase
  kinds such as `bash` / `pwsh` / `subagent` / `pty-send`). Anything carrying
  other characters — notably a uuid — was never minted by this registry. The
  hint's only claim is therefore the **negative** one: *"not one of your job
  ids"*. A job-shaped id the plugin cannot resolve stays silent, because the
  claim would not be established.
- **Never claims what the id *is*.** The hint does not say "this is a subagent
  id". An id can be a session id, a child-agent id minted as a bare uuid, or
  something else entirely; the plugin only says what it is *not* and points at
  the two ways forward.
- **Never vetoes, never rewrites a success.** A blocked result and a successful
  result pass through untouched.
- **Never becomes a second failure.** Any internal error is logged and the
  original failure is returned unchanged.

## Config

| key | default | meaning |
|---|---|---|
| `tools` | `['job_output', 'job_kill']` | tool names treated as job controls |

```yaml
- set:
    - id: job-id-guidance
      config:
        tools: ['my_job_read', 'my_job_stop']
```

## Compatibility

Mounts against every published dsh line the package was verified on. The rule
reads only the job registry's own failure wording and `ctx.jobs.list()`, so it
does not depend on a specific harness build. Peer range, declared identically on
`@deepseek-ai/dsh-jobs`, `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-tools`:

```
>=0.1.2-rc.1 <0.1.3 || >=0.1.3-alpha.2 <0.1.4 || >=0.1.5-alpha.1 <0.2.0 || >=0.1.6-alpha.1 <0.2.0
```

Every dsh release published today is a **prerelease** (`0.1.2-rc.1`, `0.1.5-alpha.1`,
`0.1.6-alpha.2`, …), and a semver comparator admits a prerelease only when some
comparator **in the same group** shares its `major.minor.patch` tuple. Two
consequences follow, and both have already bitten this package:

```jsonc
// Matches nothing: 0.1.2-rc.1 sorts BELOW 0.1.2, and every other prerelease
// carries a different tuple.  -> ETARGET, the package cannot be installed.
">=0.1.2"

// Only the 0.1.2-rc tuple. The `<0.2.0` upper bound is INERT for prereleases:
// it excludes no later line, so every other line gets ERESOLVE.
">=0.1.2-rc.1 <0.2.0"
```

The second form is the dangerous one, because it *reads* as though it covered
everything from `0.1.2-rc.1` onward. It does not — `<0.2.0` never excludes
`0.1.6-alpha.2`, and no comparator names that tuple. Up to **v0.1.0** the
shipped range was

```
>=0.1.2-rc.1 <0.2.0 || >=0.1.5-alpha.1 <0.2.0
```

which admitted the `0.1.2-rc` and `0.1.5` tuples and **nothing else** — 5 of the
23 published versions. A user on the newest shipped dsh release
(`0.1.6-alpha.2`) therefore could not install the plugin at all:

```
npm error ERESOLVE unable to resolve dependency tree
npm error peer @deepseek-ai/dsh-llm@">=0.1.2-rc.1 <0.2.0 || ..." from
npm error   @argszero/cordis-plugin-job-id-guidance@0.1.0
```

The plugin's own suite passes on that line (18/18). The dsh packages are
**peers**, so `--legacy-peer-deps` is not something a consumer can reasonably be
asked to accept: the install simply fails.

**What we ship:** one comparator per supported tuple, each with its own upper
bound so the intended span is legible rather than implied.

| clause | admits |
| --- | --- |
| `>=0.1.2-rc.1 <0.1.3` | `0.1.2-rc.1` |
| `>=0.1.3-alpha.2 <0.1.4` | `0.1.3-alpha.2` |
| `>=0.1.5-alpha.1 <0.2.0` | the whole 0.1.5 line (alpha.1, alpha.2, rc.1, rc.2) |
| `>=0.1.6-alpha.1 <0.2.0` | the whole 0.1.6 line (alpha.1, alpha.2) |

`test/peer-range` **computes** the admitted set with the real `semver` package
and asserts it equals exactly the set the suite has been run against — 8
versions — rather than pattern-matching the range string. An earlier guard only
checked that the string mentioned `0.1.2-rc.N` and `0.1.5-alpha.N`; that form
cannot tell a correct range from an incorrect one, which is how the range above
shipped green. Asserting the set exactly makes both directions loud: dropping a
supported line fails, and admitting an unverified line fails too. The same file
also asserts that this README quotes the manifest range verbatim.

## Source

Discussion [#6367](https://github.com/deepseek-ai/deepseek-harness/discussions/6367).

## License

MIT
