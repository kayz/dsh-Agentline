# Task <NNN> — 验收

## 执行约定

- 工作目录：填写任务根目录；使用 PowerShell 7，零第三方依赖。
- 每条命令独立、单行执行；输出 AC-n OK 且无错误、退出码 0 才算通过。
- verifier 将命令、退出码、原始输出追加到 run.log。
- 以下示例由 designer 按实际设计替换或扩展。

## AC-1 交付文件存在（示例）

- 命令: `if (Test-Path -LiteralPath '交付文件路径' -PathType Leaf) { 'AC-1 OK' } else { throw 'AC-1 FAIL: missing deliverable' }`
- 期望: 输出 `AC-1 OK`，无错误且退出码 0。
