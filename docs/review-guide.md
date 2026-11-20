# 代码审阅顺序

本轮改动涵盖项目事实、setup 诊断和 T3 启动。源代码按职责放在 `src/` 下。Pi 从仓库根目录的 [index.ts](../index.ts) 加载命令和阶段事件。

## 沿命令入口审阅

| 从哪里开始 | 接着看什么 | 核对什么 |
| --- | --- | --- |
| `/taskbook-setup` | [审批和汇报](../src/setup/command.ts)、[诊断](../src/setup/diagnostics.ts)、[MCP 目录](../src/integrations/mcp-catalog.ts) | 诊断先收集数据。汇报轮禁用工具。初始化、导入和清理需要对应的批准。 |
| `/taskbook-new` | [任务书与基线](../src/taskbook/document.ts)、[启动数据](../src/taskbook/entry.ts)、[T3 请求](../src/integrations/t3.ts) | T3 接收固定基线和分支，创建 worktree。子 Pi 复核实际仓库、分支、基线和任务书摘要。 |
| `/taskbook` | [检查点](../src/workflow/checkpoint.ts)、[阶段输入](../src/workflow/phase-input.ts)、[阶段迁移](../src/workflow/transitions.ts)、[独立审核](../src/review/reviewer.ts) | 检查点绑定原会话。各阶段按同一事实版本取数。独立审核读固定 Git 提交。 |
| 项目事实变更与迁移 | [事实存储](../src/facts/project-memory.ts)、[旧资料迁移](../src/facts/project-memory-migration.ts) | 独立事实审核后提交 `.fact/project.json` 和相应术语。旧引用只在迁移时读取。 |
| 完成交接 | [同步入口](../index.ts)、[Magpie 同步与镜像](../src/integrations/magpie-memory.ts) | 保存本地完成检查点后才同步。同步核对项目归属及版本。远端条件不足时保留待处理结果。 |

[工作流说明](workflow.md)记录各阶段的使用方式。运行时提示词位于 [prompts/](../prompts/)，方法选择代码位于 [src/methods/](../src/methods/)，随包固定的方法版本位于 [methods/](../methods/)。

## 核对三个版本

- **任务书摘要**绑定原文和随附事实。新 T3 thread 收到摘要后重新读取并核对。
- **候审提交**绑定规格和质量审核读到的 Git 内容。性能观测同样绑定产出观测的提交。
- **事实版本**绑定项目事实文件和词汇表。审核、冲突裁决和完成同步用它检测期间的变化。

## 重跑验收

```sh
yarn node --test tests/*.test.ts
python3 tests/setup_rpc.py
python3 tests/workflow_rpc.py
```

单元测试核对状态迁移、事实历史和 Magpie 版本条件。RPC 测试以真实 Pi 运行命令，模型、MCP 服务和 T3 由本地替身提供。命令层行为、旧检查点、提交内容和调用次序在重组前后使用同一套断言。环境、子代理验收入口和实际接口限制见 [任务书验收记录](project-facts-verification.md)。
