/**
 * wss-server.ts — WebSocket ↔ stdio 代理服务器
 *
 * 接收 bridge 的 WebSocket 连接，启动 ACP Agent 子进程（qwen-code），
 * 双向透传 WebSocket 消息和子进程 stdin/stdout。
 *
 * 修复记录：
 * - [fix] stdout → WebSocket 增加行缓冲：Node.js stdout data 事件不保证按行分割，
 *   长 JSON（如写文件时带完整文件内容）会被拆成多个 chunk，直接 socket.send 会导致
 *   bridge 端收到不完整 JSON 报 "Unterminated string in JSON" 错误。
 *   现在按 \n 分割，只发送完整的 ndjson 行。
 */

import http from "http"
import { WebSocketServer, type WebSocket } from "ws"
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { Readable, Writable } from "node:stream"

const server = http.createServer()
const wss = new WebSocketServer({ server, path: "/ws" })

// 从 URL query 获取 cwd
function parseQuery(url: string | undefined): { cwd?: string } {
  if (!url) return {}
  try {
    const urlObj = new URL(url, "http://localhost")
    const cwdParam = urlObj.searchParams.get("cwd")
    return cwdParam ? { cwd: cwdParam } : {}
  } catch {
    return {}
  }
}

wss.on("connection", (socket: WebSocket, req) => {
  let child: ChildProcess | null = null

  // 解析 query 参数获取 cwd
  const { cwd } = parseQuery(req.url)
  const workDir = cwd ?? process.cwd()

  console.log("[wss-server] connection received, cwd:", workDir)

  // 启动 ACP 进程 - 从环境变量或 query 参数获取命令
  // 支持: ACP_COMMAND 环境变量, 或 ws URL 的 ?command=xxx 参数
  const urlObj = req.url ? new URL(req.url, "http://localhost") : null
  const spawnCommand = urlObj?.searchParams.get("command") ?? process.env.ACP_COMMAND ?? "qwen"
  const spawnArgs = process.env.ACP_ARGS ? process.env.ACP_ARGS.split(" ") : ["--acp"]
  const options: SpawnOptions = {
    cwd: workDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    shell: true, // 使用系统默认 shell，兼容 macOS/Linux
  }

  console.log("[wss-server] spawning:", spawnCommand, spawnArgs.join(" "), "cwd:", workDir)

  try {
    child = spawn(spawnCommand, spawnArgs, options)
  } catch (e: any) {
    console.error("[wss-server] spawn error:", e.message)
    socket.send(JSON.stringify({ error: `Failed to spawn: ${e.message}` }))
    return
  }

  child.on("error", (err) => {
    console.error("[wss-server] child error:", err.message)
  })

  child.stderr?.on("data", (buf: Buffer) => {
    const msg = buf.toString()
    if (msg.toLowerCase().includes("error")) {
      console.error("[qwen-acp stderr]", msg.trim())
    } else {
      console.log("[qwen-acp stderr]", msg.trim())
    }
  })

  child.on("exit", (code, signal) => {
    console.log("[qwen-acp] exited", { code, signal })
  })

  // 简单的双向透传：WebSocket <-> stdio
  // WebSocket → stdin
  socket.on("message", (data: WebSocket.RawData) => {
    const text = typeof data === "string" ? data : data.toString()
    console.log("[ws] receive:", text.trim())
    child?.stdin?.write(text + "\n")
  })

  // stdout → WebSocket（行缓冲，确保每次发送完整的 ndjson 行）
  // Node.js stdout 的 data 事件不保证按行分割，长 JSON 可能被拆成多个 chunk
  // 必须按 \n 分割，只发送完整的行，否则 bridge 端 JSON.parse 会报错
  let stdoutBuffer = ""
  child.stdout?.on("data", (buf: Buffer) => {
    stdoutBuffer += buf.toString()
    const lines = stdoutBuffer.split("\n")
    // 最后一个元素可能是不完整的行，留在 buffer 里
    stdoutBuffer = lines.pop() ?? ""
    for (const line of lines) {
      if (line.trim()) {
        console.log("[qwen-acp stdout]", line.trim().substring(0, 200))
        socket.send(line)
      }
    }
  })

  socket.on("close", () => {
    if (child) {
      child.kill()
      child = null
    }
  })

  socket.on("error", (err) => {
    console.error("[ws] error:", err)
  })
})

const PORT = Number(process.env.PORT ?? "4001")

server.listen(PORT, () => {
  console.log(`ACP demo server listening on http://localhost:${PORT}`)
})
