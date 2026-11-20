# 项目事实与术语

## 查询主题事实

在 Pi 会话中调用 `taskbook_query_facts`。例如传入 `{"query":"worktree"}`，会从当前工作树的 `.fact/label.tsv` 确认标签，再跨主题表查找带该标签的事实。可传入 `{"label":"worktree","query":"t3"}` 缩小结果。未注册为标签的查询词会搜索事实正文和路径。工具默认返回五条，可以用 `limit` 指定一至十条。

标签匹配决定候选范围。额外的查询词按覆盖度排序，同等相关时优先返回有来源、表述简短的事实。结果带上路径、行 ID 和来源，方便回查。`change.tsv` 用于按需追溯。主题表格式和示例见 [提示词草稿](design/project-memory-prompt.md) 与 [事实示例](design/project-memory-examples.tsv)。

## 任务书事实审核

任务书里的 `Facts` 是该任务的原始依据。事实核查者逐条取证，独立事实审核者检查来源、范围和矛盾。独立通过的核查结果按观测提交归档。同一基线上的后续任务可以读取。

要让事实或术语跨提交持续生效，任务书可包含 `## Project memory` 或 `## 项目记忆`。每个条目给出操作、种类、稳定标识、预期版本、适用范围，以及正文或退役理由。例如，下面是一份任务书的两项授权。

```markdown
## 项目记忆
- create term delivery-receipt @0 | 发布团队 | 交付回执指接收方确认收到指定版本的记录。构建成功日志属于构建证据。
- create fact verifier-path @0 | release-tools | 当前验证脚本读取 release.json 内的 artifact 字段。
```

后续任务可以在同一事务中修订第一条、退役第二条。版本指向**执行前**读到的记录。独立审核者须逐项确认原文授权和实际证据，缺少证据退回核查。任务书中只有目标或未来计划时，现有事实仍然约束实施。恢复一个已退役条目可以使用 `create` 并引用其退役版本。

```markdown
## 项目记忆
- update term delivery-receipt @1 | 发布团队 | 交付回执须同时标识接收方和已接收版本。
- delete fact verifier-path @1 | release-tools | 旧版验证脚本已退役。
```

混合核查时，审核者须为每个通过的 P 项判断用途。例如 M1 替换术语，P1 观察另一个命令的退出码，P2 描述旧词义。P1 使用 `independent` 并成为按观测提交限定的项目事实。即使 linked worktree 的 HEAD 已领先任务基线，本任务的设计和规格审仍可使用该次独立通过的 P1，其他任务按自身基线取用。P2 使用 `change-evidence`，保存在 M1 的来源中。审核者也会看到已替换及退役的版本，可以检查旧断言是否被当作新事实重新提出。若来源、摘录与范围相同，插件会规范化 Unicode、空白及句末句点来识别重复观察。其他改写、不同来源的同义陈述需要独立审核者判断。

## 文件与版本

项目 A 的事实和术语放在 `.fact/facts.tsv`。来自项目 B 的记录放在 `.fact/b/facts.tsv`。目录用仓库短名，记录用完整的 `owner/repo` 和来源 ID 区分同名项目。

```text
项目 A/
└── .fact/
    ├── facts.tsv
    └── b/
        └── facts.tsv
```

TSV 表头列出行类型、ID、版本、事实类型、状态和来源。现行记录、历史版本、证据和事务回执各占一行。文本中的反斜杠、制表符和换行会转义。来源含仓库、任务、摘要、基线和独立审核会话。标记为 `commit:<SHA>` 的观察用于对应提交及该任务经过审核的回放。

任务书也可在 `Facts` 中用编号表达创建授权，例如 ``1. `create` · `decision` — …``。该记录保存原 `F1` 引用和类型。正文中的 `/fact(1)` 仍指向原任务书第一条事实。长期事实与术语使用 `project:fact:<key>` 和 `project:term:<key>`。默认术语清单为根目录 `GLOSSARY.md`。项目可在 `docs/agents/domain.md` 或 `AGENTS.md` 写下 `` The glossary lives at `path` `` 以指定仓库内路径。插件只写标注的术语管理区。

同一工作区的写入串行化。写入前核对审核时的事实快照，变化时重新审核。独立事实审核写入由当前 Git 分支承载。不同分支通过正常合并交换已审核事实。同一事实的并发修改应在合并时保留双方来源和版本，重新审核冲突后的内容。

