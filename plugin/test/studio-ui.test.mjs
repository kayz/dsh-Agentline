import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugin', 'lib')
const ORCH = path.join(REPO_ROOT, 'orchestrator')
const CLIENT = path.join(PLUGIN_LIB, 'client.js')
const HOST = path.join(PLUGIN_LIB, 'index.js')

// ───────────────────────────── 最小 React 运行时（只实现 client.js 用到的部分） ─────────────────────────────
const Fragment = Symbol('agentline.fragment')
let hookHost = null

class Component {
  constructor(props) { this.props = props || {}; this.state = {} }
  setState(patch) {
    const next = typeof patch === 'function' ? patch(this.state) : patch
    this.state = { ...this.state, ...next }
    if (this.__root) this.__root.dirty = true
  }
}
Component.prototype.isReactComponent = true

function createElement(type, props, ...children) {
  const kids = []
  const push = (c) => {
    if (Array.isArray(c)) { c.forEach(push); return }
    if (c === null || c === undefined || typeof c === 'boolean') return
    kids.push(c)
  }
  push(children)
  return { type, props: props || {}, children: kids }
}

function useState(init) {
  const host = hookHost
  const i = host.index++
  if (!(i in host.hooks)) host.hooks[i] = { value: typeof init === 'function' ? init() : init }
  const slot = host.hooks[i]
  const set = (v) => {
    slot.value = typeof v === 'function' ? v(slot.value) : v
    host.root.dirty = true
  }
  return [slot.value, set]
}

function useRef(v) {
  const host = hookHost
  const i = host.index++
  if (!(i in host.hooks)) host.hooks[i] = { ref: { current: v } }
  return host.hooks[i].ref
}

function useEffect(fn, deps) {
  const host = hookHost
  const i = host.index++
  const prev = host.hooks[i]
  const changed = !prev || !prev.deps || !deps || deps.length !== prev.deps.length || deps.some((d, j) => !Object.is(d, prev.deps[j]))
  if (!prev) {
    host.hooks[i] = { deps, cleanup: null, pending: fn }
    host.root.pending.push(host.hooks[i])
    return
  }
  if (changed) {
    prev.deps = deps
    prev.pending = fn
    host.root.pending.push(prev)
  }
}

const ReactStub = { createElement, Fragment, useState, useRef, useEffect, Component }

function renderNode(node, keyPath, root) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
  if (Array.isArray(node)) {
    const children = node.map((c, i) => renderNode(c, keyPath + '/' + i, root)).filter(Boolean)
    return { fragment: true, props: {}, children }
  }
  const { type, props, children } = node
  const withChildren = children.length
    ? { ...props, children: children.length === 1 ? children[0] : children }
    : props

  if (type === Fragment) {
    return { fragment: true, props: {}, children: children.map((c, i) => renderNode(c, keyPath + '/f' + i, root)).filter(Boolean) }
  }

  if (typeof type === 'function') {
    const key = keyPath + '|' + (type.name || 'anonymous')
    if (type.prototype && type.prototype.isReactComponent) {
      let inst = root.instances.get(key)
      if (!inst) {
        inst = new type(withChildren)
        inst.props = withChildren
        inst.__root = root
        root.instances.set(key, inst)
      } else inst.props = withChildren
      let out
      try {
        out = inst.render()
      } catch (e) {
        const derive = type.getDerivedStateFromError
        if (!derive) throw e
        inst.state = { ...inst.state, ...derive(e) }
        out = inst.render()
      }
      return renderNode(out, key + '/r', root)
    }
    const prevHost = hookHost
    let host = root.instances.get(key)
    if (!host) { host = { hooks: [], index: 0, root }; root.instances.set(key, host) }
    host.index = 0
    host.root = root
    hookHost = host
    let out
    try {
      out = type(withChildren)
    } finally { hookHost = prevHost }
    return renderNode(out, key + '/r', root)
  }

  return {
    type,
    props,
    children: children.map((c, i) => renderNode(c, keyPath + '/' + i, root)).filter(Boolean),
  }
}

function mount(ComponentTree) {
  const root = { dirty: true, pending: [], instances: new Map(), tree: null }
  const renderPass = () => {
    root.pending = []
    root.tree = renderNode(ComponentTree, 'root', root)
    const effects = root.pending
    root.pending = []
    for (const slot of effects) {
      if (typeof slot.cleanup === 'function') { try { slot.cleanup() } catch { /* ignore */ } }
      slot.cleanup = null
      const fn = slot.pending
      slot.pending = null
      try {
        const cleanup = fn()
        if (typeof cleanup === 'function') slot.cleanup = cleanup
      } catch { /* 宿主异常不应终止测试渲染 */ }
    }
  }
  root.flush = () => {
    let guard = 0
    while (root.dirty && guard < 40) {
      root.dirty = false
      renderPass()
      guard++
    }
  }
  root.flush()
  return root
}

function walk(node, fn) {
  if (!node) return
  if (Array.isArray(node)) { node.forEach((n) => walk(n, fn)); return }
  fn(node)
  ;(node.children || []).forEach((c) => walk(c, fn))
}

function findById(root, id) {
  let hit = null
  walk(root.tree, (n) => { if (!hit && n.props && n.props['data-testid'] === id) hit = n })
  return hit
}

