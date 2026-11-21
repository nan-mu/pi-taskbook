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

## 没有模型配置

假设 Pi 发现 Sol、Terra、DeepSeek Flash 和 Qwen4，且支持表中的档位。Setup 可以参考 PStack 的执行、判断和交叉评审分工。

> | 角色 | 工作 | Plus | Pro | Pro Plus |
> | --- | --- | --- | --- | --- |
> | `design` | 定方案、写验收判据、签发评审决定 | Sol `medium` | Sol `high` | Sol `xhigh` |
> | `designMemberA` | 独立起草和初审 | DeepSeek Flash `high` | DeepSeek Flash `high` | DeepSeek Flash `high` |
> | `designMemberB` | 独立起草和交叉评审 | Qwen4 `medium` | Qwen4 `high` | Qwen4 `xhigh` |
> | `implement` | 改代码、验证和测量 | Terra `medium` | Terra `medium` | Terra `medium` |
>
> 你想选哪档？配置放个人目录还是项目？项目表是否进 Git？

用户选档后展示完整 TSV、目标路径和 Git 行为。以下是 Pro 示例。

```tsv
role	model	thinking
design	magpie/group/sol	high
designMemberA	magpie/group/deepseek-flash	high
designMemberB	magpie/group/qwen4	high
implement	magpie/group/terra	medium
```

保留用户本次修改范围之外仍可用的旧显式角色。目录只能支持一套有效配置时，展示可运行的一套并指出模型限制。

## 项目已经选择模型表

> 这个项目使用 `.fact/models.tsv`。模型表只留在当前仓库的主 checkout，配置位置写在 Git 跟踪的 `.fact/taskbook.tsv`。目前设计使用 `terra @ high`，审核使用 `sol @ high`。我也找到了个人模型表。你想保留当前设置，切换到个人配置，还是调整项目的角色模型？

如果个人和项目表都存在但还没保存位置选择，说明当前实际使用的配置，再让用户决定。发现被选中的项目表缺失时，给出具体路径和恢复或切换选项。

## Pi 没有可用模型

> 当前 Pi 没有可用的模型。请先注册或认证一个模型，再运行 `/taskbook-setup`。这次已收集仓库和 T3 的诊断，模型配置保留原样。

如果 Pi 当前没有模型可用于对话，插件直接显示这条说明和只读诊断。

## 用户确认项目表只留本机

> 已保存项目模型配置。`.fact/taskbook.tsv` 已暂存，提交后可以将位置选择带到新 worktree。`.fact/models.tsv` 保存在主 checkout，由 Git 的排除规则处理。同一仓库的 linked worktree 会读取这份模型表。
