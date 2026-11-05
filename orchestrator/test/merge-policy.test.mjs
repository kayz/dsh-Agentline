import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  globToRegExp, inScope, assessMerge, parseTaskRange, mergePolicy,
  addGrant, listGrants, revokeGrant, activeGrantFor, isGrantActive,
} from '../lib/merge-policy.mjs'

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agentline.mjs')

const reviewedTimes = (n) => Array.from({ length: n }, () => ({ to: 'reviewed', by: 'review:model-b' }))
const stateWith = (rounds) => ({ status: 'pr_open', history: reviewedTimes(rounds) })
const change = (file, added = 10, deleted = 0) => ({ file, added, deleted })

test('write_scope matching: globs and plain directories', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b.ts'))
  assert.ok(globToRegExp('src/**/x.ts').test('src/x.ts'))
  assert.ok(globToRegExp('src/*.ts').test('src/a.ts'))
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'))
  assert.ok(inScope('crates/ui/src/lib.rs', ['crates/ui/']))
  assert.ok(inScope('crates/ui/src/lib.rs', ['crates/ui']))
  assert.ok(inScope('README.md', ['README.md']))
  assert.ok(!inScope('crates/uix/a.rs', ['crates/ui']))
  assert.ok(inScope('a\\b.ts', ['a/**']))
})

test('low tier when every limit holds; own task dir is ignored', () => {
  const r = assessMerge({
    state: stateWith(2),
    writeScope: ['src/**'],
    numstat: [change('src/a.ts', 100, 20), change('.collab/tasks/007/impl.md', 9000)],
    policy: mergePolicy({}, {}),
    taskId: '007',
  })
  assert.equal(r.tier, 'low')
  assert.deepEqual(r.reasons, [])
  assert.equal(r.metrics.files, 1)
  assert.equal(r.metrics.lines, 120)
})

test('each limit alone forces confirm', () => {
  const base = { state: stateWith(1), writeScope: ['src/**'], numstat: [change('src/a.ts')], policy: mergePolicy({}, {}), taskId: '001' }
  const tierOf = (patch) => assessMerge({ ...base, ...patch })
  assert.match(tierOf({ state: stateWith(4) }).reasons.join(), /评审 4 轮/)
  assert.match(tierOf({ writeScope: null }).reasons.join(), /未声明 write_scope/)
  // write_scope: [] 表示不改产品代码，任何代码改动都算越界
  assert.match(tierOf({ writeScope: [] }).reasons.join(), /1 个文件在 write_scope 之外/)
  assert.equal(tierOf({ writeScope: [], numstat: [] }).tier, 'low')
  assert.match(tierOf({ numstat: [change('src/a.ts'), change('docs/x.md')] }).reasons.join(), /write_scope 之外：docs\/x\.md/)
  assert.match(tierOf({ numstat: Array.from({ length: 9 }, (_, i) => change(`src/f${i}.ts`)) }).reasons.join(), /9 个文件/)
  assert.match(tierOf({ numstat: [change('src/a.ts', 2000, 1001)] }).reasons.join(), /3001 行/)
  for (const r of [tierOf({ state: stateWith(4) }), tierOf({ writeScope: null })]) assert.equal(r.tier, 'confirm')
  // 其他任务的 .collab 目录和配置文件不算本任务自己的产物
  assert.equal(tierOf({ numstat: [change('src/a.ts'), change('.collab/agentline.json')] }).tier, 'confirm')
})

test('policy overrides: config then project', () => {
  const p = mergePolicy({ policy: { merge: { low: { maxFiles: 3 } } } }, { merge: { low: { maxLines: 50 } } })
  assert.deepEqual(p.low, { maxReviewRounds: 3, maxFiles: 3, maxLines: 50 })
})

test('task ranges keep zero padding', () => {
  assert.deepEqual(parseTaskRange('016-019'), ['016', '017', '018', '019'])
  assert.deepEqual(parseTaskRange('016,018,020-021'), ['016', '018', '020', '021'])
  assert.deepEqual(parseTaskRange('009-010'), ['009', '010'])
  assert.throws(() => parseTaskRange('020-016'), /倒序/)
  assert.throws(() => parseTaskRange(''), /缺少任务编号/)
  assert.throws(() => parseTaskRange('01 6'), /无法解析/)
})

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-merge-'))
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n', 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return { repo, git }
}

