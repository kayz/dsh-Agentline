param(
    [string]$SkillRoot = (Split-Path $PSScriptRoot -Parent)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    $SkillRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($SkillRoot)
    $script:failedChecks = 0
    $utf8 = [Text.UTF8Encoding]::new($false, $true)

    function Show-Check {
        param([string]$Id, [string]$Label, [string[]]$Issues = @())
        if ($Issues.Count -gt 0) {
            $script:failedChecks++
            $details = ($Issues -join '; ') -replace '[\r\n]+', ' '
            Write-Output ('[FAIL] {0} {1}: {2}' -f $Id, $Label, $details)
        }
        else {
            Write-Output ('[OK]   {0} {1}' -f $Id, $Label)
        }
    }

    function Read-Scalar {
        param([string]$Value)
        $Value = $Value.Trim()
        if ($Value -cmatch '^([''"])(.*)\1$') {
            return $Matches[2]
        }
        return $Value
    }

    $skillPath = Join-Path $SkillRoot 'SKILL.md'
    $skillExists = Test-Path -LiteralPath $skillPath -PathType Leaf
    $issues = [Collections.Generic.List[string]]::new()
    if (-not $skillExists) { $issues.Add("not found: $skillPath") }
    Show-Check -Id C1 -Label 'SKILL.md exists' -Issues ($issues.ToArray())

    $issues.Clear()
    try {
        $files = @(Get-ChildItem -LiteralPath $SkillRoot -Recurse -File -Force)
        foreach ($file in $files) {
            $relative = [IO.Path]::GetRelativePath($SkillRoot, $file.FullName)
            try {
                $bytes = [IO.File]::ReadAllBytes($file.FullName)
                if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and
                    $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
                    $issues.Add("BOM: $relative")
                }
                try { $null = $utf8.GetString($bytes) }
                catch { $issues.Add("invalid utf-8: $relative") }
            }
            catch { $issues.Add("cannot read: $relative") }
        }
    }
    catch { $issues.Add("cannot enumerate skill files: $($_.Exception.Message)") }
    Show-Check -Id C2 -Label 'encoding utf-8 no BOM' -Issues ($issues.ToArray())

    $issues.Clear()
    $body = ''
    $readError = ''
    $lines = @()
    if ($skillExists) {
        try {
            $skillText = $utf8.GetString([IO.File]::ReadAllBytes($skillPath))
            $lines = @($skillText -split '\r?\n')
            # Fall back to the full text until front matter boundaries are known.
            $body = $lines -join "`n"
        }
        catch { $readError = "cannot read SKILL.md as utf-8: $($_.Exception.Message)" }
    }
    else { $readError = 'SKILL.md not found' }

    if ($readError) { $issues.Add($readError) }
    elseif ($lines.Count -eq 0 -or $lines[0] -cne '---') {
        $issues.Add('first line must be ---')
    }
    else {
        $closing = -1
        for ($i = 1; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -cmatch '^---[ \t]*$') { $closing = $i; break }
        }
        if ($closing -lt 0) { $issues.Add('no closing ---') }
        else {
            $body = ($lines | Select-Object -Skip ($closing + 1)) -join "`n"
            $metadata = @{}
            for ($i = 1; $i -lt $closing; $i++) {
                if ($lines[$i] -cmatch '^(name|description|version):[ \t]*(.*)$') {
                    $key = $Matches[1]
                    $value = $Matches[2]
                    if ($metadata.ContainsKey($key)) { $issues.Add("duplicate field: $key") }
                    $metadata[$key] = Read-Scalar $value
                }
            }
            foreach ($key in 'name', 'description', 'version') {
                if (-not $metadata.ContainsKey($key)) { $issues.Add("missing $key") }
            }
            if ($metadata.ContainsKey('name') -and $metadata['name'] -cne 'AgentLine') {
                $issues.Add("name='$($metadata['name'])' (expect 'AgentLine')")
            }
            if ($metadata.ContainsKey('description')) {
                $description = $metadata['description']
                if ([string]::IsNullOrWhiteSpace($description) -or
                    $description.Length -gt 1024 -or $description -match '^[>|]') {
                    $issues.Add('description must be a nonempty single-line scalar of at most 1024 characters')
                }
            }
            if ($metadata.ContainsKey('version') -and $metadata['version'] -cnotmatch '^\d+\.\d+\.\d+$') {
                $issues.Add("invalid version: $($metadata['version'])")
            }
        }
    }
    Show-Check -Id C3 -Label 'front matter' -Issues ($issues.ToArray())

    $issues.Clear()
    if ($readError) { $issues.Add($readError) }
    else {
        foreach ($heading in '## 何时使用', '## 角色', '## 交接文件', '## 流程', '## 规则') {
            if (-not [regex]::IsMatch($body, ('(?m)^' + [regex]::Escape($heading) + '[ \t]*$'))) {
                $issues.Add("missing heading: $heading")
            }
        }
    }
    Show-Check -Id C4 -Label 'headings' -Issues ($issues.ToArray())

    $issues.Clear()
    if ($readError) { $issues.Add($readError) }
    else {
        foreach ($role in 'designer', 'developer', 'verifier') {
            if (-not $body.Contains($role)) { $issues.Add("missing role: $role") }
        }
    }
    Show-Check -Id C5 -Label 'roles' -Issues ($issues.ToArray())

    $issues.Clear()
    if ($readError) { $issues.Add($readError) }
    else {
        foreach ($name in 'brief.md', 'design.md', 'acceptance.md', 'impl.md', 'review.md', 'state.json', 'run.log') {
            if (-not $body.Contains($name)) { $issues.Add("missing file name: $name") }
        }
    }
    Show-Check -Id C6 -Label 'handoff file names' -Issues ($issues.ToArray())

    $issues.Clear()
    if ($readError) { $issues.Add($readError) }
    elseif (-not $body.Contains('验证模型不得与开发模型相同')) {
        $issues.Add('missing rule: 验证模型不得与开发模型相同')
    }
    Show-Check -Id C7 -Label 'model isolation rule' -Issues ($issues.ToArray())

    $issues.Clear()
    $templateRoot = Join-Path $SkillRoot 'templates'
    foreach ($name in 'brief.md', 'design.md', 'acceptance.md', 'impl.md', 'review.md', 'state.json') {
        if (-not (Test-Path -LiteralPath (Join-Path $templateRoot $name) -PathType Leaf)) {
            $issues.Add("missing template: $name")
        }
    }
    $statePath = Join-Path $templateRoot 'state.json'
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        try {
            $state = $utf8.GetString([IO.File]::ReadAllBytes($statePath)) | ConvertFrom-Json -AsHashtable -NoEnumerate
            if ($state -isnot [Collections.IDictionary]) { $issues.Add('state.json must be a JSON object') }
            else {
                foreach ($key in 'task', 'phase', 'dev_model', 'verifier_model') {
                    if (-not $state.Contains($key)) { $issues.Add("state.json missing key: $key") }
                }
            }
        }
        catch { $issues.Add("invalid state.json: $($_.Exception.Message)") }
    }
    Show-Check -Id C8 -Label 'templates' -Issues ($issues.ToArray())

    if ($script:failedChecks -gt 0) {
        Write-Output ("FAIL: $script:failedChecks/8 checks failed")
        exit 1
    }
    Write-Output 'PASS'
    exit 0
}
catch {
    $message = $_.Exception.Message -replace '[\r\n]+', ' '
    Write-Output ("FAIL: internal error: $message")
    exit 1
}
