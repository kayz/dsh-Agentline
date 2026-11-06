import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonicalHash } from '../../orchestrator/lib/blueprint.mjs'

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
function textOf(node) {
  if (!node) return ''
  if (node.text !== undefined) return node.text
  return (node.children || []).map(textOf).join(' ')
}
function textOfId(root, id) {
  const n = findById(root, id)
  return n ? textOf(n) : ''
}
function pageText(root) { return textOf(root.tree) }
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

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-build-ui-'))
  fs.cpSync(path.join(ORCH, 'lib'), path.join(home, 'lib'), { recursive: true })
  fs.cpSync(path.join(ORCH, 'config'), path.join(home, 'config'), { recursive: true })
  fs.writeFileSync(path.join(home, 'agentline.mjs'), 'process.exit(0)\n', 'utf8')
  return home
}

function makeProject(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-build-proj-' + name + '-'))
  fs.mkdirSync(path.join(root, '.collab', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(root, '.collab', 'agentline.json'), JSON.stringify({ enabled: true }), 'utf8')
  return root
}

const NODE = {
  id: 'T-001', milestone: 'M1', title: '控制面',
  inputs: ['docs/design/agentline-v2-baseline.md'],
  outputs: ['orchestrator/lib/build.mjs'],
  depends_on: [],
  write_scope: ['orchestrator/lib/**'],
  acceptance: ['AC-001'],
  acceptance_direction: ['node --check orchestrator/lib/build.mjs'],
  test_levels: ['unit'],
  user_gate: false,
}

function writeRealTasks(root) {
  const hash = canonicalHash(NODE)
  writeJson(path.join(root, '.collab', 'blueprint', 'bp', 'state.json'), {
    schema: 'agentline.blueprint/v1',
    id: 'bp', title: 'P8', input: '实现 Build',
    status: 'approved', phase: 'review',
    round: { current: 1, max: 3 },
    roles: {
      designer: { model: 'des' },
      reviewer: { model: 'rev' },
      test_architect: { model: 'ta' },
    },
  })
  writeJson(path.join(root, '.collab', 'blueprint', 'bp', 'task-graph.json'), {
    schema: 'agentline.taskgraph/v1',
    milestones: [{ id: 'M1', title: 'Build' }],
    acceptance: [{ id: 'AC-001', text: '语法检查', levels: ['unit'] }],
    tasks: [NODE],
  })
  writeJson(path.join(root, '.collab', 'blueprint', 'bp', 'materialized.json'), {
    tasks: [
      { node: 'T-001', task: '001', node_sha256: hash },
      { node: 'T-001', task: '005', node_sha256: hash },
      { node: 'T-001', task: '006', node_sha256: hash },
      { node: 'T-001', task: '008', node_sha256: hash },
      { node: 'T-001', task: '009', node_sha256: hash },
    ],
  })
  writeJson(path.join(root, '.collab', 'blueprint', 'bp', 'approvals.json'), {
    schema: 'agentline.approvals/v1',
    items: [
      { approval_id: 'A-REV', content_hash: 'sha256:' + 'cd'.repeat(32), revoked_at: '2026-11-07T01:00:00.000Z' },
      { approval_id: 'A-EXP', content_hash: 'sha256:' + 'ef'.repeat(32) },
    ],
  })
  const task = path.join(root, '.collab', 'tasks', '001')
  writeJson(path.join(task, 'origin.json'), {
    schema: 'agentline.origin/v1', kind: 'blueprint', blueprint: 'bp', node: 'T-001',
    node_sha256: hash, g1_approval_id: 'A-1', created_at: '2026-11-07T00:00:00.000Z',
  })
  writeJson(path.join(task, 'state.json'), {
    id: '001', status: 'designed', model: 'model-a', history: [],
    counters: { business_rounds: 2, infra_retries: 1 },
  })
  fs.writeFileSync(path.join(task, 'step-ledger.jsonl'), [
    JSON.stringify({ event: 'call', role: 'dev', model_requested: 'model-a', model_resolved: 'model-a', identity_group: 'anthropic/model-a', infra: true, error: 'network error' }),
    JSON.stringify({ event: 'call', role: 'dev', model_requested: 'model-a', model_resolved: 'model-a', identity_group: 'anthropic/model-a', infra: false }),
  ].join('\n') + '\n')

  writeJson(path.join(root, '.collab', 'tasks', '002', 'state.json'), {
    id: '002', status: 'draft', history: [],
  })
  const corrupt = path.join(root, '.collab', 'tasks', '003')
  fs.mkdirSync(corrupt, { recursive: true })
  fs.writeFileSync(path.join(corrupt, 'origin.json'), '{', 'utf8')
  writeJson(path.join(root, '.collab', 'tasks', '003', 'state.json'), {
    id: '003', status: 'draft', history: [],
  })

  const changed = path.join(root, '.collab', 'tasks', '004')
  writeJson(path.join(changed, 'origin.json'), {
    schema: 'agentline.origin/v1', kind: 'blueprint', blueprint: 'bp', node: 'T-001',
    node_sha256: 'sha256:' + 'ab'.repeat(32), g1_approval_id: 'A-1', created_at: '2026-11-07T00:00:00.000Z',
  })
  writeJson(path.join(changed, 'state.json'), { id: '004', status: 'designed', history: [] })

  const revoked = path.join(root, '.collab', 'tasks', '005')
  writeJson(path.join(revoked, 'origin.json'), {
    schema: 'agentline.origin/v1', kind: 'blueprint', blueprint: 'bp', node: 'T-001',
    node_sha256: hash, g1_approval_id: 'A-REV', created_at: '2026-11-07T00:00:00.000Z',
  })
  writeJson(path.join(revoked, 'state.json'), { id: '005', status: 'designed', history: [] })

  const expired = path.join(root, '.collab', 'tasks', '006')
  writeJson(path.join(expired, 'origin.json'), {
    schema: 'agentline.origin/v1', kind: 'blueprint', blueprint: 'bp', node: 'T-001',
    node_sha256: hash, g1_approval_id: 'A-EXP', created_at: '2026-11-07T00:00:00.000Z',
  })
  writeJson(path.join(expired, 'state.json'), { id: '006', status: 'designed', history: [] })

  const disguised = path.join(root, '.collab', 'tasks', '007')
  writeJson(path.join(disguised, 'origin.json'), { kind: 'legacy' })
  writeJson(path.join(disguised, 'state.json'), { id: '007', status: 'designed', history: [] })

  writeJson(path.join(root, '.collab', 'tasks', '008', 'state.json'), { id: '008', status: 'designed', history: [] })
  writeJson(path.join(root, '.collab', 'tasks', '009', 'origin.json'), {
    schema: 'agentline.origin/v1', kind: 'adhoc', reason: 'manual',
  })
  writeJson(path.join(root, '.collab', 'tasks', '009', 'state.json'), { id: '009', status: 'designed', history: [] })
}

function makeServer(forward) {
  const server = { routes: [] }
  const reply = (prefix, fn) => server.routes.push({ prefix, fn })
  reply('/agentline/pipeline', forward.pipeline)
  reply('/agentline/tasks', forward.tasks)
  reply('/agentline/task', forward.task)
  reply('/agentline/projects', async () => forward.projects)
  reply('/agentline/metrics', async () => ({ ok: true, records: [] }))
  reply('/agentline/summary', async () => ({ ok: true, running: [], prOpen: [], blocked: [], records: [] }))
  reply('/agentline/notices', async () => ({ ok: true, notices: [] }))
  reply('/agentline/live', async () => ({ ok: true, running: [] }))
  reply('/agentline/catalog', async () => ({ ok: true, catalog: { models: [] }, discovery: null }))
  reply('/agentline/models', async () => ({ ok: true, models: [], roles: { design: [], dev: [], review: [] } }))
  reply('/agentline/routing', async () => ({
    ok: true, models: [],
    roles: {
      design: { model: 'claude-top', order: ['claude-top'] },
      dev: { model: 'codex-top', order: ['codex-top'] },
      review: { model: 'gemini-top', order: ['gemini-top'] },
    },
    routing: {},
  }))
  reply('/agentline/merge', async () => ({ ok: true, output: '' }))
  reply('/agentline/control', async () => ({ ok: true }))
  reply('/agentline/flow', async () => ({ ok: true }))
  reply('/agentline/studio', async () => ({ ok: true, sessions: [], roles: {} }))
  reply('/agentline/blueprint', async () => ({ ok: true, sessions: [], roles: {} }))
  server.routes.sort((a, b) => b.prefix.length - a.prefix.length)
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
  const host = await import(pathToFileURL(HOST).href + '?build=' + (++hostSerial))
  const { ctx, routes } = makeCtx()
  host.apply(ctx, { agentlineHome: home, nodePath: process.execPath, defaultRepo: project, metricsEnabled: false })
  assert.ok(routes.has('/agentline/pipeline'))
  assert.ok(routes.has('/agentline/tasks'))
  assert.ok(routes.has('/agentline/task'))
  const forwardOne = (routePath) => async (url, method, opts) => {
    const body = method === 'POST' ? JSON.parse(opts.body || '{}') : undefined
    const r = await callRoute(routes, routePath, { method, url, body })
    return r.body
  }
  return {
    pipeline: forwardOne('/agentline/pipeline'),
    tasks: forwardOne('/agentline/tasks'),
    task: forwardOne('/agentline/task'),
  }
}

function projectsOf(list, fallback) {
  return { ok: true, default: fallback, projects: list }
}

test.describe('build ui', { concurrency: 1 }, () => {
  test('empty project shows 暂无任务 and no sample gate', async (t) => {
    const home = makeHome()
    const project = makeProject('empty')
    t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
    const forward = await boot(home, project)
    installFetch(makeServer({
      ...forward,
      projects: projectsOf([{ title: 'empty', path: project, enabled: true, tasks: { total: 0, active: 0, last: null } }], project),
    }))
    const root = await mountCockpit()
    await settle(root)
    click(root, findById(root, 'tab-build'))
    await settle(root)
    assert.ok(findById(root, 'build-empty'))
    assert.match(textOfId(root, 'build-empty'), /暂无任务/)
    assert.equal(findById(root, 'build-error'), null)
    assert.equal(findById(root, 'build-item-001'), null)
    assert.doesNotMatch(pageText(root), /未实现/)
  })

  test('real, legacy and corrupt tasks render facts, and the old tabs stay available', async (t) => {
    const home = makeHome()
    const project = makeProject('real')
    const empty = makeProject('other')
    writeRealTasks(project)
    t.after(() => {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(project, { recursive: true, force: true })
      fs.rmSync(empty, { recursive: true, force: true })
    })
    const forward = await boot(home, project)
    installFetch(makeServer({
      ...forward,
      projects: projectsOf([
        { title: 'real', path: project, enabled: true, tasks: { total: 3, active: 1, last: 'designed' } },
        { title: 'other', path: empty, enabled: true, tasks: { total: 0, active: 0, last: null } },
      ], project),
    }))
    const root = await mountCockpit()
    await settle(root)
    click(root, findById(root, 'tab-build'))
    await settle(root)
    assert.match(textOfId(root, 'build-row-001'), /Blueprint/)
    assert.match(textOfId(root, 'build-row-001'), /unit/)
    assert.match(textOfId(root, 'build-row-001'), /model-a/)
    assert.match(textOfId(root, 'build-row-002'), /旧任务/)
    assert.match(textOfId(root, 'build-row-002'), /未知/)
    assert.match(textOfId(root, 'build-row-003'), /错误/)
    assert.match(textOfId(root, 'build-row-004'), /Blueprint/)
    assert.doesNotMatch(textOfId(root, 'build-row-004'), /旧任务/)
    assert.match(textOfId(root, 'build-row-005'), /Blueprint/)
    assert.doesNotMatch(textOfId(root, 'build-row-005'), /旧任务/)
    assert.match(textOfId(root, 'build-row-006'), /Blueprint/)
    assert.doesNotMatch(textOfId(root, 'build-row-006'), /旧任务/)
    assert.match(textOfId(root, 'build-row-007'), /错误/)
    assert.doesNotMatch(textOfId(root, 'build-row-007'), /旧任务/)
    assert.match(textOfId(root, 'build-row-008'), /错误/)
    assert.doesNotMatch(textOfId(root, 'build-row-008'), /旧任务/)
    assert.match(textOfId(root, 'build-row-009'), /错误/)
    assert.doesNotMatch(textOfId(root, 'build-row-009'), /旧任务/)
    assert.doesNotMatch(textOfId(root, 'build-row-009'), /独立/)
    assert.doesNotMatch(pageText(root), /未实现/)

    click(root, findById(root, 'build-item-001'))
    await settle(root)
    assert.match(textOfId(root, 'build-source'), /来源：Blueprint/)
    assert.match(textOfId(root, 'build-levels'), /测试层级：unit/)
    assert.match(textOfId(root, 'build-status'), /状态：designed/)
    assert.match(textOfId(root, 'build-model'), /模型：model-a/)
    assert.match(textOfId(root, 'build-business'), /业务轮次：2/)
    assert.match(textOfId(root, 'build-infra'), /基础设施重试：1/)
    assert.match(textOfId(root, 'build-gate'), /T gate：不通过/)
    assert.match(textOfId(root, 'build-check-T.origin_valid'), /失败/)
    assert.match(textOfId(root, 'build-check-T.ci_all_pass'), /未知/)
    assert.ok(findById(root, 'task-stop'))

    click(root, findById(root, 'build-item-002'))
    await settle(root)
    assert.match(textOfId(root, 'build-source'), /来源：旧任务/)
    assert.match(textOfId(root, 'build-levels'), /测试层级：未知/)
    assert.match(textOfId(root, 'build-model'), /模型：未知/)
    assert.match(textOfId(root, 'build-business'), /业务轮次：未知/)
    assert.match(textOfId(root, 'build-infra'), /基础设施重试：未知/)

    click(root, findById(root, 'build-item-003'))
    await settle(root)
    assert.match(textOfId(root, 'build-task-error'), /来源损坏/)

    click(root, findById(root, 'build-item-004'))
    await settle(root)
    assert.match(textOfId(root, 'build-source'), /来源：Blueprint/)
    assert.doesNotMatch(textOfId(root, 'build-source'), /旧任务/)
    assert.match(textOfId(root, 'build-check-T.origin_valid'), /失败/)

    click(root, findById(root, 'build-item-005'))
    await settle(root)
    assert.match(textOfId(root, 'build-source'), /来源：Blueprint/)
    assert.doesNotMatch(textOfId(root, 'build-source'), /旧任务/)
    assert.match(textOfId(root, 'build-check-T.origin_valid'), /过期/)

    click(root, findById(root, 'build-item-006'))
    await settle(root)
    assert.match(textOfId(root, 'build-source'), /来源：Blueprint/)
    assert.doesNotMatch(textOfId(root, 'build-source'), /旧任务/)
    assert.match(textOfId(root, 'build-check-T.origin_valid'), /过期/)

    click(root, findById(root, 'build-item-007'))
    await settle(root)
    assert.match(textOfId(root, 'build-task-error'), /来源损坏/)
    assert.equal(findById(root, 'build-source'), null)

    click(root, findById(root, 'build-item-008'))
    await settle(root)
    assert.match(textOfId(root, 'build-task-error'), /来源损坏/)
    assert.equal(findById(root, 'build-source'), null)

    click(root, findById(root, 'build-item-009'))
    await settle(root)
    assert.match(textOfId(root, 'build-task-error'), /来源损坏/)
    assert.equal(findById(root, 'build-source'), null)

    click(root, findById(root, 'tab-home'))
    await settle(root)
    assert.match(pageText(root), /现在卡在哪/)
    click(root, findById(root, 'tab-studio'))
    await settle(root)
    assert.ok(findById(root, 'studio-empty'))
    click(root, findById(root, 'tab-blueprint'))
    await settle(root)
    assert.ok(findById(root, 'blueprint-empty'))
    click(root, findById(root, 'tab-settings'))
    await settle(root)
    assert.match(pageText(root), /角色路由/)

    click(root, findById(root, 'tab-build'))
    await settle(root)
    change(root, findById(root, 'project-select'), empty)
    await settle(root)
    assert.ok(findById(root, 'build-empty'))
    assert.match(textOfId(root, 'build-empty'), /暂无任务/)
    assert.equal(findById(root, 'build-row-001'), null)
    change(root, findById(root, 'project-select'), project)
    await settle(root)
    assert.match(textOfId(root, 'build-row-001'), /Blueprint/)
  })

  test('a tasks path that is not a directory is an error, and retry reads the pipeline again', async (t) => {
    const home = makeHome()
    const project = makeProject('bad')
    fs.rmSync(path.join(project, '.collab', 'tasks'), { recursive: true, force: true })
    fs.writeFileSync(path.join(project, '.collab', 'tasks'), 'not-a-directory', 'utf8')
    t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
    const forward = await boot(home, project)
    installFetch(makeServer({
      ...forward,
      projects: projectsOf([{ title: 'bad', path: project, enabled: true, tasks: { total: 0, active: 0, last: null } }], project),
    }))
    const root = await mountCockpit()
    await settle(root)
    click(root, findById(root, 'tab-build'))
    await settle(root)
    assert.ok(findById(root, 'build-error'))
    assert.match(textOfId(root, 'build-error'), /错误/)
    assert.equal(findById(root, 'build-empty'), null)
    assert.doesNotMatch(textOfId(root, 'build-error'), /暂无任务/)
    const before = fetchCalls.filter((call) => call.url.includes('/agentline/pipeline')).length
    assert.ok(before >= 1)
    click(root, findById(root, 'build-retry'))
    await settle(root)
    const after = fetchCalls.filter((call) => call.url.includes('/agentline/pipeline')).length
    assert.ok(after > before)
    assert.ok(findById(root, 'build-error'))
  })

  test('a committed acceptance command change is not a passing CI gate', async (t) => {
    const home = makeHome()
    const project = makeProject('cmd')
    t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
    const git = (args, env) => execFileSync('git', args, { cwd: project, encoding: 'utf8', env: env || process.env })
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    fs.writeFileSync(path.join(project, 'README.md'), '# repo\n', 'utf8')
    git(['add', '-A'])
    git(['commit', '-qm', 'init'])
    const task = path.join(project, '.collab', 'tasks', '001')
    fs.mkdirSync(task, { recursive: true })
    writeJson(path.join(task, 'state.json'), { id: '001', status: 'reviewable', history: [] })
    const ranAtMs = Date.now() + 5000
    const acceptance = (command) => ['AC-1', 'AC-2'].map((id) => [
      `## ${id} ${id}`,
      '',
      '```pwsh',
      command(id),
      '```',
      '',
      `期望：${id} OK`,
      '',
    ].join('\n')).join('\n')
    fs.writeFileSync(path.join(task, 'acceptance.md'), acceptance((id) => `Write-Output '${id} OK'`), 'utf8')
    writeJson(path.join(task, 'ci-results.json'), {
      ranAt: new Date(ranAtMs).toISOString(),
      passed: 2,
      total: 2,
      ok: true,
      results: [
        { id: 'AC-1', passed: true, exitCode: 0, lastLine: 'AC-1 OK' },
        { id: 'AC-2', passed: true, exitCode: 0, lastLine: 'AC-2 OK' },
      ],
    })
    git(['add', '-A'])
    git(['commit', '-qm', 'report'])
    fs.writeFileSync(path.join(task, 'acceptance.md'), acceptance((id) => `Write-Output 'changed ${id}'`), 'utf8')
    git(['add', '-A'])
    git(['commit', '-qm', 'rewrite command'], {
      ...process.env,
      GIT_AUTHOR_DATE: new Date(ranAtMs + 10_000).toISOString(),
      GIT_COMMITTER_DATE: new Date(ranAtMs + 10_000).toISOString(),
    })
    const forward = await boot(home, project)
    installFetch(makeServer({
      ...forward,
      projects: projectsOf([{ title: 'cmd', path: project, enabled: true, tasks: { total: 1, active: 1, last: 'reviewable' } }], project),
    }))
    const root = await mountCockpit()
    await settle(root)
    click(root, findById(root, 'tab-build'))
    await settle(root)
    assert.match(textOfId(root, 'build-row-001'), /旧任务/)
    click(root, findById(root, 'build-item-001'))
    await settle(root)
    assert.match(textOfId(root, 'build-check-T.ci_all_pass'), /过期/)
    assert.doesNotMatch(textOfId(root, 'build-check-T.ci_all_pass'), /通过/)
    assert.match(textOfId(root, 'build-gate'), /不通过/)
  })

  test('a task recorded on main stays an error when the worktree record is damaged', async (t) => {
    const home = makeHome()
    const project = makeProject('mainrec')
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-build-ui-wt-'))
    const wt = path.join(parent, 'wt')
    t.after(() => {
      try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: project, stdio: 'ignore' }) } catch { /* 目录随后删掉 */ }
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(project, { recursive: true, force: true })
      fs.rmSync(parent, { recursive: true, force: true })
    })
    const git = (args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' })
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    fs.writeFileSync(path.join(project, 'README.md'), '# repo\n', 'utf8')
    git(['add', 'README.md'])
    git(['commit', '-qm', 'init'])
    writeJson(path.join(project, '.collab', 'blueprint', 'bp', 'materialized.json'), {
      tasks: [{ node: 'T-001', task: '001', node_sha256: 'sha256:' + 'ab'.repeat(32) }],
    })
    git(['worktree', 'add', '-b', 'task/001', wt, 'main'])
    writeJson(path.join(wt, '.collab', 'tasks', '001', 'state.json'), {
      id: '001', status: 'designed', history: [],
    })
    fs.mkdirSync(path.join(wt, '.collab', 'blueprint', 'bp'), { recursive: true })
    fs.writeFileSync(path.join(wt, '.collab', 'blueprint', 'bp', 'materialized.json'), '{', 'utf8')

    const forward = await boot(home, wt)
    installFetch(makeServer({
      ...forward,
      projects: projectsOf([{ title: 'wt', path: wt, enabled: true, tasks: { total: 1, active: 1, last: 'designed' } }], wt),
    }))
    const root = await mountCockpit()
    await settle(root)
    click(root, findById(root, 'tab-build'))
    await settle(root)
    assert.match(textOfId(root, 'build-row-001'), /错误/)
    assert.doesNotMatch(textOfId(root, 'build-row-001'), /旧任务/)
    click(root, findById(root, 'build-item-001'))
    await settle(root)
    assert.match(textOfId(root, 'build-task-error'), /来源损坏/)
    assert.equal(findById(root, 'build-source'), null)
  })
})
