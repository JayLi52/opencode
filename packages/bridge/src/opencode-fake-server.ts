/**
 * server.ts — 桥接层 HTTP 服务器
 *
 * 伪装成 opencode server，实现前端需要的所有 HTTP API。
 * 内部通过 ACP 协议连接真正的 Agent（opencode acp 或 qwen-code acp）。
 *
 * 目录管理：
 * - 每个工作目录对应一个 ACP bridge 实例（子进程 cwd = 该目录）
 * - 前端通过 x-opencode-directory header 告诉 bridge 当前操作的目录
 * - SSE 事件的 directory 字段必须和前端 child store key 一致
 * - 同一目录下的多个 session 共享同一个 ACP 子进程
 *
 * 修复记录：
 * - [fix] POST permissions 返回值从 c.json({ ok }) 改为 c.json(ok)，SDK 期望 200: boolean
 * - [fix] 权限回复成功后广播 permission.replied 事件，前端收到后移除 permission 弹窗
 * - [fix] WebSocket receive 日志截断到 200 字符，避免长 JSON 刷屏
 */

import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { addSseClient, broadcast, getSseClientCount } from "./sse.js"
import { store } from "./store.js"
import { handleAcpUpdate, handleAcpPermission } from "./eventConverter.js"
import { OpencodeAcpBridge, type EngineType } from "./acp-wss-bridge.js"
import { loadCommands, renderTemplate, type CommandInfo } from "./commandLoader.js"
import { createServer } from "http"
import { WebSocketServer, WebSocket } from "ws"
import { serve } from "@hono/node-server"

// ========== 配置 ==========

const PORT = parseInt(process.env.BRIDGE_PORT ?? "4096")
const DEFAULT_DIRECTORY = process.env.WORK_DIR ?? process.cwd()
const ENGINE: EngineType = (process.env.ACP_ENGINE as EngineType) ?? "qwen-code"
const ACP_PATH = process.env.ACP_PATH

// 前端实际使用的 directory（从 x-opencode-directory header 获取）
// 注意：不再依赖全局 activeDirectory 做 SSE 事件的 directory
// 每个 session 通过 sessionDirectory 精确跟踪自己的 directory
// activeDirectory 仅用于无法从 session 推断 directory 的场景（如 /path、/project 等全局路由）
let activeDirectory = DEFAULT_DIRECTORY
const sessionDirectory = new Map<string, string>() // sessionID → directory

function getDirectory(sessionID?: string): string {
  if (sessionID) {
    const dir = sessionDirectory.get(sessionID)
    if (dir) return dir
  }
  return DEFAULT_DIRECTORY
}

/**
 * 从请求 header 或 query parameter 中提取 directory（请求级别，不污染全局状态）
 * 前端 SDK 每个请求都带 x-opencode-directory header，
 * 但 session.list 等接口会把 directory 放在 query parameter 里
 */
function getRequestDirectory(c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }): string {
  // 优先从 query parameter 取（SDK session.list 等接口用 query param）
  const queryDir = c.req.query("directory")
  if (queryDir) {
    try {
      return decodeURIComponent(queryDir)
    } catch {
      return queryDir
    }
  }
  // 再从 header 取
  const raw = c.req.header("x-opencode-directory")
  if (raw) {
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return DEFAULT_DIRECTORY
}

// ========== 项目列表管理 ==========
// 维护用户打开过的项目列表（内存中），类似 opencode server 的 project 表
const projectSet = new Map<string, { id: string; worktree: string; time: { created: number; updated: number } }>()

function touchProject(directory: string) {
  const existing = projectSet.get(directory)
  if (existing) {
    existing.time.updated = Date.now()
  } else {
    projectSet.set(directory, {
      id: directory,
      worktree: directory,
      time: { created: Date.now(), updated: Date.now() },
    })
  }
}

// 启动时把默认目录加入项目列表
touchProject(DEFAULT_DIRECTORY)

function makeProject(directory: string) {
  const existing = projectSet.get(directory)
  if (existing) return { ...existing, sandboxes: [] }
  return {
    id: directory,
    worktree: directory,
    sandboxes: [],
    time: { created: Date.now(), updated: Date.now() },
  }
}

// ========== ACP Bridge 管理 ==========
// directory → bridge 实例（每个工作目录一个 bridge，同目录的 session 共享）
// 同一个目录下的多个 session 共享同一个 ACP 子进程
const bridges = new Map<string, OpencodeAcpBridge>()
// directory → sessionID（记录每个 bridge 当前绑定的 sessionID，用于事件回调）
const bridgeSessionMap = new Map<string, string>()

/**
 * 为指定 directory 创建 WebSocket 数据流转换器
 * @param ws WebSocket 连接
 * @returns { stdin: WritableStream, stdout: ReadableStream }
 */
function createWebSocketStreams(ws: WebSocket) {
  // 创建一个 WritableStream 用于发送数据到 WebSocket（从 ACP stdout → clientStream → WebSocket）
  const clientStream = new WritableStream({
    write: (chunk) => {
      const data = new TextDecoder().decode(chunk)
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    },
  })

  // 创建一个 ReadableStream 用于接收 WebSocket 数据（从 WebSocket → serverStream → ACP stdin）
  let serverController: ReadableStreamDefaultController<Uint8Array> | null = null
  const serverStream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      serverController = controller
    },
  })

  // 监听 WebSocket 消息，推入 serverStream
  ws.on("message", (data: WebSocket.RawData) => {
    const text = typeof data === "string" ? data : data.toString()
    const encoder = new TextEncoder()
    console.log("[ws] receive:", text.trim().substring(0, 200))
    serverController?.enqueue(encoder.encode(text + "\n"))
  })

  ws.on("close", () => {
    console.log("[ws] connection closed")
    serverController?.close()
  })

  ws.on("error", (err: any) => {
    console.error("[ws] error:", err)
    serverController?.error(err)
  })

  return {
    stdin: clientStream,
    stdout: serverStream,
  }
}

