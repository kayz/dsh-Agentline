驾驶舱已采用首页、Studio、Blueprint、Build 和设置五个 Tab。首页汇总项目、待处理事项、运行状态和事件；Studio 与 Blueprint 只展示已有摘要，Build 保留任务操作，设置页展示角色路由、模型矩阵和只读目录。项目及任务切换通过请求代次隔离旧响应。项目列表轮询不再重置设置页中未保存的路由草稿。

Host 的 pipeline 和 catalog 路由仅接受 GET，分别转发已有 pipeline 摘要和模型目录：浏览器无法直接读取项目文件或 orchestrator 配置，因此需要这两个只读入口。原始配置与凭据不会返回浏览器。

自测：`node --check` 对两个插件文件通过；验收静态检查、五 Tab 渲染、数据投影与导航检查、Host 真实路由检查均通过。项目轮询修正后重新检查客户端语法。orchestrator 的 `node --test` 中有测试会调用 Git；按照禁止执行 Git 命令的要求，本次未运行该套件，也未运行验收中直接使用 Git 的写入范围和未跟踪文件检查。仓库没有 `scripts/check-fast.ps1`。

已知限制：pipeline 摘要的来源判定存在设计文档所述的运算符优先级问题；本任务不修改 orchestrator，界面原样展示其结果。
