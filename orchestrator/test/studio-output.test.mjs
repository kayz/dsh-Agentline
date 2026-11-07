import test from 'node:test'
import assert from 'node:assert/strict'
import { extractJson, splitModelOutput } from '../lib/studio.mjs'

test('extractJson tolerates odd ASCII quotes in prose', () => {
  const text = '正文提到字段 "schema" 与 --model "<id>"，引号数量是奇数。\n{"a":1}'
  assert.deepEqual(extractJson(text), { a: 1 })
  const split = splitModelOutput(text)
  assert.deepEqual(split.json, { a: 1 })
  assert.match(split.prose, /正文/)
})

test('extractJson takes the last valid object after code examples', () => {
  const text = '示例：\n```json\n{"example":true}\n```\n正文 "quote\n{"a":{"b":"}"},"n":2}'
  assert.deepEqual(extractJson(text), { a: { b: '}' }, n: 2 })
})

test('extractJson ignores a trailing incomplete object', () => {
  const text = '说明 "x"\n{"ok":true}\n未完成 {"bad":'
  assert.deepEqual(extractJson(text), { ok: true })
})