/**
 * 创建远程 WebSocket 连接（连接到 wss-server）
 * @param wsUrl WebSocket 服务器 URL
 * @returns { stdin: WritableStream, stdout: ReadableStream }
 */
async function createRemoteWebSocketConnection(wsUrl: string): Promise<{ stdin: WritableStream; stdout: ReadableStream<Uint8Array> }> {
  console.log("[acp-wss-bridge] connecting to remote wss-server:", wsUrl)

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let isResolved = false

    ws.onerror = (err) => {
      console.error("[acp-wss-bridge] WebSocket connection error:", err)
      if (!isResolved) reject(err)
    }

    ws.onopen = () => {
      console.log("[acp-wss-bridge] WebSocket connection established")
      isResolved = true
      resolve(createWebSocketStreams(ws))
    }

    ws.onclose = (event) => {
      console.log("[acp-wss-bridge] WebSocket connection closed", {
        code: event.code,
        reason: event.reason,
      })
    }
  })
}

async function getOrCreateBridge(sessionID: string, directory: string, ws?: WebSocket): Promise<OpencodeAcpBridge> {
  // 用 directory 做 key，同目录共享 bridge
  if (bridges.has(directory)) {
    // 更新 session 映射，让事件回调用最新的 sessionID
    bridgeSessionMap.set(directory, sessionID)
    return bridges.get(directory)!
  }

  // 记录 session → directory 映射
  bridgeSessionMap.set(directory, sessionID)

  // 如果有 WebSocket，使用 WebSocket streams；否则使用本地日志 streams
  let clientStream: WritableStream
  let serverController: ReadableStreamDefaultController<Uint8Array> | null = null
  let serverStream: ReadableStream<Uint8Array>

  if (ws) {
    // 使用 WebSocket 数据流
    const wsStreams = createWebSocketStreams(ws)
    clientStream = wsStreams.stdin
    serverStream = wsStreams.stdout
  } else {
    // 使用远程 wss-server 连接（默认方式）
    // 完整链路：opencode web -> opencode-fake-server -> acp-wss-bridge -> wss-server -> acp-stdio-bridge -> 进程
    const wssServerUrl = process.env.WSS_SERVER_URL ?? "ws://localhost:4001/ws"
    console.log("[acp-wss-bridge] connecting to wss-server:", wssServerUrl)
    
    try {
      // 把 directory、engine 对应的 command/args 传给 wss-server
      const urlWithParams = new URL(wssServerUrl)
      urlWithParams.searchParams.set("cwd", directory)
      // qwen-code → command=qwen, args=--acp
      // opencode  → command=opencode, args=acp
      if (currentEngine === "qwen-code") {
        urlWithParams.searchParams.set("command", "qwen")
        urlWithParams.searchParams.set("args", "--acp")
      } else {
        urlWithParams.searchParams.set("command", "opencode")
        urlWithParams.searchParams.set("args", "acp")
      }
      const remoteStreams = await createRemoteWebSocketConnection(urlWithParams.toString())
      clientStream = remoteStreams.stdin
      serverStream = remoteStreams.stdout
    } catch (err) {
      console.error("[acp-wss-bridge] failed to connect to wss-server, falling back to local mode:", err)
      // 降级到本地日志模式
      clientStream = new WritableStream({
        write: (chunk) => {
          console.log("[bridge] → ACP:", new TextDecoder().decode(chunk).trim())
        },
      })

      serverStream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          serverController = controller
        },
      })
    }
  }

  const bridge = new OpencodeAcpBridge(
    { 
      engine: currentEngine, 
      opencodePath: ACP_PATH, 
      cwd: directory,
      streams: { stdin: clientStream, stdout: serverStream },
    },
    (update) => {
      // 回调时用 bridgeSessionMap 获取当前活跃的 sessionID
      const currentSessionID = bridgeSessionMap.get(directory) ?? sessionID
      handleAcpUpdate(currentSessionID, directory, update)
    },
  )

    bridge.onPermission = (params) => {
    const currentSessionID = bridgeSessionMap.get(directory) ?? sessionID
    return handleAcpPermission(currentSessionID, directory, params as any)
  }

  await bridge.start()
  await bridge.newSession()
  bridges.set(directory, bridge)

  // newSession 完成后模型列表已更新，广播 server.connected 触发前端重新拉取 provider
  broadcast("global", "server.connected", {})

  // 如果用户之前选过 model，恢复选择
  const previousModel = store.getSelectedModel(directory)
  if (previousModel) {
    const modelId = previousModel.includes("/") ? previousModel.split("/").slice(1).join("/") : previousModel
    if (modelId && modelId !== "bridge-agent" && modelId !== bridge.currentModelId) {
      bridge.setModel(modelId).catch((err) => {
        console.warn("[bridge] failed to restore previous model selection:", err)
      })
    }
  }

  return bridge
}

