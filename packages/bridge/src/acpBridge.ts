/**
 * acpBridge.ts — ACP Bridge 模块
 *
 * 这个文件是整个 demo 的核心，负责：
 * 1. 启动一个 ACP Agent 子进程（opencode 或 qwen-code）
 * 2. 通过 stdin/stdout 的 ndjson（换行分隔的 JSON）格式与子进程通信
 * 3. 封装 ACP 协议的所有操作：初始化、创建会话、发送 prompt、取消、停止
 * 4. 处理 Agent 发来的权限请求（当前是自动批准，阶段二会改成转发给前端）
 *
 * 架构位置：
 *   浏览器 ←HTTP+SSE→ server.ts ←调用→ acpBridge.ts ←stdio ndjson→ ACP Agent 子进程
 */

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Agent,
  type Client,
  type SessionNotification,
  type PromptResponse,
} from "@agentclientprotocol/sdk"

import { Readable, Writable } from "node:stream"
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"

// ========== 类型定义 ==========

export type EngineType = "opencode" | "qwen-code"

export interface BridgeOptions {
  engine?: EngineType
  opencodePath?: string
  cwd: string
}

export type SessionUpdateHandler = (update: SessionNotification) => void

// 权限请求处理器类型，返回 Promise 等待前端回复
export type PermissionHandler = (params: {
  toolCall?: { toolCallId?: string; title?: string; rawInput?: Record<string, unknown> }
  options?: Array<{ optionId: string; kind: string }>
}) => Promise<{ outcome: { outcome: "selected"; optionId: string } }>

// ========== 核心类 ==========

export class OpencodeAcpBridge {
  private child: ChildProcess | null = null
  private connection: ClientSideConnection | null = null
  private sessionId: string | null = null

  // 可注入的权限处理器，默认自动批准
  public onPermission: PermissionHandler = async (params) => {
    const options = params.options ?? []
    const allowOption =
      options.find(
        (o: any) => o.kind === "allow_once" || o.kind === "allow_always" || o.optionId === "allow" || o.optionId === "yes",
      ) ?? options[0]
    const optionId = allowOption?.optionId ?? "once"
    console.log("[acp-bridge] auto-approving permission:", params.toolCall?.title, "optionId:", optionId)
    return { outcome: { outcome: "selected" as const, optionId } }
  }

  constructor(private readonly opts: BridgeOptions, private readonly onUpdate: SessionUpdateHandler) {}

  get hasSession() {
    return this.sessionId !== null
  }

  async start(): Promise<void> {
    if (this.child) this.stop()

    const engine = this.opts.engine ?? "opencode"
    let spawnCommand: string
    let spawnArgs: string[]

    if (engine === "qwen-code") {
      spawnCommand = this.opts.opencodePath ?? "qwen"
      spawnArgs = ["--acp"]
    } else {
      // opencode 是 Node.js 脚本，必须用 node 显式执行
      // const opencodeScript = this.opts.opencodePath ?? "opencode"
      spawnCommand = "opencode"
      spawnArgs = ["acp"]
    }

    const options: SpawnOptions = {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      // macOS 上需要使用 shell 来在 PATH 中查找命令
      shell: true,
    }

    console.log("[acp-bridge] spawning:", spawnCommand, spawnArgs, "cwd:", options.cwd)
    try {
      this.child = spawn(spawnCommand, spawnArgs, options)
    } catch (e: any) {
      console.error("[acp-bridge] spawn threw:", e.message)
      throw e
    }

    this.child.on("error", (err) => {
      console.error("[acp-bridge] spawn error:", err.message, "path:", (err as any).path, "code:", (err as any).code)
    })

    this.child.stderr?.on("data", (buf: Buffer) => {
      console.log("[acp-bridge stderr]", buf.toString().trim())
    })

    this.child.on("exit", (code, signal) => {
      console.log("[acp-bridge] exited", { code, signal })
    })

    const stdout = Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>
    const stdin = Writable.toWeb(this.child.stdin!) as WritableStream
    const stream = ndJsonStream(stdin, stdout)

    const self = this
    this.connection = new ClientSideConnection(
      (_agent: Agent): Client => ({
        async sessionUpdate(params: SessionNotification): Promise<void> {
          self.onUpdate(params)
        },

        async requestPermission(params) {
          return self.onPermission(params as any)
        },

        readTextFile: (() => {
          throw new RequestError(-32600, "FS.readTextFile not implemented")
        }) as Client["readTextFile"],

        writeTextFile: (() => {
          throw new RequestError(-32600, "FS.writeTextFile not implemented")
        }) as Client["writeTextFile"],

        extNotification: (async () => {}) as Client["extNotification"],
      }),
      stream,
    )

    console.log("[acp-bridge] initializing ACP connection...")
    await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })
    console.log("[acp-bridge] ACP initialized OK")
  }

  private ensure(): ClientSideConnection {
    if (!this.connection) throw new Error("ACP connection not initialized")
    return this.connection
  }

  async newSession(): Promise<string> {
    const conn = this.ensure()
    console.log("[acp-bridge] creating new ACP session...")
    const res = await conn.newSession({
      cwd: this.opts.cwd,
      mcpServers: [],
    } as any)
    this.sessionId = res.sessionId
    console.log("[acp-bridge] ACP session created:", res.sessionId)
    return res.sessionId
  }

  async prompt(text: string): Promise<PromptResponse> {
    const conn = this.ensure()
    if (!this.sessionId) throw new RequestError(-32600, "No active ACP session")
    console.log("[acp-bridge] sending prompt:", text.substring(0, 80))
    return conn.prompt({
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    })
  }

  async cancel(): Promise<void> {
    const conn = this.ensure()
    if (!this.sessionId) return
    await conn.cancel({ sessionId: this.sessionId })
  }

  stop() {
    this.connection = null
    this.sessionId = null
    if (this.child) {
      this.child.kill()
      this.child = null
    }
  }
}