# 项目事实与术语

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

`.fact/project.json` 是以项目事实 ID 为键的 JSON 文档。顶层 `schema` 定义文件格式，`records` 保存文件内容，`applied` 保存任务书操作的重试标识。记录包含种类、范围、版本、状态、来源和历史。来源标注仓库、任务、摘要、基线、独立审核会话和证据。标记为 `commit:<SHA>` 的观察只在对应提交与该任务经过审核的回放中适用。

任务书也可在 `Facts` 中用编号表达创建授权，例如 ``1. `create` · `decision` — …``。该记录保存原 `F1` 引用和类型。正文中的 `/fact(1)` 仍指向原任务书第一条事实。长期事实与术语使用 `project:fact:<key>` 和 `project:term:<key>`。默认术语清单为根目录 `GLOSSARY.md`。项目可在 `docs/agents/domain.md` 或 `AGENTS.md` 写下 `` The glossary lives at `path` `` 以指定仓库内路径。插件只写标注的术语管理区。

同一工作区的写入串行化。写入前核对审核时的事实快照，变化时重新审核。独立事实审核写入由当前 Git 分支承载。不同分支通过正常合并交换已审核事实。同一事实的并发修改应在合并时保留双方来源和版本，重新审核冲突后的内容。

| 要核对的内容 | 命令 |
| --- | --- |
| 已提交的快照与退役记录 | `git show HEAD:.fact/project.json` |
| 分支上的事实和术语历史 | `git log -- .fact/project.json GLOSSARY.md` |
| 候审事实与术语 | `git show <候审提交>:.fact/project.json` |
| 当前任务的审核、同步结果与回执 | `.audit/pi-taskbook/<任务 ID>-<摘要前缀>/state.json` |

出现未经授权的矛盾时，插件暂停，显示当前事实 ID 和冲突证据。针对 `project:term:delivery-receipt` 可用 `/taskbook-decide project:term:delivery-receipt keep <保留理由>` 或 `/taskbook-decide project:term:delivery-receipt replace <新定义>` 裁决。替换需要针对同一版本再次独立审核。审核者根据项目词汇表、定义的上下文和实际用例检查同名异义词。此处借鉴 Matt 的词汇表和上下文检查，以及 PStack 对可复核证据的要求。[Matt 的领域建模](https://github.com/mattpocock/skills/blob/5863806dd4e15c63174bee4e7515a4256792ecfa/skills/engineering/domain-modeling/SKILL.md) · [PStack 的证据原则](https://github.com/cursor/plugins/blob/e58dd043600587dbaf58ba315e7f2b38373eeb43/pstack/skills/principle-prove-it-works/SKILL.md)

任务书选用 `cross-project:rule`、`cross-project:preference`、`cross-project:fact` 或 `cross-project:term` 表示明确授权发布对应跨项目记忆。项目术语需要说明为何跨项目仍有相同含义。发布适用条件及冲突处理见 [Magpie 记忆规则](../methods/magpie-memory/SKILL.md)。


## 迁移与恢复

1. 在目标分支的工作区运行 `/taskbook-setup`。报告只读盘点旧 Git 引用和 `.audit` 中可识别的材料，列出来源、版本、目标、冲突和待核实项。
2. 核对来源是否可以进入当前分支的 Git 历史。只批准需要导入的编号。运行 `/taskbook-setup apply import <盘点编号...>`。插件按本轮盘点的来源版本复核后提交。
3. 用 `git show HEAD:.fact/project.json` 核对导入结果。可以保留旧资料。如需移除已完整导入的旧引用，重新运行 `/taskbook-setup`，再运行 `/taskbook-setup apply delete-legacy-ref <盘点中的完整版本>`。插件再次核对目标和副本。对可识别的旧审计归档，可以另行运行 `/taskbook-setup apply delete-legacy-archive <已核对导入的编号>`。任务检查点保留在原位置。
4. 版本 1 检查点中已有事实审核或项目事实裁决时，保留原文件。核对迁移后的事实 ID、状态和版本。以新的 Taskbook ID 重新启动，保留原任务书供追溯。删去已经生效的操作，将仍需执行的操作指向当前版本，再提交待定裁决。版本 1 检查点处于早期阶段时可从事实核查重新开始。版本 2 使用原会话与同一任务书恢复。
5. 如果进程被强制终止，先检查 `git status --short` 和 `git diff`。查看 `git rev-parse --absolute-git-dir` 返回目录中的 `pi-taskbook-facts.lock`。确认记录的进程已退出后，核对并恢复未提交的生成文件，再移除残留锁。
6. 若需要回退事实变更，用普通 Git 历史定位变更与术语。优先用后续任务书提交经独立审核的纠正或退役。回退实现版本前保留 `.fact`、旧资料和原检查点。旧插件需要旧引用，在确认无需回退前可保留该引用。

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

外来镜像使用 `.fact/foreign.json`。它只接收对当前项目适用且来源可证的其他项目记录。分页缺失、查询未命中或断线保留现有记录。当前项目发起的同步对其他项目记录只读取。纳入版本控制或发布该文件需要单独授权。

默认 Magpie 接口的文本搜索可作为候选证据。需要以结构化作用域、归属、版本条件或退役信号为依据的操作显示为待处理。原 Pi 进程有已发现且可调用的 MCP 工具时使用该会话。重启后若可用的回退入口只支持读取，待写入项保持待处理。重新提交同一任务书可核对远端回执。