function findAllById(root, prefix) {
  const out = []
  walk(root.tree, (n) => {
    const id = n.props && n.props['data-testid']
    if (typeof id === 'string' && id.indexOf(prefix) === 0) out.push(n)
  })
  return out
}

function textOf(node) {
  if (!node) return ''
  if (node.text !== undefined) return node.text
  return (node.children || []).map(textOf).join(' ')
}

function textOfId(root, id) {
  const n = findById(root, id)
  return n ? textOf(n) : ''
}

function click(root, node) {
  assert.ok(node, 'node to click exists')
  assert.notEqual(node.props.disabled, true, 'node to click is enabled')
  assert.ok(typeof node.props.onClick === 'function', 'node has onClick')
  node.props.onClick({ preventDefault() {}, stopPropagation() {} })
  root.flush()
}

function change(root, node, value) {
  assert.ok(node, 'node to change exists')
  node.props.onChange({ target: { value } })
  root.flush()
}

async function settle(root, rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    root.flush()
    await new Promise((r) => setTimeout(r, 0))
  }
  root.flush()
}

// ───────────────────────────── 环境（隔离临时目录 + 假 CLI） ─────────────────────────────
const FIXTURE_CLI = `import fs from 'node:fs'
const args = process.argv.slice(2)
const log = process.env.STUDIO_FAKE_LOG
if (log) fs.appendFileSync(log, JSON.stringify(args) + '\\n')
if (process.env.STUDIO_FAKE_FAIL === '1') {
  process.stderr.write('fake cli failure\\n')
  process.exit(1)
}
process.stdout.write('OK ' + args.slice(0, 3).join(' ') + '\\n')
process.exit(0)
`

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-ui-home-'))
  fs.cpSync(path.join(ORCH, 'lib'), path.join(home, 'lib'), { recursive: true })
  fs.cpSync(path.join(ORCH, 'config'), path.join(home, 'config'), { recursive: true })
  fs.writeFileSync(path.join(home, 'agentline.mjs'), FIXTURE_CLI, 'utf8')
  const cliLog = path.join(home, 'cli.jsonl')
  fs.writeFileSync(cliLog, '', 'utf8')
  writeJson(path.join(home, 'config', 'agentline.local.json'), {
    providers: {
      claude: { source: 'anthropic', adapter: 'claude-cli', transport: 'cli', command: 'claude', capabilities: { readonly_mode: true } },
      codex: { source: 'openai', adapter: 'codex-cli', transport: 'cli', command: 'codex' },
      codebuddy: { source: 'tencent', adapter: 'codebuddy-cli', transport: 'cli', command: 'codebuddy' },
      gemini: { source: 'google', adapter: 'gemini-cli', transport: 'cli', command: 'gemini' },
      cursor: { source: 'cursor', adapter: 'cursor-agent', transport: 'cli', command: 'cursor' },
    },
    models: {
      'claude-top': { provider: 'claude', id: 'claude-top', tier: 'top', availability: 'callable', identity: 'verified', source: 'allowlist' },
      'codex-top': { provider: 'codex', id: 'codex-top', tier: 'top', availability: 'callable', identity: 'unverified', source: 'allowlist' },
      'buddy-top': { provider: 'codebuddy', id: 'buddy-top', tier: 'advanced', availability: 'discovered', identity: 'unverified', source: 'discovery' },
      'gemini-top': { provider: 'gemini', id: 'gemini-top' },
    },
    studio: {
      roles: {
        expert_a: ['claude-top'], expert_b: ['codex-top'], expert_c: ['claude-top'],
        moderator: ['codex-top'], scribe: ['buddy-top'],
      },
    },
  })
  return { home, cliLog }
}