// ========== Hono App ==========

const app = new Hono()

// CORS
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }))

// 从 x-opencode-directory header 更新 activeDirectory（仅用于全局路由的 fallback）
app.use("*", async (c, next) => {
  const raw = c.req.header("x-opencode-directory")
  if (raw) {
    let decoded: string
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      decoded = raw
    }
    if (decoded) {
      activeDirectory = decoded
    }
  }
  await next()
})

// 请求日志
app.use("*", async (c, next) => {
  await next()
  const status = c.res.status
  if (status >= 400) {
    console.warn(`[bridge] ${c.req.method} ${c.req.path} → ${status}`)
  } else {
    console.log(`[bridge] ${c.req.method} ${c.req.path} → ${status}`)
  }
})

// ========== 引擎切换 ==========

let currentEngine: EngineType = ENGINE

app.get("/engine", (c) => c.json({ engine: currentEngine }))

app.post("/engine/switch", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const newEngine = body.engine as EngineType
  if (newEngine !== "opencode" && newEngine !== "qwen-code") {
    return c.json({ error: "invalid engine, must be 'opencode' or 'qwen-code'" }, 400)
  }
  if (newEngine === currentEngine) {
    return c.json({ engine: currentEngine, changed: false })
  }
  // 销毁所有现有 bridge 实例（旧 session 消息保留在 store 里）
  for (const [dir, bridge] of bridges) {
    bridge.stop()
    bridges.delete(dir)
  }
  bridgeSessionMap.clear()
  currentEngine = newEngine
  console.log(`[bridge] engine switched to: ${currentEngine}`)

  // 广播引擎切换事件给所有已知的 directory
  for (const dir of projectSet.keys()) {
    broadcast(dir, "engine.switched", { engine: currentEngine })
  }

  // 广播 server.connected 触发前端 re-bootstrap（重新拉 provider/config 等）
  broadcast("global", "server.connected", {})

  // 为当前活跃目录自动创建新 session
  const dir = getRequestDirectory(c)
  touchProject(dir)
  const session = store.createSession({
    directory: dir,
    model: { providerID: "bridge", modelID: "bridge-agent" },
    agent: "coder",
    title: `New Session (${currentEngine})`,
  })
  sessionDirectory.set(session.id, dir)

  // 初始化新引擎的 bridge
  await getOrCreateBridge(session.id, dir)

  // getOrCreateBridge 内部已经广播了 server.connected，这里不需要再广播

  const sessionData = makeSessionInfo(session)
  broadcast(dir, "session.updated", { info: sessionData })

  return c.json({ engine: currentEngine, changed: true, session: sessionData })
})

// ========== Model 切换 ==========

// 获取当前 model 信息和可用 model 列表
app.get("/model", (c) => {
  const dir = getRequestDirectory(c)
  const bridge = bridges.get(dir)
  const selected = store.getSelectedModel(dir)
  return c.json({
    currentModelId: bridge?.currentModelId ?? null,
    selectedModel: selected ?? null,
    availableModels: bridge?.availableModels ?? [],
    engine: currentEngine,
  })
})

// 切换 model（bridge 独有接口，比 PATCH /config 更直接）
app.post("/model/switch", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const dir = getRequestDirectory(c)
  const modelId = body.modelId as string
  if (!modelId) {
    return c.json({ error: "modelId is required" }, 400)
  }

  const bridge = bridges.get(dir)
  if (!bridge) {
    return c.json({ error: "no active bridge for this directory" }, 404)
  }

  const ok = await bridge.setModel(modelId)
  if (!ok) {
    return c.json({ error: "failed to set model, agent may not support session/set_model" }, 500)
  }

  // 更新 store 中的选择
  store.setSelectedModel(dir, `bridge/${modelId}`)

  // 广播 provider 更新让前端刷新
  broadcast(dir, "provider.updated", {})

  return c.json({
    changed: true,
    currentModelId: bridge.currentModelId,
    availableModels: bridge.availableModels,
  })
})

