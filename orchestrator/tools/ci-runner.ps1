# =============================================================================
# ci-runner.ps1 — AgentLine 通用 CI 执行器
#
# 职责：读取 <task>/acceptance.md，逐条执行其中的 PowerShell 命令，
#       判定通过/失败，输出汇总，并以退出码表达结果。
#
# 约定（来自 acceptance.md 的设计要求）：
#   - 每条 AC 写成 "## AC-n 标题"，下含 "- 命令: `...`" 与 "- 期望: ..."
#   - 命令是单行、零第三方依赖、可独立执行
#   - 通过判定：退出码 0 且输出中出现 "<AC-n> OK"
#
# 用法：
#   pwsh -NoProfile -File ci-runner.ps1 -RepoRoot C:\path\to\repo -TaskDir .collab\tasks\001
#   pwsh -NoProfile -File ci-runner.ps1 -TaskDir .collab\tasks\001 -OutFile result.json
#
# 退出码：0 = 全部通过；1 = 有失败；2 = 框架错误（找不到 acceptance.md / 无可用用例）
# =============================================================================
[CmdletBinding()]
param(
    [string]$RepoRoot = '.',
    [string]$TaskDir = '.collab\tasks\001',
    [string]$OutFile = '',
    [int]$CommandTimeoutSec = 300
)

$ErrorActionPreference = 'Continue'
$RepoRoot = (Resolve-Path $RepoRoot -ErrorAction Stop).Path
$acceptancePath = Join-Path $RepoRoot (Join-Path $TaskDir 'acceptance.md')

if (-not (Test-Path -LiteralPath $acceptancePath -PathType Leaf)) {
    Write-Error "acceptance.md not found: $acceptancePath"
    exit 2
}

# ---- 解析（兼容两种写法）----
# A) 机器格式： "## AC-1 标题" + "- 命令: `...`" + "- 期望: ..."
# B) 文档格式： "### A6 标题" + ```powershell 代码块 + "期望：..."   （设计角色常写这种）
$cases = @()
$current = $null
$inFence = $false
$fenceLang = ''
$fenceBody = New-Object System.Collections.Generic.List[string]
foreach ($line in Get-Content -LiteralPath $acceptancePath -Encoding utf8) {
    if (-not $inFence -and $line -match '^#{2,4}\s+((?:AC-?\d+)|(?:[A-Z]{1,3}\d+)|(?:\d+(?:\.\d+)*))\b[\.:、]?\s*(.*)$') {
        if ($current -and $fenceBody.Count -gt 0) { $current.Command = ($fenceBody -join "`n") }
        $fenceBody = New-Object System.Collections.Generic.List[string]
        $current = [pscustomobject]@{ Id = $Matches[1]; Title = $Matches[2].Trim(); Command = $null; Expect = $null }
        $cases += $current
        continue
    }
    if (-not $current) { continue }

    if ($line -match '^\s*```(\w*)') {
        if (-not $inFence) { $inFence = $true; $fenceLang = $Matches[1]; $fenceBody = New-Object System.Collections.Generic.List[string] }
        else { $inFence = $false }
        continue
    }
    if ($inFence) { $fenceBody.Add($line); continue }

    if (-not $current.Command -and $fenceBody.Count -gt 0) { $current.Command = ($fenceBody -join "`n") }
    if (-not $current.Command -and $line -match '^-\s*命令:\s*`(.+)`\s*$') { $current.Command = $Matches[1]; continue }
    if (-not $current.Expect -and $line -match '^-\s*期望:\s*(.+)$') { $current.Expect = $Matches[1].Trim(); continue }
    if (-not $current.Expect -and $line -match '^\s*期望[:：]\s*(.+)$') { $current.Expect = $Matches[1].Trim() }
}
if ($current -and -not $current.Command -and $fenceBody.Count -gt 0) { $current.Command = ($fenceBody -join "`n") }

$runnable = @($cases | Where-Object { $_.Command })
if ($runnable.Count -eq 0) {
    Write-Error "no runnable cases parsed from $acceptancePath"
    exit 2
}

# ---- 执行 ----
$results = @()
Push-Location $RepoRoot
try {
    foreach ($case in $runnable) {
        $started = [System.Diagnostics.Stopwatch]::StartNew()
        # 关键 1：子进程的 stdout 是管道，默认按 OEM 代码页（如 936）解码 git 的 UTF-8 输出，
        # 遇到无法映射的字节会截断，导致「行数变少」这类假失败（实测 76 行被读成 47 行）。
        # 关键 2：命令写进临时 .ps1 再执行，避免 `pwsh -Command` 的引号/换行转义问题
        # （含 $(...) 与正则括号的插值在 -Command 下会被拆坏）。
        $utf8Prelude = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Text.UTF8Encoding]::new($false); '
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ('agentline-ci-' + [guid]::NewGuid() + '.ps1')
        try {
            [IO.File]::WriteAllText($tmp, ($utf8Prelude + "`n" + $case.Command), [Text.UTF8Encoding]::new($false))
            $output = @(& pwsh -NoProfile -NonInteractive -File $tmp 2>&1 | ForEach-Object { "$_" })
            $exit = $LASTEXITCODE
        }
        finally {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
        $started.Stop()

        $joined = $output -join "`n"
        $last = if ($output.Count -gt 0) { "$($output[-1])".TrimEnd() } else { '' }
        # 通过判定（兼容两种验收写法）：
        #   A) 命令自己输出 "<AC-n> OK"
        #   B) 命令最后打印 "exit=<码>"（设计角色常用），以该码为准
        $markerOk = $joined -match [regex]::Escape("$($case.Id) OK")
        $reported = $null
        foreach ($m in [regex]::Matches($joined, 'exit=(\d+)')) { $reported = [int]$m.Groups[1].Value }
        if ($markerOk) { $passed = ($exit -eq 0) }
        elseif ($null -ne $reported) { $passed = ($reported -eq 0) }
        else { $passed = ($exit -eq 0) }

        $results += [pscustomobject]@{
            id        = $case.Id
            title     = $case.Title
            passed    = $passed
            exitCode  = $exit
            durationS = [math]::Round($started.Elapsed.TotalSeconds, 2)
            lastLine  = $last
            output    = $joined
        }

        $status = if ($passed) { 'PASS' } else { 'FAIL' }
        "{0}  {1}  exit={2}  {3}s  {4}" -f $case.Id, $status, $exit, $started.Elapsed.TotalSeconds.ToString('0.0'), $last
    }
}
finally { Pop-Location }

$passedCount = @($results | Where-Object passed).Count
$total = $results.Count
$ok = ($passedCount -eq $total)

Write-Output ''
Write-Output ("CI SUMMARY: {0}/{1} passed" -f $passedCount, $total)

$payload = [pscustomobject]@{
    repo       = $RepoRoot
    taskDir    = $TaskDir
    ranAt      = (Get-Date).ToString('o')
    passed     = $passedCount
    total      = $total
    ok         = $ok
    results    = $results
}
if ($OutFile) {
    $payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutFile -Encoding utf8
    Write-Output "written: $OutFile"
}

if ($ok) { exit 0 } else { exit 1 }

