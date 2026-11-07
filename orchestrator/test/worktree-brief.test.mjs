import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertTaskBrief } from '../lib/worktree.mjs'

test('assertTaskBrief rejects a missing brief with the worktree error code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-brief-'))
  try {
    assert.throws(() => assertTaskBrief(dir), (e) => e.code === 'E_BRIEF_MISSING_IN_WORKTREE')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('assertTaskBrief rejects an empty brief', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-brief-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), '  \n', 'utf8')
    assert.throws(() => assertTaskBrief(dir), (e) => e.code === 'E_BRIEF_MISSING_IN_WORKTREE')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('assertTaskBrief returns a readable brief', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-brief-'))
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), '# task\n', 'utf8')
    assert.equal(assertTaskBrief(dir), '# task\n')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