// ========== 全局路由 ==========

app.get("/global/health", (c) => c.json({ healthy: true, version: "1.0.0-bridge" }))
app.get("/global/sse-status", (c) => c.json({ clients: getSseClientCount() }))
app.get("/debug/store", (c) => {
  const sessions = store.listSessions()
  const result: Record<string, unknown> = { sessions }
  for (const s of sessions) {
    const msgs = store.getMessages(s.id)
    result[`messages_${s.id}`] = msgs.map(m => ({
      id: m.info.id,
      role: m.info.role,
      partsCount: m.parts.length,
      parts: m.parts.map(p => ({ id: p.id, type: p.type, text: (p as any).text?.substring(0, 50) }))
    }))
  }
  return c.json(result)
})

// SSE 事件流
app.get("/global/event", (c) => {
  console.log("[bridge] SSE /global/event connection opened")
  return streamSSE(c, async (stream) => {
    const remove = addSseClient((data) => {
      stream.writeSSE({ data }).catch(() => {})
    })

    await stream.writeSSE({
      data: JSON.stringify({
        directory: "global",
        payload: { type: "server.connected", properties: {} },
      }),
    })

    const heartbeat = setInterval(() => {
      stream.writeSSE({
        data: JSON.stringify({
          directory: "global",
          payload: { type: "server.heartbeat", properties: {} },
        }),
      }).catch(() => clearInterval(heartbeat))
    }, 10000)

    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener("abort", () => {
        clearInterval(heartbeat)
        remove()
        resolve()
      })
    })
  })
})

app.get("/global/config", (c) => c.json({}))
app.patch("/global/config", (c) => c.json({}))

// ========== 路径信息 ==========

app.get("/path", (c) => {
  const home = process.env.HOME ?? "/home/user"
  const dir = getRequestDirectory(c)
  return c.json({
    home,
    state: `${home}/.local/state/opencode`,
    config: `${home}/.config/opencode`,
    worktree: dir,
    directory: dir,
  })
})

// ========== Provider 路由 ==========

const BRIDGE_MODEL = {
  id: "bridge-agent",
  name: "Bridge Agent",
  release_date: "2026-01-01",
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  limit: { context: 128000, output: 8192 },
  options: {},
}

app.get("/provider", (c) => {
  const dir = getRequestDirectory(c)
  // 优先查当前 directory 的 bridge，找不到就遍历所有 bridge 找有 model 信息的
  let bridge = bridges.get(dir)
  if (!bridge || bridge.availableModels.length === 0) {
    for (const [, b] of bridges) {
      if (b.availableModels.length > 0) {
        bridge = b
        break
      }
    }
  }
  
  // 从 bridge 获取 ACP Agent 返回的真实 model 列表
  if (bridge && bridge.availableModels.length > 0) {
    const models: Record<string, any> = {}
    for (const m of bridge.availableModels) {
      models[m.modelId] = {
        id: m.modelId,
        name: m.name ?? m.modelId,
        family: m.modelId, // 每个 model 独立 family，确保前端 visible() 不会过滤
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: false,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
        options: {},
      }
    }
    // 确保当前 model 在列表里
    const currentId = bridge.currentModelId ?? bridge.availableModels[0]?.modelId
    if (currentId && !models[currentId]) {
      models[currentId] = {
        id: currentId,
        name: currentId,
        family: currentId,
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: false,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
        options: {},
      }
    }
    return c.json({
      all: [
        {
          id: "bridge",
          name: `Bridge Agent (${currentEngine})`,
          env: [],
          models,
        },
      ],
      connected: ["bridge"],
      default: { bridge: currentId ?? "bridge-agent" },
    })
  }

  return c.json({
    all: [
      {
        id: "bridge",
        name: "Bridge Agent",
        env: [],
        models: { "bridge-agent": BRIDGE_MODEL },
      },
    ],
    connected: ["bridge"],
    default: { bridge: "bridge-agent" },
  })
})

app.get("/provider/auth", (c) => c.json({}))

// ========== 配置路由 ==========

app.get("/config", (c) => {
  const dir = getRequestDirectory(c)
  const selected = store.getSelectedModel(dir)
  // 查找 bridge：优先当前 directory，fallback 到任意活跃 bridge
  let bridge = bridges.get(dir)
  if (!bridge) {
    for (const [, b] of bridges) {
      if (b.currentModelId) { bridge = b; break }
    }
  }
  // 优先用用户选择的 model，其次用 bridge 当前的 model
  const model = selected ?? (bridge?.currentModelId ? `bridge/${bridge.currentModelId}` : "bridge/bridge-agent")
  return c.json({
    autoshare: false,
    autoupdate: false,
    disabled_providers: [],
    model,
  })
})

