import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, deepMerge, missingRoleSetup, validateConfig } from '../lib/config.mjs'

const tempDirs = []
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentline-config-'))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

const baseConfig = {
  configVersion: 1,
  collabDir: '.collab/tasks',
  providers: {
    claude: { source: 'anthropic', adapter: 'claude-cli', command: 'claude' },
    codex: { source: 'openai', adapter: 'codex-cli', command: 'codex' },
  },
  models: {},
  roles: {
    design: { candidates: [], effort: 'high' },
    dev: { candidates: [], effort: 'high' },
    review: { candidates: [], effort: 'high' },
  },
  policy: { handoff: true },
  effort: { default: 'high' },
}

test('deepMerge: arrays replace, objects merge', () => {
  assert.deepEqual(deepMerge({ a: [1, 2], b: { x: 1 } }, { a: [3], b: { y: 2 } }), { a: [3], b: { x: 1, y: 2 } })
})

test('loadConfig merges base + local + discovery cache', () => {
  const root = tmpDir()
  const basePath = path.join(root, 'config', 'agentline.config.json')
  const localPath = path.join(root, 'config', 'agentline.local.json')
  const modelsPath = path.join(root, 'config', 'agentline.models.json')
  writeJson(basePath, baseConfig)
  writeJson(localPath, {
    providers: { claude: { command: 'C:/tools/claude.exe' } },
    roles: { design: { candidates: ['claude-opus-x'] } },
  })
  writeJson(modelsPath, {
    version: 1,
    generatedAt: '2026-01-01T00:00:00Z',
    providers: {
      claude: { source: 'cli-scan', models: [{ id: 'claude-opus-x' }, { id: 'claude-sonnet-y' }] },
    },
  })
  const loaded = loadConfig({ orchestratorRoot: root, configPath: basePath, localPath, modelsPath, repo: root })
  assert.equal(loaded.errors.length, 0)
  assert.equal(loaded.config.providers.claude.command, 'C:/tools/claude.exe')
  assert.equal(loaded.config.models['claude-opus-x'].provider, 'claude')
  assert.equal(loaded.config.models['claude-opus-x'].source, 'cli-scan')
  assert.deepEqual(loaded.config.roles.design.candidates, ['claude-opus-x'])
  assert.deepEqual(missingRoleSetup(loaded.config), ['dev', 'review'])
})

test('user-defined models win over discovered duplicates', () => {
  const root = tmpDir()
  const basePath = path.join(root, 'config', 'agentline.config.json')
  const modelsPath = path.join(root, 'config', 'agentline.models.json')
  writeJson(basePath, {
    ...baseConfig,
    models: { 'claude-opus-x': { provider: 'claude', id: 'pinned-id' } },
  })
  writeJson(modelsPath, {
    providers: { claude: { source: 'api', models: [{ id: 'claude-opus-x' }] } },
  })
  const loaded = loadConfig({ orchestratorRoot: root, configPath: basePath, modelsPath })
  assert.equal(loaded.config.models['claude-opus-x'].id, 'pinned-id')
  assert.equal(loaded.config.models['claude-opus-x'].source, undefined)
})

test('validateConfig reports unknown model references', () => {
  const cfg = {
    ...baseConfig,
    roles: {
      design: { candidates: ['nope'], effort: 'high' },
      dev: { candidates: [], effort: 'high' },
      review: { candidates: [], effort: 'high' },
    },
  }
  const { errors } = validateConfig(cfg)
  assert.ok(errors.some((e) => e.includes('unknown model "nope"')))
})
