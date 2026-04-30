# openclaw-cursor-mcp

一个用于连接 OpenClaw 与 Cursor 的 MCP Server，可做会话管理、授权流控和审计。

## 功能

- 管理对话会话：
  - `cursor_session_create`
  - `cursor_session_send_message`
  - `cursor_session_get`
  - `cursor_session_list`
- 管理授权：
  - `cursor_permission_request`
  - `cursor_permission_grant`
  - `cursor_permission_revoke`
  - `cursor_permission_list`

当前版本使用 JSON 文件持久化（默认 `./data/openclaw-cursor-db.json`）。

新增：

- `cursor_audit_list`：查询审计事件。
- `cursor_metrics_get`：聚合审计日志，输出轻量可靠性指标（成功率、超时率、权限拦截率、平均耗时）。
- `cursor_gateway_config_get`：读取网关配置文件（需 `adminToken`）。
- `cursor_gateway_config_update`：按 JSON 深度合并方式更新网关配置（需 `adminToken`）。
- `cursor_gateway_process_status` / `start` / `stop` / `restart` / `logs`：通过 MCP 直接管理网关进程（需 `adminToken`）。
- `cursor_session_send_message` 默认强制 `chat_send` 授权检查。
- `cursor_session_send_message` 支持 `idempotencyKey` 去重（重试不重复执行）。
- 未传 `idempotencyKey` 时，自动用 `sessionId + callerId + 归一化消息` 生成默认幂等键。
- `cursor_permission_grant` / `cursor_permission_revoke` 强制 `adminToken` 校验。
- `cursor_permission_request` 支持有效期（`expiresInMs`），过期授权不会通过 `chat_send` 校验。

## 快速开始

```bash
npm install
npm run build
npm start
```

## 一键整合启动（推荐）

目标：只需配置 OpenClaw MCP + `CURSOR_CLOUD_API_KEY` 即可使用。

### 1) 初始化

```bash
npm run cli -- init
```

初始化后会生成：

- `.env.local`（本地密钥与管理员 token）
- `gateway/config/gateway.config.json`（网关配置）
- `examples/openclaw-mcp-config.generated.json`（OpenClaw 导入模板）

### 2) 配置 API Key

编辑 `.env.local`，填写：

- `CURSOR_CLOUD_API_KEY=<your_key>`
- `CURSOR_CLOUD_REPO_URL=https://github.com/<org>/<repo>`
- 可选：`CURSOR_CLOUD_REPO_REF=main`

### 3) 一键拉起

```bash
npm run cli -- up
```

`up` 会自动执行：

- 检查并自动选择可用网关端口（占用时自动递增）
- 启动 gateway（后台）
- 检查 MCP `dist/index.js` 构建产物（OpenClaw 拉起时可直接使用）
- 健康检查通过后输出可用状态

可选运维命令：

```bash
npm run cli -- status
npm run cli -- logs
npm run cli -- down
npm run cli -- doctor
npm run cli -- doctor --fix
```

`down` 会停止 gateway 后台进程。MCP 为 stdio 模式，由 OpenClaw 在调用时拉起。

`doctor --fix` 会自动补齐缺失的初始化文件并尝试构建 `dist/`。

你也可以全局安装后使用同名命令：

```bash
npm i -g .
openclaw-cursor-mcp init
openclaw-cursor-mcp up
```

## 发布建议

发布前建议执行：

```bash
npm run build
npm run cli -- doctor --fix
npm run acceptance:check
```

本地验证无误后可发布：

```bash
npm pack
# 或 npm publish（发布到 npm）
```

## 上线前检查清单

- `.env.local` 已配置：
  - `CURSOR_CLOUD_API_KEY`
  - `CURSOR_CLOUD_REPO_URL`
  - `CURSOR_CLOUD_REPO_REF`
  - `OPENCLAW_ADMIN_TOKEN`
