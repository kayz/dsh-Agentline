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
      try { out = inst.render() } catch (e) {
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
    try { out = type(withChildren) } finally { hookHost = prevHost }
    return renderNode(out, key + '/r', root)
  }
  return { type, props, children: children.map((c, i) => renderNode(c, keyPath + '/' + i, root)).filter(Boolean) }
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
      } catch { /* ignore */ }
    }
  }
  root.flush = () => {
    let guard = 0
    while (root.dirty && guard < 40) { root.dirty = false; renderPass(); guard++ }
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
function delay(ms) { return new Promise((r) => setTimeout(r, ms)) }
async function settle(root, rounds = 200) {
  for (let i = 0; i < rounds; i++) {
    root.flush()
    if (fetchInflight === 0 && !root.dirty) {
      await delay(0)
      root.flush()
      if (fetchInflight === 0 && !root.dirty) return
    }
    await delay(fetchInflight > 0 ? 25 : 0)
  }
  root.flush()
}

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-bp-ui-'))
  fs.cpSync(path.join(ORCH, 'lib'), path.join(home, 'lib'), { recursive: true })
  fs.cpSync(path.join(ORCH, 'config'), path.join(home, 'config'), { recursive: true })
  fs.writeFileSync(path.join(home, 'agentline.mjs'), FIXTURE_CLI, 'utf8')
  const cliLog = path.join(home, 'cli.jsonl')
  fs.writeFileSync(cliLog, '', 'utf8')
  return { home, cliLog }
}

function makeProject(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-bp-proj-' + name + '-'))
  fs.mkdirSync(path.join(root, '.collab', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(root, '.collab', 'agentline.json'), JSON.stringify({ enabled: true }), 'utf8')
  return root
}

function blueprintSession(id, title) {
  return {
    'state.json': {
      schema: 'agentline.blueprint/v1',
      id, title, input: '实现 Blueprint 控制面',
      from: null,
      status: 'running',
      phase: 'review',
      round: { current: 1, max: 3 },
      roles: {
        designer: { model: 'des', id: 'claude-des', tier: 'top', vendor: 'anthropic', identity: 'verified' },
        reviewer: { model: 'rev', id: 'codex-rev', tier: 'top', vendor: 'openai', identity: 'verified' },
        test_architect: { model: 'ta', id: 'buddy-ta', tier: 'top', vendor: 'tencent', identity: 'verified' },
      },
      awaiting: null,
      last_error: null,
      calls: [],
      created_at: '2026-11-07T00:00:00.000Z',
      updated_at: '2026-11-07T01:00:00.000Z',
      revision: 4,
    },
    'task-graph.json': {
      schema: 'agentline.taskgraph/v1',
      milestones: [{ id: 'M1', title: 'Blueprint' }],
      acceptance: [{ id: 'AC-001', text: '插件语法检查输出 AC-1 OK', levels: ['unit'] }],
      tasks: [{
        id: 'T-001', milestone: 'M1', title: '控制面',
        inputs: ['docs/design/agentline-v2-baseline.md'],
        outputs: ['orchestrator/lib/blueprint.mjs'],
        depends_on: [],
        write_scope: ['orchestrator/lib/**'],
        acceptance: ['AC-001'],
        acceptance_direction: ['node --check orchestrator/lib/blueprint.mjs'],
        test_levels: ['unit'],
      }],
    },
    'review-v1.verdict.json': {
      round: 1,
      reviewer: { model: 'rev', id: 'codex-rev', model_resolved: 'codex-rev', identity: 'verified', vendor: 'openai' },
      input_digests: {},
      verdict: 'revise',
      findings: [{ id: 'F-07', severity: 'major', status: 'open', text: '任务图还缺一条验收' }],
    },
  }
}

function writeBlueprint(root, id, files) {
  const dir = path.join(root, '.collab', 'blueprint', id)
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, data] of Object.entries(files)) {
    const file = path.join(dir, name)
    if (typeof data === 'string') fs.writeFileSync(file, data, 'utf8')
    else writeJson(file, data)
  }
}

