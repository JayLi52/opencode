import http from "http"
import express from "express"
import { WebSocketServer, type WebSocket } from "ws"
import path from "path"
import { QwenAcpBridge } from "./acp-stdio-bridge"
import type { SessionNotification } from "@agentclientprotocol/sdk"

const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: "/ws" })

app.use(express.static(path.join(__dirname, "..", "public")))

wss.on("connection", (socket: WebSocket) => {
  let bridge: QwenAcpBridge | null = null

  // 创建一个 WritableStream 用于发送数据到客户端
  const clientStream = new WritableStream({
    write: (chunk) => {
      const data = new TextDecoder().decode(chunk)
      socket.send(data)
    },
  })

  // 创建一个 ReadableStream 用于接收客户端数据
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const serverStream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c
    },
  })

  socket.on("message", (data: WebSocket.RawData) => {
    const text = typeof data === "string" ? data : data.toString()
    const encoder = new TextEncoder()
    console.log("[ws] receive:", text)
    controller?.enqueue(encoder.encode(text + "\n"))
  })

  socket.on("close", () => {
    controller?.close()
    if (bridge) bridge.stop()
  })

  socket.on("error", (err) => {
    console.error("[ws] error:", err)
    controller?.error(err)
  })

  // 初始化 bridge，传入 streams 而不是 wsUrl
  bridge = new QwenAcpBridge(
    {
      cwd: process.cwd(),
      streams: { stdin: clientStream, stdout: serverStream },
    },
    (update: SessionNotification) => {
      console.log("[bridge] session update:", update)
    },
  )

  bridge.start().catch((err) => {
    console.error("[bridge] start failed:", err)
    socket.send(JSON.stringify({ type: "error", message: err.message }))
  })
})

const PORT = Number(process.env.PORT ?? "4001")

server.listen(PORT, () => {
  console.log(`ACP demo server listening on http://localhost:${PORT}`)
})