- `npm run cli -- doctor --fix` 全 PASS
- `npm run acceptance:check` 通过（含真实 `/chat` 调用）
- `npm run gateway:status` 显示 running 且 `/health` 正常
- OpenClaw 已导入 `examples/openclaw-mcp-config.generated.json`

开发模式：

```bash
npm run dev
```

启动 HTTP 网关（Cursor 下游入口）：

```bash
npm run gateway
```

推荐使用可控管理命令（避免“启动后不易停止”）：

```bash
npm run gateway:start
npm run gateway:status
npm run gateway:stop
```

可选：

- `npm run gateway:restart`
- `npm run gateway:logs`

说明：

- `gateway:start` 会写入 PID 到 `data/runtime/gateway.pid`
- `gateway:stop` 会优雅停止（超时后强制结束）
- `gateway:logs` 查看 `data/runtime/gateway.log`

打开可视化配置页面（网关启动后）：

- `http://127.0.0.1:8787/config`
- 支持在线编辑并保存 `gateway/config/gateway.config.json`

## 全流程测试（推荐）

### 0. 编译

```bash
npm install
npm run build
```

### 1. 启动 Gateway（下游）

```bash
npm run gateway:start
```

启动成功日志示例：

`Cursor HTTP gateway listening on http://127.0.0.1:8791 (mode=plugin)`

> 注意：健康检查地址必须和日志里的端口一致。  
> 例如日志是 `8791`，就访问 `http://127.0.0.1:8791/health`，不是 `8787`。

### 2. 配置插件（可视化）

浏览器打开：

- `http://127.0.0.1:<gateway_port>/config`

在页面里填写：

- `cloud.CURSOR_CLOUD_API_KEY`
- 其他 Cloud 配置（按需）

点击：

- `测试 Cloud 连通性`
- `保存`

然后重启 gateway 生效。

### 3. 启动 MCP Server（上游）

新开终端，在项目根目录：

```bash
npm start
```

或开发模式：

```bash
npm run dev
```

### 4. 在 OpenClaw 导入 MCP

参考 `examples/openclaw-mcp-config.json`，确保：

- `command` 指向 `node`
- `args` 指向 `dist/index.js`
- `CURSOR_ADAPTER_MODE=http`
- `CURSOR_API_BASEURL=http://127.0.0.1:<gateway_port>`
- `CURSOR_API_ENDPOINT=/chat`

### 5. 端到端调用顺序

1. `cursor_session_create`
2. `cursor_permission_request`（`requestedAction=chat_send`）
3. `cursor_permission_grant`（带 `adminToken`）
4. `cursor_session_send_message`
5. `cursor_session_get` / `cursor_audit_list`
6. 可选：`cursor_metrics_get` 查看最近窗口稳定性指标。
7. 可选：`cursor_gateway_config_get` / `cursor_gateway_config_update` 由 OpenClaw 自动调整网关配置（例如切换 mode、更新 cloud 参数）。

可选环境变量：

