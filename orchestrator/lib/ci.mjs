import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 调 spec/tools/ci-runner.ps1 执行 acceptance.md，返回结构化结果。
 * CI 是 reviewable 状态的唯一裁决者。
 */
export async function runCI({ repo, taskDirRel, runnerPath, outPath, timeoutMs = 3_600_000 }) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-File', runnerPath,
      '-RepoRoot', repo,
      '-TaskDir', taskDirRel,
      '-OutFile', outPath]
    const child = spawn('pwsh', args, { cwd: repo, windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
    }, timeoutMs)

    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, exitCode: -1, out, err: e.message, summary: null }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      let summary = null
      try { summary = JSON.parse(fs.readFileSync(outPath, 'utf8')) } catch { /* ignore */ }
      resolve({ ok: code === 0 && summary?.ok === true, exitCode: code, out, err, summary })
    })
  })
}

export function ciRecord(result, taskDirRel, repo, runnerPath = null) {
  const rel = path.relative(repo, path.join(repo, taskDirRel)).replaceAll('\\', '/')
  return {
    runner: runnerPath ? path.basename(runnerPath) : 'ci-runner.ps1',
    passed: result.summary?.passed ?? null,
    total: result.summary?.total ?? null,
    ok: result.ok,
    ran_at: new Date().toISOString(),
    report_ref: `${rel}/ci-results.json`,
  }
}