function makeServer(blueprint, overrides = {}) {
  const server = { routes: [] }
  const reply = (prefix, fn) => server.routes.push({ prefix, fn })
  reply('/agentline/blueprint', blueprint)
  reply('/agentline/projects', async () => overrides.projects || { ok: true, default: '', projects: [] })
  reply('/agentline/tasks', async () => overrides.tasks || { ok: true, tasks: [], tokens: { total: { input: 0, output: 0 } } })
  reply('/agentline/metrics', async () => ({ ok: true, records: [] }))
  reply('/agentline/summary', async () => overrides.summary || { ok: true, running: [], prOpen: [], blocked: [], records: [] })
  reply('/agentline/notices', async () => ({ ok: true, notices: [] }))
  reply('/agentline/live', async () => ({ ok: true, running: [] }))
  reply('/agentline/pipeline', async () => ({ ok: true, summary: { stages: { studio: { status: 'idle', sessions: [] }, blueprint: { status: 'not_started', sessions: [] } }, tasks: [] } }))
  reply('/agentline/task', async () => overrides.task || { ok: true, task: '001', state: { status: 'blocked', blocked_reason: 'awaiting_human' }, logs: [], runs: [], attention: { question: '要不要继续？' }, stepLedger: [] })
  reply('/agentline/catalog', async () => ({ ok: true, catalog: { models: [] }, discovery: null }))
  reply('/agentline/models', async () => ({ ok: true, models: [], roles: { design: [], dev: [], review: [] } }))
  reply('/agentline/routing', async () => ({ ok: true, models: [], roles: { design: { model: 'claude-top', order: ['claude-top'] }, dev: { model: 'codex-top', order: ['codex-top'] }, review: { model: 'gemini-top', order: ['gemini-top'] } }, routing: {} }))
  reply('/agentline/merge', async () => ({ ok: true, output: '' }))
  reply('/agentline/control', async () => ({ ok: true }))
  reply('/agentline/flow', async () => ({ ok: true }))
  reply('/agentline/studio', async () => ({ ok: true, sessions: [], roles: {} }))
  return server
}

let fetchCalls = []
let fetchInflight = 0
function installFetch(server) {
  fetchCalls = []
  fetchInflight = 0
  globalThis.fetch = async (url, opts = {}) => {
    fetchInflight++
    try {
      const u = String(url)
      fetchCalls.push({ url: u, method: (opts.method || 'GET').toUpperCase(), body: opts.body ? JSON.parse(opts.body) : null })
      let payload = { ok: true }
      for (const r of server.routes) {
        if (u.indexOf(r.prefix) === 0) { payload = await r.fn(u, (opts.method || 'GET').toUpperCase(), opts); break }
      }
      return { status: (payload && payload.__status) || 200, json: async () => payload }
    } finally { fetchInflight-- }
  }
}

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
let hostSerial = 0

async function loadClient() {
  if (clientModule) return clientModule
  globalThis.window = windowStub
  globalThis.document = documentStub
  windowStub.__ModuleLoader__ = {
    load: ({ factory }) => { clientModule = factory((name) => (name === 'react' ? ReactStub : {})) },
  }
  await import(pathToFileURL(CLIENT).href)
  const ctx = { slots: { inject: (name, fn) => { fn() }, register: (spec, Comp) => { if (spec && spec.name === 'main') registeredMain = Comp; return () => {} } } }
  clientModule.apply(ctx)
  assert.ok(registeredMain, 'main slot registered')
  return clientModule
}

async function mountCockpit() {
  await loadClient()
  localStorageData.clear()
  return mount(ReactStub.createElement(registeredMain, {}))
}

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
  return { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(payload) { this.body = payload } }
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

async function boot(home, project) {
  const host = await import(pathToFileURL(HOST).href + '?bp=' + (++hostSerial))
  const { ctx, routes } = makeCtx()
  host.apply(ctx, { agentlineHome: home, nodePath: process.execPath, defaultRepo: project, metricsEnabled: false })
  assert.ok(routes.has('/agentline/blueprint'))
  const forward = async (url, method, opts) => {
    const body = method === 'POST' ? JSON.parse(opts.body || '{}') : undefined
    const r = await callRoute(routes, '/agentline/blueprint', { method, url, body })
    return r.body
  }
  return { routes, forward }
}

