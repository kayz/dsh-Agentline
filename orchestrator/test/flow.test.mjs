import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { executeRole } from '../lib/exec.mjs'

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-flow-'))
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
  return { repo, taskDir }
}

function configFor(models) {
  const base = {
    collabDir: '.collab/tasks',
    providers: {
      p1: { adapter: 'fake', command: 'fake', source: 'test' },
      p2: { adapter: 'fake', command: 'fake', source: 'test' },
    },
    models: {
      a: { provider: 'p1', id: 'model-a' },
      b: { provider: 'p2', id: 'model-b' },
    },
    roles: {
      design: { candidates: ['a', 'b'], effort: 'high' },
      dev: { candidates: ['a', 'b'], effort: 'high' },
      review: { candidates: ['a', 'b'], effort: 'high' },
    },
    policy: { maxSwitchesPerStage: 2, networkRetries: 0, handoff: true },
    effort: { default: 'high' },
  }
  if (models) base.models = { ...base.models, ...models }
  return base
}

test('candidate switch writes handoff and next candidate sees it', async (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const prompts = []
  const adapterFactory = () => ({
    async run({ prompt, model, logPath }) {
      fs.writeFileSync(logPath, `fake ${model}\n`, 'utf8')
      if (model === 'model-a') {
        fs.writeFileSync(path.join(taskDir, 'design.md'), '# partial A\n', 'utf8')
        fs.writeFileSync(path.join(repo, 'scratch-a.txt'), 'x', 'utf8')
        return { exitCode: 1, error: 'exit 1' }
      }
      prompts.push(prompt)
      fs.writeFileSync(path.join(taskDir, 'design.md'), '# full B\n', 'utf8')
      fs.writeFileSync(path.join(taskDir, 'acceptance.md'), '- AC-1: x\n', 'utf8')
      return { exitCode: 0, error: null }
    },
  })

  const r = await executeRole({
    config: configFor(), repo, taskId: '001', role: 'design',
    adapterFactory, log: () => {},
  })
  assert.equal(r.ok, true)
  assert.equal(r.model, 'b')
  assert.equal(r.state.status, 'designed')

  const handoffFile = path.join(taskDir, 'handoff', 'design-r1-c1-to-c2.md')
  assert.ok(fs.existsSync(handoffFile))
  const handoff = fs.readFileSync(handoffFile, 'utf8')
  assert.match(handoff, /exit=1/)
  assert.match(handoff, /scratch-a\.txt/)
  assert.match(handoff, /checkpoint：`refs\/agentline\//)
  assert.match(prompts[0], /上一候选的现场/)
  assert.match(prompts[0], /design-r1-c1-to-c2\.md/)

  const runs = JSON.parse(fs.readFileSync(path.join(taskDir, 'run.json'), 'utf8'))
  assert.equal(runs.length, 2)
  assert.ok(runs[0].handoff?.file?.includes('design-r1-c1-to-c2.md'))
  assert.equal(runs[1].inherited_from?.candidate, 1)
})

test('inheriting without new work fails as no_new_work', async (t) => {
  const { repo, taskDir } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const adapterFactory = () => ({
    async run({ model, logPath }) {
      fs.writeFileSync(logPath, `fake ${model}\n`, 'utf8')
      if (model === 'model-a') {
        fs.writeFileSync(path.join(taskDir, 'design.md'), '# partial A\n', 'utf8')
        return { exitCode: 1, error: 'exit 1' }
      }
      return { exitCode: 0, error: null }
    },
  })
  const r = await executeRole({
    config: configFor(), repo, taskId: '001', role: 'design',
    adapterFactory, log: () => {},
  })
  const runs = JSON.parse(fs.readFileSync(path.join(taskDir, 'run.json'), 'utf8'))
  assert.equal(r.ok, false)
  assert.equal(runs[1].error, 'no_new_work')
  assert.equal(r.state.status, 'blocked')
})