function makeProject(name, { sessions = [], tasks = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-ui-' + name + '-'))
  fs.mkdirSync(path.join(root, '.collab'), { recursive: true })
  fs.writeFileSync(path.join(root, '.collab', 'agentline.json'), JSON.stringify({ enabled: true }), 'utf8')
  fs.mkdirSync(path.join(root, '.collab', 'tasks'), { recursive: true })
  for (const t of tasks) {
    const dir = path.join(root, '.collab', 'tasks', t.id)
    fs.mkdirSync(dir, { recursive: true })
    if (t.state) writeJson(path.join(dir, 'state.json'), t.state)
    if (t.logs) fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
  }
  for (const s of sessions) {
    const dir = path.join(root, '.collab', 'studio', s.id)
    writeJson(path.join(dir, 'session.json'), s.session)
    writeJson(path.join(dir, 'questions.json'), s.questions || [])
    writeJson(path.join(dir, 'decisions.json'), s.decisions || [])
    fs.mkdirSync(path.join(dir, 'confirmations'), { recursive: true })
    if (s.minutes !== undefined) fs.writeFileSync(path.join(dir, 'minutes-final.md'), s.minutes, 'utf8')
  }
  return root
}

function studioFixture(id, { status = 'awaiting_user', step = 'moderator' } = {}) {
  return {
    id,
    session: {
      schema: 'agentline.studio/v1',
      id,
      title: '会话 ' + id,
      input: '讨论 P6',
      status,
      roles: {
        expert_a: { model: 'claude-top', id: 'claude-top', tier: 'top', provider: 'claude' },
        expert_b: { model: 'codex-top', id: 'codex-top', tier: 'top', provider: 'codex' },
        expert_c: { model: 'claude-top', id: 'claude-top', tier: 'top', provider: 'claude' },
        moderator: { model: 'codex-top', id: 'codex-top', tier: 'top', provider: 'codex' },
        scribe: { model: 'buddy-top', id: 'buddy-top', tier: 'advanced', provider: 'codebuddy' },
      },
      steps_done: ['expert_a', 'expert_b', 'expert_c', 'moderator'],
      outputs: {},
      calls: [],
      revision: 4,
      created_at: '2026-11-06T00:00:00.000Z',
      updated_at: '2026-11-06T00:10:00.000Z',
    },
    questions: [
      { id: 'Q-1', text: '范围是否只做 P6？', blocking: true, status: 'open', rounds_used: 1, default: 'A', user_action: null },
    ],
    decisions: [
      { id: 'D-1', title: '范围', detail: '只做 P6', default: 'P6', status: 'draft', rounds_used: 0, confirmed_by_user: null },
    ],
    minutes: '',
  }
}

function makeServer(overrides = {}) {
  const server = { calls: [], routes: [], data: overrides }
  const reply = (prefix, fn) => server.routes.push({ prefix, fn })
  reply('/agentline/studio', async (url, method, opts) => {
    if (overrides.studio) return overrides.studio(url, method, opts)
    return { ok: true, sessions: [], roles: {} }
  })
  reply('/agentline/projects', async () => overrides.projects || { ok: true, default: '', projects: [] })
  reply('/agentline/tasks', async () => overrides.tasks || { ok: true, tasks: [], tokens: { total: { input: 0, output: 0 } } })
  reply('/agentline/metrics', async () => ({ ok: true, records: [] }))
  reply('/agentline/summary', async () => ({ ok: true, running: [], prOpen: [], blocked: [], records: [] }))
  reply('/agentline/notices', async () => ({ ok: true, notices: [] }))
  reply('/agentline/live', async () => ({ ok: true, running: [] }))
  reply('/agentline/pipeline', async () => ({ ok: true, summary: { stages: { studio: { status: 'idle', sessions: [] }, blueprint: { status: 'not_started', sessions: [] } }, tasks: [] } }))
  reply('/agentline/task', async () => overrides.task || { ok: true, task: '001', state: { status: 'blocked', blocked_reason: 'awaiting_human' }, logs: [], runs: [], attention: { question: '要不要继续？' }, stepLedger: [] })
  reply('/agentline/catalog', async () => overrides.catalog || { ok: true, catalog: { models: [] }, discovery: null })
  reply('/agentline/models', async () => ({ ok: true, models: [], roles: { design: [], dev: [], review: [] } }))
  reply('/agentline/routing', async () => ({ ok: true, models: [], roles: { design: { model: 'claude-top', order: ['claude-top', 'codex-top'] }, dev: { model: 'codex-top', order: ['codex-top'] }, review: { model: 'gemini-top', order: ['gemini-top'] } }, routing: {} }))
  reply('/agentline/merge', async () => ({ ok: true, output: '' }))
  reply('/agentline/control', async () => ({ ok: true }))
  reply('/agentline/flow', async () => ({ ok: true }))
  return server
}

let fetchCalls = []
function installFetch(server) {
  fetchCalls = []
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    fetchCalls.push({ url: u, method: (opts.method || 'GET').toUpperCase(), body: opts.body ? JSON.parse(opts.body) : null })
    let payload = { ok: true }
    for (const r of server.routes) {
      if (u.indexOf(r.prefix) === 0) { payload = await r.fn(u, (opts.method || 'GET').toUpperCase(), opts); break }
    }
    return { status: (payload && payload.__status) || 200, json: async () => payload }
  }
}

// ───────────────────────────── 加载 client.js ─────────────────────────────
const localStorageData = new Map()
const windowStub = {
  localStorage: {
    getItem: (k) => (localStorageData.has(k) ? localStorageData.get(k) : null),
    setItem: (k, v) => localStorageData.set(k, String(v)),
    removeItem: (k) => localStorageData.delete(k),
  },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  Notification: undefined,
}
const documentStub = {
  head: { appendChild: () => {} },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
  querySelectorAll: () => [],
}

let clientModule = null
let registeredMain = null

async function loadClient() {
  if (clientModule) return clientModule
  globalThis.window = windowStub
  globalThis.document = documentStub
  windowStub.__ModuleLoader__ = {
    load: ({ factory }) => { clientModule = factory((name) => (name === 'react' ? ReactStub : {})) },
  }
  await import(pathToFileURL(CLIENT).href)
  const ctx = {
    slots: {
      inject: (name, fn) => { fn() },
      register: (spec, Comp) => {
        if (spec && spec.name === 'main') registeredMain = Comp
        return () => {}
      },
    },
  }
  clientModule.apply(ctx)
  assert.ok(registeredMain, 'main slot registered')
  return clientModule
}

async function mountCockpit() {
  await loadClient()
  localStorageData.clear()
  const root = mount(ReactStub.createElement(registeredMain, {}))
  return root
}