app.patch("/config", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const dir = getRequestDirectory(c)

  if (body.model && typeof body.model === "string") {
    // 前端发来的格式是 "providerID/modelID"，例如 "bridge/qwen-max"
    store.setSelectedModel(dir, body.model)
    
    // 提取 modelId（去掉 "bridge/" 前缀）
    const modelId = body.model.includes("/") ? body.model.split("/").slice(1).join("/") : body.model
    
    // 查找 bridge：优先当前 directory，fallback 到任意活跃 bridge
    let bridge = bridges.get(dir)
    if (!bridge) {
      for (const [, b] of bridges) {
        if (b.currentModelId) { bridge = b; break }
      }
    }
    if (bridge) {
      const ok = await bridge.setModel(modelId)
      if (ok) {
        console.log(`[bridge] model switched to: ${modelId}`)
        broadcast(dir, "provider.updated", {})
      }
    }
  }

  // 返回更新后的 config
  const selected = store.getSelectedModel(dir)
  let bridge = bridges.get(dir)
  if (!bridge) {
    for (const [, b] of bridges) {
      if (b.currentModelId) { bridge = b; break }
    }
  }
  const model = selected ?? (bridge?.currentModelId ? `bridge/${bridge.currentModelId}` : "bridge/bridge-agent")
  return c.json({
    autoshare: false,
    autoupdate: false,
    disabled_providers: [],
    model,
  })
})
app.get("/config/providers", (c) => c.json([]))

// ========== 项目路由 ==========
// 返回所有打开过的项目列表

app.get("/project", (c) => {
  const dir = getRequestDirectory(c)
  touchProject(dir)
  const projects = Array.from(projectSet.values())
    .sort((a, b) => b.time.updated - a.time.updated)
    .map((p) => ({ ...p, sandboxes: [] }))
  return c.json(projects)
})
app.get("/project/current", (c) => {
  const dir = getRequestDirectory(c)
  touchProject(dir)
  return c.json(makeProject(dir))
})
app.patch("/project/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const dir = getRequestDirectory(c)
  const directory = body.directory ?? c.req.param("id")
  if (directory) touchProject(directory)
  return c.json(makeProject(directory ?? dir))
})

// ========== Agent 路由 ==========

const AGENTS = [{ id: "coder", name: "Coder", description: "Default coding agent" }]
app.get("/agent", (c) => c.json(AGENTS))
app.get("/experimental/agents", (c) => c.json(AGENTS))

// ========== 空路由（前端会调用但不影响核心功能）==========

// ========== 命令和技能路由 ==========

// 缓存已加载的 command 列表（directory → commands），避免每次请求都扫描磁盘
const commandCache = new Map<string, { commands: CommandInfo[]; loadedAt: number }>()
const COMMAND_CACHE_TTL = 30_000 // 30 秒缓存

async function getCommands(directory: string): Promise<CommandInfo[]> {
  const cached = commandCache.get(directory)
  if (cached && Date.now() - cached.loadedAt < COMMAND_CACHE_TTL) {
    return cached.commands
  }
  const commands = await loadCommands(directory)
  commandCache.set(directory, { commands, loadedAt: Date.now() })
  console.log(`[bridge] loaded ${commands.length} commands/skills from ${directory}`)
  return commands
}

app.get("/command", async (c) => {
  const dir = getRequestDirectory(c)
  console.log(`[bridge] /command request, directory=${dir}`)
  const commands = await getCommands(dir)
  return c.json(commands)
})

app.get("/skill", async (c) => {
  const dir = getRequestDirectory(c)
  const commands = await getCommands(dir)
  return c.json(commands.filter((cmd) => cmd.source === "skill"))
})

// ========== 空路由（前端会调用但不影响核心功能）==========

app.get("/vcs", (c) => c.json({ branch: "main" }))
app.get("/permission", (c) => c.json([]))
app.get("/question", (c) => c.json([]))
app.get("/mcp", (c) => c.json({}))
app.get("/mcp/status", (c) => c.json({}))
app.get("/lsp", (c) => c.json([]))
app.get("/experimental/lsp", (c) => c.json([]))
app.get("/experimental/session", (c) => c.json(store.listSessions(getRequestDirectory(c)).map(makeSessionInfo)))
app.get("/session/status", (c) => c.json({}))
app.post("/log", (c) => c.json({ ok: true }))

// ========== 文件系统路由 ==========

app.get("/file", async (c) => {
  const directory = c.req.query("directory") ?? getRequestDirectory(c)
  const path = c.req.query("path") ?? ""
  const target = path ? `${directory}/${path}`.replace(/\/+/g, "/") : directory
  try {
    const { readdir } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const entries = await readdir(target, { withFileTypes: true })
    const nodes = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => ({
        name: e.name,
        path: path ? `${path}/${e.name}` : e.name,
        absolute: join(target, e.name),
        type: e.isDirectory() ? "directory" : "file",
        ignored: false,
      }))
    return c.json(nodes)
  } catch {
    return c.json([])
  }
})