test.describe('blueprint ui', { concurrency: 1 }, () => {
  test('empty project is an empty state, not an error or a sample', async (t) => {
    const { home } = makeHome()
    const project = makeProject('empty')
    t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
    const { forward } = await boot(home, project)
    installFetch(makeServer(forward, {
      projects: { ok: true, default: project, projects: [{ title: 'empty', path: project, enabled: true, tasks: { total: 0, active: 0, last: null } }] },
    }))
    const root = await mountCockpit()
    await settle(root)
    click(root, findById(root, 'tab-blueprint'))
    await settle(root)
    assert.ok(findById(root, 'blueprint-empty'))
    assert.match(textOfId(root, 'blueprint-empty'), /还没有 Blueprint 会话/)
    assert.equal(findById(root, 'blueprint-error'), null)
    assert.equal(findById(root, 'finding-F-07'), null)
    assert.equal(findById(root, 'task-T-001'), null)
  })

  test('a real session renders rounds, roles, findings, the task graph and G1', async (t) => {
    const { home } = makeHome()
    const project = makeProject('real')
    writeBlueprint(project, 'bp-real', blueprintSession('bp-real', '真实蓝图'))
    t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
    const { forward } = await boot(home, project)
    installFetch(makeServer(forward, {
      projects: { ok: true, default: project, projects: [{ title: 'real', path: project, enabled: true, tasks: { total: 0, active: 0, last: null } }] },
    }))
    const root = await mountCockpit()
    await settle(root)
    click(root, findById(root, 'tab-blueprint'))
    await settle(root)
    assert.ok(findById(root, 'blueprint-session-bp-real'))
    click(root, findById(root, 'blueprint-session-bp-real'))
    await settle(root)
    assert.match(textOfId(root, 'blueprint-round'), /第 1\/3 轮/)
    assert.match(textOfId(root, 'blueprint-round'), /评审/)
    assert.match(textOfId(root, 'blueprint-role-designer'), /anthropic/)
    assert.match(textOfId(root, 'finding-F-07'), /任务图还缺一条验收/)
    assert.match(textOfId(root, 'task-T-001'), /控制面/)
    assert.match(textOfId(root, 'task-T-001'), /orchestrator\/lib\/\*\*/)
    assert.ok(findById(root, 'g1-G1.graph_schema'))
    assert.ok(findById(root, 'g1-G1.studio_link'))
    assert.match(textOfId(root, 'blueprint-approval'), /未批准/)
    assert.equal(findById(root, 'blueprint-approve').props.disabled, true)
    assert.equal(findById(root, 'blueprint-materialize').props.disabled, true)
    assert.equal(findById(root, 'blueprint-detail-error'), null)
  })

  test('corrupt session detail is an error that can be retried, not an empty list', async (t) => {
    const { home } = makeHome()
    const project = makeProject('bad')
    writeBlueprint(project, 'bad', { 'state.json': '{' })
    t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
    const { forward } = await boot(home, project)
    installFetch(makeServer(forward, {
      projects: { ok: true, default: project, projects: [{ title: 'bad', path: project, enabled: true, tasks: { total: 0, active: 0, last: null } }] },
    }))
    const root = await mountCockpit()
    await settle(root)
    click(root, findById(root, 'tab-blueprint'))
    await settle(root)
    assert.ok(findById(root, 'blueprint-session-bad'))
    assert.equal(findById(root, 'blueprint-empty'), null)
    click(root, findById(root, 'blueprint-session-bad'))
    await settle(root)
    assert.ok(findById(root, 'blueprint-detail-error'))
    assert.match(textOfId(root, 'blueprint-detail-error'), /无法读取会话/)
    assert.ok(findById(root, 'blueprint-retry'))
    assert.equal(findById(root, 'finding-F-07'), null)
  })

  test('a failed list read inside a valid project is an error, distinct from an empty project', async (t) => {
    const { home } = makeHome()
    const project = makeProject('blocked')
    const blueprintRoot = path.join(project, '.collab', 'blueprint')
    fs.writeFileSync(blueprintRoot, 'not-a-directory', 'utf8')
    t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
    const { routes, forward } = await boot(home, project)
    const listed = await callRoute(routes, '/agentline/blueprint', {
      url: '/agentline/blueprint?project=' + encodeURIComponent(project),
    })
    assert.equal(listed.status, 500)
    assert.equal(listed.body.ok, false)
    assert.match(listed.body.error, /is not a directory/)
    assert.doesNotMatch(listed.body.error, /project not found/)
    installFetch(makeServer(forward, {
      projects: { ok: true, default: project, projects: [{ title: 'blocked', path: project, enabled: true, tasks: { total: 0, active: 0, last: null } }] },
    }))
    const root = await mountCockpit()
    await settle(root)
    click(root, findById(root, 'tab-blueprint'))
    await settle(root)
    assert.ok(findById(root, 'blueprint-error'))
    assert.match(textOfId(root, 'blueprint-error'), /无法读取 Blueprint 会话/)
    assert.match(textOfId(root, 'blueprint-error'), /is not a directory/)
    assert.doesNotMatch(textOfId(root, 'blueprint-error'), /project not found/)
    assert.ok(findById(root, 'blueprint-retry-list'))
    assert.equal(findById(root, 'blueprint-empty'), null)
    click(root, findById(root, 'blueprint-retry-list'))
    await settle(root)
    assert.ok(findById(root, 'blueprint-error'))
    assert.equal(findById(root, 'blueprint-empty'), null)
  })

  test('switching projects re-reads that project’s blueprint sessions', async (t) => {
    const { home } = makeHome()
    const projectA = makeProject('a')
    const projectB = makeProject('b')
    writeBlueprint(projectA, 'bp-a', blueprintSession('bp-a', '项目 A'))
    writeBlueprint(projectB, 'bp-b', blueprintSession('bp-b', '项目 B'))
    t.after(() => {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(projectA, { recursive: true, force: true })
      fs.rmSync(projectB, { recursive: true, force: true })
    })
    const { forward } = await boot(home, projectA)
    installFetch(makeServer(forward, {
      projects: {
        ok: true, default: projectA, projects: [
          { title: 'A', path: projectA, enabled: true, tasks: { total: 0, active: 0, last: null } },
          { title: 'B', path: projectB, enabled: true, tasks: { total: 0, active: 0, last: null } },
        ],
      },
    }))
    const root = await mountCockpit()
    await settle(root)
    click(root, findById(root, 'tab-blueprint'))
    await settle(root)
    assert.ok(findById(root, 'blueprint-session-bp-a'))
    assert.equal(findById(root, 'blueprint-session-bp-b'), null)
    change(root, findById(root, 'project-select'), projectB)
    await settle(root)
    click(root, findById(root, 'tab-blueprint'))
    await settle(root)
    assert.equal(findById(root, 'blueprint-session-bp-a'), null)
    assert.ok(findById(root, 'blueprint-session-bp-b'))
  })

  test('each blueprint action forwards one CLI, and a failure shows the reason once', async (t) => {
    const { home, cliLog } = makeHome()
    const project = makeProject('ops')
    writeBlueprint(project, 'bp-real', blueprintSession('bp-real', '真实蓝图'))
    t.after(() => {
      delete process.env.STUDIO_FAKE_LOG
      delete process.env.STUDIO_FAKE_FAIL
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(project, { recursive: true, force: true })
    })
    process.env.STUDIO_FAKE_LOG = cliLog
    const { forward } = await boot(home, project)
    installFetch(makeServer(forward, {
      projects: { ok: true, default: project, projects: [{ title: 'ops', path: project, enabled: true, tasks: { total: 0, active: 0, last: null } }] },
    }))
    const root = await mountCockpit()
    await settle(root)
    click(root, findById(root, 'tab-blueprint'))
    await settle(root)
    click(root, findById(root, 'blueprint-session-bp-real'))
    await settle(root)

    const cliCalls = () => fs.readFileSync(cliLog, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    const posted = () => fetchCalls.filter((c) => c.method === 'POST' && c.url.indexOf('/agentline/blueprint') === 0)

    click(root, findById(root, 'blueprint-run'))
    await settle(root)
    assert.equal(posted().length, 1)
    assert.equal(posted()[0].body.action, 'run')
    assert.equal(posted()[0].body.id, 'bp-real')
    assert.equal(cliCalls().length, 1)
    assert.deepEqual(cliCalls()[0].slice(0, 2), ['blueprint', 'run'])
    assert.ok(cliCalls()[0].includes(project))
    assert.ok(cliCalls()[0].includes('bp-real'))
    assert.match(textOfId(root, 'blueprint-msg'), /已提交/)

    click(root, findById(root, 'blueprint-review'))
    await settle(root)
    assert.equal(posted().length, 2)
    assert.equal(posted()[1].body.action, 'review')
    assert.equal(cliCalls().length, 2)
    assert.deepEqual(cliCalls()[1].slice(0, 2), ['blueprint', 'review'])

    change(root, findById(root, 'blueprint-new-id'), 'bp-new')
    change(root, findById(root, 'blueprint-new-title'), '新建')
    change(root, findById(root, 'blueprint-new-input'), '再开一轮')
    click(root, findById(root, 'blueprint-new-submit'))
    await settle(root)
    assert.equal(posted().length, 3)
    assert.equal(posted()[2].body.action, 'new')
    assert.equal(posted()[2].body.id, 'bp-new')
    assert.equal(cliCalls().length, 3)
    assert.deepEqual(cliCalls()[2].slice(0, 2), ['blueprint', 'new'])
    assert.ok(cliCalls()[2].includes('--input'))

    click(root, findById(root, 'blueprint-session-bp-real'))
    await settle(root)
    process.env.STUDIO_FAKE_FAIL = '1'
    const before = cliCalls().length
    click(root, findById(root, 'blueprint-run'))
    await settle(root)
    assert.equal(cliCalls().length, before + 1)
    assert.equal(posted().length, 4)
    assert.match(textOfId(root, 'blueprint-msg'), /操作失败/)
    assert.match(textOfId(root, 'blueprint-msg'), /fake cli failure/)
    delete process.env.STUDIO_FAKE_FAIL
  })

  test('five tabs, Studio, Build, portfolio and the read-only blueprint matrix stay in place', async (t) => {
    const { home } = makeHome()
    const project = makeProject('legacy')
    t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
    const { forward } = await boot(home, project)
    installFetch(makeServer(forward, {
      projects: { ok: true, default: project, projects: [{ title: 'legacy', path: project, enabled: true, tasks: { total: 1, active: 1, last: 'blocked' } }] },
      tasks: { ok: true, tasks: [{ id: '001', state: { id: '001', status: 'blocked', blocked_reason: 'awaiting_human' } }], tokens: { total: { input: 0, output: 0 } } },
      summary: { ok: true, running: [], prOpen: [], blocked: [{ project: 'legacy', projectPath: project, task: '001', reason: 'awaiting_human' }], records: [] },
    }))
    const root = await mountCockpit()
    await settle(root)
    assert.equal(findAllById(root, 'tab-').length, 6)
    const tabText = ['home', 'studio', 'blueprint', 'build', 'models', 'settings'].map((id) => textOfId(root, 'tab-' + id))
    assert.match(tabText[0], /^首页/)
    assert.deepEqual(tabText.slice(1), ['Studio', 'Blueprint', 'Build', '模型', '设置'])
    assert.match(textOf(root.tree), /项目组合/)

    click(root, findById(root, 'tab-studio'))
    await settle(root)
    assert.ok(findById(root, 'studio-empty'))

    click(root, findById(root, 'tab-build'))
    await settle(root)
    assert.ok(findById(root, 'task-stop'))
    assert.ok(findById(root, 'task-stop-now'))

    click(root, findById(root, 'tab-settings'))
    await settle(root)
    assert.match(textOfId(root, 'role-row-blueprint-designer'), /只读/)

    click(root, findById(root, 'tab-blueprint'))
    await settle(root)
    assert.ok(findById(root, 'blueprint-empty'))
  })
})