- `OPENCLAW_CURSOR_DB_PATH`：持久化文件路径（JSON）。
- `OPENCLAW_ADMIN_TOKEN`：授权审批管理员令牌（必配，供 grant/revoke 校验）。
- `OPENCLAW_PERMISSION_TTL_MS`：审批默认有效期（毫秒），默认 `86400000`（24h）。
- `CURSOR_ADAPTER_MODE`：`mock` / `http` / `cli`。
- `CURSOR_API_BASEURL`：`http` 模式下 Cursor 后端地址。
- `CURSOR_API_ENDPOINT`：`http` 模式下接口路径，默认 `/chat`。
- `CURSOR_CLI_CMD`：`cli` 模式下命令路径，参数为 `[sessionId, message]`。
- `CURSOR_GATEWAY_CONFIG_PATH`：网关配置文件路径（默认 `gateway/config/gateway.config.json`）。
- `CURSOR_GATEWAY_HOST`：网关监听地址（环境变量优先于配置文件）。
- `CURSOR_GATEWAY_PORT`：网关监听端口（环境变量优先于配置文件）。
- `CURSOR_GATEWAY_MODE`：网关后端模式，`mock` / `cli` / `plugin`（环境变量优先于配置文件）。
- `CURSOR_GATEWAY_CLI_CMD`：网关 `cli` 模式下执行命令。
- `CURSOR_GATEWAY_CLI_ARGS_JSON`：网关 `cli` 模式命令参数模板（JSON 字符串数组，支持 `{{sessionId}}`、`{{message}}`）。
- `CURSOR_GATEWAY_CLI_TIMEOUT_MS`：网关 `cli` 模式超时，默认 `60000`。
- `CURSOR_GATEWAY_PLUGIN`：网关 `plugin` 模式的模块路径（默认 `./providers/custom-provider.mjs`）。
- `CURSOR_CLOUD_API_KEY`：插件模式下调用 Cloud Agents API 的 Bearer Token。
- `CURSOR_CLOUD_API_BASE_URL`：Cloud API 地址，默认 `https://api.cursor.com`。
- `CURSOR_CLOUD_WORKSPACE_PATH`：创建 agent 时使用的工作目录，默认 `.`。
- `CURSOR_CLOUD_REPO_URL`：Cloud Agents API v1 必填，agent 操作的 GitHub 仓库 URL。
- `CURSOR_CLOUD_REPO_REF`：仓库起始分支/标签/提交，默认 `main`。
- `CURSOR_CLOUD_MODEL`：可选，指定 Cloud Agent 模型。
- `CURSOR_CLOUD_POLL_INTERVAL_MS`：run 状态轮询间隔，默认 `1500`。
- `CURSOR_CLOUD_POLL_MAX_INTERVAL_MS`：指数退避轮询的最大间隔，默认 `5000`。
- `CURSOR_CLOUD_POLL_BACKOFF_MULTIPLIER`：轮询退避系数，默认 `1.5`。
- `CURSOR_CLOUD_TIMEOUT_MS`：run 超时，默认 `120000`。
- `CURSOR_CLOUD_REQUIRED`：`true` 时若缺少 API key 直接报错；否则回退到本地提示回复。
- `CURSOR_SESSION_AGENT_CACHE_PATH`：`sessionId -> agentId` 持久化缓存文件（默认 `./data/session-agent-map.json`）。
- `CURSOR_SESSION_AGENT_TTL_MS`：`sessionId -> agentId` 映射 TTL，过期后自动重建 agent，默认 `86400000`（24h）。
- `CURSOR_BRIDGE_MODE`：`gateway/cursor-cli-wrapper.mjs` 的模式，`mock` / `cursor-agent-json` / `command`。
- `CURSOR_REAL_CLI_CMD`：wrapper 在 `command` 模式下调用的真实命令。
- `CURSOR_REAL_CLI_ARGS_JSON`：真实命令参数模板（JSON 字符串数组，支持 `{{sessionId}}`、`{{message}}`）。
- `CURSOR_REAL_CLI_TIMEOUT_MS`：真实命令超时，默认 `120000`。
- `CURSOR_AGENT_CMD`：`cursor-agent-json` 模式下的命令名，Windows 默认 `cursor.cmd`，其他系统默认 `cursor`。
- `CURSOR_AGENT_MODEL`：可选，指定 `cursor agent` 使用的模型。
- `CURSOR_AGENT_PROMPT_PREFIX`：可选，注入到代理 prompt 的前缀说明。

## 与 OpenClaw 联动思路

1. 在 OpenClaw 中将该进程注册为 MCP server（stdio 模式），可参考 `examples/openclaw-mcp-config.json`。
2. OpenClaw 调用 `cursor_session_create` 创建会话。
3. 发送消息前，OpenClaw 可先调用 `cursor_permission_request`。
   - 可选传 `expiresInMs` 指定本次审批有效期（毫秒）。
