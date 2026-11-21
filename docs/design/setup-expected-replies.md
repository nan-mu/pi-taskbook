# `/taskbook-setup` 预期回复

以下模型和推理档位来自示例目录。实际回复用当前 Pi 返回的可用模型和各自支持的档位。Plus、Pro 和 Pro Plus 描述本次配置的用量取向。

## 在命令中给出批准

| 输入 | 预期回复或操作 |
| --- | --- |
| `/taskbook-setup` | 报告现状。模型配置可用时结束本轮。 |
| `/taskbook-setup 请把旧审计资料归档，原来的 .audit 留着` | 执行本次盘点中的 `.audit` 迁移并报告结果。 |
| `/taskbook-setup 批准按 Pro 生成项目模型配置` | 按有效保存设置写入模型表并报告结果。 |
| `/taskbook-setup 批准迁移旧 .audit，批准按 Pro 生成项目模型配置` | 归档已批准的 .audit，再按有效保存设置写入模型表。 |
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
> 这几个方案会使用项目已有的保存设置。你想选哪档？

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

> 这个项目使用 `.fact/models.tsv`。模型表只留在当前仓库的主 checkout，配置位置写在 Git 跟踪的 `.fact/taskbook.tsv`。目前设计使用 `terra @ high`，审核使用 `sol @ high`。Setup 已就绪。

说明插件解析出的有效模型来源。模型表缺失时，按既定保存路径提出恢复方式。用户主动要求调整存放策略时，再核对新的路径或跟踪方式。

## Pi 没有可用模型

> 当前 Pi 没有可用的模型。请先注册或认证一个模型，再运行 `/taskbook-setup`。这次已收集仓库和 T3 的诊断，模型配置保留原样。

如果 Pi 当前没有模型可用于对话，插件直接显示这条说明和只读诊断。

## 既定设置为本机保存

> 已保存项目模型配置。`.fact/taskbook.tsv` 已暂存，提交后可以将位置选择带到新 worktree。`.fact/models.tsv` 保存在主 checkout，由 Git 的排除规则处理。同一仓库的 linked worktree 会读取这份模型表。
