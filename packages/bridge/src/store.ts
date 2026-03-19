/**
 * store.ts — 桥接层状态管理
 *
 * 维护会话列表、消息历史、权限请求队列等状态。
 * 这些数据在 opencode server 里是存在 SQLite 里的，
 * 桥接层用内存 Map 简单模拟。
 */

import { ulid } from "ulid"

// 前端用 msg_ 前缀 + hex 时间戳 + 随机字符 生成 message ID
// bridge 也需要用相同前缀，否则字符串排序会导致 assistant message 排在 user message 前面
// （ULID 以 "01" 开头 < "msg_"，SessionTurn 组件依赖排序来匹配 user/assistant 消息对）
function ascendingMessageId(): string {
  const now = BigInt(Date.now()) * BigInt(0x1000) + BigInt(1)
  const bytes = new Uint8Array(6)
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
  }
  let hex = ""
  for (const b of bytes) hex += b.toString(16).padStart(2, "0")
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let rand = ""
  for (let i = 0; i < 14; i++) rand += chars[Math.floor(Math.random() * 62)]
  return "msg_" + hex + rand
}

// ========== 类型定义 ==========

export interface SessionInfo {
  id: string
  title: string
  directory: string
  time: { created: number; updated: number }
  model?: { providerID: string; modelID: string }
  agent?: string
}

export type PartState =
  | { status: "pending" | "running"; input: Record<string, unknown>; time: { start: number } }
  | {
      status: "completed"
      input: Record<string, unknown>
      output?: string
      title?: string
      metadata?: unknown
      time: { start: number; end: number }
    }
  | {
      status: "error"
      input: Record<string, unknown>
      error?: string
      time: { start: number; end: number }
    }

export interface TextPart {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
}

export interface ReasoningPart {
  id: string
  sessionID: string
  messageID: string
  type: "reasoning"
  text: string
  time: { start: number; end?: number }
}

export interface ToolPart {
  id: string
  sessionID: string
  messageID: string
  type: "tool"
  callID: string
  tool: string
  state: PartState
}

export type MessagePart = TextPart | ReasoningPart | ToolPart

export interface MessageInfo {
  id: string
  sessionID: string
  role: "user" | "assistant"
  time: { created: number; completed?: number }
  model?: { providerID: string; modelID: string }
  agent?: string
  parentID?: string
  finish?: "end_turn" | "tool-calls" | "max_tokens"
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}

export interface Message {
  info: MessageInfo
  parts: MessagePart[]
}

// 权限请求挂起状态
export interface PendingPermission {
  sessionID: string
  toolCallId: string
  toolTitle: string
  rawInput: Record<string, unknown>
  resolve: (optionId: string) => void
}

// ========== Store ==========

class BridgeStore {
  private sessions = new Map<string, SessionInfo>()
  private messages = new Map<string, Message[]>() // sessionId → messages
  private pendingPermissions = new Map<string, PendingPermission>() // permissionId → pending

  // 当前每个会话正在生成的 assistant message
  private currentAssistantMsg = new Map<string, Message>()
  // toolCallId → partId 映射
  private toolCallPartMap = new Map<string, string>()

  // ---- 会话管理 ----

  createSession(opts: { directory: string; model?: { providerID: string; modelID: string }; agent?: string }): SessionInfo {
    const id = ulid()
    return this._makeSession(id, opts)
  }

  createSessionWithId(id: string, opts: { directory: string; model?: { providerID: string; modelID: string }; agent?: string }): SessionInfo {
    if (this.sessions.has(id)) return this.sessions.get(id)!
    return this._makeSession(id, opts)
  }

  private _makeSession(id: string, opts: { directory: string; model?: { providerID: string; modelID: string }; agent?: string }): SessionInfo {
    const session: SessionInfo = {
      id,
      title: "New Session",
      directory: opts.directory,
      time: { created: Date.now(), updated: Date.now() },
      model: opts.model,
      agent: opts.agent,
    }
    this.sessions.set(id, session)
    this.messages.set(id, [])
    return session
  }

  getSession(id: string): SessionInfo | undefined {
    return this.sessions.get(id)
  }

  listSessions(directory?: string): SessionInfo[] {
    const all = Array.from(this.sessions.values())
    if (directory) return all.filter((s) => s.directory === directory)
    return all
  }

  updateSessionTitle(id: string, title: string) {
    const s = this.sessions.get(id)
    if (s) {
      s.title = title
      s.time.updated = Date.now()
    }
  }

  // ---- 消息管理 ----

  addUserMessage(sessionID: string, text: string, model?: { providerID: string; modelID: string }, messageID?: string): Message {
    const msgId = messageID ?? ascendingMessageId()
    const msg: Message = {
      info: {
        id: msgId,
        sessionID,
        role: "user",
        time: { created: Date.now() },
        model,
      },
      parts: [{ id: ulid(), sessionID, messageID: msgId, type: "text", text }],
    }
    this.messages.get(sessionID)?.push(msg)
    return msg
  }

