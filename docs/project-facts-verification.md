# 项目事实任务书验收

验收针对 `repair-project-facts-and-magpie-sync`。源码基线为 `49e8ba978de0a450be5dc3281519b3e4558ccc37`，运行使用本次交付的工作区改动。测试在各自的临时仓库写入普通 Git 提交。RPC 测试从状态文件取出每次候审提交和事实版本，与 Git 实际内容及 MCP 调用顺序比较。

环境为 macOS arm64、Pi 1.5.2、Node 26.10.0 和 Python 3.9.6。Pi RPC 使用独立配置、本地模型替身和 stdio MCP 替身。测试不会接触工作仓库的旧资料。

| 任务书目标 | 入口与证据 | 结果 |
| --- | --- | --- |
| 1. 持久化与审核 | [工作流 RPC](../tests/workflow_rpc.py) 从 `/taskbook` 验证创建、后续任务读取、更新、退役、冲突裁决和恢复。比较候审与同步的同一提交和事实版本，检查普通 clone、术语清单和旧引用。另用[项目事实测试](../tests/project-memory.test.ts)覆盖过期版本、提交失败回滚和并发写入。 | 通过 |
| 2. 初始化诊断 | [Setup RPC](../tests/setup_rpc.py) 覆盖缺失、有效和损坏配置，以及有无检查点 Git 排除规则。[工作流 RPC](../tests/workflow_rpc.py) 在模型返回 503 后自动重试，比较两次模型请求的工具、批准前后文件及同一会话约束。 | 通过 |
| 3. 旧资料迁移 | [项目事实测试](../tests/project-memory.test.ts) 核对旧 Git 引用、已批准观察、退役、预览无写入、失败重试和精准删除。[工作流 RPC](../tests/workflow_rpc.py) 用 setup 命令独立批准导入与归档清理，比较实际 Git 内容和旧检查点。 | 通过 |
| 4. 跨项目准入 | [工作流 RPC](../tests/workflow_rpc.py) 核对原任务书 F ID 保留、仅项目事实留在本地、同 ID 不同归属并存、提前写入被拦截。[Magpie 测试](../tests/magpie-memory.test.ts) 核对范围不明、错误归属和模拟凭据。 | 通过 |
| 5. 完成同步 | [工作流 RPC](../tests/workflow_rpc.py) 从真实 Pi 完成入口检查四个 MCP 工具，核对取消、提交、规格与质量通过、检查点、按 ID 更新与撤回、回执丢失和重试。 | 受控 MCP 通过 |
| 6. 外来镜像 | [Magpie 测试](../tests/magpie-memory.test.ts) 在两个独立项目之间验证同文同名隔离、创建、更新、明确退役和分页缺失。RPC 比较另一项目镜像、Git 排除规则和四项工具请求。 | 受控 MCP 通过 |
| 7. MCP 能力 | [Setup RPC](../tests/setup_rpc.py) 覆盖完整、部分、不同命名和不可连接的工具目录。真实 Pi 目录另做只读发现。 | 受控 RPC 与真实目录发现通过 |

## 重跑

```sh
yarn node --test tests/*.test.ts
python3 tests/workflow_rpc.py
python3 tests/setup_rpc.py
```

RPC 用例在 `127.0.0.1` 启动替身服务。它们从临时仓库读取已写入的数据和工具日志，再清理临时文件。Node 中的替身覆盖还包括远端并发变化、归属冲突、网络失败和镜像数据保留。

以 `PI_TASKBOOK_TEST_SUBAGENTS` 指向已安装的 `@tintinweb/pi-subagents` 0.26.1 目录重跑工作流 RPC，也已通过。该入口额外核对现场派发的审核者 ID 与仅开放的固定提交读取工具。

## T3 托管 worktree

工作流 RPC 的 T3 替身在收到 `t3_thread_launch` 后创建 linked worktree。用例核对 `workspaceStrategy.type = worktree`、固定基线、分支、子 Pi 入口和重试标识。Setup 先只读核对支持的参数。目录只提供项目根目录模式时，插件拒绝启动。独立 Setup RPC 同时覆盖缺少 T3 上下文的状态。

## 真实连接

真实 Pi 1.5.2 会话连接当前的 Magpie HTTP 网关，目录发现得到 `mcp__magpie__github__get_file_contents`、`mcp__magpie__github__issue_read`、`mcp__magpie__github__search_issues` 和 `mcp__magpie__github__pull_request_read`。该会话没有注册四个 `memory_*` 工具。此次验证限于工具发现，未调用 GitHub 对象操作。

本机 Magpie 0.1.4574 CLI 的只读发现返回了四个工具。只读 `memory_context` 也能返回项目上下文，CLI 使用的调用上下文没有 agent 身份。原生接口缺少完成同步所需的创建隔离、条件版本和可核对的退役信号。条件写入和镜像退役仅在替身上验证。详见[Magpie 同步接口](magpie-sync.md)。

## 待批准的旧资料操作

在目标项目运行 `/taskbook-setup` 获取当前盘点。初始化、导入及旧引用或归档删除各自需要明确批准。适用命令见[迁移与恢复](project-memory.md#迁移与恢复)。
