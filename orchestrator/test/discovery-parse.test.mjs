import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCodexModels } from '../lib/adapters/codex.mjs'
import { parseCodebuddyModels } from '../lib/adapters/codebuddy.mjs'
import { normalizeClaudeIds } from '../lib/adapters/claude.mjs'
import { normalizeGeminiIds } from '../lib/adapters/gemini.mjs'

test('codex debug models JSON is normalized', () => {
  const models = parseCodexModels({
    models: [
      { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
      { slug: 'hidden-model', visibility: 'hidden' },
      { nope: true },
    ],
  })
  assert.deepEqual(models, [{ id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', efforts: ['low', 'high'] }])
})

test('codebuddy --help model list is parsed', () => {
  const help = `--model <model>  Model for the current session. Currently supported: (hy4-preview, hy3, deepseek-v4.1-flash, kimi-k3.1-pro)
--other flag  something`
  assert.deepEqual(parseCodebuddyModels(help), ['hy4-preview', 'hy3', 'deepseek-v4.1-flash', 'kimi-k3.1-pro'])
  assert.deepEqual(parseCodebuddyModels('no list here'), [])
})

test('claude model ids drop dated and -vN variants', () => {
  const ids = normalizeClaudeIds([
    'claude-opus-4-5',
    'claude-opus-4-5-20251101',
    'claude-opus-4-5-20251101-v1',
    'claude-sonnet-4-20250514',
    'claude-sonnet-4',
    'not-a-model',
  ])
  assert.deepEqual(ids, ['claude-opus-4-5', 'claude-sonnet-4'])
})

test('gemini ids filter non-text models', () => {
  const ids = normalizeGeminiIds(['gemini-3.1-pro', 'gemini-3.1-flash-image', 'gemini-2.5-flash', 'gemini-2.5-flash-tts'])
  assert.deepEqual(ids, ['gemini-2.5-flash', 'gemini-3.1-pro'])
})
