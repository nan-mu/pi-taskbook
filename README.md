# pi-taskbook

Pi 使用一条有状态的执行流程处理任务书。当前版本是可运行的原型，目标运行环境为 Pi 1.5.2。

## 任务类型与共用流程

页首的 `Entry` 给出任务类型。例如 `**Entry** New feature` 解析为 `new-feature`。旧任务书可继续用 `Goal` 下的 `Type`。两处同时出现时须一致。

所有类型使用同一套阶段状态。核查任务依据 → 澄清与设计 → 实施并取证 → 规格审核 → 质量审核。实验类或质量阶段要求测量时进入性能验证。类型用于选择阶段提示词。例如核查修复类任务时，Pi 要求复现或核实原缺陷。修复实验的设计与取证还要明确受影响数据、重跑范围及仍有效的结果。

## 安装与使用

在运行 T3 Code 的机器上用 `pi install /absolute/path/to/pi-taskbook` 安装到 Pi。将 `.audit/pi-taskbook/` 加入对应仓库的 Git 排除配置。

| 工作区准备方式 | Pi 执行 |
| --- | --- |
| `/taskbook-new <任务书路径>` | 在当前项目解析固定基线，用 Git 建立新分支和 linked worktree。任务书有 Work branch 时采用该名字。随后直接调用 T3 MCP 的 `t3_thread_launch`。新 thread 在已创建的 worktree 上接收一条内部 `/taskbook` 命令。 |
| `/taskbook <任务书路径>` | 在当前持久会话内核对 GitHub origin、工作分支、linked worktree 和基线，通过后建立审计记录并开始事实核查。重交同一任务书可从检查点恢复。 |

自动准备 worktree 需要 T3 为 Pi 注入本地 MCP 端点，以及 `PI_TASKBOOK_WORKTREE_ROOT` 指向已有的专用目录。接收端复核实际目录、任务书和事实摘要以及固定基线。新分支从 `Base commit` 或本地基线分支解析的提交创建。既有 worktree 的无显式 SHA 基线取其 HEAD 与基线分支的 merge-base。两种工作区准备方式汇入同一接收处理代码。工作区通过校验后进入共用事实核查阶段。任务书未指定 Work branch 时，已有 worktree 使用其当前命名分支，新建命令使用 `agent/<任务标识>`。Taskbook ID 缺省时使用由内容摘要派生的标识。MCP 回执缺失时，检查原 thread 是否已建立，保留已创建的 worktree 供核对。

`/taskbook-exit` 主动取消当前运行。没有有效阶段报告或模型被中断时，本轮退出并保留检查点。审计记录保存已通过验收的阶段事实和候审提交。

## 当前识别的任务书格式

任务书和事实清单仍使用 Markdown。原型只解析任务标识、仓库、分支、目标类型与可选事实文件。检查与验收细节保留原文，交由当前阶段理解。Facts 可以用同目录下的相对路径，含下级目录。

```markdown
# 修正报告生成行为

**Repository** `owner/demo`
**Base commit** `0123456789012345678901234567890123456789`
**Entry** Fix feature

## Goal

通过正常入口生成报告时，即使数据为空也应输出一份表头完整的报告。

## Facts

1. 项目的公共入口负责生成报告。

## Delivery

给出实现、本地交付提交及可复跑的验收证据。
```

Entry 可写 `New feature`、`Fix feature`、`New experiment` 或 `Fix experiment`。需给出 Base commit 或 Base branch。若当前 GitHub origin 使用 SSH Host 别名，需对应调整本地仓库校验规则或使用标准 GitHub origin。

## 阶段驱动与附加提示词

`startPhase` 从审计状态取阶段，用 `buildPhaseInput` 组装阶段指导、任务书、事实、前序报告及该阶段的上游方法，仅启动一次当前阶段的模型轮次。`taskbook_report` 复核阶段执行标识、报告和 Git 快照。`nextPhase` 只依据类型、当前阶段和经过校验的结果决定迁移。

