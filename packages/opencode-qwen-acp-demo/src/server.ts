import http from "http"
import express from "express"
import { WebSocketServer, type WebSocket } from "ws"
import path from "path"
import { QwenAcpBridge } from "./acpBridge"
import type { SessionNotification } from "@agentclientprotocol/sdk"

const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: "/ws" })

// 静态前端（很简单的 HTML/JS）
app.use(express.static(path.join(__dirname, "..", "public")))

type ClientMsg =
  | { type: "init"; cliEntryPath: string; cwd?: string }
  | { type: "prompt"; text: string }
  | { type: "cancel" }

type ServerMsg =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "sessionUpdate"; payload: SessionNotification }
  | { type: "promptResult"; stopReason?: string | null }

wss.on("connection", (socket: WebSocket) => {
  let bridge: QwenAcpBridge | null = null

  const send = (msg: ServerMsg) => {
    socket.send(JSON.stringify(msg))
  }

  socket.on("message", async (data: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(String(data)) as ClientMsg
      console.log("Received message:", msg)

      if (msg.method === "initialize") {
        if (bridge) bridge.stop()
        const cwd = msg.cwd ?? process.cwd()
        bridge = new QwenAcpBridge(
          {
            cliEntryPath: '/Users/terry/work/ai-workspace/qwen-code/dist/cli.js',
            cwd,
          },
          (update: SessionNotification) => {
            send({ type: "sessionUpdate", payload: update })
          },
        )
        await bridge.start()
        
        // await bridge.newSession()
        // send({ type: "ready" })
        return
      }

      if (!bridge) {
        send({ type: "error", message: "Bridge not initialized. Send init first." })
        return
      }

      switch (msg.type) {
        case "prompt": {
          const res = await bridge.prompt(msg.text)
          send({ type: "promptResult", stopReason: res.stopReason ?? null })
          break
        }
        case "cancel": {
          await bridge.cancel()
          break
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      send({ type: "error", message })
    }
  })

  socket.on("close", () => {
    if (bridge) bridge.stop()
  })
})

const PORT = Number(process.env.PORT ?? "4001")

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`ACP demo server listening on http://localhost:${PORT}`)
})

