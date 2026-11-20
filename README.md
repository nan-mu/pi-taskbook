# pi-taskbook

Pi 按 Markdown 任务书核查事实、设计、实施和取证。规格和质量审核针对同一个 Git 提交。通过后，Pi 显示「可交接」和交付提交。

## 开始运行

1. 准备 Git、Node.js 22.19 或更新版本和 Pi 1.5.2。在 Pi 中配置可用模型。如果使用 T3 Code，请在 T3 启动 Pi 时使用的 agent 目录安装插件。

   ```sh
   pi install https://github.com/nan-mu/pi-taskbook
   ```

2. 打开一个新的 Pi 会话，运行 `/taskbook-setup`，查看模型、仓库和 T3 能力。可在同一会话用普通回复批准生成配置或迁移旧资料。见[安装与配置](docs/setup.md)。
3. 按[任务书示例](docs/workflow.md#任务书格式)准备 Markdown 文件。已有 linked worktree 时运行 `/taskbook <任务书路径>`。要让 T3 创建 worktree 和会话时，在 T3 启动的 Pi 中运行 `/taskbook-new <任务书路径>`。

## 命令

| 命令 | 用途 |
| --- | --- |
| `/taskbook-setup` | 检查当前会话与仓库，显示可用能力和初始化建议。 |
| `/taskbook <任务书路径>` | 在已有 worktree 中开始任务，或在原会话恢复任务。 |
| `/taskbook-new <任务书路径>` | 请 T3 按任务书的基线创建 worktree 并启动会话。 |
| `/taskbook-answer <决定>` | 回答执行流程中待用户决定的问题。 |
| `/taskbook-decide <事实 ID> keep <理由>` | 保留有冲突的事实。使用 `replace <完整新事实>` 可指定替换内容。 |
| `/taskbook-exit` | 取消当前任务，保留检查点。 |

## 文档

- [安装与配置](docs/setup.md)说明模型配置、旧资料迁移和 setup 报告。
- [任务书与执行流程](docs/workflow.md)提供格式示例，说明审核、交付和恢复。
- [项目事实与迁移](docs/project-memory.md)说明事实版本、术语和旧资料迁移。[Magpie 同步接口](docs/magpie-sync.md)列出远端写入与镜像条件。
- [代码审阅指南](docs/review-guide.md)指出各模块的职责和建议阅读顺序。[验收记录](docs/project-facts-verification.md)列出测试环境和复跑命令。