// ───────────────────────────── host half ─────────────────────────────
function makeCtx() {
  const routes = new Map()
  const ctx = {
    get: () => undefined,
    logger: { warn: () => {} },
    effect: () => () => {},
    inject: (deps, cb) => {
      if (deps.indexOf('webServer') >= 0) {
        cb({
          effect: (fn) => { fn(); return () => {} },
          webServer: { register: ({ path: p, handler }) => { routes.set(p, handler); return () => {} } },
        })
      }
    },
  }
  return { ctx, routes }
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    end(payload) { this.body = payload },
  }
}

async function callRoute(routes, routePath, { method = 'GET', url, body } = {}) {
  const handler = routes.get(routePath)
  assert.ok(handler, 'route registered: ' + routePath)
  const req = {
    method,
    url: url || routePath,
    on(event, cb) {
      if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') cb()
      if (event === 'error') { /* noop */ }
      return this
    },
    destroy() {},
  }
  const res = makeRes()
  await handler(req, res)
  let json = null
  try { json = JSON.parse(res.body) } catch { json = res.body }
  return { status: res.statusCode, body: json }
}

// ───────────────────────────── 测试 ─────────────────────────────
test('studio ui: five tabs, Inbox, portfolio, legacy task controls and unimplemented stages stay intact', async (t) => {
  const { home, cliLog } = makeHome()
  const project = makeProject('main', {
    tasks: [{ id: '001', state: { id: '001', status: 'blocked', blocked_reason: 'awaiting_human', updated_at: '2026-11-06T00:00:00.000Z' } }],
  })
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })

  const server = makeServer({
    projects: { ok: true, default: project, projects: [{ title: 'main', path: project, enabled: true, tasks: { total: 1, active: 1, last: 'blocked' } }] },
    tasks: { ok: true, tasks: [{ id: '001', state: { id: '001', status: 'blocked', blocked_reason: 'awaiting_human' } }], tokens: { total: { input: 0, output: 0 } } },
    summary: { ok: true, running: [], prOpen: [], blocked: [{ project: 'main', projectPath: project, task: '001', reason: 'awaiting_human' }], records: [] },
  })
  installFetch(server)
  const root = await mountCockpit()
  await settle(root)

  assert.equal(findAllById(root, 'tab-').length, 5)
  assert.deepEqual(['home', 'studio', 'blueprint', 'build', 'settings'].map((id) => textOfId(root, 'tab-' + id)), ['首页', 'Studio', 'Blueprint', 'Build', '设置'])
  assert.ok(findAllById(root, 'project-select').length >= 1)
  assert.match(textOf(root.tree), /项目组合/)
  assert.match(textOf(root.tree), /待处理/)
  assert.match(textOf(root.tree), /斜杠命令/)

  click(root, findById(root, 'tab-build'))
  await settle(root)
  assert.ok(findById(root, 'task-stop'), 'legacy stop control present')
  assert.ok(findById(root, 'task-stop-now'), 'legacy stop-now control present')
  assert.match(textOf(root.tree), /执行记录/)

  click(root, findById(root, 'tab-blueprint'))
  await settle(root)
  assert.match(textOf(root.tree), /未实现/)
})

test('studio ui: empty, real, error and project-switch states are distinct', async (t) => {
  const { home } = makeHome()
  const projectA = makeProject('a', { sessions: [studioFixture('s-a')] })
  const projectB = makeProject('b', { sessions: [studioFixture('s-b', { status: 'running' })] })
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(projectA, { recursive: true, force: true })
    fs.rmSync(projectB, { recursive: true, force: true })
  })

  let mode = 'real'
  const server = makeServer({
    projects: { ok: true, default: projectA, projects: [
      { title: 'A', path: projectA, enabled: true, tasks: { total: 0, active: 0, last: null } },
      { title: 'B', path: projectB, enabled: true, tasks: { total: 0, active: 0, last: null } },
    ] },
    studio: async (url) => {
      if (mode === 'error') return { ok: false, error: 'studio read failed' }
      const pid = url.indexOf(encodeURIComponent(projectB)) >= 0 ? projectB : projectA
      const id = url.indexOf('id=') >= 0 ? decodeURIComponent(url.split('id=')[1].split('&')[0]) : null
      const session = pid === projectB ? studioFixture('s-b', { status: 'running' }) : studioFixture('s-a')
      if (!id) {
        return {
          ok: true,
          sessions: [{ id: session.id, title: session.session.title, status: session.session.status, step: 'moderator', updated_at: session.session.updated_at, open_blocking: 1, pending_decisions: 1 }],
          roles: { expert_a: { primary: 'claude-top', backups: [], tier: 'top', constraint: 'top；独立调用' } },
        }
      }
      return {
        ok: true,
        id,
        session: { ...session.session, id },
        questions: session.questions,
        decisions: session.decisions,
        confirmations: { expert_a: { expert: 'expert_a', verdict: 'accept', notes: '同意', model: 'claude-top', at: '2026-11-06T00:10:00.000Z' } },
        minutes: '',
        g0: { gate: 'G0', pass: false, status: 'fail', checks: [
          { id: 'G0.minutes_final', desc: '纪要存在且非空', pass: false, waivable: false, evidence: 'missing' },
          { id: 'G0.no_open_blocking', desc: '无阻塞问题', pass: false, waivable: false, evidence: 'Q-1:open' },
        ] },
      }
    },
  })
  installFetch(server)
  const root = await mountCockpit()
  await settle(root)

  click(root, findById(root, 'tab-studio'))
  await settle(root)
  assert.ok(findById(root, 'studio-session-s-a'), 'real session listed')
  assert.equal(findById(root, 'studio-empty'), null)

  click(root, findById(root, 'studio-session-s-a'))
  await settle(root)
  assert.match(textOfId(root, 'studio-session-status'), /待你处理/)
  assert.ok(findById(root, 'question-Q-1'), 'question rendered')
  assert.ok(findById(root, 'decision-D-1'), 'decision rendered')
  assert.match(textOfId(root, 'confirmation-expert_a'), /accept/)
  assert.match(textOfId(root, 'confirmation-expert_b'), /未确认/)
  assert.ok(findById(root, 'g0-G0.minutes_final'), 'G0 checks rendered')
  assert.equal(findById(root, 'studio-run').props.disabled, true, 'run is disabled while a blocking question is open')

  // 项目切换：重新读取，不保留上一个项目的数据
  change(root, findById(root, 'project-select'), projectB)
  await settle(root)
  assert.ok(findById(root, 'studio-session-s-b'), 'project B session listed')
  assert.equal(findById(root, 'studio-session-s-a'), null, 'project A data is gone')

  mode = 'error'
  click(root, findById(root, 'studio-session-s-b'))
  await settle(root)
  assert.ok(findById(root, 'studio-detail-error'), 'detail read error is shown')
  assert.match(textOfId(root, 'studio-detail-error'), /无法读取会话/)
  assert.ok(findById(root, 'studio-retry'))
  assert.equal(findById(root, 'studio-empty'), null, 'detail error is not confused with empty')

  // 列表读取失败也是错误态，而不是空态
  change(root, findById(root, 'project-select'), projectA)
  await settle(root)
  assert.ok(findById(root, 'studio-error'), 'list error is shown')
  assert.equal(findById(root, 'studio-empty'), null)
  assert.equal(findById(root, 'studio-detail-error'), null)
})

