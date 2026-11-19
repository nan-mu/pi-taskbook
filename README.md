# pi-taskbook

Pi 使用一条有状态的执行流程处理任务书。当前版本是可运行的原型，目标运行环境为 Pi 1.5.2。

## 任务类型与共用流程

页首的 `Entry` 给出任务类型。例如 `**Entry** New feature` 解析为 `new-feature`。旧任务书可继续用 `Goal` 下的 `Type`。两处同时出现时须一致。

新增和修复共用同一套阶段。工作会话核查前提，独立事实审核者审定候选主张。实施者完成设计、改动和取证后，插件固定候审提交，依次派发独立规格审核和质量审核。实验类先测量再送审，功能类可由交付审核要求补测。测量后的候审材料重新经两审。可修复缺项回到实施，事实冲突进入用户裁决。

## 安装与使用

在运行 T3 Code 的机器上用 `pi install /absolute/path/to/pi-taskbook` 安装到 Pi。将 `.audit/pi-taskbook/` 加入对应仓库的 Git 排除配置。

| 工作区准备方式 | Pi 执行 |
| --- | --- |
| `/taskbook-new <任务书路径>` | 在当前项目解析固定基线，用 Git 建立新分支和 linked worktree。任务书有 Work branch 时采用该名字。随后直接调用 T3 MCP 的 `t3_thread_launch`。新 thread 在已创建的 worktree 上接收一条内部 `/taskbook` 命令。 |
| `/taskbook <任务书路径>` | 在当前持久会话内核对 GitHub origin、工作分支、linked worktree 和基线，通过后建立审计记录并开始事实核查。重交同一任务书可从检查点恢复。 |

自动准备 worktree 需要 T3 为 Pi 注入本地 MCP 端点，以及 `PI_TASKBOOK_WORKTREE_ROOT` 指向已有的专用目录。接收端复核实际目录、任务书和事实摘要以及固定基线。新分支从 `Base commit` 或本地基线分支解析的提交创建。既有 worktree 的无显式 SHA 基线取其 HEAD 与基线分支的 merge-base。两种工作区准备方式汇入同一接收处理代码。工作区通过校验后进入共用事实核查阶段。任务书未指定 Work branch 时，已有 worktree 使用其当前命名分支，新建命令使用 `agent/<任务标识>`。Taskbook ID 缺省时使用由内容摘要派生的标识。MCP 回执缺失时，检查原 thread 是否已建立，保留已创建的 worktree 供核对。

`/taskbook-exit` 主动取消当前运行。没有有效阶段报告或模型被中断时，本轮退出并保留检查点。审计记录保存已通过验收的阶段事实和候审提交。

## 当前识别的任务书格式

任务书和事实清单仍使用 Markdown。插件读取任务元数据，并把 Goal、Facts、Delivery 分别标记为 G、F、D 条目，保留完整原文。经过独立复核的新增事实记为 V 条目。Facts 可以用同目录下的相对路径，含下级目录。

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

每个工作阶段使用新的上下文边界。插件提供原任务书、当前有效事实与用户裁决、当前阶段选定的上游提示词，以及本阶段需要的报告。设计建议可按证据调整。任务书里的历史行为、目标要求的未来行为、实际执行结果分别解释。

以下三个时点由插件直接创建新的只读 Pi SDK 会话。每次派发使用当前选择的模型，工具只开放 `inspect_revision`。审核者可在基线和候审 Git 对象上独立查看文件、差异及改变的路径。工具返回的观察由插件编号；回执记录审核角色、会话 ID、模型、版本和上下文摘要。上游提示词参与各角色的判断，状态迁移由插件执行。

| 派发时点 | 上下文与职责 | 通过后可依赖的结果 |
|---|---|---|
| 新主张进入事实表之前 | 对照当前受保护事实、待审主张、出处和固定基线，判断证据是否相干以及版本是否一致。 | 通过的主张加入有效事实表。被退回的提案留在审计中，可补证重报。 |
| 候审材料就绪后 | 规格审核逐条对照目标、交付要求和有效事实。观察固定 Git 快照，引用适用于该提交的实际运行记录。 | 必需条目都有该审核会话的判断。遗漏或实现错误送回实施。 |
| 同一候审的规格通过后 | 新的质量审核者读取任务书、当前事实、候审材料与 Standards 提示词。它不能继承规格审核会话或替其背书。 | 两份有效回执属于同一候审；如有正式测量需求，要带新测量结果重审。 |

插件从两份必需的本地 Git checkout 读取上游原文。`PI_TASKBOOK_PSTACK_ROOT` 指向 cursor/plugins 的仓库根，`PI_TASKBOOK_MATT_ROOT` 指向 mattpocock/skills 的仓库根。两者均使用绝对路径。新任务固定两个提交，并检查首次核查所需的文件和段落。后续阶段按保存的版本读取所需片段，失败时报告具体来源。旧任务恢复时，如果缺少上游记录，先验证当前阶段的来源，再保存固定版本。

