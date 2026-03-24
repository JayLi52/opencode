# OpenCode Web Bridge

基于 opencode web 前端的 ACP 协议桥接层。复用 opencode 的 web UI，通过 bridge 对接任意支持 ACP 协议的 AI Agent（如 opencode、qwen-code 等）。

## 系统要求

- Node.js >= 20
- [Bun](https://bun.sh/) >= 1.3（包管理和运行）
- 一个支持 ACP 协议的 Agent CLI（如 `opencode`、`qwen` 等），需要在 PATH 中可用

## 快速开始

### 1. 安装依赖

```bash
# 在项目根目录（opencode/）
bun install
```

### 2. 启动服务

需要启动两个服务：wss-server（ACP 进程管理）和 bridge（HTTP API 层）。

**终端 1 — 启动 wss-server**

```bash
# 在项目根目录
bun run dev:ws
```

默认监听 `4001` 端口，通过 WebSocket 管理 ACP Agent 子进程。

**终端 2 — 启动 bridge**

```bash
# 在项目根目录
bun run dev:bridge
```

默认监听 `4096` 端口，伪装成 opencode server 为前端提供 HTTP API + SSE。

**终端 3 — 启动前端**

```bash
# 在项目根目录
bun run dev:web
```

默认监听 `3000` 端口。打开浏览器访问 `http://localhost:3000`，在前端添加 server 地址 `http://localhost:4096` 即可。

## 环境变量

所有配置都通过环境变量控制，没有硬编码路径。

### Bridge（opencode-fake-server）

| 变量 | 说明 | 默认值 |
|---|---|---|
| `BRIDGE_PORT` | bridge HTTP 服务端口 | `4096` |
| `WORK_DIR` | 默认工作目录 | 当前目录 `process.cwd()` |
| `ACP_ENGINE` | 引擎类型 | `qwen-code` |
| `ACP_PATH` | ACP CLI 的完整路径（bridge 本地进程模式） | 不设置则按 engine 类型使用默认命令名 |
| `ACP_COMMAND` | ACP 命令名（本地进程模式 fallback） | `qwen`（qwen-code 引擎）或 `opencode` |
| `WSS_SERVER_URL` | wss-server 的 WebSocket 地址 | `ws://localhost:4001/ws` |

### wss-server

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | WebSocket 服务端口 | `4001` |
| `ACP_COMMAND` | 要启动的 ACP CLI 命令名 | `qwen` |
| `ACP_ARGS` | ACP CLI 参数（空格分隔） | `--acp` |

### 示例：使用 opencode 作为 Agent

```bash
# wss-server
ACP_COMMAND=opencode ACP_ARGS=acp PORT=4001 bun run dev:ws

# bridge
ACP_ENGINE=opencode WSS_SERVER_URL=ws://localhost:4001/ws bun run dev:bridge
```

### 示例：使用 qwen-code 作为 Agent

```bash
# wss-server
ACP_COMMAND=qwen ACP_ARGS=--acp PORT=4001 bun run dev:ws

# bridge（默认就是 qwen-code）
bun run dev:bridge
```

### 示例：ACP CLI 不在 PATH 中，指定完整路径

```bash
# wss-server
ACP_COMMAND=/usr/local/bin/qwen bun run dev:ws

# 或者 bridge 本地进程模式
ACP_PATH=/usr/local/bin/qwen bun run dev:bridge
```

## 架构概览

```
opencode web 前端 (:3000)
  ↕ HTTP + SSE
bridge / opencode-fake-server (:4096)
  ↕ WebSocket (ndjson)
wss-server (:4001)
  ↕ stdio (stdin/stdout)
ACP Agent 进程 (qwen --acp / opencode acp)
```

- **bridge** — 伪装成 opencode server，实现前端需要的所有 HTTP API（session、消息、文件、SSE 等）
- **wss-server** — WebSocket 中转，每个连接启动一个 ACP Agent 子进程，双向透传 ndjson 数据
- **前端** — 直接复用 opencode 的 `packages/app`，无需修改

详细架构说明见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 常见问题

### 启动报错 `spawn qwen ENOENT` 或 `spawn opencode ENOENT`

ACP CLI 命令不在 PATH 中。解决方式：

```bash
# 方式 1: 确认命令可用
which qwen  # 或 which opencode

# 方式 2: 通过环境变量指定完整路径
ACP_COMMAND=/your/path/to/qwen bun run dev:ws
```

### 启动报错 `spawn ENOENT` 提示 `/bin/zsh`

旧版本代码写死了 macOS 的 shell 路径，已修复。请拉取最新代码。

### 前端连不上 bridge

1. 确认 bridge 已启动且端口正确（默认 4096）
2. 在前端 UI 中添加 server 地址：`http://localhost:4096`
3. 如果跨机器访问，确认防火墙放行了对应端口

### wss-server 和 bridge 部署在不同机器上

```bash
# 机器 A: 运行 wss-server（有 ACP CLI 的机器）
ACP_COMMAND=qwen PORT=4001 bun run dev:ws

# 机器 B: 运行 bridge
WSS_SERVER_URL=ws://机器A的IP:4001/ws bun run dev:bridge
```

## 平台兼容性

| 平台 | 状态 | 备注 |
|---|---|---|
| macOS | ✅ | |
| Linux | ✅ | |
| Windows (WSL) | ✅ | 在 WSL 内运行即可 |
| Windows (原生) | ⚠️ | 未测试，理论上 `shell: true` 可以工作 |

## API 实现状态

bridge 的 `opencode-fake-server` 伪装成 opencode 原版 server，下面是所有 API 接口与实现状态的完整对比。

状态说明：
- ✅ 已实现 — 功能完整可用
- ⚠️ 桩 — 返回空数据，前端不会崩但功能缺失
- 🔶 部分 — 有基本实现但不完整
- ❌ 缺失 — 未实现

### Global 路由

| 接口 | 说明 | 状态 | 备注 |
|---|---|---|---|
| `GET /global/health` | 健康检查 | ✅ | 返回固定版本号 |
| `GET /global/event` | SSE 全局事件流 | ✅ | 含 heartbeat |
| `GET /global/config` | 全局配置 | ⚠️ | 返回 `{}` |
| `PATCH /global/config` | 更新全局配置 | ⚠️ | 返回 `{}` |
| `POST /global/dispose` | 销毁所有实例 | ❌ | |

### Auth 路由

| 接口 | 说明 | 状态 | 备注 |
|---|---|---|---|
| `PUT /auth/:providerID` | 设置认证凭据 | ❌ | |
| `DELETE /auth/:providerID` | 删除认证凭据 | ❌ | |

### 基础信息路由

| 接口 | 说明 | 状态 | 备注 |
|---|---|---|---|
| `GET /path` | 路径信息 | ✅ | |
| `GET /vcs` | git 分支 | ⚠️ | 固定返回 `main` |
| `GET /command` | 命令列表 | ⚠️ | 返回 `[]` |
| `GET /agent` | Agent 列表 | ✅ | 固定返回 coder |
| `GET /skill` | Skill 列表 | ⚠️ | 返回 `[]` |
| `POST /log` | 写日志 | ⚠️ | 不做实际处理 |
| `GET /lsp` | LSP 状态 | ⚠️ | 返回 `[]` |
| `GET /formatter` | 格式化器状态 | ❌ | |
| `GET /event` | 实例级 SSE 事件流 | ❌ | 用 `/global/event` 替代 |
| `GET /doc` | OpenAPI 文档 | ❌ | |
| `POST /instance/dispose` | 销毁实例 | ❌ | |

### Provider 路由

| 接口 | 说明 | 状态 | 备注 |
|---|---|---|---|
| `GET /provider` | 列出 provider | ✅ | 固定返回 bridge provider |
| `GET /provider/auth` | 认证方式 | ⚠️ | 返回 `{}` |
| `POST /provider/:id/oauth/authorize` | OAuth 授权 | ❌ | |
| `POST /provider/:id/oauth/callback` | OAuth 回调 | ❌ | |

### Config 路由

| 接口 | 说明 | 状态 | 备注 |
|---|---|---|---|
| `GET /config` | 获取配置 | ✅ | 固定配置 |
| `PATCH /config` | 更新配置 | ⚠️ | 不做实际处理 |
| `GET /config/providers` | 配置的 provider 列表 | ⚠️ | 返回 `[]` |

### Project 路由

| 接口 | 说明 | 状态 | 备注 |
|---|---|---|---|
| `GET /project` | 列出项目 | ✅ | 内存维护 |
| `GET /project/current` | 当前项目 | ✅ | |
| `PATCH /project/:id` | 更新项目 | ✅ | |
| `POST /project/git/init` | 初始化 git 仓库 | ❌ | |

### Session 路由（核心）

| 接口 | 说明 | 状态 | 备注 |
|---|---|---|---|
| `GET /session` | 列出 session | ✅ | |
| `POST /session` | 创建 session | ✅ | |
| `GET /session/status` | 所有 session 状态 | ⚠️ | 返回 `{}` |
| `GET /session/:id` | 获取 session | ✅ | |
| `PATCH /session/:id` | 更新 session | ✅ | 支持改标题 |
| `DELETE /session/:id` | 删除 session | 🔶 | 不真正删除 |
| `GET /session/:id/message` | 消息列表 | ✅ | 未实现分页 |
| `GET /session/:id/message/:msgID` | 获取单条消息 | ❌ | |
| `DELETE /session/:id/message/:msgID` | 删除消息 | ❌ | |
| `DELETE /session/:id/message/:msgID/part/:partID` | 删除 part | ❌ | |
| `PATCH /session/:id/message/:msgID/part/:partID` | 更新 part | ❌ | |
| `POST /session/:id/message` | 同步发送消息 | ❌ | 只有 async 版本 |
| `POST /session/:id/prompt_async` | 异步发送消息 | ✅ | 核心接口 |
| `POST /session/:id/abort` | 中止 session | ✅ | |
| `POST /session/:id/command` | 发送命令 | ❌ | |
| `POST /session/:id/shell` | 执行 shell | ❌ | |
| `POST /session/:id/init` | 初始化（AGENTS.md） | ❌ | |
| `POST /session/:id/fork` | Fork session | ❌ | |
| `POST /session/:id/share` | 分享 session | ❌ | |
| `DELETE /session/:id/share` | 取消分享 | ❌ | |
| `POST /session/:id/summarize` | 总结/压缩 | ❌ | |
| `POST /session/:id/revert` | 回滚消息 | ❌ | |
| `POST /session/:id/unrevert` | 恢复回滚 | ❌ | |
| `GET /session/:id/todo` | Todo 列表 | ⚠️ | 返回 `[]` |
| `GET /session/:id/diff` | 文件变更 | ✅ | |
| `GET /session/:id/children` | 子 session | ⚠️ | 返回 `[]` |
| `POST /session/:id/permissions/:pid` | 回复权限（旧版） | ✅ | |

### Permission 路由

| 接口 | 说明 | 状态 | 备注 |
|---|---|---|---|
| `GET /permission` | 列出待处理权限 | ⚠️ | 返回 `[]` |
| `POST /permission/:id/reply` | 回复权限（新版） | ❌ | |

### Question 路由

| 接口 | 说明 | 状态 | 备注 |
|---|---|---|---|
| `GET /question` | 列出待处理问题 | ⚠️ | 返回 `[]` |
| `POST /question/:id/reply` | 回复问题 | ❌ | |
| `POST /question/:id/reject` | 拒绝问题 | ❌ | |

### File 路由

| 接口 | 说明 | 状态 | 备注 |
|---|---|---|---|
| `GET /file` | 列出文件 | ✅ | 不递归，过滤隐藏文件 |
| `GET /file/content` | 读取文件内容 | ✅ | 支持二进制检测 |
| `GET /file/status` | git 文件状态 | ⚠️ | 返回 `[]` |
| `GET /find/file` | 搜索文件 | 🔶 | 只搜一层目录 |
| `GET /find` | ripgrep 文本搜索 | ❌ | |
| `GET /find/symbol` | LSP 符号搜索 | ❌ | |

### MCP 路由

| 接口 | 说明 | 状态 | 备注 |
|---|---|---|---|
| `GET /mcp` | MCP 状态 | ⚠️ | 返回 `{}` |
| `POST /mcp` | 添加 MCP server | ❌ | |
| `POST /mcp/:name/connect` | 连接 | ❌ | |
| `POST /mcp/:name/disconnect` | 断开 | ❌ | |
| `POST /mcp/:name/auth` | OAuth 开始 | ❌ | |
| `POST /mcp/:name/auth/callback` | OAuth 回调 | ❌ | |
| `POST /mcp/:name/auth/authenticate` | OAuth 认证 | ❌ | |
| `DELETE /mcp/:name/auth` | 删除 OAuth | ❌ | |

### PTY 路由（终端）

| 接口 | 说明 | 状态 | 备注 |
|---|---|---|---|
| `GET /pty` | 列出终端 | ❌ | |
| `POST /pty` | 创建终端 | ❌ | |
| `GET /pty/:id` | 获取终端 | ❌ | |
| `PUT /pty/:id` | 更新终端 | ❌ | |
| `DELETE /pty/:id` | 删除终端 | ❌ | |
| `GET /pty/:id/connect` | WebSocket 连接 | ❌ | |

### Experimental 路由

| 接口 | 说明 | 状态 | 备注 |
|---|---|---|---|
| `GET /experimental/session` | 跨项目 session 列表 | ✅ | |
| `GET /experimental/tool/ids` | 工具 ID 列表 | ❌ | |
| `GET /experimental/tool` | 工具列表 | ❌ | |
| `POST /experimental/worktree` | 创建 worktree | ❌ | |
| `GET /experimental/worktree` | 列出 worktree | ❌ | |
| `DELETE /experimental/worktree` | 删除 worktree | ❌ | |
| `POST /experimental/worktree/reset` | 重置 worktree | ❌ | |
| `GET /experimental/resource` | MCP 资源 | ❌ | |
| `POST /experimental/workspace` | 创建 workspace | ❌ | |
| `GET /experimental/workspace` | 列出 workspace | ❌ | |
| `DELETE /experimental/workspace/:id` | 删除 workspace | ❌ | |

### TUI 路由（终端 UI 专用）

全部未实现，web 场景不需要。包括 `append-prompt`、`submit-prompt`、`clear-prompt`、`open-help`、`open-sessions`、`open-themes`、`open-models`、`execute-command`、`show-toast`、`publish`、`select-session`、`control/next`、`control/response`。

### Bridge 独有接口（原版没有）

| 接口 | 说明 |
|---|---|
| `GET /engine` | 获取当前引擎类型（opencode / qwen-code） |
| `POST /engine/switch` | 切换引擎，销毁旧 bridge 实例 |
| `GET /global/sse-status` | 当前 SSE 连接数 |
| `GET /debug/store` | 调试用，查看内存中的 session 和消息状态 |

### 统计

| 状态 | 数量 | 说明 |
|---|---|---|
| ✅ 已实现 | ~20 | 核心对话流程完整 |
| ⚠️ 桩 | ~15 | 返回空数据，不影响核心功能 |
| 🔶 部分实现 | ~3 | 有基本功能但不完整 |
| ❌ 缺失 | ~40 | 高级功能未实现 |

核心对话链路（创建 session → 发消息 → 流式回复 → 权限处理 → 文件 diff）完整可用。

主要缺失的功能模块：
- PTY 终端（整个模块）
- MCP 管理（整个模块）
- OAuth 认证流程
- Session fork / revert / share / summarize
- ripgrep 文本搜索
- Worktree / Workspace 管理
- git 文件状态（`file/status`）
- 消息分页、单条消息操作