插件从两份必需的本地 Git checkout 读取上游原文。`PI_TASKBOOK_PSTACK_ROOT` 指向 cursor/plugins 的仓库根，`PI_TASKBOOK_MATT_ROOT` 指向 mattpocock/skills 的仓库根。两者均使用绝对路径。新任务固定两个提交，并检查首次核查所需的文件和段落。后续阶段按保存的版本读取所需片段，失败时报告具体来源。旧任务恢复时，如果缺少上游记录，先验证当前阶段的来源，再保存固定版本。

| 阶段 | 本轮实际附加的内容 |
| --- | --- |
| 核查任务依据 | 附加 `pstack:principle-prove-it-works` 与 `matt:research` 中逐项追溯一手来源的条款。修复类额外附加 `matt:diagnosing-bugs` 的 Redact 与第 1–2 阶段。 |
| 澄清与设计 | 附加 `pstack:principle-model-the-domain` 和 `matt:codebase-design`。 |
| 实施并取证 | 附加 `pstack:principle-sequence-verifiable-units`。新增功能额外附加 `matt:tdd` 和两份附文，新增实验额外附加 `pstack:benchmark-checklist`，修复类额外附加 `matt:diagnosing-bugs` 第 3 阶段及以后。 |
| 规格审核 | 附加 `matt:code-review` 的 Spec 段和 `pstack:principle-prove-it-works`。 |
| 质量审核 | 附加 `matt:code-review` 的 Standards 提示词与第 3 节审查清单，以及 `pstack:principle-minimize-reader-load`。 |
| 性能验证 | 附加 `pstack:benchmark-checklist`。实验类型必经，功能任务在质量阶段报告测量需要时进入。 |

`phaseSources` 按类型和阶段选择补充提示词。`workflow.ts` 维护状态和迁移。设计参考 `pstack:poteto-mode:Feature` 的先追踪受影响系统、再设计的顺序。

### 事实核查的输入与报告

当前主会话执行 `prompts/fact-check.md` 和对应入口的指导。任务书里的 Facts 随原文进入，另有事实附件时附加一次。例如，目标引用 /fact(1) 声明了旧输出目录，主会话用它定位基线实现，再以源代码或运行输出判断声明是否成立。任务书内列出的未来验收步骤只描述预期检查。

主会话用 `factChecks` 提交决定是否能进入设计的主张、原文摘录和来源。`taskbook_report` 在工具调用内同步核对当前 attempt。通过报告至少需要一条可复查来源。Git 引用由 `checkFacts` 在固定基线的指定文件行核对，工具引用与本轮工具回执和原始输出比对。错误引用可在当前阶段修正。没有足够依据可以提交 blocked。如果轮次结束仍没有有效报告，保留检查点并退出。

代码校验来源、位置及摘录的一致性。主会话判断观察是否触达目标、是否足以支持主张，以及是否覆盖关键前提。命令返回非零可以是正确的故障复现，需解释它和目标症状的关系。下一阶段能看到已接受的记录及其出处。恢复旧检查点会保留历史报告，新增的引用校验适用于此版本新提交的事实核查报告。

### 本地回归

安装 Pi 1.5.2 并准备 Git 和 Python 3 后，在仓库根运行 `python3 tests/workflow_rpc.py`。测试使用临时 Git 工作区及实际 Pi RPC，以本地模型与 MCP 替身验证插件发出的调用、报告接受与拒绝、退出和恢复。可用 `PI_BIN` 指定 Pi 可执行文件。若已设置上文的两个仓库路径，可运行 `node --test tests/upstream.test.ts`，逐项检查本机实际上游版本的提示词片段。

当前原型在规格和质量阶段依次接收报告。插件校验审核标识非空、两次标识不同以及候审 SHA 相同。T3 子会话由现有阶段提示词请求，报告标识仍由模型提供。程序化委派并校验子会话回执属于后续接入。性能阶段目前在审核之后运行，测量需要的改动前基线应由任务准备阶段先提供。

运行依赖 [Pi Extensions](https://docs.pi.dev/latest/extensions) 与 T3 的 [thread launch MCP 约定](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md#t3_thread_launch)。上游来源见 [PStack](https://github.com/cursor/plugins/tree/main/pstack) 和 [Matt Pocock 的 skills](https://github.com/mattpocock/skills)。