4. 管理端调用 `cursor_permission_grant`（携带 `adminToken`）通过授权后，再调用 `cursor_session_send_message`（建议显式传 `idempotencyKey`；不传则自动生成）。
5. 通过 `cursor_session_get` / `cursor_session_list` 回读状态。
6. 用 `cursor_audit_list` 审计关键动作。

## Cursor 真实接入

当前 `src/index.ts` 中 `CursorAdapter` 已支持三种模式：

- `mock`：本地模拟响应，便于联调。
- `http`：POST 到 `${CURSOR_API_BASEURL}${CURSOR_API_ENDPOINT}`，body 为 `{ sessionId, message, traceId }`，并透传 `x-trace-id`。
- `cli`：调用 `CURSOR_CLI_CMD sessionId message` 并读取 stdout 作为回复。

### 最小 HTTP 网关联调

1. 先启动网关：`npm run gateway`
2. MCP Server 设置：
   - `CURSOR_ADAPTER_MODE=http`
   - `CURSOR_API_BASEURL=http://127.0.0.1:8787`
   - `CURSOR_API_ENDPOINT=/chat`
3. 健康检查：`GET http://127.0.0.1:8787/health`
4. 网关聊天接口：
   - `POST /chat`
   - 请求体：`{ "sessionId": "xxx", "message": "hello", "traceId": "optional-trace-id" }`
   - 成功返回：`{ "ok": true, "reply": "...", "traceId": "..." }`
   - 失败返回：`{ "ok": false, "code": "...", "message": "...", "traceId": "...", "retryable": true|false, "detail": ... }`

### 重试策略建议（OpenClaw 调用侧）

- 对 `cursor_session_send_message`：优先显式传 `idempotencyKey`；若未传，服务端会按 `sessionId + callerId + 归一化消息` 自动生成默认键。
- 若网关返回 `retryable=true`（例如 `CLI_TIMEOUT` / `CLI_EXEC_FAILED` / `PLUGIN_INVALID_REPLY`），可按指数退避重试，并复用同一 `idempotencyKey`。
- 若 `retryable=false`（如参数错误、权限错误、配置错误），应直接失败并提示人工处理。
- 排障时统一使用 `traceId` 串联 OpenClaw 日志、MCP 审计日志、Gateway/Provider 日志。

### 轻量指标观测（MCP）

- 工具：`cursor_metrics_get`
- 入参：
  - `lookbackHours`：统计窗口（小时，默认 `24`）
  - `limit`：最多扫描审计条数（默认 `1000`）
- 输出指标：
  - `rates.successRate`：发送成功率
  - `rates.timeoutRate`：超时错误率
  - `rates.permissionBlockedRate`：权限拦截率
  - `latency.avgMs`：平均端到端耗时（基于 `session.message.user -> session.message.assistant`）

### 配置自动化（MCP）

- 工具：`cursor_gateway_config_get`
  - 入参：`adminToken`
  - 返回：当前 `gateway/config/gateway.config.json`（或 `CURSOR_GATEWAY_CONFIG_PATH` 指定路径）的配置内容
- 工具：`cursor_gateway_config_update`
  - 入参：`adminToken`, `patch`
  - 行为：以“深度合并（deep merge）”方式更新配置；只覆盖 `patch` 中给出的字段
  - 典型用途：OpenClaw 自动切换 `gateway.mode`、更新 `cloud.CURSOR_CLOUD_MODEL`、调整轮询参数等
- 安全：两个工具都要求 `adminToken`，并写入审计事件（`gateway.config.get` / `gateway.config.update`）

### 网关进程自动运维（MCP）

- 工具：
  - `cursor_gateway_process_status`
  - `cursor_gateway_process_start`
  - `cursor_gateway_process_stop`
  - `cursor_gateway_process_restart`
  - `cursor_gateway_process_logs`（支持 `lines` 参数，默认 200）
