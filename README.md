# pi-taskbook

把自己的任务书执行提示词加载进 Pi。流程入口是接受任务书，出口是交接、阻塞或用户退出。当前版本是可运行的原型，目标运行环境为 Pi 1.5.2。

## 安装与使用

在运行 T3 Code 的机器上用 `pi install /absolute/path/to/pi-taskbook` 安装到 Pi。将 `.audit/pi-taskbook/` 加入对应仓库的 Git 排除配置。

| 入口 | Pi 执行 |
| --- | --- |
| `/taskbook-new <任务书路径>` | 在当前项目解析固定基线，用 Git 建立任务书指定的新分支和 linked worktree，再直接调用 T3 MCP 的 `t3_thread_launch`。新 thread 在已创建的 worktree 上接收一条内部 `/taskbook` 命令。 |
| `/taskbook <任务书路径>` | 在当前持久会话内核对 GitHub origin、工作分支、linked worktree 和基线，通过后建立审计记录并开始事实核查。重交同一任务书可从检查点恢复。 |

新建入口需要 T3 为 Pi 注入本地 MCP 端点，以及 `PI_TASKBOOK_WORKTREE_ROOT` 指向已有的专用目录。接收端复核实际目录、任务书和事实摘要以及固定基线。新分支从 `Base commit` 或本地基线分支解析的提交创建。既有 worktree 的无显式 SHA 基线取其 HEAD 与基线分支的 merge-base。两个入口先做程序校验，通过后才启动模型轮次。MCP 回执缺失时，检查原 thread 是否已建立，保留已创建的 worktree 供核对。

`/taskbook-exit` 主动取消当前运行。没有有效阶段报告或模型被中断时，本轮退出并保留检查点。审计记录保存已通过验收的阶段事实和候审提交。

## 当前识别的任务书入口

任务书和事实清单仍使用 Markdown。原型只解析任务标识、仓库、分支、目标类型与可选事实文件。检查与验收细节保留原文，交由当前阶段理解。Facts 可以用同目录下的相对路径，含下级目录。

```markdown
# 修正报告生成行为

Taskbook ID: demo-01
Repository: owner/demo
Base branch: main
Work branch: agent/report
Facts: ./demo.facts.md

## Goal

Type: fix-feature

通过正常入口生成报告时，即使数据为空也应输出一份表头完整的报告。

## Delivery

给出实现、本地交付提交及可复跑的验收证据。
```

目标类型包括 `new-feature`、`fix-feature`、`new-experiment` 和 `fix-experiment`。可用 `Base commit` 固定完整提交 ID。若当前 GitHub origin 使用了 SSH Host 别名，需要先调整本地仓库校验规则或使用标准 GitHub origin。

## 阶段驱动与原文输入

`startPhase` 从审计状态取阶段，用 `buildPhaseInput` 组装当地规则、任务书、事实、前序报告及该阶段的上游方法，仅启动一次当前阶段的模型轮次。`taskbook_report` 复核阶段执行标识、报告和 Git 快照。`nextPhase` 只依据类型、当前阶段和经过校验的结果决定迁移。

同时设置 `PI_TASKBOOK_PSTACK_ROOT` 与 `PI_TASKBOOK_MATT_ROOT` 后，插件可从两份本地 Git checkout 读取原文。首次接收时固定两个 commit。已有记录恢复时沿用原有版本。两者都未配置时可运行原型自带的本地提示词。

| 阶段 | 选择的上游方法 |
| --- | --- |
| 事实核查 | PStack Prove It Works。修复类任务另取 Matt diagnosing-bugs Phase 1–2。 |
| 澄清与设计 | PStack Model the Domain 和 Matt codebase-design。 |
| 实现与取证 | PStack Sequence Work into Verifiable Units。新任务加 Matt tdd 及附文，修复类继续 diagnosing-bugs Phase 3 及之后。 |
| 规格与质量审核 | 分别取 Matt code-review 的 Spec 和 Standards 执行部分，并搭配相应的 PStack 原则。 |
| 性能验证 | PStack benchmark-checklist。实验类型必经，其他任务由质量阶段报告测量需要后进入。 |

`phaseSources` 固定可加载的路径与必要原文章节。运行阶段由插件自身维护，可重用上游方法而无需运行上游入口。

当前原型在规格和质量阶段依次接收报告。插件校验审核标识非空、两次标识不同以及候审 SHA 相同。T3 子会话由现有阶段提示词请求，报告标识仍由模型提供。程序化委派并校验子会话回执属于后续接入。性能阶段目前在审核之后运行，测量需要的改动前基线应由任务准备阶段先提供。

运行依赖 [Pi Extensions](https://docs.pi.dev/latest/extensions) 与 T3 的 [thread launch MCP 约定](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md#t3_thread_launch)。上游来源见 [PStack](https://github.com/cursor/plugins/tree/main/pstack) 和 [Matt Pocock 的 skills](https://github.com/mattpocock/skills)。
