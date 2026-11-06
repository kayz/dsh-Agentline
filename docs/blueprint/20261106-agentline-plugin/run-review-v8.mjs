import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const dir = 'C:/git/dsh-Agentline/docs/blueprint/20261106-agentline-plugin'
const prompt = fs.readFileSync(path.join(dir, 'review-prompt-v8.md'), 'utf8')
const codexJs = 'C:/Users/kayz/AppData/Local/Programs/nodejs/node_modules/@openai/codex/bin/codex.js'
const out = path.join(dir, 'review-v8.md')
const r = spawnSync(process.execPath, [codexJs, 'exec', '--model', 'gpt-6-astra', '-s', 'read-only', '--skip-git-repo-check', '-o', out], {
  cwd: 'C:/git/dsh-Agentline', input: prompt, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 25 * 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
})
fs.writeFileSync(path.join(dir, 'review-v8.raw.txt'), String(r.stdout || '') + '\n--- STDERR ---\n' + String(r.stderr || ''), 'utf8')
console.log('exit', r.status, r.error?.message || '', fs.existsSync(out))
