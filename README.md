# pi-taskbook

把自己的任务书执行提示词加载进 Pi。流程入口是接受任务书，出口是交接、阻塞或用户退出。当前版本是可运行的原型，目标运行环境为 Pi 1.5.2。

## 安装与使用

在运行 T3 Code 的机器上，用当前 Pi 安装本地仓库目录，例如 `pi install /absolute/path/to/pi-taskbook`。也可以用 `pi -e ./index.ts` 单次试用。用 T3 Code 创建或选择已绑定的 linked worktree。将 `.audit/pi-taskbook/` 加入仓库的 Git 排除配置。可使用 Git 的本地 exclude，以便同时保留仓库已有的术语文件跟踪规则。

在持久 Pi 会话中输入 `/taskbook /absolute/path/to/taskbook.md`。第一个参数是整段文件路径，包含空格时可以加双引号。结束时插件显示结果和记录位置。被中断或服务重启时，用同一 Pi 会话和同一任务书路径恢复。任务书正文或随附事实变动会产生新的运行记录。可用 `/taskbook-exit` 结束已加载任务，审计记录会保留。

验证 checkout 时检查 GitHub origin、工作分支、linked worktree 和基线。基线用显式 Base commit，或用 Base branch 与当前 HEAD 的 merge-base。审阅快照是干净工作区对应的 Git 提交。实施之后改动快照时，先退出，再按更新后的任务书开启一轮。

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

## 提示词与流程

| 阶段 | 设计来源 | 接到任务书流程后的行为 |
| --- | --- | --- |
| 事实核查 | PStack Bug fix / Perf issue，Matt diagnosing-bugs | 先证明问题和任务前提，控制准备和复跑成本。 |
| 澄清与设计 | PStack architect / prototype，Matt grill-with-docs / domain-modeling | 优先查已有事实，记录真正改变决定的接口与术语。 |
| 实现与取证 | PStack Proof 与 Prove It Works，Matt tdd | 用真实入口跑小切片和验收，长期测试遵守任务书批准点。 |
| 规格审核 | Matt code-review 的 Spec 轴 | 新审核会话针对固定提交检查任务书的完成判据。 |
| 质量审核 | Matt code-review 的 Standards 轴 | 新审核会话独立判断质量和仓库规范，本流程串行执行。 |
| 性能验证 | PStack benchmark-checklist | 按任务意图与成本分流，用可比较的基线、数据和复跑支撑结论。 |

`prompts/common.md` 写所有阶段共有的约定。各阶段在自己的 Markdown 中维护。插件读取这些文件，在进入阶段时选择相应提示词。改完提示词后重载 Pi 扩展。从模型输出和任务书正文提及的 skill 名称不会触发加载。普通 Pi 历史可能仍含旧阶段的消息，独立审核通过新的 T3 子会话隔离。

原型使用内置的 `taskbook_report` 提交阶段结果。程序检查运行标识、状态转移、报告证据、所报审核 thread 标识的存在与唯一性以及待审提交是否变化。审阅者的实际身份、报告证据的真实性、正文里的审批点和用户运行的工作区权限，需要由主会话及 T3 审核能力确认。阶段提示词里的只读要求依赖 T3 权限和审核者行为。原型按单会话串行运行，使用该任务唯一的 T3 worktree。

PStack 和 Matt 的设计来源分别见 [poteto-mode](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/SKILL.md)、[PStack 操作指南](https://github.com/cursor/plugins/blob/main/pstack/docs/guide/02-poteto-mode.md) 和 [Matt Pocock 的 skill 索引](https://github.com/mattpocock/skills)。运行依赖 [Pi Extensions](https://docs.pi.dev/latest/extensions) 以及可选的 [T3 Code Pi 集成](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-pi.md)。原型提示词可直接在此仓库维护。