test('grants: add, match, expire and revoke', async (t) => {
  const { repo } = makeRepo()
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const now = Date.parse('2026-11-05T00:00:00Z')
  const g = await addGrant(repo, { tasks: '016-018', hours: 2, text: '按 S3 依次推进', now })
  assert.deepEqual(g.tasks, ['016', '017', '018'])
  const grants = await listGrants(repo)
  assert.equal(activeGrantFor(grants, '017', now + 3600_000)?.id, g.id)
  assert.equal(activeGrantFor(grants, '019', now), null)
  assert.equal(activeGrantFor(grants, '017', now + 3 * 3600_000), null)
  await revokeGrant(repo, g.id, now + 60_000)
  assert.equal(isGrantActive((await listGrants(repo))[0], now + 120_000), false)
  await assert.rejects(addGrant(repo, { tasks: '001', hours: 1, text: '  ' }), /用户原话/)
  await assert.rejects(addGrant(repo, { tasks: '001', hours: 500, text: 'x' }), /--hours/)
})

/** 建一个停在 pr_open 的任务分支（in-place 模式：工作区停在任务分支上） */
function prOpenTask({ repo, git }, taskId, { rounds = 1, writeScope = ['src/**'], files = ['src/a.txt'] } = {}) {
  git('switch', '-q', '-c', `task/${taskId}`)
  const taskDir = path.join(repo, '.collab', 'tasks', taskId)
  fs.mkdirSync(taskDir, { recursive: true })
  const scope = writeScope ? `---\nwrite_scope:\n${writeScope.map((s) => `  - ${s}`).join('\n')}\n---\n` : ''
  fs.writeFileSync(path.join(taskDir, 'design.md'), `${scope}# design\n`, 'utf8')
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true })
    fs.writeFileSync(path.join(repo, f), `${f}\n`, 'utf8')
  }
  const state = { id: taskId, status: 'pr_open', history: reviewedTimes(rounds), pr: { branch: `task/${taskId}`, state: 'open' } }
  fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8')
  git('add', '-A')
  git('commit', '-qm', `task ${taskId}`)
}

const cli = (repo, ...a) => spawnSync(process.execPath, [CLI, ...a, '--repo', repo], { encoding: 'utf8' })
const mergedState = (repo, taskId) => JSON.parse(fs.readFileSync(path.join(repo, '.collab', 'tasks', taskId, 'state.json'), 'utf8'))

test('cli: --grant merges a low-tier task only while a grant covers it', async (t) => {
  const ctx = makeRepo()
  t.after(() => fs.rmSync(ctx.repo, { recursive: true, force: true }))
  prOpenTask(ctx, '001')

  const noGrant = cli(ctx.repo, 'merge', '--task', '001', '--grant')
  assert.notEqual(noGrant.status, 0)
  assert.match(noGrant.stderr, /没有覆盖 task 001 的有效预授权/)

  const granted = cli(ctx.repo, 'grant', '--tasks', '001-002', '--hours', '1', '--text', '自动推进到代码侧完成')
  assert.equal(granted.status, 0, granted.stderr)

  const check = cli(ctx.repo, 'merge', '--task', '001', '--check')
  assert.equal(check.status, 0, check.stderr)
  assert.equal(JSON.parse(check.stdout).tier, 'low')

  const ok = cli(ctx.repo, 'merge', '--task', '001', '--grant')
  assert.equal(ok.status, 0, ok.stderr + ok.stdout)
  const st = mergedState(ctx.repo, '001')
  assert.equal(st.status, 'merged')
  assert.equal(st.pr.permission_kind, 'grant')
  assert.match(st.pr.permission, /^预授权 g\w+：自动推进到代码侧完成$/)
  assert.match(st.history.at(-1).by, /^grant:g\w+$/)
  assert.equal(st.merge_risk.tier, 'low')
})

test('cli: confirm-tier task refuses --grant but accepts explicit permission', async (t) => {
  const ctx = makeRepo()
  t.after(() => fs.rmSync(ctx.repo, { recursive: true, force: true }))
  prOpenTask(ctx, '002', { rounds: 5 })
  assert.equal(cli(ctx.repo, 'grant', '--tasks', '002', '--hours', '1', '--text', '批量放行').status, 0)

  const refused = cli(ctx.repo, 'merge', '--task', '002', '--grant')
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /需要逐个确认.*评审 5 轮/)
  assert.equal(mergedState(ctx.repo, '002').status, 'pr_open')

  const both = cli(ctx.repo, 'merge', '--task', '002', '--grant', '--permission', '允许合并')
  assert.notEqual(both.status, 0)
  assert.match(both.stderr, /只能二选一/)

  const ok = cli(ctx.repo, 'merge', '--task', '002', '--permission', '允许合并')
  assert.equal(ok.status, 0, ok.stderr + ok.stdout)
  const st = mergedState(ctx.repo, '002')
  assert.equal(st.pr.permission_kind, 'explicit')
  assert.equal(st.pr.permission, '允许合并')
  assert.equal(st.history.at(-1).by, 'human')
  assert.equal(st.merge_risk.tier, 'confirm')
})
