import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decide, isUnknownJobFailure, looksLikeJobId } from '../lib/guidance.js'

const job = id => ({ id })

test('detects only this call\'s own unknown-job failure', () => {
  assert.equal(isUnknownJobFailure('unknown job 3e9f-1', '3e9f-1'), true)
  // The wording alone is not enough: the id must match, or an unrelated
  // message that happens to mention jobs would be rewritten.
  assert.equal(isUnknownJobFailure('unknown job bash-2', '3e9f-1'), false)
  assert.equal(isUnknownJobFailure('Error: unknown job', '3e9f-1'), false)
  assert.equal(isUnknownJobFailure('job_output: unknown job id', '3e9f-1'), false)
  // The registry interpolates the id verbatim, so the match must end where the
  // id ends: a longer id in the message is a different job.
  assert.equal(isUnknownJobFailure('unknown job 1', '1'), true)
  assert.equal(isUnknownJobFailure('unknown job 11', '1'), false)
  assert.equal(isUnknownJobFailure('unknown job bash-12', 'bash-1'), false)
  // An empty id must never match by prefix.
  assert.equal(isUnknownJobFailure('unknown job ', ''), false)
})

test('recognizes the minted job-id shape', () => {
  assert.equal(looksLikeJobId('bash-1'), true)
  assert.equal(looksLikeJobId('subagent-12'), true)
  assert.equal(looksLikeJobId('pty-send-3'), true)
  // The id the reporter actually passed: a continuable subagent id is a uuid,
  // which this registry never mints as a job id.
  assert.equal(looksLikeJobId('3e9f0a1b-4c2d-4e6f-8a90-1234567890ab'), false)
  // A bare kind is not a job id either.
  assert.equal(looksLikeJobId('bash'), false)
  // An id with no counter, or with a non-numeric tail, was not minted here.
  assert.equal(looksLikeJobId('bash-'), false)
  assert.equal(looksLikeJobId('bash-x'), false)
  assert.equal(looksLikeJobId('session-fd18fa92-1'), true)
  assert.equal(looksLikeJobId('subagent/send_message-2'), false)
  assert.equal(looksLikeJobId(''), false)
})

test('leaves everything it does not own untouched', () => {
  assert.equal(decide({ requestedId: undefined, unknownJob: true, visibleJobIds: () => [] }), undefined)
  assert.equal(decide({ requestedId: 'bash-1', unknownJob: false, visibleJobIds: () => [] }), undefined)
})

test('a visible job id is never "unknown"', () => {
  const probe = { requestedId: 'bash-1', unknownJob: true, visibleJobIds: () => [job('bash-1')] }
  // The registry and this listener disagree about the id, so no claim is made.
  assert.equal(decide(probe), undefined)
})

test('a job-shaped id never receives the hint', () => {
  // Even an invisible one: the id could have been minted here, so the only
  // claim this rule may make ("not one of your job ids") is not established.
  assert.equal(decide({ requestedId: 'bash-9', unknownJob: true, visibleJobIds: () => [job('bash-1')] }), undefined)
  assert.equal(decide({ requestedId: 'subagent-4', unknownJob: true, visibleJobIds: () => [] }), undefined)
})

test('the reporter\'s uuid gets the pointing hint', () => {
  const uuid = '3e9f0a1b-4c2d-4e6f-8a90-1234567890ab'
  const guidance = decide({ requestedId: uuid, unknownJob: true, visibleJobIds: () => [] })
  assert.ok(guidance)
  assert.match(guidance.text, /not one of your background job ids/)
  assert.match(guidance.text, /job_list/)
  assert.match(guidance.text, /send_message/)
  assert.match(guidance.text, /interrupt_agent/)
  // The hint must not assert what the id IS — only what it is not. A live
  // continuable subagent id is not always resolvable through the listing, so a
  // positive claim could be wrong.
  assert.doesNotMatch(guidance.text, /is a subagent/)
})

test('the hint is stable across repeated decisions', () => {
  const probe = { requestedId: 'abc', unknownJob: true, visibleJobIds: () => [] }
  assert.equal(decide(probe).text, decide(probe).text)
})
