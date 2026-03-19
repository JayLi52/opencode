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
 */

import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { addSseClient, broadcast, getSseClientCount } from "./sse.js"
import { store } from "./store.js"
import { handleAcpUpdate, handleAcpPermission } from "./eventConverter.js"
import { OpencodeAcpBridge, type EngineType } from "./acpBridge.js"

// ========== 配置 ==========

const PORT = parseInt(process.env.BRIDGE_PORT ?? "4096")
const DEFAULT_DIRECTORY = process.env.WORK_DIR ?? process.cwd()
const ENGINE: EngineType = (process.env.ACP_ENGINE as EngineType) ?? "qwen-code"
const ACP_PATH = process.env.ACP_PATH

// 前端实际使用的 directory（从 x-opencode-directory header 获取）
// bridge 的 SSE 事件需要用这个 directory，否则前端的 child store 匹配不上
// per-session 跟踪，因为前端可能有多个 directory 的 child store
let activeDirectory = DEFAULT_DIRECTORY
const sessionDirectory = new Map<string, string>() // sessionID → directory

function getDirectory(sessionID?: string): string {
  if (sessionID) {
    const dir = sessionDirectory.get(sessionID)
    if (dir) return dir
  }
  return activeDirectory
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

async function getOrCreateBridge(sessionID: string, directory: string): Promise<OpencodeAcpBridge> {
  // 用 directory 做 key，同目录共享 bridge
  if (bridges.has(directory)) {
    // 更新 session 映射，让事件回调用最新的 sessionID
    bridgeSessionMap.set(directory, sessionID)
    return bridges.get(directory)!
  }

  // 记录 session → directory 映射
  bridgeSessionMap.set(directory, sessionID)

  const bridge = new OpencodeAcpBridge(
    { engine: currentEngine, opencodePath: ACP_PATH, cwd: directory },
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
  return bridge
}

// ========== Hono App ==========

const app = new Hono()

// CORS
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }))

// 从 x-opencode-directory header 提取前端实际使用的 directory
// 前端 SDK 每个请求都会带这个 header
app.use("*", async (c, next) => {
  const raw = c.req.header("x-opencode-directory")
  if (raw) {
    const decoded = decodeURIComponent(raw)
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

  // 广播引擎切换事件，前端收到后可以跳转到新 session
  broadcast(activeDirectory, "engine.switched", { engine: currentEngine })

  return c.json({ engine: currentEngine, changed: true })
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
  return c.json({
    home,
    state: `${home}/.local/state/opencode`,
    config: `${home}/.config/opencode`,
    worktree: activeDirectory,
    directory: activeDirectory,
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
  return c.json({
    autoshare: false,
    autoupdate: false,
    disabled_providers: [],
    model: "bridge/bridge-agent",
  })
})

app.patch("/config", async (c) => c.json({}))
app.get("/config/providers", (c) => c.json([]))

// ========== 项目路由 ==========
// 返回所有打开过的项目列表

app.get("/project", (c) => {
  // 确保当前 activeDirectory 在列表中
  touchProject(activeDirectory)
  const projects = Array.from(projectSet.values())
    .sort((a, b) => b.time.updated - a.time.updated)
    .map((p) => ({ ...p, sandboxes: [] }))
  return c.json(projects)
})
app.get("/project/current", (c) => {
  touchProject(activeDirectory)
  return c.json(makeProject(activeDirectory))
})
app.patch("/project/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const directory = body.directory ?? c.req.param("id")
  if (directory) touchProject(directory)
  return c.json(makeProject(directory ?? activeDirectory))
})

// ========== Agent 路由 ==========

const AGENTS = [{ id: "coder", name: "Coder", description: "Default coding agent" }]
app.get("/agent", (c) => c.json(AGENTS))
app.get("/experimental/agents", (c) => c.json(AGENTS))

// ========== 空路由（前端会调用但不影响核心功能）==========

app.get("/command", (c) => c.json([]))
app.get("/vcs", (c) => c.json({ branch: "main" }))
app.get("/permission", (c) => c.json([]))
app.get("/question", (c) => c.json([]))
app.get("/mcp", (c) => c.json({}))
app.get("/mcp/status", (c) => c.json({}))
app.get("/lsp", (c) => c.json([]))
app.get("/experimental/lsp", (c) => c.json([]))
app.get("/experimental/session", (c) => c.json(store.listSessions(activeDirectory).map(makeSessionInfo)))
app.get("/session/status", (c) => c.json({}))
app.get("/skill", (c) => c.json([]))
app.post("/log", (c) => c.json({ ok: true }))

// ========== 文件系统路由 ==========

app.get("/file", async (c) => {
  const directory = c.req.query("directory") ?? activeDirectory
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

// 读取文件内容 — 前端点击文件查看时调用
app.get("/file/content", async (c) => {
  const directory = c.req.query("directory") ?? activeDirectory
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
  const directory = c.req.query("directory") ?? activeDirectory
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
  // 返回当前 activeDirectory 下的 session 列表
  return c.json(store.listSessions(activeDirectory).map(makeSessionInfo))
})

app.post("/session", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  // 确保当前目录在项目列表中
  touchProject(activeDirectory)
  const session = store.createSession({
    directory: activeDirectory,
    model: body.model ?? { providerID: "bridge", modelID: "bridge-agent" },
    agent: body.agent ?? "coder",
  })
  sessionDirectory.set(session.id, activeDirectory)
  const sessionData = makeSessionInfo(session)
  // 前端期望 session.updated 的 properties 是 { info: Session }
  broadcast(activeDirectory, "session.updated", { info: sessionData })
  return c.json(sessionData)
})

app.get("/session/:id", (c) => {
  const id = c.req.param("id")
  let session = store.getSession(id)
  if (!session) {
    session = store.createSessionWithId(id, { directory: activeDirectory })
    sessionDirectory.set(id, activeDirectory)
  }
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

// 发送消息（异步）— 核心接口
app.post("/session/:id/prompt_async", async (c) => {
  const sessionID = c.req.param("id")
  const body = await c.req.json().catch(() => ({}))

  // 确保 session 存在，并记录 directory
  const existingSession = store.getSession(sessionID)
  if (!existingSession) {
    store.createSessionWithId(sessionID, { directory: activeDirectory })
  }

  // 记住这个 session 对应的前端 directory，SSE 事件需要用
  sessionDirectory.set(sessionID, activeDirectory)
  // 确保目录在项目列表中
  touchProject(activeDirectory)

  const sessionDir = getDirectory(sessionID)

  const parts: Array<{ type: string; text?: string }> = body.parts ?? []
  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n")

  const userMsg = store.addUserMessage(sessionID, text, body.model, body.messageID)

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
      const bridge = await getOrCreateBridge(sessionID, sessionDir)
      await bridge.prompt(text)
      const msg = store.getCurrentAssistantMsg(sessionID)
      if (msg) {
        store.completeAssistantMessage(sessionID, "end_turn")
        broadcast(sessionDir, "session.status", { sessionID, status: { type: "idle" } })
      }
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
  const permID = c.req.param("pid")
  const body = await c.req.json().catch(() => ({}))
  const optionId = body.response ?? "once"
  const ok = store.resolvePendingPermission(permID, optionId)
  return c.json({ ok })
})

// ========== 启动服务器 ==========

console.log(`[bridge] server starting on http://localhost:${PORT}`)
console.log(`[bridge] engine: ${ENGINE}, workdir: ${DEFAULT_DIRECTORY}`)

import { serve } from "@hono/node-server"
serve({ fetch: app.fetch, port: PORT })