app.get("/file/content", async (c) => {
  const directory = c.req.query("directory") ?? getRequestDirectory(c)
  const filePath = c.req.query("path") ?? ""
  if (!filePath) return c.json({ type: "text", content: "" })

  const { resolve } = await import("node:path")
  const target = resolve(directory, filePath)

  try {
    const { readFile, stat } = await import("node:fs/promises")
    const info = await stat(target)

    // 文件太大就不读了（超过 2MB）
    if (info.size > 2 * 1024 * 1024) {
      return c.json({ type: "binary", content: "[文件过大，无法预览]" })
    }

    const buf = await readFile(target)

    // 简单判断是否是二进制文件：检查前 8KB 有没有 null byte
    const sample = buf.subarray(0, 8192)
    const isBinary = sample.includes(0)

    if (isBinary) {
      return c.json({ type: "binary", content: "[二进制文件]" })
    }

    return c.json({ type: "text", content: buf.toString("utf-8") })
  } catch {
    return c.json({ type: "text", content: "" }, 404)
  }
})

// git 文件状态 — 前端文件树用
app.get("/file/status", (c) => c.json([]))

app.get("/find/file", async (c) => {
  const directory = c.req.query("directory") ?? getRequestDirectory(c)
  const query = c.req.query("query") ?? ""
  const type = c.req.query("type") ?? "directory"
  const limit = parseInt(c.req.query("limit") ?? "50")
  try {
    const { readdir } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const entries = await readdir(directory, { withFileTypes: true })
    const results = entries
      .filter((e) => !e.name.startsWith("."))
      .filter((e) => (type === "directory" ? e.isDirectory() : e.isFile()))
      .filter((e) => !query || e.name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, limit)
      .map((e) => join(directory, e.name))
    return c.json(results)
  } catch {
    return c.json([])
  }
})

// ========== 会话路由 ==========

/**
 * 从用户消息中生成简短标题
 * 截取前 50 个字符，去掉换行，作为 session 标题
 */
function generateTitleFromMessage(text: string): string {
  const cleaned = text.replace(/\n+/g, " ").trim()
  if (!cleaned) return "New Session"
  return cleaned.length > 50 ? cleaned.substring(0, 47) + "..." : cleaned
}

/**
 * 如果 session 标题还是默认的 "New Session"，用第一条消息自动更新标题
 */
function autoUpdateSessionTitle(sessionID: string, text: string, directory: string) {
  const session = store.getSession(sessionID)
  if (!session) return
  // 只在标题是默认值时自动更新（包括引擎切换时创建的 "New Session (xxx)"）
  if (!session.title.startsWith("New Session")) return
  const title = generateTitleFromMessage(text)
  if (title === "New Session") return
  store.updateSessionTitle(sessionID, title)
  broadcast(directory, "session.updated", { info: makeSessionInfo(session) })
}

// 把 store 的 SessionInfo 转成前端 SDK 期望的 Session 格式
function makeSessionInfo(s: import("./store.js").SessionInfo) {
  // 用 session 自己记录的 directory，不用全局 activeDirectory
  const dir = s.directory
  return {
    id: s.id,
    slug: s.id,
    projectID: dir,
    directory: dir,
    title: s.title,
    version: "1",
    time: s.time,
  }
}

app.get("/session", (c) => {
  const dir = getRequestDirectory(c)
  return c.json(store.listSessions(dir).map(makeSessionInfo))
})

app.post("/session", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const dir = getRequestDirectory(c)
  touchProject(dir)
  const session = store.createSession({
    directory: dir,
    model: body.model ?? { providerID: "bridge", modelID: "bridge-agent" },
    agent: body.agent ?? "coder",
  })
  sessionDirectory.set(session.id, dir)
  
  // 提前初始化 bridge 实例，确保 session 创建时就准备好
  await getOrCreateBridge(session.id, dir)
  
  const sessionData = makeSessionInfo(session)
  broadcast(dir, "session.updated", { info: sessionData })
  return c.json(sessionData)
})

app.get("/session/:id", (c) => {
  const id = c.req.param("id")
  const dir = getRequestDirectory(c)
  let session = store.getSession(id)
  if (!session) {
    session = store.createSessionWithId(id, { directory: dir })
    sessionDirectory.set(id, dir)
  }
  
  // 确保 bridge 已初始化（如果还没创建），不阻塞响应
  getOrCreateBridge(id, dir).catch(console.error)
  
  return c.json(makeSessionInfo(session))
})

