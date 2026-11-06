import test from 'node:test'
import assert from 'node:assert/strict'
import {
  claudeReply, codebuddyReply, codexReply, geminiReply, cursorReply, fixtureStdout, replyFromAdapter,
} from '../lib/adapters/reply.mjs'

const reply = '设计正文\n{"ok":true}\n'

test('claude reply text and the single modelUsage key', () => {
  const stdout = fixtureStdout('claude-cli', 'claude-opus-4-5', reply)
  const parsed = claudeReply(stdout)
  assert.equal(parsed.text, reply)
  assert.equal(parsed.modelResolved, 'claude-opus-4-5')
})

test('claude reply does not pick one model when modelUsage lists several', () => {
  const stdout = JSON.stringify({
    type: 'result',
    result: reply,
    modelUsage: { 'claude-a': { inputTokens: 1 }, 'claude-b': { inputTokens: 1 } },
  })
  const parsed = claudeReply(stdout)
  assert.equal(parsed.text, reply)
  assert.equal(parsed.modelResolved, null)
})

test('claude reply without modelUsage has text and no identity', () => {
  const parsed = claudeReply(fixtureStdout('claude-cli', null, reply))
  assert.equal(parsed.text, reply)
  assert.equal(parsed.modelResolved, null)
})

test('codebuddy reply uses result text and j.model only', () => {
  const parsed = codebuddyReply(fixtureStdout('codebuddy-cli', 'glm-5', reply))
  assert.equal(parsed.text, reply)
  assert.equal(parsed.modelResolved, 'glm-5')
  const missing = codebuddyReply(fixtureStdout('codebuddy-cli', null, reply))
  assert.equal(missing.text, reply)
  assert.equal(missing.modelResolved, null)
})

test('codex reply reads agent_message text and stays unverified without a model field', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: reply } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4 } }),
  ].join('\n')
  const parsed = codexReply(stdout)
  assert.equal(parsed.text, reply)
  assert.equal(parsed.modelResolved, null)
})

test('codex reply keeps a model only when the event itself carries one', () => {
  const parsed = codexReply(fixtureStdout('codex-cli', 'gpt-6.1-sol', reply))
  assert.equal(parsed.text, reply)
  assert.equal(parsed.modelResolved, 'gpt-6.1-sol')
})

test('gemini reply uses response and stats.models, never a requested model argument', () => {
  const observed = geminiReply(fixtureStdout('gemini-cli', 'gemini-2.5-pro', reply))
  assert.equal(observed.text, reply)
  assert.equal(observed.modelResolved, 'gemini-2.5-pro')
  assert.equal(geminiReply.length, 1)

  const echoedShape = geminiReply(JSON.stringify({ response: reply, model: 'gemini-requested' }))
  assert.equal(echoedShape.text, reply)
  assert.equal(echoedShape.modelResolved, null)

  const missing = geminiReply(JSON.stringify({ response: reply }))
  assert.equal(missing.text, reply)
  assert.equal(missing.modelResolved, null)

  const several = geminiReply(JSON.stringify({
    response: reply,
    stats: { models: { 'gemini-a': {}, 'gemini-b': {} } },
  }))
  assert.equal(several.modelResolved, null)
})

test('cursor reply uses result text and a single stream model', () => {
  const parsed = cursorReply(fixtureStdout('cursor-wsl', 'grok-4.7', reply))
  assert.equal(parsed.text, reply)
  assert.equal(parsed.modelResolved, 'grok-4.7')
  const bare = cursorReply(JSON.stringify({ type: 'result', result: reply }))
  assert.equal(bare.text, reply)
  assert.equal(bare.modelResolved, null)
})

test('replyFromAdapter dispatches on the provider adapter id', () => {
  const stdout = fixtureStdout('gemini-cli', 'gemini-2.5-pro', reply)
  assert.equal(replyFromAdapter('gemini-cli', stdout).modelResolved, 'gemini-2.5-pro')
  assert.equal(replyFromAdapter('claude-cli', stdout).modelResolved, null)
  assert.deepEqual(replyFromAdapter('unknown', stdout), { text: '', modelResolved: null })
})
