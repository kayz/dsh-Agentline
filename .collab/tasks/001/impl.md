# 实现说明

工作区已有 Tab 驾驶舱实现：按项目展示首页、Studio、Blueprint、Build 和设置，保留 Build 任务操作，并通过只读 pipeline、catalog 路由转发既有数据。浏览器不能直接读取项目文件，故 Host 使用这两条只读路由；非 GET 请求被拒绝。此次核对补充了项目列表请求的代次检查，避免切换项目后旧请求覆盖新项目的 pipeline、路由和草稿状态。

已知限制：核心 `pipeline.mjs` 的 source 判定存在设计中记录的运算符优先级问题，UI 原样展示核心返回值，本任务未修改 orchestrator。

自测：client.js 和 index.js 的语法检查通过；AC-3 至 AC-8 静态检查、五个 Tab 的桩渲染和默认首页检查通过；数据投影与导航夹具输出 `OK data projection+navigation`；orchestrator 的 `node --test` 汇总 71 项，64 通过、7 跳过、0 失败。测试套件运行时内部调用了 Git，执行前未识别这一点。

未执行 AC-10：其夹具会创建临时目录及文件，与用户禁止创建其他文件的要求冲突。未执行 AC-12 和 AC-14：两项要求运行 Git，与用户禁止执行 Git 的要求冲突。因此不能声明全部验收通过。未发现 `scripts/check-fast.ps1`。
