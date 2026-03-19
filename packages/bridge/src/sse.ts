/**
 * sse.ts — SSE 事件推送管理
 *
 * 管理所有连接到 /global/event 的 SSE 客户端，
 * 提供 broadcast 方法把事件推送给所有客户端。
 *
 * opencode 前端期望的 SSE 事件格式：
 * data: {"directory":"/path","payload":{"type":"xxx","properties":{...}}}
 */

import type { MessagePart, ToolPart, MessageInfo } from "./store.js"

// SSE 客户端写入函数类型
type SseWriter = (data: string) => void

// 所有活跃的 SSE 连接
const clients = new Set<SseWriter>()

export function getSseClientCount(): number {
  return clients.size
}

export function addSseClient(writer: SseWriter): () => void {
  clients.add(writer)
  console.log(`[sse] client connected, total: ${clients.size}`)
  return () => {
    clients.delete(writer)
    console.log(`[sse] client disconnected, total: ${clients.size}`)
  }
}

// 向所有客户端广播事件
export function broadcast(directory: string, type: string, properties: unknown) {
  const data = JSON.stringify({ directory, payload: { type, properties } })
  if (type !== "session.status") {
    console.log(`[sse] broadcast dir="${directory}" type=${type} clients=${clients.size} data=${data.substring(0, 150)}`)
  } else {
    console.log(`[sse] broadcast dir="${directory}" type=${type} clients=${clients.size}`)
  }
  let sent = 0
  for (const write of clients) {
    try {
      write(data)
      sent++
    } catch (e) {
      console.error("[sse] write error:", e)
    }
  }
  if (sent !== clients.size) {
    console.warn(`[sse] only sent to ${sent}/${clients.size} clients`)
  }
}

// ========== 具体事件构造函数 ==========

export function emitSessionStatus(directory: string, sessionID: string, status: "busy" | "idle") {
  broadcast(directory, "session.status", { sessionID, status: { type: status } })
}

export function emitMessageUpdated(directory: string, sessionID: string, info: MessageInfo) {
  // 前端期望扁平格式的 message info
  const flat: Record<string, unknown> = {
    id: info.id,
    sessionID: info.sessionID,
    role: info.role,
    time: info.time,
    modelID: info.model?.modelID ?? "bridge-agent",
    providerID: info.model?.providerID ?? "bridge",
    agent: info.agent ?? "coder",
    mode: "agent",
    parentID: info.parentID ?? "",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: info.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: info.finish,
  }
  broadcast(directory, "message.updated", { info: flat })
}

export function emitMessagePartDelta(
  directory: string,
  sessionID: string,
  messageID: string,
  partID: string,
  delta: string,
  field: "text" = "text",
) {
  broadcast(directory, "message.part.delta", { sessionID, messageID, partID, field, delta })
}

export function emitReasoningPartDelta(
  directory: string,
  sessionID: string,
  messageID: string,
  partID: string,
  delta: string,
) {
  broadcast(directory, "message.part.delta", {
    sessionID,
    messageID,
    partID,
    field: "text",
    delta,
    // reasoning 标记
    reasoning: true,
  })
}

export function emitMessagePartUpdated(directory: string, sessionID: string, part: MessagePart) {
  broadcast(directory, "message.part.updated", { sessionID, part })
}

export function emitToolPartUpdated(directory: string, part: ToolPart) {
  broadcast(directory, "message.part.updated", { sessionID: part.sessionID, part })
}

export function emitPermissionAsked(
  directory: string,
  permissionID: string,
  sessionID: string,
  toolCallId: string,
  toolTitle: string,
  rawInput: Record<string, unknown>,
) {
  broadcast(directory, "permission.asked", {
    id: permissionID,
    sessionID,
    permission: toolTitle,
    tool: { callID: toolCallId },
    metadata: rawInput,
  })
}