test('studio ui: empty project shows an explicit empty state, not an error', async (t) => {
  const { home } = makeHome()
  const project = makeProject('empty')
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
  installFetch(makeServer({
    projects: { ok: true, default: project, projects: [{ title: 'empty', path: project, enabled: true, tasks: { total: 0, active: 0, last: null } }] },
  }))
  const root = await mountCockpit()
  await settle(root)
  click(root, findById(root, 'tab-studio'))
  await settle(root)
  assert.ok(findById(root, 'studio-empty'))
  assert.match(textOfId(root, 'studio-empty'), /还没有 Studio 会话/)
  assert.equal(findById(root, 'studio-error'), null)
})

test('studio ui: new / run / answer / conclude each forward exactly one CLI call', async (t) => {
  const { home, cliLog } = makeHome()
  const project = makeProject('ops', { sessions: [studioFixture('ops-1')] })
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })

  process.env.STUDIO_FAKE_LOG = cliLog
  t.after(() => { delete process.env.STUDIO_FAKE_LOG; delete process.env.STUDIO_FAKE_FAIL })

  const base = studioFixture('ops-1')
  let answered = false
  const detailFor = (id) => ({
    ok: true,
    id,
    session: { ...base.session, id },
    questions: answered
      ? [{ ...base.questions[0], status: 'answered', user_action: { kind: 'answer', text: '只做 P6', at: '2026-11-06T00:20:00.000Z' } }]
      : base.questions,
    decisions: base.decisions,
    confirmations: {},
    minutes: '',
    g0: { gate: 'G0', pass: false, status: 'fail', checks: [] },
  })

  // 真实 host 路由：写操作必须真的转发一条 CLI
  const host = await import(pathToFileURL(HOST).href + '?v=' + Date.now())
  const { ctx, routes } = makeCtx()
  host.apply(ctx, { agentlineHome: home, nodePath: process.execPath, defaultRepo: project, metricsEnabled: false })
  assert.ok(routes.has('/agentline/studio'))

  const server = makeServer({
    projects: { ok: true, default: project, projects: [{ title: 'ops', path: project, enabled: true, tasks: { total: 0, active: 0, last: null } }] },
    studio: async (url, method, opts) => {
      if (method === 'POST') {
        const body = JSON.parse(opts.body || '{}')
        const r = await callRoute(routes, '/agentline/studio', { method: 'POST', url, body })
        if (body.action === 'answer' && r.body.ok) answered = true
        return r.body
      }
      if (url.indexOf('&id=') >= 0) {
        const id = decodeURIComponent(url.split('&id=')[1].split('&')[0])
        return detailFor(id)
      }
      return { ok: true, sessions: [{ id: 'ops-1', title: '会话 ops-1', status: 'awaiting_user', step: 'moderator', updated_at: '2026-11-06T00:10:00.000Z', open_blocking: 1 }], roles: {} }
    },
  })
  installFetch(server)
  const root = await mountCockpit()
  await settle(root)

  const cliCalls = () => fs.readFileSync(cliLog, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  const posted = () => fetchCalls.filter((c) => c.method === 'POST' && c.url.indexOf('/agentline/studio') === 0)

  click(root, findById(root, 'tab-studio'))
  await settle(root)
  click(root, findById(root, 'studio-session-ops-1'))
  await settle(root)

  const before = cliCalls().length
  change(root, findById(root, 'studio-new-id'), 'ops-2')
  change(root, findById(root, 'studio-new-title'), '新会话')
  change(root, findById(root, 'studio-new-input'), '继续讨论 P6')
  click(root, findById(root, 'studio-new-submit'))
  await settle(root)
  assert.equal(posted().length, 1)
  assert.equal(posted()[0].body.action, 'new')
  assert.equal(posted()[0].body.id, 'ops-2')

  const afterNew = cliCalls()
  assert.equal(afterNew.length, before + 1)
  assert.deepEqual(afterNew[afterNew.length - 1].slice(0, 4), ['studio', 'new', '--repo', project])
  assert.ok(afterNew[afterNew.length - 1].indexOf('ops-2') >= 0)

  // 回到 ops-1 继续操作
  click(root, findById(root, 'studio-session-ops-1'))
  await settle(root)

  // run：阻塞问题未回答时禁用，且按钮说明原因
  const runBtn = findById(root, 'studio-run')
  assert.equal(runBtn.props.disabled, true, 'blocking question prevents run')
  assert.match(String(runBtn.props.title || ''), /阻塞问题/)

  // 回答 = 一次 CLI 调用
  change(root, findById(root, 'answer-input-Q-1'), '只做 P6')
  click(root, findById(root, 'answer-submit-Q-1'))
  await settle(root)
  assert.equal(posted().length, 2)
  assert.deepEqual(posted()[1].body, { project, action: 'answer', id: 'ops-1', question: 'Q-1', text: '只做 P6' })
  const afterAnswer = cliCalls()
  assert.equal(afterAnswer.length, before + 2)
  assert.deepEqual(afterAnswer[afterAnswer.length - 1].slice(0, 4), ['studio', 'answer', '--repo', project])
  assert.ok(afterAnswer[afterAnswer.length - 1].indexOf('--channel') >= 0)

  click(root, findById(root, 'studio-run'))
  await settle(root)
  assert.equal(posted().length, 3)
  assert.equal(posted()[2].body.action, 'run')
  assert.equal(cliCalls().length, before + 3)

  click(root, findById(root, 'studio-conclude'))
  await settle(root)
  assert.equal(posted().length, 4)
  assert.equal(posted()[3].body.action, 'conclude')
  assert.equal(cliCalls().length, before + 4)

  // 失败：显示原因，不自动重发
  process.env.STUDIO_FAKE_FAIL = '1'
  const beforeFail = cliCalls().length
  const postsBeforeFail = posted().length
  click(root, findById(root, 'studio-conclude'))
  await settle(root)
  assert.equal(posted().length, postsBeforeFail + 1)
  assert.equal(cliCalls().length, beforeFail + 1)
  assert.match(textOfId(root, 'studio-msg'), /操作失败/)
})

