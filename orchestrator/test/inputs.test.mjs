import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { executeRole } from '../lib/exec.mjs'
import { appendInput, readInputs, pendingInputs, markConsumed, readAttention, removeAttention } from '../lib/inputs.mjs'

test('inputs: append, pending, consume, attention', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-inputs-'))
  const note = appendInput(dir, { kind: 'note', text: '注意 X' })
  const am = appendInput(dir, { kind: 'amendment', text: '验收改成 Y' })
  assert.equal(pendingInputs(dir).length, 2)
  markConsumed(dir, [note.id])
  assert.deepEqual(pendingInputs(dir).map((i) => i.kind), ['amendment'])
  assert.equal(readInputs(dir).length, 2)
  fs.writeFileSync(path.join(dir, 'attention.json'), JSON.stringify({ question: '选 A 还是 B?', options: ['A', 'B'] }), 'utf8')
  assert.equal(readAttention(dir).question, '选 A 还是 B?')
  removeAttention(dir)
  assert.equal(readAttention(dir), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('inputs: note is injected into the role prompt and consumed on success', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-inputflow-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  const taskDir = path.join(repo, '.collab', 'tasks', '001')
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, 'brief.md'), '# brief\n', 'utf8')
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n', 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'init')

  const note = appendInput(taskDir, { kind: 'note', text: '实现时注意锁顺序' })
  let promptSeen = ''
  const adapterFactory = () => ({
    async run({ prompt, logPath }) {
      promptSeen = prompt
      fs.writeFileSync(logPath, 'fake\n', 'utf8')
      fs.writeFileSync(path.join(taskDir, 'design.md'), '# design\n', 'utf8')
      fs.writeFileSync(path.join(taskDir, 'acceptance.md'), '# acceptance\n', 'utf8')
      return { exitCode: 0, error: null }
    },
  })
  const config = {
    collabDir: '.collab/tasks',
    providers: { p: { adapter: 'fake', command: 'x', source: 'test' } },
    models: { d: { provider: 'p', id: 'design-model' } },
    roles: {
      design: { candidates: ['d'], effort: 'high' },
      dev: { candidates: ['d'], effort: 'high' },
      review: { candidates: ['d'], effort: 'high' },
    },
    policy: { maxSwitchesPerStage: 1, networkRetries: 0, handoff: false },
    effort: { default: 'high' },
  }
  const r = await executeRole({ config, repo, taskId: '001', role: 'design', adapterFactory, log: () => {} })
  assert.equal(r.ok, true)
  assert.match(promptSeen, /\[note\] 实现时注意锁顺序/)
  assert.equal(readInputs(taskDir).find((i) => i.id === note.id).status, 'consumed')
  fs.rmSync(repo, { recursive: true, force: true })
})
