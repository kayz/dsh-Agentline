# =============================================================================
# check-task.ps1 — AgentLine 任务产物只读校验（PowerShell 7）
#
# 校验调度器模式（status）下的证据链；手动模式（phase）只做基本检查。
# 只读：不修改仓库、不执行 acceptance。
#
# 用法：
#   pwsh -NoProfile -File check-task.ps1 -RepoRoot C:\path\to\repo -TaskDir .collab\tasks\003
#   pwsh -NoProfile -File check-task.ps1 -RepoRoot . -TaskDir .collab\tasks\003 -Lenient
#   pwsh -NoProfile -File check-task.ps1 -RepoRoot . -TaskDir .collab\tasks\003 -Strict
#
# 退出码：0 = 通过（可能有 WARN）；1 = 有 FAIL；2 = 参数/目录错误。
# =============================================================================
[CmdletBinding()]
param(
    [string]$RepoRoot = '.',
    [string]$TaskDir = '',
    [string]$BaseRef = 'main',
    [switch]$Lenient,
    [switch]$Strict
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:failed = 0
$script:warned = 0

function Write-Check {
    param(
        [string]$Id,
        [string]$Label,
        [string[]]$Issues = @(),
        [string[]]$Warnings = @()
    )
    if ($Issues.Count -gt 0) {
        $script:failed++
        $text = ($Issues -join '; ') -replace '[\r\n]+', ' '
        Write-Output ('[FAIL] {0} {1}: {2}' -f $Id, $Label, $text)
    }
    elseif ($Warnings.Count -gt 0) {
        $script:warned++
        $text = ($Warnings -join '; ') -replace '[\r\n]+', ' '
        Write-Output ('[WARN] {0} {1}: {2}' -f $Id, $Label, $text)
    }
    else {
        Write-Output ('[OK]   {0} {1}' -f $Id, $Label)
    }
}

function Read-Json {
    param([string]$Path)
    try {
        $raw = Get-Content -LiteralPath $Path -Raw -Encoding utf8
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ($raw | ConvertFrom-Json -AsHashtable -NoEnumerate)
    }
    catch { return $null }
}

function As-Object {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Collections.IDictionary]) { return $Value }
    return $null
}

function As-Array {
    param($Value)
    if ($null -eq $Value) { return @() }
    return @($Value)
}

function Git-Lines {
    param([string[]]$GitArgs)
    $out = & git -C $RepoRoot @GitArgs 2>$null
    if ($LASTEXITCODE -ne 0) { return @() }
    return @($out)
}

