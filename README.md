# pi-taskbook

Pi 先同步 Markdown 任务书给出的事实，再设计、实施和审核候审 Git 提交。Fact Management 使用执行任务的 Pi 主会话模型和推理档位。由 T3 创建 checkout 时，以新 checkout 中 Pi 的选择为准。`/taskbook-setup` 会显示当前会话的选择。通过审核后，Pi 显示「可交接」和交付提交。

## 开始运行

1. 准备 Git、Node.js 22.19 或更新版本和 Pi 1.5.2。在 Pi 中配置可用模型。如果使用 T3 Code，请在 T3 启动 Pi 时使用的 agent 目录安装插件。

   ```sh
   pi install https://github.com/nan-mu/pi-taskbook
   ```

2. 打开一个新的 Pi 会话，运行 `/taskbook-setup`，查看模型、仓库和 T3 能力。可在命令后或同一会话中批准生成配置和迁移旧资料。Setup 将模型位置暂存到 `.fact/taskbook.tsv`。提交该设置后，让新的 T3 worktree 从包含设置的基线启动。
3. 按[任务书示例](docs/workflow.md#任务书格式)准备 Markdown 文件。已有 linked worktree 时运行 `/taskbook <任务书路径>`。要让 T3 创建 worktree 和会话时，在 T3 启动的 Pi 中运行 `/taskbook-new <任务书路径>`。

Design 由组长和两名组员独立起草，组长签发两名组员确认的方案。组员 A 初审，组员 B 清理上下文后复核，组长签发审核结果。配置对应 `design`、`designMemberA`、`designMemberB`。`implement` 指定单个 Implementer，涵盖实现、测量、验证和返工。审核通过后，主会话归类草稿事实并准备本地交付说明。

任务书按 `Entry` 选择 Implement playbook。需要指定流程时，在 `## Goal` 前加 `Playbook: <名称>`。可选 `feature`、`refactoring`、`bug-fix`、`perf-issue`、`hillclimb`、`experiment` 或 `experiment-fix`。`hillclimb` 使用任务书 Goal 作为目标，默认做 1 到 3 次尝试。

## 命令

| 命令 | 用途 |
| --- | --- |
| `/taskbook-setup` | 检查当前会话与仓库，显示可用能力和初始化建议。 |
| `/taskbook <任务书路径>` | 在已有 worktree 中开始任务，或在原会话恢复任务。 |
| `/taskbook-new <任务书路径>` | 请 T3 按任务书的基线创建 worktree 并启动会话。 |
| `/taskbook-handoff <任务书路径>` | 将当前 T3 线程迁到托管 worktree 后继续，已有匹配绑定时直接使用该绑定。 |
| `/taskbook-publish <任务书路径>` | 在原任务会话预览、批准或重试 PR 交付。 |
| `/taskbook-answer <决定>` | 回答执行流程中待用户决定的问题。 |
| `/taskbook-decide <事实 ID> <操作> <内容>` | 裁决事实。入口同步可选择 `use <已有 ID>`、`update <已有 ID>` 或 `create <区分理由>`。已登记事实冲突可使用 `keep <理由>` 或 `replace <完整新事实>`。 |
| `/taskbook-exit` | 取消当前任务，保留检查点。 |

任务书的 Delivery 可以要求创建 PR、更新当前分支的 PR 说明或追加评论。Handoff 会在 Pi 中展示目标、发送内容和需要的分支推送。批准后，插件用 Git 推送交付提交，用当前会话的 Magpie GitHub MCP 操作 PR，并将实际事实 diff 追加到讨论。已完成的本地交付也可以通过 `/taskbook-publish` 发布。

如果 T3 已迁移原线程但继续执行仍在排队，在同一线程重新提交 `/taskbook <任务书路径>`。插件会核对当前 T3 绑定并使用迁移时保存的基线。

## 文档

- [角色模型示例](taskbook-models.example.md)列出当前工作流的四个子代理配置键。模型可放在 `~/.agents/taskbook-models.md` 或项目 `.fact/models.md`，后者可选择由 Git 跟踪。
- [任务书与执行流程](docs/workflow.md)提供格式示例，说明审核、交付和恢复。
- [项目事实与迁移](docs/project-memory.md)说明事实版本、术语和旧资料迁移。[Magpie 同步接口](docs/magpie-sync.md)列出远端写入与镜像条件。
- [代码审阅指南](docs/review-guide.md)指出各模块的职责和建议阅读顺序。[验收记录](docs/project-facts-verification.md)列出测试环境和复跑命令。
