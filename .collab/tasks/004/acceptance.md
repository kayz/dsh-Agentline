## AC-1 插件与 CLI 语法
```pwsh
$files = @('plugin/lib/client.js', 'plugin/lib/index.js', 'orchestrator/agentline.mjs'); foreach ($file in $files) { & node --check $file; if ($LASTEXITCODE -ne 0) { exit 1 } }; Write-Output 'AC-1 OK'
```
期望：退出码 0，最后输出 `AC-1 OK`。

## AC-2 Blueprint CLI 和物化
```pwsh
& node --test orchestrator/test/blueprint-cli.test.mjs; if ($LASTEXITCODE -ne 0) { exit 1 }; Write-Output 'AC-2 OK'
```
期望：退出码 0，最后输出 `AC-2 OK`；测试覆盖 design.md 中六个命令、单步顺序、恢复、冲突、物化保真和失效后重新批准。

## AC-3 G1 正反例
```pwsh
& node --test orchestrator/test/blueprint-g1.test.mjs; if ($LASTEXITCODE -ne 0) { exit 1 }; Write-Output 'AC-3 OK'
```
期望：退出码 0，最后输出 `AC-3 OK`；测试逐项验证 design.md 的 G1 正反例及内容变更失效。

## AC-4 Blueprint UI
```pwsh
& node --test plugin/test/blueprint-ui.test.mjs; if ($LASTEXITCODE -ne 0) { exit 1 }; Write-Output 'AC-4 OK'
```
期望：退出码 0，最后输出 `AC-4 OK`；测试验证真实、空、错误状态、操作与现有功能。

## AC-5 完整回归
```pwsh
Push-Location orchestrator; try { & npm test; if ($LASTEXITCODE -ne 0) { exit 1 } } finally { Pop-Location }; & node --test plugin/test/*.test.mjs; if ($LASTEXITCODE -ne 0) { exit 1 }; Write-Output 'AC-5 OK'
```
期望：退出码 0，最后输出 `AC-5 OK`；orchestrator 和插件测试全部通过。
