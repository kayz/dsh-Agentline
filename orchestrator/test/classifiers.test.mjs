import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyClaudeLine } from '../lib/adapters/claude.mjs'
import { classifyCodexLine } from '../lib/adapters/codex.mjs'

test('claude classifier: tool_use / tool_result / error', () => {
  assert.deepEqual(
    classifyClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash' }] } })),
    { kind: 'tool_start', id: 'toolu_1' },
  )
  assert.deepEqual(
    classifyClaudeLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] } })),
    { kind: 'tool_end', id: 'toolu_1' },
  )
  assert.equal(classifyClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })).kind, 'activity')
  assert.equal(classifyClaudeLine(JSON.stringify({ type: 'result', is_error: true, result: 'boom' })).kind, 'error')
})

test('codex classifier: command_execution start/end and turn.failed', () => {
  assert.deepEqual(
    classifyCodexLine(JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution' } })),
    { kind: 'tool_start', id: 'item_1' },
  )
  assert.deepEqual(
    classifyCodexLine(JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution' } })),
    { kind: 'tool_end', id: 'item_1' },
  )
  assert.equal(classifyCodexLine(JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message' } })).kind, 'activity')
  assert.equal(classifyCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: 'nope' } })).kind, 'error')
})
