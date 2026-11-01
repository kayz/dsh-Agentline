---
write_scope:
  - path/to/code-or-dir/**
---

# Task <NNN> — 设计

## 目标与非目标

根据 brief.md 写明交付边界。

## 结构

列出目录、文件及各自职责。

## 接口与判定逻辑

说明输入、输出、失败处理及通过条件。

## 写入范围

与 front matter 的 `write_scope` 保持一致：列出允许新增或修改的路径（相对仓库根，`*` 单段、`**` 多段），以及禁止修改的文件。`write_scope: []` 表示本任务不改产品代码。
