# 项目事实与术语

任务书里的 `Facts` 是该任务的原始依据。事实核查者逐条取证，独立事实审核者检查来源、范围和矛盾。普通任务书的核查结果自动按观测提交归档，同一基线的后续任务可以读取。已有任务书无需转换。

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

一个 clone 的所有 linked worktree 共用 `refs/pi-taskbook/project-memory`。每次成功写入保留前一版本、任务书摘要、基线、证据和审核会话。退役记录保留在历史中。两个任务同时基于同一版记忆工作时，先完成的一方推进引用，后完成的一方需重新审核。不同 clone 有各自的项目台账。各任务的检查点仍在当前工作区的 `.audit/pi-taskbook/`。

| 要核对的内容 | 命令 |
| --- | --- |
| 现行快照，含退役记录 | `git show refs/pi-taskbook/project-memory:memory.json` |
| 逐次审核写入 | `git log --oneline refs/pi-taskbook/project-memory` |
| 某次审核时的定义和来源 | `git show <审核提交>:memory.json` |

出现未经授权的矛盾时，插件暂停，显示当前事实 ID 和冲突证据。针对 `project:term:delivery-receipt` 可用 `/taskbook-decide project:term:delivery-receipt keep <保留理由>` 或 `/taskbook-decide project:term:delivery-receipt replace <新定义>` 裁决。替换需要针对同一版本再次独立审核。审核者根据项目词汇表、定义的上下文和实际用例检查同名异义词。此处借鉴 Matt 的词汇表和上下文检查，以及 PStack 对可复核证据的要求。[Matt 的领域建模](https://github.com/mattpocock/skills/blob/5863806dd4e15c63174bee4e7515a4256792ecfa/skills/engineering/domain-modeling/SKILL.md) · [PStack 的证据原则](https://github.com/cursor/plugins/blob/e58dd043600587dbaf58ba315e7f2b38373eeb43/pstack/skills/principle-prove-it-works/SKILL.md)

任务书选用 `cross-project:rule`、`cross-project:preference`、`cross-project:fact` 或 `cross-project:term` 表示明确授权发布对应跨项目记忆。项目术语需要说明为何跨项目仍有相同含义。发布适用条件及冲突处理见 [Magpie 记忆规则](../methods/magpie-memory/SKILL.md)。
