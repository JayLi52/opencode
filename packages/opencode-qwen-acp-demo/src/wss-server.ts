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

  // 启动 ACP 进程 - 固定使用 qwen --acp
  const spawnCommand = "qwen"
  const spawnArgs = ["--acp"]
  const options: SpawnOptions = {
    cwd: workDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    shell: true, // macOS 需要这个来找到 qwen 命令
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

  // stdout → WebSocket
  child.stdout?.on("data", (buf: Buffer) => {
    const msg = buf.toString()
    console.log("[qwen-acp stdout]", msg.trim())
    socket.send(msg)
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
