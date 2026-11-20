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

使用 `pi --offline --list-models` 核对可用模型 ID。需要为不同阶段指定模型时，将[角色配置示例](../pi-taskbook.example.json)复制到 agent 目录并命名为 `pi-taskbook.json`。也可以设置 `PI_TASKBOOK_CONFIG` 指向文件的绝对路径。将示例中的值替换成 Pi 已注册的 `provider/model-id`。

| 配置键 | 职责 | 默认模型 |
| --- | --- | --- |
| `factCheck`、`performance` | 主会话取证和正式测量 | 入口模型 |
| `design`、`implement` | 主会话设计和实施 | 入口模型 |
| `consult` | 独立只读设计咨询 | `design` |
| `review` | 共用审核模型 | 入口模型 |
| `factReview`、`correctness`、`quality` | 独立事实、规格和质量审核 | `review` |

历史环境变量仍可设置默认值。对应变量为 `PI_TASKBOOK_DESIGN_MODEL`、`PI_TASKBOOK_IMPLEMENT_MODEL`、`PI_TASKBOOK_REVIEW_MODEL`、`PI_TASKBOOK_FACT_REVIEW_MODEL`、`PI_TASKBOOK_CORRECTNESS_MODEL`、`PI_TASKBOOK_QUALITY_MODEL`。文件中的同名角色优先。文件设置 `review` 后，未在文件单独指定的审核角色都使用它。

任务开始时保存解析后的模型 ID。恢复沿用检查点中的 ID。独立会话继承派发时的 Pi thinking level。

## 设置 Git 排除规则

在目标仓库的 `.gitignore` 或 `git rev-parse --git-path info/exclude` 所指文件中加入以下规则。

```gitignore
/.audit/pi-taskbook/
/.fact/foreign.json
/.fact/foreign.lock/
```

第一条是正式任务的前置条件。后两条用于启用外来事实镜像。项目事实文件 `.fact/project.json` 应允许 Git 跟踪。

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

在同一 Pi 会话执行 `/taskbook-setup apply <批准的改动>`，才会进入执行阶段。初始化、旧资料导入和删除分开批准。迁移命令见[迁移与恢复](project-memory.md#迁移与恢复)。
