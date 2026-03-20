## 已完成

### 1. 修改 acpBridge，替换子进程为 WS 通信 ✅
- 创建了 `acpBridge.ws.ts` - WebSocket 客户端版本的 Bridge
- 保留了原有的 `acpBridge.ts` - 子进程版本（向后兼容）
- WebSocket 客户端通过 WS 协议与远程 server 通信

### 2. 建立 ws 的流程前置到 session init ✅  
- Server 端在收到 `init` 消息时自动创建 session
- Client 端在 `start()` 时发送 init 并等待 ready 信号
- 会话 ID 在服务端创建后返回给客户端

### 3. Dockerfile 部署配置 ✅
- 创建了最小化 Dockerfile
- 仅需 Node.js 环境即可运行
- 不需要预装 opencode、qwen-code

---

## 使用方式

### 启动 WebSocket Server
```bash
cd packages/bridge/opencode-qwen-acp-demo
npm install
npm run dev
# 或构建后运行
npm run build
node dist/server.js
```

### Docker 部署
```bash
docker build -t opencode-qwen-acp-server .
docker run -p 4001:4001 opencode-qwen-acp-server
```

### Client 端使用示例
```typescript
import { QwenAcpBridge } from "./acpBridge.ws"

const bridge = new QwenAcpBridge(
  {
    wsUrl: "ws://localhost:4001/ws",
    cliEntryPath: "/path/to/qwen-code/dist/index.mjs",
    cwd: process.cwd(),
  },
  (update) => {
    console.log("session update:", update)
  }
)

await bridge.start() // 自动发送 init 并等待 ready
await bridge.newSession()
const result = await bridge.prompt("Hello")
```

---

## 待完成
4、获取权限修改文件，会导致 opencode web 页面 crash
5、审查无法感知到以及被 git 版本控制的 project
6、agentrun 提供了怎么样的 infra，考虑后期如何接入