test('studio ui: catalog is grouped by five channels with seven columns, collapse and filters', async (t) => {
  const { home } = makeHome()
  const project = makeProject('catalog')
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })

  const models = [
    { key: 'claude-top', provider: 'claude', id: 'claude-top', tier: 'top', identity: 'verified', availability: 'callable', source: 'allowlist' },
    { key: 'codex-top', provider: 'codex', id: 'codex-top', tier: 'top', identity: 'unverified', availability: 'callable', source: 'allowlist' },
    { key: 'buddy-top', provider: 'codebuddy', id: 'buddy-top', tier: 'advanced', identity: 'unverified', availability: 'discovered', source: 'discovery' },
    { key: 'gemini-top', provider: 'gemini', id: 'gemini-top', tier: 'unknown', identity: 'unverified', availability: 'unknown', source: '' },
  ]
  installFetch(makeServer({
    projects: { ok: true, default: project, projects: [{ title: 'catalog', path: project, enabled: true, tasks: { total: 0, active: 0, last: null } }] },
    catalog: { ok: true, catalog: { models }, discovery: null },
  }))
  const root = await mountCockpit()
  await settle(root)
  click(root, findById(root, 'tab-settings'))
  await settle(root)

  for (const id of ['claude', 'codex', 'codebuddy', 'cursor', 'gemini']) {
    assert.ok(findById(root, 'channel-group-' + id), 'group exists: ' + id)
  }
  const headers = []
  walk(findById(root, 'channel-group-claude'), (n) => { if (n.type === 'th') headers.push(textOf(n)) })
  assert.deepEqual(headers, ['模型', '渠道', 'id', '档位', '身份', '可用性', '来源'])
  assert.match(textOf(root.tree), /模型目录/)
  for (const column of ['模型', '渠道', 'id', '档位', '身份', '可用性', '来源']) {
    assert.match(textOf(root.tree), new RegExp(column))
  }
  assert.match(textOf(root.tree), /暂无该渠道模型/, 'empty channel is visible without inventing models')
  assert.equal(findById(root, 'catalog-row-cursor-x'), null)

  // 未知值明确显示未知；discovered 不等于 callable
  assert.match(textOfId(root, 'channel-group-gemini'), /未知/)
  assert.match(textOfId(root, 'channel-group-codebuddy'), /discovered/)
  assert.match(textOfId(root, 'channel-group-codebuddy'), /unverified/)
  assert.doesNotMatch(textOfId(root, 'channel-group-codebuddy'), /callable/)

  // 折叠
  assert.ok(findById(root, 'catalog-row-claude-top'))
  click(root, findById(root, 'channel-toggle-claude'))
  await settle(root)
  assert.equal(findById(root, 'catalog-row-claude-top'), null, 'collapsed group hides rows')
  click(root, findById(root, 'channel-toggle-claude'))
  await settle(root)
  assert.ok(findById(root, 'catalog-row-claude-top'))

  // 渠道筛选
  change(root, findById(root, 'catalog-filter'), 'codex')
  await settle(root)
  assert.ok(findById(root, 'catalog-row-codex-top'))
  assert.equal(findById(root, 'catalog-row-claude-top'), null)
  change(root, findById(root, 'catalog-filter'), 'all')
  await settle(root)

  // 搜索
  change(root, findById(root, 'catalog-search'), 'buddy')
  await settle(root)
  assert.ok(findById(root, 'catalog-row-buddy-top'))
  assert.equal(findById(root, 'catalog-row-codex-top'), null)
})

