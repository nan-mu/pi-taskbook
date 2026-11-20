# 任务书与执行流程

## 任务书格式

用目标仓库的 GitHub `owner/repo` 和本地可解析的基线替换示例值。带空格的文件路径可以加双引号。

```markdown
# 修复空数据报告

**Repository** `owner/demo`
**Base branch** `main`
**Entry** Fix feature

## Goal

输入为空时，公共入口仍生成含完整表头的报告。

## Delivery

给出交付提交和复跑该用例的命令。
```

- `Entry` 支持 `New feature`、`Fix feature`、`New experiment` 和 `Fix experiment`。旧任务书可在 `Goal` 下用 `Type` 表达同一类型。两处均填写时须一致。
- `Repository` 须与标准 GitHub `origin` 对应。至少填写 `Base commit` 或 `Base branch`。提交使用完整 SHA。两项都填写时，提交须在基线分支的历史中。
- 可用 `Taskbook ID` 固定任务标识。省略时从任务书及事实附件摘要生成。`Work branch` 可指定任务分支。
- 可增加 `## Facts`，逐条填写已有事实。页首另可用 `Facts: ./facts.md` 引用附件，文件须位于任务书目录内。插件为目标、事实和交付项分配 `G`、`F`、`D` 编号。任务书中的 `/fact(1)` 指向第一条事实。
- 在任务中新增、修改或退役长期事实时，使用[项目事实和术语的授权格式](project-memory.md)。

## 工作区与基线

`/taskbook` 在当前 linked worktree 和持久 Pi 会话执行。指定 `Work branch` 时，当前分支须匹配。仅指定 `Base branch` 时，基线是该分支和当前 HEAD 的 merge base。

`/taskbook-new` 解析本地基线提交和工作分支，向 T3 发送托管 worktree 请求。默认分支名是 `agent/<任务标识>`。T3 创建 worktree 和会话，并将任务交给该会话的 Pi。接收端核对仓库、分支、基线和任务书摘要。启动回执丢失时，重交同一任务书会沿用请求标识。

## 阶段与证据

| 阶段 | 输入和结果 |
| --- | --- |
| 事实核查 | 主会话提交主张、摘录和来源。插件在固定基线检查 Git 引用，在本轮工具记录中检查工具摘录。 |
| 独立事实审核 | 审核者判断证据能否支持主张。独立通过的结果按适用版本写入项目事实。补证和冲突记录留在检查点。 |
| 设计 | 设计者为每个步骤提供 ID、行动、验收与覆盖的目标，提交版本化计划。可通过 `taskbook_consult` 获取独立只读建议，或通过 `taskbook_probe` 在临时检出上运行实验。实验进程使用当前操作系统账户的权限。 |
| 实施与测量 | 执行者按当前计划改动、提交和取证。插件要求候审工作区干净。实验类直接进入正式测量，功能类可由审核要求补测。 |
| 独立规格审核 | 在候审提交上逐项检查目标、交付要求、有效事实、计划验收和用户裁决。执行证据须对应同一提交。 |
| 独立质量审核 | 新的审核会话检查同一候审提交的质量。改动或补测后，插件重新派发规格和质量审核。 |
| 交接 | 两审通过后显示「可交接」、交付提交和审计路径。Magpie 同步结果单列。推送、创建 PR 和合并由接手者处理。 |

每个工作阶段的输入包括任务书、有效事实、该阶段的方法和所需报告。独立审核的工具仅有 `inspect_revision`。审核者可读取固定 Git 对象上的文件和差异。插件记录会话、模型、候审版本及带编号的观察。审核者判断自然语言中的含义和证据充分性。

实施和测量可以提交工具观察回执。插件核对工具调用前后是同一干净提交，并向审核者提供输入、输出摘录和提交 ID。新的实施报告会建立候审记录。补测后，两份审核都要核对新证据。

## 暂停与恢复

- 审核发现证据与既有事实冲突时，Pi 保存双方依据。用 `/taskbook-decide F1 keep <理由>` 或 `/taskbook-decide F1 replace <完整新事实>` 裁决。插件保留原文并重新核查。
- 计划遇到缺口时，实施者提交步骤、观察和待决问题。设计者可修订计划。需要用户决定时，用 `/taskbook-answer <决定>` 继续。
- 如果模型中断或本轮没有有效报告，在原持久会话重交同一份任务书。交接消息列出检查点路径。文件位于 Git worktree 元数据的 `pi-taskbook/runs/`，可查已接受的报告、裁决和候审提交。旧格式检查点的处理见[迁移与恢复](project-memory.md#迁移与恢复)。

## 方法目录

PStack 和 Matt Pocock 的方法条目分别记录在 [pstack.json](../methods/pstack.json) 和 [matt.json](../methods/matt.json)。每条注明上游版本、适用阶段和采纳范围。插件按任务类型与阶段附加核心方法。工作会话可用 `taskbook_method` 读取本阶段的其它条目，例如实施阶段的 `matt:pr`。

离线目录和执行流程图可由仓库中的脚本生成。流程图使用运行时相同的阶段方法选择。

```sh
python3 tools/render-catalog.py /tmp/pi-skill-catalog.html
python3 tools/render-statecharts.py /tmp/pi-taskbook-statecharts.html
```
