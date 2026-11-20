# 安装与配置

## 选择 Pi 的 agent 目录

在日常使用的 Pi 环境运行 `pi install https://github.com/nan-mu/pi-taskbook`。Pi 默认使用 `~/.pi/agent`。如果设置了 `PI_CODING_AGENT_DIR`，在同一个环境安装插件和配置模型。T3 启动的 Pi 也需要加载该目录中的插件和配置。

如果已配置 GitHub SSH 访问，可运行 `pi install git:git@github.com:nan-mu/pi-taskbook.git`。用 `pi list` 查看包来源和实际安装路径。编辑开发 checkout 中的文件后，通过该 checkout 加载插件即可验证改动。GitHub 包安装使用 Pi 管理的 checkout。

在新的 Pi 会话输入 `/taskbook-setup`。也可以离线查看已注册的命令和模型。

```sh
printf '%s\n' '{"type":"get_commands"}' '{"type":"get_available_models"}' |
  pi --offline --no-mcp --mode rpc --no-session
```

可选安装 `pi install npm:@tintinweb/pi-subagents@0.26.0`，用于派发独立顾问和审核。已验证 0.26.0 和 0.26.1。没有可用的子代理 RPC 时，插件使用独立 Pi SDK 会话。

## 配置角色模型

使用 `pi --offline --list-models` 核对模型 ID。[角色配置示例](../taskbook-models.example.md)使用每行一个 `角色: provider/model-id` 的 Markdown 格式，支持 `#` 注释和空行。可以用 `design: magpie/group/sol @ high` 为角色指定该模型在 Pi 中支持的推理档位。

在 `/taskbook-setup` 中选择个人配置 `~/.agents/taskbook-models.md`，或项目配置 `.fact/models.md`。插件把选择暂存到 `.fact/taskbook.tsv`。项目模型表可以同时加入 Git，也可以保存在主 checkout，用仓库的本机 `info/exclude` 排除。同一仓库的 linked worktree 可以使用主 checkout 的本机模型表。提交设置后，从包含该提交的基线启动的新 worktree 才能取得位置选择。其他 clone 使用本机选项时需要自己的模型表。

项目没有保存过位置选择时，Pi 沿用个人配置、`PI_TASKBOOK_CONFIG` 和旧 `pi-taskbook.json` 的读取方式。Setup 会参考已有配置、`~/.agents/pstack-models.md` 与 Pi 当前可用的模型和档位。[Setup 回复示例](design/setup-expected-replies.md)

| 配置键 | 职责 | 默认模型 |
| --- | --- | --- |
| `factCheck`、`performance` | 主会话取证和正式测量 | 入口模型 |
| `design`、`implement` | 主会话设计和实施 | 入口模型 |
| `consult` | 独立只读设计咨询 | `design` |
| `review` | 共用审核模型 | 入口模型 |
| `factReview`、`correctness`、`quality` | 独立事实、规格和质量审核 | `review` |

历史环境变量仍可设置默认值。对应变量为 `PI_TASKBOOK_DESIGN_MODEL`、`PI_TASKBOOK_IMPLEMENT_MODEL`、`PI_TASKBOOK_REVIEW_MODEL`、`PI_TASKBOOK_FACT_REVIEW_MODEL`、`PI_TASKBOOK_CORRECTNESS_MODEL`、`PI_TASKBOOK_QUALITY_MODEL`。文件中的同名角色优先。文件设置 `review` 后，未在文件单独指定的审核角色都使用它。

省略推理档位时，角色继承入口会话的档位，由 Pi 按目标模型能力适配。共享审核角色和设计咨询的回退同时继承模型与档位。项目已保存位置选择时，插件在每阶段开始及每次独立派发前读取所选配置。现有未设置位置的任务沿用检查点中的模型选择。设计咨询使用 `taskbook_consult`，独立审核由插件自动派发。

## 生成配置与迁移旧资料

运行 `/taskbook-setup` 开始普通 AI 对话。插件将本次模型、项目和 MCP 探测结果附到消息中，并询问需要你决定的事项。也可以把明确的批准直接写在命令后，例如 `/taskbook-setup 批准迁移旧 .audit，保留原件`。本次要求的事项都批准时直接执行。批准为空、范围不清或缺少选择时，setup 会指出需要补齐的内容。

生成项目模型表时，可一次写清方案、保存位置和 Git 选择，例如 `/taskbook-setup 批准按 Pro 生成项目模型配置，不追踪`。迁移与清理是各自的批准事项，清理前仍需核对迁移结果。[批准与回复示例](design/setup-expected-replies.md#在命令中给出批准)

新的检查点位于当前 Git worktree 的元数据目录。项目事实用 `.fact/facts.tsv`，允许 Git 跟踪。迁移与目录说明见[项目事实与术语](project-memory.md)。

## 解读 setup 报告

`/taskbook-setup` 一次收集当前会话与仓库的数据。报告阶段只使用当次采集结果。

| 检查项 | 如何解读 |
| --- | --- |
| `readiness.runnable` | 当前模型和仓库满足已有 worktree 的任务配置条件。详细缺项见 `blockers`。 |
| `readiness.taskbookNew` | 上述条件满足，且当前 Pi 会话发现 T3 的托管 worktree 参数。T3 在实际请求时校验权限和基线。 |
| `readiness.initialized` | 在可运行的基础上，已配置角色模型，且仓库已有有效的项目事实文件和词汇表。缺少角色配置时仍可使用入口模型回退。 |
| `subagents` | 安装版本和当前 RPC 响应分别报告。 |
| `mcp` | Magpie 和 GitHub 在 Pi 工具目录中发现的能力。工具注册状态与调用权限分别核对。 |
| `t3` | 使用当前会话的 T3 MCP 上下文只读检查 `t3_thread_launch` 及托管 worktree 参数。 |

使用 `/taskbook-new` 时，从 T3 启动的 Pi 会话运行 setup。T3 为该会话注入 MCP 上下文，并管理 worktree 路径。已有 linked worktree 可以使用 `/taskbook` 独立运行。