app.get("/session/:id/message", (c) => {
  const sessionID = c.req.param("id")
  const rawMessages = store.getMessages(sessionID)
  const limit = c.req.query("limit")
  console.log(`[bridge] /session/${sessionID}/message: ${rawMessages.length} messages, limit=${limit}`)
  // SDK 期望格式: Array<{ info: Message, parts: Part[] }>
  // UserMessage 用 model: { providerID, modelID }
  // AssistantMessage 用扁平的 modelID, providerID
  const messages = rawMessages.map((m) => {
    const info: Record<string, unknown> = {
      id: m.info.id,
      sessionID: m.info.sessionID,
      role: m.info.role,
      time: m.info.time,
      agent: m.info.agent ?? "coder",
    }
    if (m.info.role === "assistant") {
      info.modelID = m.info.model?.modelID ?? "bridge-agent"
      info.providerID = m.info.model?.providerID ?? "bridge"
      info.cost = 0
      info.tokens = m.info.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      info.finish = m.info.finish
      info.mode = "agent"
      info.parentID = m.info.parentID ?? ""
      info.path = { cwd: getDirectory(sessionID), root: getDirectory(sessionID) }
    }
    if (m.info.role === "user") {
      info.model = m.info.model ?? { providerID: "bridge", modelID: "bridge-agent" }
      const textParts = m.parts.filter((p) => p.type === "text") as Array<{ text: string }>
      info.content = textParts.map((p) => p.text).join("\n")
    }
    return { info, parts: m.parts }
  })
  return c.json(messages)
})

app.get("/session/:id/todo", (c) => c.json([]))
app.get("/session/:id/diff", (c) => {
  const sessionID = c.req.param("id")
  return c.json(store.getFileDiffs(sessionID))
})
app.get("/session/:id/children", (c) => c.json([]))
app.patch("/session/:id", async (c) => {
  const id = c.req.param("id")
  const body = await c.req.json().catch(() => ({}))
  const session = store.getSession(id)
  if (!session) return c.json({}, 404)
  if (body.title) store.updateSessionTitle(id, body.title)
  return c.json(makeSessionInfo(session))
})
app.delete("/session/:id", (c) => {
  const id = c.req.param("id")
  const session = store.getSession(id)
  if (!session) return c.json({}, 404)
  // 不真正删除，只返回成功（内存 store 没有 delete 方法）
  return c.json({ ok: true })
})

// 执行命令（slash command）— 渲染模板后当 prompt 发给 agent
app.post("/session/:id/command", async (c) => {
  const sessionID = c.req.param("id")
  const body = await c.req.json().catch(() => ({}))
  const dir = getRequestDirectory(c)
  const commandName: string = body.command ?? ""
  const args: string = body.arguments ?? ""

  const commands = await getCommands(dir)
  const cmd = commands.find((cmd) => cmd.name === commandName)
  if (!cmd) {
    return c.json({ error: `Command "${commandName}" not found` }, 404)
  }

  // 确保 session 存在
  const existingSession = store.getSession(sessionID)
  if (!existingSession) {
    store.createSessionWithId(sessionID, { directory: dir })
  }
  sessionDirectory.set(sessionID, dir)
  touchProject(dir)

  const sessionDir = getDirectory(sessionID)

  // 渲染模板：替换变量、执行 shell 命令
  let renderedText: string
  try {
    renderedText = await renderTemplate(cmd.template, args, sessionDir)
  } catch (err: any) {
    console.error(`[bridge] command render error:`, err)
    return c.json({ error: `Failed to render command: ${err.message}` }, 500)
  }

  console.log(`[bridge] command /${commandName} rendered (${renderedText.length} chars)`)

  // 当作普通用户消息发送
  const userMsg = store.addUserMessage(sessionID, renderedText, body.model ? { providerID: "bridge", modelID: "bridge-agent" } : undefined)

  // 自动更新 session 标题（用命令名作为标题）
  autoUpdateSessionTitle(sessionID, `/${commandName} ${args}`.trim(), sessionDir)

  broadcast(sessionDir, "message.updated", {
    info: {
      id: userMsg.info.id,
      sessionID,
      role: "user",
      time: userMsg.info.time,
      agent: body.agent ?? "coder",
      model: body.model ?? { providerID: "bridge", modelID: "bridge-agent" },
    },
  })
  for (const part of userMsg.parts) {
    broadcast(sessionDir, "message.part.updated", { part })
  }
  broadcast(sessionDir, "session.status", { sessionID, status: { type: "busy" } })

  // 广播 command.executed 事件
  broadcast(sessionDir, "command.executed", { name: commandName, sessionID, arguments: args })

  ;(async () => {
    try {
      const bridge = bridges.get(sessionDir)
      if (!bridge) throw new Error(`Bridge not found for directory: ${sessionDir}`)
      await bridge.prompt(renderedText)
      const msg = store.getCurrentAssistantMsg(sessionID)
      if (msg) {
        store.completeAssistantMessage(sessionID, "end_turn")
      }
      broadcast(sessionDir, "session.status", { sessionID, status: { type: "idle" } })
    } catch (err) {
      console.error("[bridge] command prompt error:", err)
      broadcast(sessionDir, "session.status", { sessionID, status: { type: "idle" } })
    }
  })()

  return c.json({ ok: true })
})

