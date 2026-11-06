import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readPipelineSummary, formatPipelineSummary } from '../lib/pipeline.mjs'

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-pipeline-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  fs.mkdirSync(path.join(repo, '.collab', 'tasks', '001'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.collab', 'tasks', '001', 'state.json'), JSON.stringify({
    id: '001', status: 'pr_open', role: 'dev', model: 'm1', updated_at: '2026-11-06T00:00:00.000Z',
    pr: { branch: 'task/001', sha: 'abc123' },
  }), 'utf8')
  fs.mkdirSync(path.join(repo, '.collab', 'tasks', '002'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.collab', 'tasks', '002', 'state.json'), JSON.stringify({
    id: '002', status: 'blocked', role: 'review', model: 'm2', blocked_reason: 'auth',
  }), 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'fixture')
  return repo
}

test('pipeline: summary counts and task records are read-only', () => {
  const repo = makeRepo()
  const before = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
  const s = readPipelineSummary(repo)
  const after = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
  assert.equal(before, after)
  assert.equal(s.schema, 'agentline.pipeline/v1')
  assert.equal(s.stages.build.counts.total, 2)
  assert.equal(s.stages.build.counts.pr_open, 1)
  assert.equal(s.stages.build.counts.blocked, 1)
  assert.equal(s.tasks.find((t) => t.id === '002').blocked_reason, 'auth')
  fs.rmSync(repo, { recursive: true, force: true })
})

test('pipeline: text formatter mentions stages and tasks', () => {
  const repo = makeRepo()
  const text = formatPipelineSummary(readPipelineSummary(repo))
  assert.match(text, /Studio：/)
  assert.match(text, /Build：/)
  assert.match(text, /#001/)
  assert.match(text, /blocked=auth/)
  fs.rmSync(repo, { recursive: true, force: true })
})