- 全部要求 `adminToken`
- 底层调用 `gateway/manage.mjs`，与本地 `npm run gateway:*` 行为一致
- 适合 OpenClaw 自动化场景：发布后重启、故障自愈、日志回读

### 从 mock 迁移到真实 CLI

1. 网关设置为 `cli` 模式，并让它调用 wrapper：
   - `CURSOR_GATEWAY_MODE=cli`
   - `CURSOR_GATEWAY_CLI_CMD=node`
   - `CURSOR_GATEWAY_CLI_ARGS_JSON=["D:/.../gateway/cursor-cli-wrapper.mjs","{{sessionId}}","{{message}}"]`
2. wrapper 切到真实命令转发：
   - 方案 A（推荐）：`CURSOR_BRIDGE_MODE=cursor-agent-json`（直接调用 `cursor agent -p --output-format json`）
   - 方案 B：`CURSOR_BRIDGE_MODE=command` + `CURSOR_REAL_CLI_CMD=<你的真实命令>`
   - 方案 B 参数：`CURSOR_REAL_CLI_ARGS_JSON=["{{sessionId}}","{{message}}"]`（按真实命令需要调整）
3. 如果真实命令 stdout 返回 JSON，且包含 `reply` 字段，wrapper 会自动提取该字段；否则原样透传 stdout。

### 当本机 Cursor CLI 不支持 headless 时（推荐）

如果你本机 `cursor` 实测不能稳定执行 `agent -p`，可使用插件后端避免被 CLI 能力卡住：

1. 设置网关为插件模式：
   - `CURSOR_GATEWAY_MODE=plugin`
   - `CURSOR_GATEWAY_PLUGIN=./providers/custom-provider.mjs`
2. 在 `gateway/providers/custom-provider.mjs` 中实现：
   - `export async function generateReply(sessionId, message, context) { ... }`
3. 你可以在这个插件里接任意真实后端（自建服务、ACP 客户端、Cloud Agent API 适配层）。

当前仓库自带的 `gateway/providers/custom-provider.mjs` 已实现 Cloud Agents API 版本：

- 首次按 `sessionId` 创建并缓存 `agentId`
- 每条消息创建 run 并轮询到完成
- 自动提取 reply 字段（支持多种常见返回结构）
- `sessionId -> agentId` 会持久化到 `CURSOR_SESSION_AGENT_CACHE_PATH` 文件，重启后仍可复用

### 推荐配置方式（避免每次设环境变量）

1. 编辑 `gateway/config/gateway.config.json`
2. 启动网关：`npm run gateway`
3. 浏览器打开 `/config` 页面进行可视化修改
4. 点击保存后重启网关生效

## 常见问题

### 1) `http://127.0.0.1:8787/health` 无法访问

你的情况通常是端口不一致：

- 你实际启动在 `8791`
- 但访问了 `8787`

请以网关日志为准访问：

- `http://127.0.0.1:<日志端口>/health`

若端口被占用（`EADDRINUSE`）：

```bash
netstat -ano | findstr :8787
taskkill /PID <PID> /F
```

或直接换端口：

```bash
$env:CURSOR_GATEWAY_PORT="8791"
npm run gateway
```

### 2) `CURSOR_CLOUD_API_KEY` 如何获取

通常在 Cursor 账户的 API/开发者页面创建：

1. 登录 Cursor 账户后台
2. 进入 API Keys（或 Developer / Cloud Agent API）页面
3. 创建新 Key 并复制
4. 填到 `/config` 页的 `cloud.CURSOR_CLOUD_API_KEY` 后保存

文档参考：

- [Cursor API 总览](https://cursor.com/docs/api.md)
- [Cloud Agent API endpoints](https://cursor.com/docs/cloud-agent/api/endpoints.md)

> 安全建议：不要把 key 提交到 git；只保存在本地配置文件或受控密钥管理中。

建议加上：

- 多租户隔离（OpenClaw 用户/项目维度）；
- 基于动作与会话级别的策略控制（RBAC/ABAC）。
