# Bridge 架构说明

## 完整通信链路

### 请求链路（发送）
```
opencode web 
  → opencode-fake-server (bridge) 
    → acp-wss-bridge 
      → wss-server 
        → acp-stdio-bridge 
          → Agent 进程 (stdin)
```

### 响应链路（返回）
```
Agent 进程 (stdout) 
  → acp-stdio-bridge 
    → wss-server 
      → acp-wss-bridge 
        → opencode-fake-server (bridge) 
          → opencode web
```

## 组件说明

### 1. opencode-fake-server
**位置**: `packages/bridge/src/opencode-fake-server.ts`

**职责**:
- 伪装成 opencode server，提供前端需要的所有 HTTP API
- 管理多个工作目录的 ACP bridge 实例
- 处理 SSE 事件广播
- 通过 `acp-wss-bridge` 连接远程 wss-server 或本地进程

**配置**:
- `BRIDGE_PORT`: HTTP 服务器端口（默认：4096）
- `WORK_DIR`: 默认工作目录
- `ACP_ENGINE`: 引擎类型（`opencode` 或 `qwen-code`）
- `ACP_PATH`: ACP CLI 路径（bridge 本地进程模式使用）
- `ACP_COMMAND`: ACP 命令名（wss-server 和 bridge 本地进程模式使用，默认：`qwen`）
- `ACP_ARGS`: ACP 命令参数（wss-server 使用，默认：`--acp`，空格分隔）
- `WSS_SERVER_URL`: 远程 wss-server 的 WebSocket URL（默认：`ws://localhost:4001/ws`）

### 2. acp-wss-bridge
**位置**: `packages/bridge/src/acp-wss-bridge.ts`

**职责**:
- ACP 协议桥接层
- 支持三种连接模式：
  1. **streams 模式**: 使用传入的 WritableStream/ReadableStream（可以是远程 WebSocket 或本地 stdio）
  2. **wsUrl 模式**: 连接到远程 wss-server
  3. **本地进程模式**: 直接启动 ACP Agent 子进程

**连接优先级**:
1. 如果提供 `streams` 参数，优先使用（最灵活，可用于任何数据传输方式）
2. 否则如果提供 `wsUrl`，连接远程 WebSocket
3. 否则启动本地子进程

### 3. wss-server
**位置**: `packages/opencode-qwen-acp-demo/src/wss-server.ts`

**职责**:
- WebSocket 服务器，监听 `/ws` 路径
- 接收前端 WebSocket 连接
- 创建 `acp-stdio-bridge` 实例，透传 ACP 协议数据到 Agent 进程
- 实现透明的数据流转发

**配置**:
- `PORT`: WebSocket 服务器端口（默认：4001）

### 4. acp-stdio-bridge
**位置**: `packages/opencode-qwen-acp-demo/src/acp-stdio-bridge.ts`

**职责**:
- 直接启动 ACP Agent 子进程（如 `qwen --acp`）
- 通过 stdio（stdin/stdout）与子进程通信
- 使用 ndjson（换行分隔的 JSON）格式解析 ACP 协议数据
- 封装 ACP 协议操作：初始化、创建会话、发送 prompt、取消等

## 数据流详解

### streams 模式（推荐）
```typescript
// opencode-fake-server 创建远程 WebSocket 连接
const remoteStreams = await createRemoteWebSocketConnection(wssServerUrl)

// acp-wss-bridge 使用这些 streams
const bridge = new OpencodeAcpBridge(
  { 
    cwd: directory,
    streams: { 
      stdin: remoteStreams.stdin,   // 发送到 wss-server
      stdout: remoteStreams.stdout   // 从 wss-server 接收
    }
  },
  callback
)
```

### wsUrl 模式
```typescript
// acp-wss-bridge 直接连接 WebSocket
const bridge = new OpencodeAcpBridge(
  { 
    cwd: directory,
    wsUrl: "ws://localhost:4001/ws"
  },
  callback
)
```

### 本地进程模式
```typescript
// acp-wss-bridge 启动本地子进程
const bridge = new OpencodeAcpBridge(
  { 
    cwd: directory,
    engine: "qwen-code",
    opencodePath: "/path/to/qwen"
  },
  callback
)
```

## 为什么需要 wss-server？

由于 ACP SDK 没有实现 streamable 通信方式，我们只能用以下方式来模拟进程的 stdio 通信：

```
acp-wss-bridge → wss-server → acp-stdio-bridge → Agent 进程
```

这样设计的好处：
1. **解耦**: opencode-fake-server 不需要知道底层如何连接 Agent
2. **灵活性**: 可以在不同部署场景下选择不同的连接方式
3. **透明传输**: wss-server 只负责转发 ACP 协议数据，不关心业务逻辑
4. **可扩展**: 可以轻松切换到其他传输方式（如 TCP、Unix Socket）

## 部署示例

### 本地开发
```bash
# 终端 1: 启动 wss-server
cd packages/opencode-qwen-acp-demo
bun run src/wss-server.ts

# 终端 2: 启动 opencode-fake-server
cd packages/bridge
WSS_SERVER_URL="ws://localhost:4001/ws" bun dev
```

### Docker 部署
```yaml
version: '3'
services:
  wss-server:
    image: opencode/wss-server
    ports:
      - "4001:4001"
    environment:
      - PORT=4001
  
  bridge:
    image: opencode/bridge
    ports:
      - "4096:4096"
    environment:
      - BRIDGE_PORT=4096
      - WSS_SERVER_URL=ws://wss-server:4001/ws
      - WORK_DIR=/workspace
    volumes:
      - ./workspace:/workspace
```

## 调试模式

如果需要降级到本地日志模式（不连接实际 Agent），可以设置：

```bash
# 不设置 WSS_SERVER_URL，且让连接失败后自动降级
unset WSS_SERVER_URL
```

或者在代码中捕获错误后自动降级到本地模式。

## 注意事项

1. **同一目录共享 bridge**: 同一个工作目录下的多个 session 共享同一个 ACP bridge 实例
2. **sessionDirectory 映射**: 记录每个 session 对应的 directory，用于 SSE 事件路由
3. **bridgeSessionMap**: 记录每个 directory 当前绑定的 sessionID，用于事件回调
4. **自动降级**: 如果连接 wss-server 失败，会自动降级到本地日志模式