  // 开始一条新的 assistant message（流式生成开始时调用）
  startAssistantMessage(sessionID: string, model?: { providerID: string; modelID: string }): Message {
    const msgId = ascendingMessageId()
    // 找到最后一个 user message 作为 parentID
    const msgs = this.messages.get(sessionID) ?? []
    const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
    const parentID = lastUserMsg?.info.id ?? ""
    const msg: Message = {
      info: {
        id: msgId,
        sessionID,
        role: "assistant",
        time: { created: Date.now() },
        model,
        parentID,
      },
      parts: [],
    }
    this.currentAssistantMsg.set(sessionID, msg)
    this.messages.get(sessionID)?.push(msg)
    return msg
  }

  getCurrentAssistantMsg(sessionID: string): Message | undefined {
    return this.currentAssistantMsg.get(sessionID)
  }

  // 完成当前 assistant message
  completeAssistantMessage(sessionID: string, finish?: "end_turn" | "tool-calls" | "max_tokens") {
    const msg = this.currentAssistantMsg.get(sessionID)
    if (msg) {
      msg.info.time.completed = Date.now()
      if (finish) msg.info.finish = finish
      this.currentAssistantMsg.delete(sessionID)
    }
  }

  // 追加文本到当前 assistant message 的 text part
  appendTextDelta(sessionID: string, delta: string): { messageID: string; partID: string } {
    const msg = this.currentAssistantMsg.get(sessionID)
    if (!msg) throw new Error(`No active assistant message for session ${sessionID}`)

    // 找到最后一个 text part，没有就新建
    let textPart = msg.parts.findLast((p) => p.type === "text") as TextPart | undefined
    if (!textPart) {
      textPart = { id: ulid(), sessionID, messageID: msg.info.id, type: "text", text: "" }
      msg.parts.push(textPart)
    }
    textPart.text += delta
    return { messageID: msg.info.id, partID: textPart.id }
  }

  // 追加推理文本
  appendReasoningDelta(sessionID: string, delta: string): { messageID: string; partID: string } {
    const msg = this.currentAssistantMsg.get(sessionID)
    if (!msg) throw new Error(`No active assistant message for session ${sessionID}`)

    let part = msg.parts.findLast((p) => p.type === "reasoning") as ReasoningPart | undefined
    if (!part) {
      part = { id: ulid(), sessionID, messageID: msg.info.id, type: "reasoning", text: "", time: { start: Date.now() } }
      msg.parts.push(part)
    }
    part.text += delta
    return { messageID: msg.info.id, partID: part.id }
  }

  // 创建或更新 tool part
  upsertToolPart(
    sessionID: string,
    toolCallId: string,
    tool: string,
    state: PartState,
  ): { messageID: string; part: ToolPart } {
    const msg = this.currentAssistantMsg.get(sessionID)
    if (!msg) throw new Error(`No active assistant message for session ${sessionID}`)

    let partId = this.toolCallPartMap.get(toolCallId)
    let toolPart = partId ? (msg.parts.find((p) => p.id === partId) as ToolPart | undefined) : undefined

    if (!toolPart) {
      partId = ulid()
      this.toolCallPartMap.set(toolCallId, partId)
      toolPart = { id: partId, sessionID, messageID: msg.info.id, type: "tool", callID: toolCallId, tool, state }
      msg.parts.push(toolPart)
    } else {
      toolPart.state = state
    }

    return { messageID: msg.info.id, part: toolPart }
  }

  getMessages(sessionID: string): Message[] {
    return this.messages.get(sessionID) ?? []
  }

  // ---- 权限管理 ----

  // ---- 文件变更管理（session diff）----
  private sessionDiffs = new Map<string, Array<{ file: string; before: string; after: string; additions: number; deletions: number }>>()

  addFileDiff(sessionID: string, file: string, before: string, after: string) {
    if (!this.sessionDiffs.has(sessionID)) {
      this.sessionDiffs.set(sessionID, [])
    }
    const diffs = this.sessionDiffs.get(sessionID)!
    // 如果同一个文件已经有 diff，更新它（取最新的 after）
    const existing = diffs.find((d) => d.file === file)
    const additions = after.split("\n").length
    const deletions = before ? before.split("\n").length : 0
    if (existing) {
      existing.after = after
      existing.additions = additions
      existing.deletions = deletions
    } else {
      diffs.push({ file, before, after, additions, deletions })
    }
  }

  getFileDiffs(sessionID: string): Array<{ file: string; before: string; after: string; additions: number; deletions: number }> {
    return this.sessionDiffs.get(sessionID) ?? []
  }

  // ---- 权限管理 ----

  addPendingPermission(perm: PendingPermission): string {
    const id = ulid()
    this.pendingPermissions.set(id, perm)
    return id
  }

  resolvePendingPermission(id: string, optionId: string): boolean {
    const perm = this.pendingPermissions.get(id)
    if (!perm) return false
    perm.resolve(optionId)
    this.pendingPermissions.delete(id)
    return true
  }

  getPendingPermission(id: string): PendingPermission | undefined {
    return this.pendingPermissions.get(id)
  }
}

export const store = new BridgeStore()
