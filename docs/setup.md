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

角色模型表使用 TSV，列为 `role`、`model` 和 `thinking`。用完整的 Pi 模型 ID，例如 `magpie/group/sol`。留空第三列可继承推理档位。[角色配置示例](../taskbook-models.example.tsv)

插件读取 `.fact/taskbook.tsv` 的两个设置。

| 设置 | 默认值 | 用途 |
| --- | --- | --- |
| `modelConfig` | `.fact/models.tsv` | 模型表路径。项目表使用仓库内 `.fact/` 下的 TSV 路径。个人表使用 `~/.agents/taskbook-models.tsv`。 |
| `modelGitTracking` | `false` | `true` 表示随项目暂存。项目表使用 `false` 时保存在主 checkout，同一仓库的 linked worktree 可读取。个人表使用 `false`。 |

运行 `/taskbook-setup` 查看有效配置。修改角色模型时沿用已声明的路径和跟踪方式。没有项目设置时，原有个人配置和环境变量仍可作为运行时来源。Setup 首次保存默认写入本机项目表和上述两项设置。旧单值设置在读取时会解释为等价的路径和跟踪方式。

已有 Markdown 和 JSON 配置仍可读取。Setup 保存时写入 TSV，TSV 优先。Setup 也会参考 `~/.agents/pstack-models.md` 和当前 Pi 的模型目录。

| 配置键 | 职责 | 省略时 |
| --- | --- | --- |
| `design` | 组长确定方案和验收判据，签发 Design 和 Review 决定。 | 入口模型 |
| `designMemberA` | 独立起草方案并执行初审。 | `review` 或入口模型 |
| `designMemberB` | 独立起草方案并执行交叉评审。 | `review` 或入口模型 |
| `implement` | 修改代码、执行正式测量、验证并提交候审版本。 | 入口模型 |

Fact Management 使用执行任务的 Pi 主会话模型和档位。

历史环境变量仍可设置默认值。对应变量为 `PI_TASKBOOK_DESIGN_MODEL`、`PI_TASKBOOK_IMPLEMENT_MODEL`、`PI_TASKBOOK_REVIEW_MODEL`、`PI_TASKBOOK_FACT_REVIEW_MODEL`、`PI_TASKBOOK_CORRECTNESS_MODEL`、`PI_TASKBOOK_QUALITY_MODEL`。文件中的同名角色优先。文件设置 `review` 后，未在文件单独指定的审核角色都使用它。

已有配置中的旧角色设置继续可用。模型 ID 和档位由当前 Pi 校验。

## 生成配置与迁移旧资料

运行 `/taskbook-setup`，查看模型、仓库和 MCP 诊断。也可以在命令后写明批准范围，例如 `/taskbook-setup 批准迁移旧 .audit，保留原件`。Setup 会询问尚未决定的事项。

同一 Pi 会话恢复后，插件会保留 Setup 待办和用户决定。新增模型后，在对话中要求重查即可刷新当前 Pi 的目录。批准后，Setup 通过插件工具执行并返回回执。工具不可用时，Setup 会保留待办并询问如何继续。

模型保存和资料迁移使用当前 Pi 进程所在的 Git checkout。T3 的托管 worktree 启动与线程迁移有各自的检查结果。

只有在你要求改动路径或跟踪方式时，Setup 才会处理对应设置。旧 `.audit` 的归档与清理分别批准。示例见[批准与回复](design/setup-expected-replies.md#在命令中给出批准)。

插件将 `.fact/always.tsv` 的内容注入每轮系统提示，包括 Setup 和独立工作会话。其他事实和术语通过主题表按需查询。Setup 的就绪状态只依赖模型和运行环境。

## 解读 setup 报告

`/taskbook-setup` 在调用模型前检查当前 Pi 会话。插件读取工具目录，向已加载的子代理插件发出 RPC ping，并对 T3 直接接口做只读检查。模型根据结果生成报告。

| 检查项 | 如何解读 |
| --- | --- |
| `readiness.runnable` | 当前模型和仓库满足已有 worktree 的任务配置条件。详细缺项见 `blockers`。 |
| `readiness.taskbookNew` | 上述条件满足，且当前 Pi 会话发现 T3 的托管 worktree 参数。T3 在实际请求时校验权限和基线。 |
| `readiness.initialized` | 已有有效的角色模型配置。缺少角色配置时仍可使用入口模型回退。 |
| `availability.subagents` | 区分内置 SDK 加载、已安装版本和当前 RPC 回应。 |
| `availability.github` 和 `availability.magpieMemory` | 列出当前会话发现的能力。仓库访问和远端权限留待实际任务核对。 |
| `availability.t3` | 分开报告 Pi 工具注册情况、插件的 T3 直接接口和两个命令的预检结果。 |

T3 使用服务器监听的地址注册当前线程的 HTTP `/mcp` 端点。Taskbook 接受回环地址和操作系统已分配给本机的接口地址。Setup 只读取目录和线程绑定。

Pi 在后台连接配置为 `codemode` 的 MCP 服务。Setup 最多等候两秒，随后报告已启用的 Magpie 服务有没有注册工具。T3 的 Issue 和 PR 工具单列。PR 交付使用通过 Taskbook 参数检查的 Magpie GitHub 工具。Memory 可用性来自实际目录。

使用 `/taskbook-new` 时，从 T3 启动的 Pi 会话运行 setup。T3 为该会话注入 MCP 上下文，并管理 worktree 路径。已有 linked worktree 可以使用 `/taskbook` 独立运行。
