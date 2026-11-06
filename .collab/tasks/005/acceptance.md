## AC-1 插件语法
```pwsh
$files = @('plugin/lib/client.js', 'plugin/lib/index.js', 'orchestrator/agentline.mjs'); foreach ($file in $files) { & node --check $file; if ($LASTEXITCODE -ne 0) { exit 1 } }; Write-Output 'AC-1 OK'
```
期望：退出码 0，最后输出 `AC-1 OK`。

## AC-2 Build 来源校验
```pwsh
& node --test orchestrator/test/build-source.test.mjs; if ($LASTEXITCODE -ne 0) { exit 1 }; Write-Output 'AC-2 OK'
```
期望：退出码 0，最后输出 `AC-2 OK`。覆盖来源正反例，拒绝时零模型调用。

## AC-3 K1 step/runBuild 到 pr_open
```pwsh
& node --test orchestrator/test/build-execution.test.mjs; if ($LASTEXITCODE -ne 0) { exit 1 }; Write-Output 'AC-3 OK'
```
期望：退出码 0，最后输出 `AC-3 OK`。覆盖单步、完整运行、失败与锁和恢复。

## AC-4 T gate 缺失证据
```pwsh
& node --test orchestrator/test/build-gate.test.mjs; if ($LASTEXITCODE -ne 0) { exit 1 }; Write-Output 'AC-4 OK'
```
期望：退出码 0，最后输出 `AC-4 OK`。缺失或无效 CI 证据为未知且不通过，覆盖 gate 正反例。

## AC-5 角色锁/实际身份
```pwsh
& node --test orchestrator/test/build-roles.test.mjs; if ($LASTEXITCODE -ne 0) { exit 1 }; Write-Output 'AC-5 OK'
```
期望：退出码 0，最后输出 `AC-5 OK`。覆盖新旧角色、实际调用、身份与重试，并验证证据及 gate。

## AC-6 Build UI 真实/空/错误状态
```pwsh
& node --test plugin/test/build-ui.test.mjs; if ($LASTEXITCODE -ne 0) { exit 1 }; Write-Output 'AC-6 OK'
```
期望：退出码 0，最后输出 `AC-6 OK`。覆盖真实、空、错误、重试、项目切换和既有功能。

## AC-7 完整回归
```pwsh
Push-Location orchestrator; try { & npm test; if ($LASTEXITCODE -ne 0) { exit 1 } } finally { Pop-Location }; & node --test plugin/test/*.test.mjs; if ($LASTEXITCODE -ne 0) { exit 1 }; Write-Output 'AC-7 OK'
```
期望：退出码 0，最后输出 `AC-7 OK`。orchestrator 和插件测试全部通过。
