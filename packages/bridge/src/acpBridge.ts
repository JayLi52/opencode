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
  wsUrl?: string
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
  private ws: WebSocket | null = null

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
    
    // 如果配置了 WebSocket URL，则使用 WebSocket 连接，否则使用子进程方式
    const wsUrl = this.opts.wsUrl ?? "ws://localhost:4001/ws"
    await this.startWebSocketConnection(wsUrl)

    console.log("[acp-bridge] initializing ACP connection...")
    await this.connection!.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })
    console.log("[acp-bridge] ACP initialized OK")
  }

  private async startWebSocketConnection(url: string): Promise<void> {
    console.log("[acp-bridge] connecting to WebSocket:", url)

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url)

      this.ws.onopen = () => {
        console.log("[acp-bridge] WebSocket connection established")
        
        const encoder = new TextEncoder()
        const decoder = new TextDecoder()

        // 创建 ReadableStream 接收 WebSocket 消息
        const stdout = new ReadableStream<Uint8Array>({
          start: (controller) => {
            this.ws!.onmessage = (event) => {
              try {
                const data = typeof event.data === "string" ? event.data : decoder.decode(event.data)
                controller.enqueue(encoder.encode(data + "\n"))
              } catch (err) {
                controller.error(err)
              }
            }
            this.ws!.onclose = () => {
              controller.close()
            }
            this.ws!.onerror = (err) => {
              controller.error(new Error("WebSocket error"))
            }
          },
        })

        // 创建 WritableStream 发送数据到 WebSocket
        let isClosed = false
        const stdin = new WritableStream({
          write: (chunk) => {
            if (isClosed || !this.ws) return
            const data = decoder.decode(chunk)
            this.ws.send(data)
          },
          close: () => {
            isClosed = true
            this.ws?.close()
          },
        })

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

        resolve()
      }

      this.ws.onerror = (err) => {
        console.error("[acp-bridge] WebSocket error:", err)
        reject(err)
      }

      this.ws.onclose = (event) => {
        console.log("[acp-bridge] WebSocket connection closed", {
          code: event.code,
          reason: event.reason,
        })
      }
    })
  }

  private async spawnChildProcess(_engine: string): Promise<void> {
    let spawnCommand: string
    let spawnArgs: string[]

    if (_engine === "qwen-code") {
      spawnCommand = this.opts.opencodePath ?? "qwen"
      spawnArgs = ["--acp"]
    } else {
      spawnCommand = "opencode"
      spawnArgs = ["acp"]
    }

    const options: SpawnOptions = {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
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
    
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    
    if (this.child) {
      this.child.kill()
      this.child = null
    }
  }
}