| 要核对的内容 | 命令 |
| --- | --- |
| 已提交的快照与退役记录 | `git show HEAD:.fact/facts.tsv` |
| 分支上的事实和术语历史 | `git log -- .fact/facts.tsv GLOSSARY.md` |
| 候审事实与术语 | `git show <候审提交>:.fact/facts.tsv` |
| 当前任务的审核、同步结果与回执 | `<Git worktree 目录>/pi-taskbook/runs/<任务 ID>-<摘要前缀>/state.json` |

出现未经授权的矛盾时，插件暂停，显示当前事实 ID 和冲突证据。针对 `project:term:delivery-receipt` 可用 `/taskbook-decide project:term:delivery-receipt keep <保留理由>` 或 `/taskbook-decide project:term:delivery-receipt replace <新定义>` 裁决。替换需要针对同一版本再次独立审核。审核者根据项目词汇表、定义的上下文和实际用例检查同名异义词。此处借鉴 Matt 的词汇表和上下文检查，以及 PStack 对可复核证据的要求。[Matt 的领域建模](https://github.com/mattpocock/skills/blob/5863806dd4e15c63174bee4e7515a4256792ecfa/skills/engineering/domain-modeling/SKILL.md) · [PStack 的证据原则](https://github.com/cursor/plugins/blob/e58dd043600587dbaf58ba315e7f2b38373eeb43/pstack/skills/principle-prove-it-works/SKILL.md)

任务书选用 `cross-project:rule`、`cross-project:preference`、`cross-project:fact` 或 `cross-project:term` 表示明确授权发布对应跨项目记忆。项目术语需要说明为何跨项目仍有相同含义。发布适用条件及冲突处理见 [Magpie 记忆规则](../methods/magpie-memory/SKILL.md)。


## 迁移与恢复

1. 在目标工作区运行 `/taskbook-setup`，看旧 `.audit`、事实 JSON 和 Git 引用需要迁到哪里。
2. 批准迁移后，插件把可识别的事实导入 TSV，把旧 `.audit` 原样复制到 Git worktree 元数据中的 `pi-taskbook/legacy-audit`。可恢复的检查点复制到 `pi-taskbook/runs`。无法识别的内容保存在归档中。
3. 用 `git show HEAD:.fact/facts.tsv` 核对导入结果。选择保留原 `.audit`，或另行批准删除。删除前会再次核对原件、归档和已导入条目。当前术语清单位于 `.audit` 内时，先按项目约定迁出并更新路径声明。
4. 用 `git rev-parse --absolute-git-dir` 找到检查点目录。兼容的旧检查点使用原会话和原任务书，重新审核 TSV 对应的事实版本。旧格式如果无法验证历史审核或冲突裁决，保留原始检查点，使用新的 Taskbook ID 重新核查。
5. 用 Git 历史定位事实和术语变更。后续任务可提交经独立审核的纠正或退役。回退到旧版插件前，保留 TSV 与已核对的原始资料。

## MCP 能力

Setup 从当前 Pi 会话实际工具目录读取工具名与服务名。工具已发现只证明该会话注册了工具。运行时身份、权限、分页和写入条件由完成同步验证。

| 服务 | 能力 | 用途 |
| --- | --- | --- |
| Magpie | `memory_context` | 确认 agent、项目、搜索范围和写入条件。 |
| Magpie | `memory_search` | 在明确范围内按来源、远端 ID 和版本核对记录。 |
| Magpie | `memory_save` | 对有当前项目授权的记录创建或按 ID、预期版本更新。 |
| Magpie | `memory_forget` | 依据已审核的退役和预期版本撤回当前项目记录。 |
| GitHub | 仓库文件、Issue 读取与搜索、PR 元数据与 diff | 为声明依赖 GitHub 的任务取证。 |
| GitHub | 工作流声明的写操作 | 由 setup 单列。实际写入前仍核对授权、身份和目标。 |

其他项目的镜像使用 `.fact/<仓库名>/facts.tsv`。它只接收对当前项目适用且来源可证的其他项目记录。分页缺失、查询未命中或断线保留现有记录。当前项目发起的同步对其他项目记录只读取。纳入版本控制或发布该文件需要单独授权。

默认 Magpie 接口的文本搜索可作为候选证据。需要以结构化作用域、归属、版本条件或退役信号为依据的操作显示为待处理。原 Pi 进程有已发现且可调用的 MCP 工具时使用该会话。重启后若可用的回退入口只支持读取，待写入项保持待处理。重新提交同一任务书可核对远端回执。