test('studio ui: role matrix shows all 11 stage roles with five attributes', async (t) => {
  const { home } = makeHome()
  const project = makeProject('roles')
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
  installFetch(makeServer({
    projects: { ok: true, default: project, projects: [{ title: 'roles', path: project, enabled: true, tasks: { total: 0, active: 0, last: null } }] },
    catalog: { ok: true, catalog: { models: [] }, discovery: null },
  }))
  const root = await mountCockpit()
  await settle(root)
  click(root, findById(root, 'tab-settings'))
  await settle(root)

  const ids = [
    'studio-expert_a', 'studio-expert_b', 'studio-expert_c', 'studio-moderator', 'studio-scribe',
    'blueprint-designer', 'blueprint-reviewer', 'blueprint-test_architect',
    'build-designer', 'build-developer', 'build-verifier',
  ]
  for (const id of ids) {
    const row = findById(root, 'role-row-' + id)
    assert.ok(row, 'role row: ' + id)
    assert.equal(row.children.length, 7, 'row shows stage/role/primary/backup/tier/constraint/probe: ' + id)
  }

  const matrix = findById(root, 'role-matrix')
  const header = textOf(matrix)
  for (const column of ['阶段', '角色', '主选', '备选', '档位要求', '约束', 'probe']) assert.match(header, new RegExp(column))

  // Studio 未配置时显示未设置 / 未知，不捏造通过
  assert.match(textOfId(root, 'role-row-studio-expert_a'), /未设置/)
  assert.match(textOfId(root, 'role-row-studio-expert_a'), /未知/)

  // Blueprint 明确只读
  assert.match(textOfId(root, 'role-row-blueprint-designer'), /只读/)

  // Build 映射现有 design/dev/review 路由
  assert.match(textOfId(root, 'role-row-build-designer'), /claude-top/)
  assert.match(textOfId(root, 'role-row-build-developer'), /codex-top/)
  assert.match(textOfId(root, 'role-row-build-verifier'), /gemini-top/)
})

test('studio ui: corrupt session detail shows a retryable error, not empty data', async (t) => {
  const { home } = makeHome()
  const project = makeProject('corrupt')
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
  installFetch(makeServer({
    projects: { ok: true, default: project, projects: [{ title: 'corrupt', path: project, enabled: true, tasks: { total: 0, active: 0, last: null } }] },
    studio: async (url) => (url.indexOf('&id=') >= 0
      ? { ok: false, state: 'corrupt', error: 'session.json missing required fields' }
      : { ok: true, sessions: [{ id: 'bad', title: 'bad', status: 'corrupt', step: null, updated_at: null, open_blocking: null }], roles: {} }),
  }))
  const root = await mountCockpit()
  await settle(root)
  click(root, findById(root, 'tab-studio'))
  await settle(root)
  click(root, findById(root, 'studio-session-bad'))
  await settle(root)
  assert.ok(findById(root, 'studio-detail-error'))
  assert.ok(findById(root, 'studio-retry'))
  assert.match(textOfId(root, 'studio-detail-error'), /无法读取会话/)
})

