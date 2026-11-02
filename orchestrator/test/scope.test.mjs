import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readWriteScope, scopeOverlaps } from '../lib/scope.mjs'

test('readWriteScope parses front matter list and empty list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-scope-'))
  const file = path.join(dir, 'design.md')
  fs.writeFileSync(file, '---\nwrite_scope:\n  - src/app/**\n  - src/shared/util.ts\n---\n\n# design\n', 'utf8')
  assert.deepEqual(readWriteScope(file), ['src/app/**', 'src/shared/util.ts'])
  fs.writeFileSync(file, '---\nwrite_scope: []\n---\n', 'utf8')
  assert.deepEqual(readWriteScope(file), [])
  fs.writeFileSync(file, '# no front matter\n', 'utf8')
  assert.equal(readWriteScope(file), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('scopeOverlaps is conservative but allows disjoint prefixes', () => {
  assert.equal(scopeOverlaps(['src/app/**'], ['src/shared/**']), false)
  assert.equal(scopeOverlaps(['src/**'], ['src/app/**']), true)
  assert.equal(scopeOverlaps(['src/app/**'], ['src/app/main.ts']), true)
  assert.equal(scopeOverlaps([], ['src/**']), false)
  assert.equal(scopeOverlaps(null, ['src/**']), true)
})