function Git-Ok {
    param([string[]]$GitArgs)
    & git -C $RepoRoot @GitArgs 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Test-Glob {
    param([string]$File, [string]$Scope)
    $f = $File.Replace('\', '/')
    $s = $Scope.Trim().Replace('\', '/')
    if ($s.EndsWith('/')) { $s = $s + '**' }
    $escaped = [regex]::Escape($s)
    $pattern = $escaped.Replace('\*\*', '.*').Replace('\*', '[^/]*').Replace('\?', '[^/]')
    if (-not $s.Contains('*') -and -not $s.Contains('?')) {
        $pattern = "^$pattern(/.*)?$"
    }
    else {
        $pattern = "^$pattern$"
    }
    return [regex]::IsMatch($f, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

function Get-WriteScope {
    param([string]$DesignPath)
    if (-not (Test-Path -LiteralPath $DesignPath -PathType Leaf)) { return @() }
    $lines = @(Get-Content -LiteralPath $DesignPath -Encoding utf8)
    if ($lines.Count -lt 2 -or $lines[0].Trim() -ne '---') { return @() }
    $end = -1
    for ($i = 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -eq '---') { $end = $i; break }
    }
    if ($end -lt 0) { return @() }

    $scopes = @()
    $inScope = $false
    for ($i = 1; $i -lt $end; $i++) {
        $line = $lines[$i]
        if ($line -match '^write_scope:\s*(.*)$') {
            $inline = $Matches[1].Trim()
            $inScope = $true
            if ($inline -eq '' -or $inline -eq '[]') { continue }
            if ($inline.StartsWith('[')) {
                foreach ($part in ($inline.Trim('[', ']') -split ',')) {
                    $v = $part.Trim().Trim('"', "'")
                    if ($v) { $scopes += $v }
                }
            }
            else {
                $scopes += $inline.Trim('"', "'")
            }
            continue
        }
        if ($inScope) {
            if ($line -match '^\s*-\s*(.+?)\s*$') {
                $v = $Matches[1].Trim().Trim('"', "'")
                if ($v) { $scopes += $v }
                continue
            }
            if ($line.Trim() -eq '') { continue }
            break
        }
    }
    return $scopes
}

# ── 参数与目录 ──────────────────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($TaskDir)) {
    Write-Output 'ERROR: -TaskDir is required (e.g. .collab/tasks/003)'
    exit 2
}
try {
    $RepoRoot = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
}
catch {
    Write-Output ("ERROR: RepoRoot not found: {0}" -f $RepoRoot)
    exit 2
}
$taskPath = if ([IO.Path]::IsPathRooted($TaskDir)) { $TaskDir } else { Join-Path $RepoRoot $TaskDir }
if (-not (Test-Path -LiteralPath $taskPath -PathType Container)) {
    Write-Output ("ERROR: task dir not found: {0}" -f $taskPath)
    exit 2
}
$taskPath = (Resolve-Path -LiteralPath $taskPath -ErrorAction Stop).Path
$taskId = Split-Path -Leaf $taskPath
$statePath = Join-Path $taskPath 'state.json'

$validStatuses = @('draft', 'designed', 'implemented', 'reviewable', 'reviewed', 'pr_open', 'merged', 'blocked')
$validPhases = @('brief', 'design', 'develop', 'verify', 'done', 'blocked')

# ── C1 state.json ───────────────────────────────────────────────────────
$issues = [Collections.Generic.List[string]]::new()
$warnings = [Collections.Generic.List[string]]::new()
$state = $null
$status = $null
$manual = $false
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    $issues.Add('state.json not found')
}
else {
    $state = Read-Json $statePath
    if (-not $state) {
        $issues.Add('state.json is not valid JSON')
    }
    else {
        $taskField = $null
        if ($state.Contains('task')) { $taskField = [string]$state['task'] }
        elseif ($state.Contains('id')) { $taskField = [string]$state['id'] }
        if ([string]::IsNullOrWhiteSpace($taskField)) { $issues.Add('missing id/task') }
        elseif ($taskField -ne $taskId) { $issues.Add("id/task='$taskField' but dir is '$taskId'") }

        if ($state.Contains('status') -and -not [string]::IsNullOrWhiteSpace([string]$state['status'])) {
            $status = [string]$state['status']
            if ($status -notin $validStatuses) { $issues.Add("unknown status: $status") }
        }
        elseif ($state.Contains('phase') -and -not [string]::IsNullOrWhiteSpace([string]$state['phase'])) {
            $manual = $true
            $phase = [string]$state['phase']
            if ($phase -notin $validPhases) { $issues.Add("unknown phase: $phase") }
            $warnings.Add('manual mode (phase): scheduler artifacts are not checked')
        }
        else {
            $issues.Add('state.json needs status (orchestrator) or phase (manual)')
        }
    }
}
Write-Check -Id C1 -Label 'state.json' -Issues $issues.ToArray() -Warnings $warnings.ToArray()

if ($manual) {
    Write-Output 'PASS (manual mode; scheduler checks skipped)'
    exit 0
}

# ── C2 run.json ─────────────────────────────────────────────────────────
$issues.Clear(); $warnings.Clear()
$runPath = Join-Path $taskPath 'run.json'
$runs = @()
if (Test-Path -LiteralPath $runPath -PathType Leaf) {
    $raw = Read-Json $runPath
    if ($null -eq $raw) { $issues.Add('run.json is not valid JSON') }
    else { $runs = As-Array $raw }
    if ($runs.Count -eq 0) { $issues.Add('run.json is empty') }
    foreach ($r in $runs) {
        $ro = As-Object $r
        if (-not $ro) { $issues.Add('run entry is not an object'); continue }
        if (-not $ro.Contains('role') -or [string]::IsNullOrWhiteSpace([string]$ro['role'])) { $issues.Add('run entry missing role') }
        if (-not $ro.Contains('exit') -or -not (As-Object $ro['exit']) -or -not $ro['exit'].Contains('code')) { $issues.Add('run entry missing exit.code') }
        if (-not $ro.Contains('model_requested') -or [string]::IsNullOrWhiteSpace([string]$ro['model_requested'])) { $issues.Add('run entry missing model_requested') }
    }
}
elseif ($status -in @('implemented', 'reviewable', 'reviewed', 'pr_open', 'merged')) {
    $issues.Add('run.json not found for status ' + $status)
}
else {
    $warnings.Add('run.json not present yet (status ' + $status + ')')
}
Write-Check -Id C2 -Label 'run.json' -Issues $issues.ToArray() -Warnings $warnings.ToArray()

# ── C3 model isolation ──────────────────────────────────────────────────
$issues.Clear(); $warnings.Clear()
$devRuns = @($runs | Where-Object {
    $o = As-Object $_
    $o -and [string]$o['role'] -eq 'dev' -and $o.Contains('exit') -and [int]$o['exit']['code'] -eq 0
})
$revRuns = @($runs | Where-Object {
    $o = As-Object $_
    $o -and [string]$o['role'] -eq 'review' -and $o.Contains('exit') -and [int]$o['exit']['code'] -eq 0
})
$modelOf = {
    param($Run)
    if ($Run.Contains('model_resolved') -and -not [string]::IsNullOrWhiteSpace([string]$Run['model_resolved'])) { return [string]$Run['model_resolved'] }
    return [string]$Run['model_requested']
}
if ($status -in @('reviewed', 'pr_open', 'merged')) {
    if ($devRuns.Count -eq 0) { $issues.Add('no successful dev run') }
    if ($revRuns.Count -eq 0) { $issues.Add('no successful review run') }
}
if ($devRuns.Count -gt 0 -and $revRuns.Count -gt 0) {
    $devModel = & $modelOf $devRuns[-1]
    $revModel = & $modelOf $revRuns[-1]
    if ($devModel -eq $revModel) {
        $issues.Add("review model == dev model ($devModel)")
    }
}
elseif ($status -in @('implemented', 'reviewable')) {
    $warnings.Add('review not run yet; isolation will be checked at review')
}
Write-Check -Id C3 -Label 'model isolation' -Issues $issues.ToArray() -Warnings $warnings.ToArray()

# ── C4 ci-results.json ──────────────────────────────────────────────────
$issues.Clear(); $warnings.Clear()
$ciPath = Join-Path $taskPath 'ci-results.json'
$ci = $null
if (Test-Path -LiteralPath $ciPath -PathType Leaf) {
    $ci = Read-Json $ciPath
    if (-not $ci) { $issues.Add('ci-results.json is not valid JSON') }
    else {
        $passed = $ci['passed']; $total = $ci['total']; $ok = $ci['ok']
        if ($null -eq $passed -or $null -eq $total) { $issues.Add('missing passed/total') }
        elseif ([int]$total -le 0) { $issues.Add('total must be > 0') }
        elseif ([int]$passed -ne [int]$total -and [bool]$ok) { $issues.Add("ok=true but passed=$passed/$total") }
        if ($null -eq $ok) { $issues.Add('missing ok') }
        if ($null -eq $ci['results']) { $issues.Add('missing results') }
    }
}
elseif ($status -in @('reviewable', 'reviewed', 'pr_open', 'merged')) {
    $issues.Add('ci-results.json not found for status ' + $status)
}
else {
    $warnings.Add('CI not run yet (status ' + $status + ')')
}
Write-Check -Id C4 -Label 'ci-results.json' -Issues $issues.ToArray() -Warnings $warnings.ToArray()

# ── C5 verdict ──────────────────────────────────────────────────────────
$issues.Clear(); $warnings.Clear()
$verdictFiles = @(Get-ChildItem -LiteralPath $taskPath -File -Filter 'verdict*.json' -ErrorAction SilentlyContinue)
$best = $null
if ($verdictFiles.Count -gt 0) {
    $best = $verdictFiles | Sort-Object {
        if ($_.Name -match '^verdict-r(\d+)\.json$') { [int]$Matches[1] } else { 1 }
    } | Select-Object -Last 1
}
$verdict = $null
if ($best) {
    $verdict = Read-Json $best.FullName
    if (-not $verdict) { $issues.Add("$($best.Name) is not valid JSON") }
    else {
        $v = [string]$verdict['verdict']
        if ([string]::IsNullOrWhiteSpace($v)) { $issues.Add('missing verdict') }
        elseif ($status -in @('reviewed', 'pr_open', 'merged') -and $v -ne 'pass') { $issues.Add("final status $status but verdict=$v") }
        if ($null -eq $verdict['passed'] -or $null -eq $verdict['total']) {
            if ($Lenient) { $warnings.Add('missing passed/total (legacy verdict)') } else { $issues.Add('missing passed/total') }
        }
        if ($null -eq $verdict['findings']) { $issues.Add('missing findings') }
        elseif ($verdict['findings'] -isnot [System.Collections.IList]) { $issues.Add('findings must be an array') }

        $sha = ''
        if ($verdict.Contains('git_sha')) { $sha = ([string]$verdict['git_sha']).Trim() }
        if ([string]::IsNullOrWhiteSpace($sha)) {
            if ($Lenient) { $warnings.Add('missing git_sha (legacy verdict)') } else { $issues.Add('missing git_sha') }
        }
        else {
            if (Test-Path -LiteralPath (Join-Path $RepoRoot '.git')) {
                if (-not (Git-Ok @('merge-base', '--is-ancestor', $sha, 'HEAD'))) {
                    $issues.Add("git_sha $sha is not an ancestor of HEAD")
                }
            }
            else { $warnings.Add('not a git repo; git_sha not verified') }
        }
    }
}
elseif ($status -in @('reviewed', 'pr_open', 'merged')) {
    $issues.Add('no verdict*.json for status ' + $status)
}
elseif ($status -eq 'reviewable') {
    $warnings.Add('review not completed yet')
}
Write-Check -Id C5 -Label 'verdict.json' -Issues $issues.ToArray() -Warnings $warnings.ToArray()

# ── C6 logs / handoff 引用 ──────────────────────────────────────────────
$issues.Clear(); $warnings.Clear()
$checkedLogs = 0
foreach ($r in $runs) {
    $ro = As-Object $r
    if (-not $ro) { continue }
    if ($ro.Contains('log_ref') -and -not [string]::IsNullOrWhiteSpace([string]$ro['log_ref'])) {
        $logPath = Join-Path $RepoRoot ([string]$ro['log_ref']).Replace('/', [IO.Path]::DirectorySeparatorChar)
        if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) {
            if ($Lenient) { $warnings.Add('log missing (legacy): ' + $ro['log_ref']) }
            else { $issues.Add('log missing: ' + $ro['log_ref']) }
        }
        $checkedLogs++
    }
    if ($ro.Contains('handoff') -and (As-Object $ro['handoff'])) {
        $hf = [string]$ro['handoff']['file']
        if ($hf) {
            $hp = Join-Path $taskPath $hf.Replace('/', [IO.Path]::DirectorySeparatorChar)
            if (-not (Test-Path -LiteralPath $hp -PathType Leaf)) {
                if ($Lenient) { $warnings.Add('handoff missing (legacy): ' + $hf) }
                else { $issues.Add('handoff missing: ' + $hf) }
            }
        }
    }
}
if ($checkedLogs -eq 0) { $warnings.Add('no log_ref entries') }
Write-Check -Id C6 -Label 'logs / handoff references' -Issues $issues.ToArray() -Warnings $warnings.ToArray()

# ── C7 write_scope ──────────────────────────────────────────────────────
$issues.Clear(); $warnings.Clear()
$designPath = Join-Path $taskPath 'design.md'
$scopes = @(Get-WriteScope $designPath)
if ($scopes.Count -eq 0) {
    if ($Strict) { $issues.Add('design.md has no write_scope front matter') }
    else { $warnings.Add('design.md has no write_scope front matter (run with -Strict to require)') }
}
elseif (Test-Path -LiteralPath (Join-Path $RepoRoot '.git')) {
    $changed = @()
    $changed += Git-Lines @('diff', '--name-only', "$BaseRef...HEAD")
    if ($changed.Count -eq 0) { $changed += Git-Lines @('diff', '--name-only', $BaseRef) }
    foreach ($line in (Git-Lines @('status', '--porcelain'))) {
        if ($line.Length -lt 4) { continue }
        $p = $line.Substring(3).Trim()
        if ($p.Contains(' -> ')) { $p = ($p -split ' -> ')[-1] }
        $changed += $p.Trim('"')
    }
    if ($state -and (As-Object $state['pr']) -and $state['pr'].Contains('files')) {
        $changed += As-Array $state['pr']['files']
    }
    $changed = @($changed | Where-Object { $_ -and -not $_.StartsWith('.collab/') } | Sort-Object -Unique)
    if ($changed.Count -eq 0) {
        $warnings.Add('no changed files to check')
    }
    else {
        $outOfScope = @($changed | Where-Object {
            $file = $_
            -not ($scopes | Where-Object { Test-Glob -File $file -Scope $_ })
        })
        if ($outOfScope.Count -gt 0) {
            $issues.Add('out of write_scope: ' + (($outOfScope | Select-Object -First 8) -join ', '))
        }
    }
}
else {
    $warnings.Add('not a git repo; write_scope not checked')
}
Write-Check -Id C7 -Label 'write_scope' -Issues $issues.ToArray() -Warnings $warnings.ToArray()

# ── C8 状态与必需产物 ────────────────────────────────────────────────────
$issues.Clear(); $warnings.Clear()
$need = @('brief.md', 'design.md', 'acceptance.md')
if ($status -in @('implemented', 'reviewable', 'reviewed', 'pr_open', 'merged')) { $need += 'impl.md' }
foreach ($name in $need) {
    if (-not (Test-Path -LiteralPath (Join-Path $taskPath $name) -PathType Leaf)) { $issues.Add("missing $name for status $status") }
}
if ($status -in @('reviewed', 'pr_open', 'merged')) {
    $reviewFiles = @(Get-ChildItem -LiteralPath $taskPath -File -Filter 'review*.md' -ErrorAction SilentlyContinue)
    if ($reviewFiles.Count -eq 0) { $issues.Add("missing review*.md for status $status") }
}
if ($status -in @('pr_open', 'merged')) {
    if (-not ($state -and (As-Object $state['pr']) -and $state['pr']['branch'])) { $issues.Add('state.pr.branch is missing') }
}
if ($status -eq 'merged') {
    if (-not ($state -and (As-Object $state['pr']) -and $state['pr']['sha'])) { $issues.Add('state.pr.sha is missing') }
}
if ($status -eq 'blocked') {
    if (-not ($state -and $state.Contains('blocked_reason') -and -not [string]::IsNullOrWhiteSpace([string]$state['blocked_reason']))) {
        $issues.Add('state.blocked_reason is missing')
    }
}
Write-Check -Id C8 -Label 'required artifacts' -Issues $issues.ToArray() -Warnings $warnings.ToArray()

# ── 结果 ────────────────────────────────────────────────────────────────
if ($script:failed -gt 0) {
    Write-Output ("FAIL: {0} check(s) failed, {1} warning(s)" -f $script:failed, $script:warned)
    exit 1
}
if ($script:warned -gt 0) {
    Write-Output ("PASS ({0} warning(s))" -f $script:warned)
    exit 0
}
Write-Output 'PASS'
exit 0


