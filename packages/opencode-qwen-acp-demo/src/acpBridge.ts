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

export interface BridgeOptions {
  /**
   * qwen-code CLI 入口脚本路径，例如：
   *   /Users/terry/work/ai-workspace/qwen-code/packages/cli/dist/index.mjs
   */
  cliEntryPath: string
  /**
   * 工作目录（用于 session cwd）
   */
  cwd: string
  /**
   * 额外 CLI 参数，例如 ["--config", "path/to/config.json"]
   */
  extraArgs?: string[]
}

export type SessionUpdateHandler = (update: SessionNotification) => void

export class QwenAcpBridge {
  private child: ChildProcess | null = null
  public connection: ClientSideConnection | null = null
  private sessionId: string | null = null

  constructor(private readonly opts: BridgeOptions, private readonly onUpdate: SessionUpdateHandler) {}

  get hasSession() {
    return this.sessionId !== null
  }

  async start(): Promise<void> {
    if (this.child) this.stop()

    const env = { ...process.env }

    // 使用当前 PATH 里的 node，可避免旧 node 路径失效导致 ENOENT
    const spawnCommand = "node"
    const spawnArgs = [
      this.opts.cliEntryPath,
      "--acp",
      // channel 值必须是 VSCode/ACP/SDK/CI 之一，这里统一用 SDK
      "--channel=SDK",
      ...(this.opts.extraArgs ?? []),
    ]

    const options: SpawnOptions = {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: false,
    }

    this.child = spawn(spawnCommand, spawnArgs, options)

    // 日志输出到当前进程 stderr，方便调试
    this.child.stderr?.on("data", (buf: Buffer) => {
      const msg = buf.toString()
      if (msg.toLowerCase().includes("error")) {
        // eslint-disable-next-line no-console
        console.error("[qwen-acp stderr]", msg.trim())
      } else {
        // eslint-disable-next-line no-console
        console.log("[qwen-acp stderr]", msg.trim())
      }
    })

    this.child.on("exit", (code, signal) => {
      // eslint-disable-next-line no-console
      console.error("[qwen-acp] exited", { code, signal })
    })

    // 转成 Web Streams
    const stdout = Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>
    const stdin = Writable.toWeb(this.child.stdin!) as WritableStream
    const stream = ndJsonStream(stdin, stdout)

    const self = this
    this.connection = new ClientSideConnection(
      (_agent: Agent): Client => ({
        async sessionUpdate(params: SessionNotification): Promise<void> {
          self.onUpdate(params)
        },
        requestPermission: (() => {
          throw new RequestError("PermissionDenied", "Permission handling not implemented in demo bridge")
        }) as Client["requestPermission"],
        readTextFile: (() => {
          throw new RequestError("InvalidRequest", "FS.readTextFile not implemented in demo bridge")
        }) as Client["readTextFile"],
        writeTextFile: (() => {
          throw new RequestError("InvalidRequest", "FS.writeTextFile not implemented in demo bridge")
        }) as Client["writeTextFile"],
        extNotification: (async () => {}) as Client["extNotification"],
      }),
      stream,
    )

    await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
      },
    })
  }

  private ensure(): ClientSideConnection {
    if (!this.connection) throw new Error("ACP connection not initialized")
    return this.connection
  }

  async newSession(): Promise<string> {
    const conn = this.ensure()
    const res = await conn.newSession({
      cwd: this.opts.cwd,
      mcpServers: [],
    } as any)
    this.sessionId = res.sessionId
    return res.sessionId
  }

  async prompt(text: string): Promise<PromptResponse> {
    const conn = this.ensure()
    if (!this.sessionId) {
      throw new RequestError("InvalidRequest", "No active ACP session")
    }
    const res = await conn.prompt({
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    })
    return res
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