| 阶段 | 本轮实际附加的内容 |
| --- | --- |
| 核查任务依据 | 附加 `pstack:principle-prove-it-works` 与 `matt:research` 中逐项追溯一手来源的条款。修复类额外附加 `matt:diagnosing-bugs` 的 Redact 与第 1–2 阶段。 |
| 独立事实复核 | 附加 `pstack:principle-prove-it-works` 与 `matt:research` 的溯源条款。 |
| 澄清与设计 | 附加 `pstack:principle-model-the-domain` 和 `matt:codebase-design`。 |
| 实施并取证 | 附加 `pstack:principle-sequence-verifiable-units`。新增功能额外附加 `matt:tdd` 和两份附文，新增实验额外附加 `pstack:benchmark-checklist`，修复类额外附加 `matt:diagnosing-bugs` 第 3 阶段及以后。 |
| 规格审核 | 附加 `matt:code-review` 的 Spec 段和 `pstack:principle-prove-it-works`。 |
| 质量审核 | 附加 `matt:code-review` 的 Standards 提示词与第 3 节审查清单，以及 `pstack:principle-minimize-reader-load`。 |
| 性能验证 | 附加 `pstack:benchmark-checklist`。实验任务在实施后进入。功能任务在规格或质量审核要求正式测量时进入。 |

`phaseSources` 按类型和阶段选择补充提示词。`workflow.ts` 维护状态和迁移。设计参考 `pstack:poteto-mode:Feature` 的先追踪受影响系统、再设计的顺序。

### 事实核查的输入与报告

当前主会话执行 `prompts/fact-check.md` 和对应入口的指导。任务书里的 Facts 随原文进入，另有事实附件时附加一次。例如，目标引用 /fact(1) 声明了旧输出目录，主会话用它定位基线实现，再以源代码或运行输出判断声明是否成立。任务书内列出的未来验收步骤只描述预期检查。

主会话用 `factChecks` 提交决定是否能进入设计的主张、原文摘录和来源。`taskbook_report` 在工具调用内同步核对当前 attempt。通过报告至少需要一条可复查来源。Git 引用由 `checkFacts` 在固定基线的指定文件行核对，工具引用与本轮工具回执和原始输出比对。错误引用可在当前阶段修正。没有足够依据可以提交 blocked。如果轮次结束仍没有有效报告，保留检查点并退出。

代码先验证出处和摘录，独立事实审核者再判断证据是否支持主张。提案得到认可后才进入受保护的事实表。来自当前阶段之外的对话、旧候审结论和实现者的自评都不能充作独立回执。

### 冲突、返工与实现自由

若同一对象、版本和条件下的新证据与既有事实不相容，插件记录双方依据并暂停。用户通过 `/taskbook-decide F1 keep <理由>` 保留原事实，或通过 `/taskbook-decide F1 replace <完整新事实>` 指定有效内容。两种操作都保留原始任务书与裁决历史，并重新核查。重启仍会读到待裁决记录。

例如 libbpf-mcu 的 F1 记载基线使用 ../build，G1 授权改为仓库内 build/。两项同时有效。若只改 build 而 clean 仍指向旧目录，规格审退回 G1，实施者可以自行选择修法。G2 把布局交给实现者；G5 要求下游实读，F8 给出的是计划，验收仍须核对实际结果。G4 的本地准备与用户保留的正式发布决定分别审查。

每次提交实施结果都会建立新的候审记录。即使只补运行证据，仍需针对更新后的材料出具审核结论。旧记录保留以便追溯。实现或测量阶段可引用实际工具调用的回执；代码核对其调用前后是同一干净提交，并把工具输入、结果摘录与版本交给审核者。独立审核结论可逐项引用该版运行证据。旧版未取得独立回执的运行记录在恢复时重新核查。

这些保证适用于插件的正常调用路径。代码核验角色、条目覆盖、来源和版本，模型判断自然语言含义与证据充分性。工作进程与插件同属一个系统用户时，本地审计文件受该系统用户权限控制。

### 本地回归

- `python3 tests/workflow_rpc.py` 运行真实 Pi RPC 与独立 SDK 会话，模型和 T3 使用本地替身。可用 `PI_BIN` 选择 Pi 1.5.2。
- `node --test tests/memory.test.ts` 检查任务条目、历史事实、用户裁决和上下文选择。
- 配置两个实际上游后，`node --test tests/upstream.test.ts` 可核查全部任务类型与阶段的原文选择。
- 在仓库内用 Yarn 安装开发依赖后，在仓库根运行 `node tests/case_review.mjs /absolute/path/to/libbpf-mcu-build-and-release-taskbook.md`，可选第二个参数指定 JSON 轨迹输出文件。它以完整任务书审核缩小的候审 Git 样本。模型结论采用受控应答，真实下游业务构建须在对应项目环境执行。

运行依赖 [Pi Extensions](https://docs.pi.dev/latest/extensions) 与 T3 的 [thread launch MCP 约定](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md#t3_thread_launch)。上游来源见 [PStack](https://github.com/cursor/plugins/tree/main/pstack) 和 [Matt Pocock 的 skills](https://github.com/mattpocock/skills)。
