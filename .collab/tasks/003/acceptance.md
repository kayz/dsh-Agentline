## AC-1 插件与 CLI 语法
```pwsh
$files = @('plugin/lib/client.js', 'plugin/lib/index.js', 'orchestrator/agentline.mjs'); foreach ($file in $files) { & node --check $file; if ($LASTEXITCODE -ne 0) { exit 1 } }; Write-Output 'AC-1 OK'; exit 0
```
期望：退出码 0，输出 `AC-1 OK`。

## AC-2 Studio CLI 单步与持久化
```pwsh
& node --test orchestrator/test/studio-cli.test.mjs; if ($LASTEXITCODE -ne 0) { exit 1 }; Write-Output 'AC-2 OK'; exit 0
```
期望：退出码 0，输出 `AC-2 OK`；测试覆盖 design.md 中 CLI 的 new、run、answer、conclude、status、逐步执行和恢复、问题及决策记录。

## AC-3 G0 正反例
```pwsh
& node --test orchestrator/test/studio-g0.test.mjs; if ($LASTEXITCODE -ne 0) { exit 1 }; Write-Output 'AC-3 OK'; exit 0
```
期望：退出码 0，输出 `AC-3 OK`；测试逐项验证 design.md 中 G0 正例及所有反例，包括证据变更后重新求值。

## AC-4 五渠道、11 角色与 Studio UI
```pwsh
& node --test plugin/test/studio-ui.test.mjs; if ($LASTEXITCODE -ne 0) { exit 1 }; Write-Output 'AC-4 OK'; exit 0
```
期望：退出码 0，输出 `AC-4 OK`；测试覆盖 design.md 中渠道分组和筛选、角色矩阵、真实/空/错误状态、操作转发及现有功能保留。

## AC-5 orchestrator 完整回归
```pwsh
Push-Location orchestrator; try { & npm test; if ($LASTEXITCODE -ne 0) { exit 1 } } finally { Pop-Location }; Write-Output 'AC-5 OK'; exit 0
```
期望：退出码 0，输出 `AC-5 OK`，现有及新增 orchestrator 测试全部通过。
