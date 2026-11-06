import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCursorModels } from '../lib/adapters/cursor.mjs'

test('cursor model list parses grok ids and skips auto', () => {
  const text = `Available models\n\nauto - Auto (default)\ngrok-4.7-high - Grok 4.7 High\ngrok-4.7-xhigh - Grok 4.7 Extra High\nclaude-opus-5-5-high - Claude Opus 5.5 1M High\n`
  const models = parseCursorModels(text)
  assert.deepEqual(models.map((m) => m.id), ['grok-4.7-high', 'grok-4.7-xhigh', 'claude-opus-5-5-high'])
  assert.equal(models[0].displayName, 'Grok 4.7 High')
})

test('cursor model list ignores headings', () => {
  assert.deepEqual(parseCursorModels('Available models\n\n  \n'), [])
})
