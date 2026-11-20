# `/taskbook-setup` 预期回复

以下模型和推理档位来自示例目录。实际回复用当前 Pi 返回的可用模型和各自支持的档位。Plus、Pro 和 Pro Plus 描述本次配置的用量取向。

## 在命令中给出批准

| 输入 | 预期回复或操作 |
| --- | --- |
| `/taskbook-setup` | 给出诊断和建议，请用户决定需要授权的事项。 |
| `/taskbook-setup 请把旧审计资料归档，原来的 .audit 留着` | 执行本次盘点中的 `.audit` 迁移并报告结果。 |
| `/taskbook-setup 批准按 Pro 生成项目模型配置` | “已确认 Pro 方案和项目位置。项目模型表是否由 Git 跟踪？” 用户回复“不追踪”后，保存并报告结果。 |
| `/taskbook-setup 批准迁移旧 .audit，批准按 Pro 生成项目模型配置` | “迁移范围和模型方案已确认。还需要确定项目模型表是否由 Git 跟踪。” 补齐选择后执行获批事项。 |
| `/taskbook-setup 批准：` | “当前没有获批的操作。请说明要批准哪一项。” |

## 没有模型配置，也没有参考文件

假设 Pi 发现 `magpie/group/sol` 和 `magpie/group/terra`，两者分别支持 `low`、`medium`、`high` 和 `medium`、`high`、`xhigh`。

> 当前项目还没有 Taskbook 模型配置。Pi 有两个可用模型，我可以按下面三种用量取向生成配置。未单列的独立审核角色继承 `review`，咨询继承 `design`。
>
> | 方案 | 事实核查与实施 | 设计 | 独立审核 |
> | --- | --- | --- | --- |
> | Plus · 日常任务 | `sol @ low` | `sol @ medium` | `sol @ medium` |
> | Pro · 复杂改动 | `sol @ medium` | `terra @ high` | `sol @ high` |
> | Pro Plus · 深度设计与审核 | `terra @ high` | `terra @ xhigh` | `terra @ xhigh` |
>
> 你想选哪档？放到个人的 `~/.agents/taskbook-models.md`，还是项目的 `.fact/models.md`？如果放项目里，你希望模型表进 Git，还是仅留在本机？我会先给你看所选方案的完整文件。

如果 Pi 只提供一个模型且只有 `off`，回复应明确三档无法形成实际差别，并给出能运行的一套配置。

用户选档后，回复展示拟保存的完整内容。以上目录对应的三个示例如下。

```text
# Plus
factCheck: magpie/group/sol @ low
implement: magpie/group/sol @ low
design: magpie/group/sol @ medium
review: magpie/group/sol @ medium
```

```text
# Pro
factCheck: magpie/group/sol @ medium
implement: magpie/group/sol @ medium
design: magpie/group/terra @ high
review: magpie/group/sol @ high
```

```text
# Pro Plus
factCheck: magpie/group/terra @ high
implement: magpie/group/terra @ high
design: magpie/group/terra @ xhigh
review: magpie/group/terra @ xhigh
```

## 只有 PStack 配置或旧 Taskbook JSON

> 找到了旧 Taskbook 配置和 PStack 偏好。旧配置的执行角色已匹配 `magpie/group/terra`，我会在转换方案里保留它。PStack 的 `judgment and prose` 指向 `group/sol`，Pi 中有唯一对应的 `magpie/group/sol`，可用于独立审核。PStack 的 `xhigh` 在这份 Pi 目录里只适用于 `terra`。我建议保留 `sol @ high` 做审核，你也可以选择把深度审核交给 `terra @ xhigh`。你希望沿用旧路由迁移，还是调整这两项？目标文件放个人目录还是项目里？

如果别名无法唯一解析，询问用户应对应哪个 Pi 模型。确认前展示拟写入的完整 Markdown、目标及 Git 行为。

## 项目已经选择模型表

> 这个项目使用 `.fact/models.md`。模型表只留在当前仓库的主 checkout，配置位置写在 Git 跟踪的 `.fact/taskbook.tsv`。目前设计使用 `terra @ high`，审核使用 `sol @ high`。我也找到了个人模型表。你想保留当前设置，切换到个人配置，还是调整项目的角色模型？

如果个人和项目表都存在但还没保存位置选择，说明当前实际使用的配置，再让用户决定。发现被选中的项目表缺失时，给出具体路径和恢复或切换选项。

## Pi 没有可用模型

> 当前 Pi 没有可用的模型。请先注册或认证一个模型，再运行 `/taskbook-setup`。这次已收集仓库和 T3 的诊断，模型配置保留原样。

如果 Pi 当前没有模型可用于对话，插件直接显示这条说明和只读诊断。

## 用户确认项目表只留本机

> 已保存项目模型配置。`.fact/taskbook.tsv` 已暂存，提交后可以将位置选择带到新 worktree。`.fact/models.md` 保存在主 checkout，由 Git 的本机排除规则处理。同一仓库的 linked worktree 会读取这份模型表。