// 发送消息（异步）— 核心接口
app.post("/session/:id/prompt_async", async (c) => {
  const sessionID = c.req.param("id")
  const body = await c.req.json().catch(() => ({}))
  const dir = getRequestDirectory(c)

  // 确保 session 存在，并记录 directory
  const existingSession = store.getSession(sessionID)
  if (!existingSession) {
    store.createSessionWithId(sessionID, { directory: dir })
  }

  // 记住这个 session 对应的前端 directory，SSE 事件需要用
  sessionDirectory.set(sessionID, dir)
  touchProject(dir)

  const sessionDir = getDirectory(sessionID)

  const parts: Array<{ type: string; text?: string }> = body.parts ?? []
  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n")

  const userMsg = store.addUserMessage(sessionID, text, body.model, body.messageID)

  // 自动更新 session 标题（第一条消息时）
  autoUpdateSessionTitle(sessionID, text, sessionDir)

  // 广播用户消息和 parts — 用 sessionDir 确保和前端 child store 一致
  broadcast(sessionDir, "message.updated", {
    info: {
      id: userMsg.info.id,
      sessionID,
      role: "user",
      time: userMsg.info.time,
      agent: "coder",
      model: body.model ?? { providerID: "bridge", modelID: "bridge-agent" },
    },
  })
  for (const part of userMsg.parts) {
    broadcast(sessionDir, "message.part.updated", { part })
  }
  broadcast(sessionDir, "session.status", { sessionID, status: { type: "busy" } })

  ;(async () => {
    try {
      // Bridge 已在 session 创建时初始化，这里直接获取
      const bridge = bridges.get(sessionDir)
      if (!bridge) {
        throw new Error(`Bridge not found for directory: ${sessionDir}`)
      }
      // 如果前端选了不同的 model，先切换
      if (body.model?.modelID && body.model.modelID !== "bridge-agent") {
        const targetModelId = body.model.modelID
        if (targetModelId !== bridge.currentModelId) {
          console.log(`[bridge] switching model before prompt: ${bridge.currentModelId} → ${targetModelId}`)
          await bridge.setModel(targetModelId)
        }
      } else {
        console.log(`[bridge] prompt with model:`, JSON.stringify(body.model), `current:`, bridge.currentModelId)
      }
      await bridge.prompt(text)
      const msg = store.getCurrentAssistantMsg(sessionID)
      if (msg) {
        store.completeAssistantMessage(sessionID, "end_turn")
      }
      // 无论如何都广播 idle，确保前端不会卡在 busy 状态
      broadcast(sessionDir, "session.status", { sessionID, status: { type: "idle" } })
    } catch (err) {
      console.error("[bridge] prompt error:", err)
      broadcast(sessionDir, "session.status", { sessionID, status: { type: "idle" } })
    }
  })()

  return c.json({ ok: true })
})

app.post("/session/:id/abort", async (c) => {
  const sessionID = c.req.param("id")
  const sessionDir = getDirectory(sessionID)
  const bridge = bridges.get(sessionDir)
  if (bridge) {
    await bridge.cancel().catch(() => {})
  }
  broadcast(sessionDir, "session.status", { sessionID, type: "idle" })
  return c.json({ ok: true })
})

app.post("/session/:id/permissions/:pid", async (c) => {
  const sessionID = c.req.param("id")
  const permID = c.req.param("pid")
  const body = await c.req.json().catch(() => ({}))
  const optionId = body.response ?? "once"
  console.log(`[bridge] permission reply: permID=${permID}, optionId=${optionId}, body=`, JSON.stringify(body))
  const pending = store.getPendingPermission(permID)
  if (!pending) {
    console.warn(`[bridge] permission ${permID} NOT FOUND in pending map! Already resolved or never created.`)
  }
  const ok = store.resolvePendingPermission(permID, optionId)
  console.log(`[bridge] permission resolve result: ${ok}`)

  if (ok) {
    // 广播 permission.replied 事件，前端收到后会移除 permission 弹窗
    const sessionDir = getDirectory(sessionID)
    broadcast(sessionDir, "permission.replied", { sessionID, requestID: permID })
  }

  return c.json(ok)
})

// ========== 启动服务器 ==========

console.log(`[bridge] server starting on http://localhost:${PORT}`)
console.log(`[bridge] engine: ${ENGINE}, workdir: ${DEFAULT_DIRECTORY}`)
console.log(`[bridge] wss-server: ${process.env.WSS_SERVER_URL ?? "ws://localhost:4001/ws"}`)

// 使用 @hono/node-server 启动 HTTP 服务器
serve({
  fetch: app.fetch,
  port: PORT,
})

console.log(`[bridge] server is ready at http://localhost:${PORT}`)

