# Magpie 同步接口

Pi 在规格审核和质量审核均通过、完成检查点写入后同步。检查点保存候审 Git 提交、项目事实版本，以及每条同步结果。重交同一任务书会先读回已尝试的操作。已经与获批条目一致的记录只确认版本。

插件在 Pi 已注册的同一 MCP 服务中调用 `memory_context` 和 `memory_search`。如果当前调用上下文不可用，`magpie tool` 只读后备可用于核查。遇到未知身份、未知归属或缺少版本条件时，同步结果保留为待处理。

## 已核对的 Magpie 版本

在 macOS 本机的 Magpie 0.1.4574 服务运行时，用 `magpie tools <工具名>` 只读发现四个工具。发现未调用这些工具，也未改动记忆。发现结果与[上游实现](https://github.com/yetone/magpie/blob/main/internal/gateway/memory_mcp.go)一致。

| 工具 | 上游能力 | 对同步的影响 |
| --- | --- | --- |
| `memory_context` | 返回调用者、项目和搜索范围 | 用于核对当前会话 |
| `memory_search` | 返回有限条文本结果，无分页游标与退役记录 | 可召回候选。归属、版本与退役等待证明 |
| `memory_save` | 创建时可合并同文记录。按 ID 编辑时没有版本条件 | 创建和更新待处理 |
| `memory_forget` | 按 ID 隐藏记录 | 退役待处理 |

## 具备版本条件的服务约定

`tests/fixtures/magpie_mcp.py` 和 `tests/magpie-memory.test.ts` 使用受控替身验证以下扩展约定。上游 Magpie 原生接口目前没有声明此约定。

- `memory_context` 在结构化结果中声明 `protocol: pi-taskbook-magpie-v1`。同时返回 `agent.id`、`project.key`、`search_scopes` 和 `capabilities`。调用者项目必须等于 `github.com/<owner>/<repo>`，且搜索范围包括 `global`。
- `memory_search` 接受 `scope`、`limit`、`tags` 和可选的 `cursor`。返回 `scope: global`、`records` 和 `next_cursor`。每条记录含 `owner`、`fact_id`、`id`、`kind`、`text`、`scope`、`version`、`fact_version`、`status`、`eligible`、`writable`。服务只返回调用者获准看到的记录。带归属标签的查询必须包括对应的退役记录。普通文本和标签本身不能证明归属。
- `memory_save` 使用 `owner`、`fact_id`、`fact_version`、`idempotency_key`、`if_version`。创建时 `if_version` 为 null，服务必须按归属与事实 ID 隔离创建，并保证相同幂等键不会复活已退役记录。更新另带 `id`，且必须在同一事务中检查归属和预期版本。写入返回变更后的记录。
- `memory_forget` 按 `id` 退役，使用同样的归属与预期版本条件。服务返回可通过归属标签读回的退役状态。插件要求记录的本地来源中包含明确的退役操作。
- 服务分别通过 `owner_isolated_create`、`conditional_update` 和 `conditional_forget` 声明上述保证。布尔值作为该接口的运行时声明。每次写入还会检查已审核的本地版本、服务工具参数、明确授权和按归属读回的结果。

## 外来事实镜像

外来事实保存在被 Git 排除的 `.fact/foreign.json`。原子替换使用同样被排除的 `.fact/foreign.lock/` 目录。镜像以归属项目和 Magpie 记录 ID 标识，使用远端版本顺序更新。明确退役的记录保留版本及退役状态。查询缺失或连接失败会保留已有镜像并报告待核实。镜像不修改已审核的 `.fact/project.json`。