test('studio host route: reads real sessions read-only and forwards writes as one CLI call', async (t) => {
  const { home, cliLog } = makeHome()
  const project = makeProject('host', { sessions: [studioFixture('real')] })
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
  process.env.STUDIO_FAKE_LOG = cliLog
  t.after(() => { delete process.env.STUDIO_FAKE_LOG })

  const host = await import(pathToFileURL(HOST).href + '?v=' + Date.now())
  const { ctx, routes } = makeCtx()
  host.apply(ctx, { agentlineHome: home, nodePath: process.execPath, defaultRepo: project, metricsEnabled: false })
  const cliCalls = () => fs.readFileSync(cliLog, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))

  const before = fs.readFileSync(path.join(project, '.collab', 'studio', 'real', 'session.json'), 'utf8')
  const list = await callRoute(routes, '/agentline/studio', { url: '/agentline/studio?project=' + encodeURIComponent(project) })
  assert.equal(list.status, 200)
  assert.equal(list.body.ok, true)
  assert.deepEqual(list.body.sessions.map((s) => s.id), ['real'])
  assert.equal(list.body.roles.expert_a.primary, 'claude-top')
  assert.equal(list.body.roles.scribe.tier, 'advanced')

  const detail = await callRoute(routes, '/agentline/studio', {
    url: '/agentline/studio?project=' + encodeURIComponent(project) + '&id=real',
  })
  assert.equal(detail.body.ok, true)
  assert.equal(detail.body.session.id, 'real')
  assert.equal(detail.body.g0.checks.length, 7)
  assert.equal(detail.body.state, 'ok')

  // 读取是只读的
  assert.equal(fs.readFileSync(path.join(project, '.collab', 'studio', 'real', 'session.json'), 'utf8'), before)
  assert.equal(cliCalls().length, 0)

  const unsafe = await callRoute(routes, '/agentline/studio', {
    url: '/agentline/studio?project=' + encodeURIComponent(project) + '&id=' + encodeURIComponent('../x'),
  })
  assert.equal(unsafe.status, 400)
  assert.equal(unsafe.body.ok, false)

  const missing = await callRoute(routes, '/agentline/studio', {
    url: '/agentline/studio?project=' + encodeURIComponent(project) + '&id=missing',
  })
  assert.equal(missing.body.ok, false)
  assert.equal(missing.body.state, 'missing')

  const badAction = await callRoute(routes, '/agentline/studio', {
    method: 'POST', url: '/agentline/studio', body: { project, action: 'explode', id: 'real' },
  })
  assert.equal(badAction.status, 400)
  assert.equal(cliCalls().length, 0)

  const badId = await callRoute(routes, '/agentline/studio', {
    method: 'POST', url: '/agentline/studio', body: { project, action: 'run', id: '../../etc' },
  })
  assert.equal(badId.status, 400)
  assert.equal(cliCalls().length, 0)

  const run = await callRoute(routes, '/agentline/studio', {
    method: 'POST', url: '/agentline/studio', body: { project, action: 'run', id: 'real' },
  })
  assert.equal(run.body.ok, true)
  const calls = cliCalls()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['studio', 'run', '--repo', project, '--id', 'real'])

  const answer = await callRoute(routes, '/agentline/studio', {
    method: 'POST', url: '/agentline/studio', body: { project, action: 'answer', id: 'real', question: 'Q-1', text: '只做 P6' },
  })
  assert.equal(answer.body.ok, true)
  assert.deepEqual(cliCalls()[1], ['studio', 'answer', '--repo', project, '--id', 'real', '--question', 'Q-1', '--text', '只做 P6', '--channel', 'ui'])
})

test('studio host route: a corrupt confirmation file is a read error, not ok', async (t) => {
  const { home } = makeHome()
  const project = makeProject('corrupt-confirmation', { sessions: [studioFixture('bad-conf')] })
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
  fs.writeFileSync(path.join(project, '.collab', 'studio', 'bad-conf', 'confirmations', 'expert_a.json'), '{oops', 'utf8')

  const host = await import(pathToFileURL(HOST).href + '?v=' + Date.now())
  const { ctx, routes } = makeCtx()
  host.apply(ctx, { agentlineHome: home, nodePath: process.execPath, defaultRepo: project, metricsEnabled: false })

  const list = await callRoute(routes, '/agentline/studio', {
    url: '/agentline/studio?project=' + encodeURIComponent(project),
  })
  assert.equal(list.body.ok, true)
  assert.equal(list.body.sessions[0].state, 'corrupt', '列表必须显示损坏，而不是当作缺失')

  const detail = await callRoute(routes, '/agentline/studio', {
    url: '/agentline/studio?project=' + encodeURIComponent(project) + '&id=bad-conf',
  })
  assert.equal(detail.body.ok, false)
  assert.equal(detail.body.state, 'corrupt')
  assert.match(detail.body.error, /confirmations\/expert_a\.json/)
})

test('studio host route: corrupt associated evidence is an error, not empty or ok', async (t) => {
  const { home } = makeHome()
  const project = makeProject('corrupt-evidence', { sessions: [studioFixture('bad')] })
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
  fs.writeFileSync(path.join(project, '.collab', 'studio', 'bad', 'questions.json'), '{oops', 'utf8')

  const host = await import(pathToFileURL(HOST).href + '?v=' + Date.now())
  const { ctx, routes } = makeCtx()
  host.apply(ctx, { agentlineHome: home, nodePath: process.execPath, defaultRepo: project, metricsEnabled: false })

  const list = await callRoute(routes, '/agentline/studio', {
    url: '/agentline/studio?project=' + encodeURIComponent(project),
  })
  assert.equal(list.body.ok, true)
  assert.deepEqual(list.body.sessions.map((s) => s.id), ['bad'])
  assert.equal(list.body.sessions[0].state, 'corrupt')

  const detail = await callRoute(routes, '/agentline/studio', {
    url: '/agentline/studio?project=' + encodeURIComponent(project) + '&id=bad',
  })
  assert.equal(detail.body.ok, false)
  assert.equal(detail.body.state, 'corrupt')
  assert.match(detail.body.error, /questions\.json/)

  fs.rmSync(path.join(project, '.collab', 'studio', 'bad', 'questions.json'))
  const missingEvidence = await callRoute(routes, '/agentline/studio', {
    url: '/agentline/studio?project=' + encodeURIComponent(project) + '&id=bad',
  })
  assert.equal(missingEvidence.body.ok, false)
  assert.equal(missingEvidence.body.state, 'corrupt')
  assert.match(missingEvidence.body.error, /missing/)
})

