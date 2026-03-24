/**
 * eventConverter.ts — ACP sessionUpdate → opencode SSE 事件转换
 *
 * 这是桥接层最核心的逻辑：
 * 把 ACP Agent 推送的 SessionNotification 事件，
 * 转换成 opencode web 前端期望的 SSE 事件格式。
 *
 * 参考：opencode/packages/opencode/src/acp/agent.ts handleEvent（反向操作）
 *
 * 修复记录：
 * - [fix] tool title 显示 "unknown"：ACP 的 tool_call_update(completed) 事件不带 title 字段，
 *   新增 toolTitleCache 缓存 tool_call(in_progress) 和 request_permission 中的 title，
 *   completed 时从缓存取，fallback 到 _meta.toolName
 * - [fix] emitPermissionAsked 补充 patterns/always/messageID 字段，修复前端 permission dock 崩溃
 * - [fix] handleAcpPermission 保存 acpOptions 到 pending，用于 optionId 映射
 */

import * as path from "node:path"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { store } from "./store.js"
import {
  emitSessionStatus,
  emitMessageUpdated,
  emitMessagePartDelta,
  emitMessagePartUpdated,
  emitReasoningPartDelta,
  emitToolPartUpdated,
  emitPermissionAsked,
  broadcast,
} from "./sse.js"

// toolCallId → title 缓存
// tool_call(in_progress) 和 request_permission 都会带 title，
// 但 tool_call_update(completed) 不带，需要从缓存里取
const toolTitleCache = new Map<string, string>()

/**
 * 处理一条 ACP sessionUpdate 事件
 * @param sessionID - opencode 会话 ID（对应 ACP sessionId）
 * @param directory - 工作目录（SSE 事件需要带上）
 * @param update - ACP 推送的事件
 */
export function handleAcpUpdate(sessionID: string, directory: string, update: SessionNotification) {
  const u = update.update as any
  console.log("[event-converter] received ACP update:", JSON.stringify(u).substring(0, 200))
  if (!u) return

  const type: string = u.sessionUpdate ?? u.type ?? ""

  switch (type) {
    case "agent_message_chunk": {
      let msg = store.getCurrentAssistantMsg(sessionID)
      if (!msg) {
        const session = store.getSession(sessionID)
        msg = store.startAssistantMessage(sessionID, session?.model)
        emitSessionStatus(directory, sessionID, "busy")
        // 告诉前端有新消息
        emitMessageUpdated(directory, sessionID, msg.info)
      }

      const text: string = u.content?.text ?? u.chunk ?? ""
      if (text) {
        const { messageID, partID } = store.appendTextDelta(sessionID, text)
        // 确保前端知道这个 part 存在
        const part = msg.parts.find((p) => p.id === partID)
        if (part) emitMessagePartUpdated(directory, sessionID, part)
        emitMessagePartDelta(directory, sessionID, messageID, partID, text)
      }
      break
    }

    case "agent_thought_chunk": {
      let msg = store.getCurrentAssistantMsg(sessionID)
      if (!msg) {
        const session = store.getSession(sessionID)
        msg = store.startAssistantMessage(sessionID, session?.model)
        emitSessionStatus(directory, sessionID, "busy")
        emitMessageUpdated(directory, sessionID, msg.info)
      }

      const text: string = u.content?.text ?? u.chunk ?? ""
      if (text) {
        const { messageID, partID } = store.appendReasoningDelta(sessionID, text)
        const part = msg.parts.find((p) => p.id === partID)
        if (part) emitMessagePartUpdated(directory, sessionID, part)
        emitReasoningPartDelta(directory, sessionID, messageID, partID, text)
      }
      break
    }

    case "tool_call":
    case "tool_call_update": {
      // 工具调用开始或状态更新
      let msg = store.getCurrentAssistantMsg(sessionID)
      if (!msg) {
        const session = store.getSession(sessionID)
        msg = store.startAssistantMessage(sessionID, session?.model)
        emitSessionStatus(directory, sessionID, "busy")
      }

      const toolCallId: string = u.toolCallId ?? u.toolCall?.id ?? ""
      const rawInput: Record<string, unknown> = u.rawInput ?? u.toolCall?.input ?? {}
      const acpStatus: string = u.status ?? "in_progress"

      // title 解析优先级：事件自带 > 缓存 > _meta.toolName > "unknown"
      let toolTitle: string = u.title ?? u.toolCall?.title ?? ""
      if (toolTitle && toolTitle !== "unknown" && toolCallId) {
        // 有有效 title，缓存起来
        toolTitleCache.set(toolCallId, toolTitle)
      } else if (!toolTitle || toolTitle === "unknown") {
        // 没有 title，从缓存取
        toolTitle = (toolCallId && toolTitleCache.get(toolCallId))
          ?? u._meta?.toolName
          ?? "unknown"
      }

      // 映射 ACP status → opencode status
      let ocStatus: "pending" | "running" | "completed" | "error"
      if (acpStatus === "completed") ocStatus = "completed"
      else if (acpStatus === "failed") ocStatus = "error"
      else ocStatus = "running"

      let partState: import("./store.js").PartState
      if (ocStatus === "completed") {
        const outputText = extractOutputText(u)
        partState = {
          status: "completed",
          input: rawInput,
          output: outputText,
          title: toolTitle,
          metadata: u.rawOutput?.metadata,
          time: { start: Date.now() - 1000, end: Date.now() },
        }
      } else if (ocStatus === "error") {
        const errorText = extractOutputText(u) ?? "Tool execution failed"
        partState = {
          status: "error",
          input: rawInput,
          error: errorText,
          time: { start: Date.now() - 1000, end: Date.now() },
        }
      } else {
        partState = {
          status: "running",
          input: rawInput,
          time: { start: Date.now() },
        }
      }

      const { part } = store.upsertToolPart(sessionID, toolCallId, toolTitle, partState)
      emitToolPartUpdated(directory, part)

      // 当写文件工具完成时，提取文件变更信息用于 session diff
      if (ocStatus === "completed") {
        const filePath = extractFilePath(u, rawInput, directory)
        if (filePath) {
          const newText = extractNewText(u)
          const oldText = u.rawOutput?.oldText ?? u.oldText ?? ""
          store.addFileDiff(sessionID, filePath, oldText, newText ?? "")
          // 广播 session.diff 事件，前端会更新审查(Review) tab
          broadcast(directory, "session.diff", {
            sessionID,
            diff: store.getFileDiffs(sessionID),
          })
          // 广播 file.watcher.updated 事件，前端会刷新"所有文件"(All Files) 文件树
          // 注意：file 字段用绝对路径（和 opencode 原版一致），前端 normalize 会转成相对路径
          const absFilePath = path.resolve(directory, filePath)
          broadcast(directory, "file.watcher.updated", {
            file: absFilePath,
            event: "add",
          })
        }
      }
      break
    }

    case "agent_message_completed": {
      // 一条完整的 AI 回复结束
      store.completeAssistantMessage(sessionID, "end_turn")
      emitSessionStatus(directory, sessionID, "idle")
      break
    }

    default:
      // 其他事件类型暂时忽略
      break
  }
}

/**
 * 处理 ACP requestPermission 回调
 * 把权限请求转换成 SSE permission.asked 事件，
 * 并挂起等待前端回复。
 */
export async function handleAcpPermission(
  sessionID: string,
  directory: string,
  params: {
    toolCall?: { toolCallId?: string; title?: string; rawInput?: Record<string, unknown> }
    options?: Array<{ optionId: string; kind: string }>
  },
): Promise<{ outcome: { outcome: "selected"; optionId: string } }> {
  const toolCallId = params.toolCall?.toolCallId ?? ""
  const toolTitle = params.toolCall?.title ?? "unknown"
  const rawInput = params.toolCall?.rawInput ?? {}
  const acpOptions = params.options ?? []

  // request_permission 事件带有完整的 title（如 "Writing to README.md"），缓存起来
  if (toolCallId && toolTitle && toolTitle !== "unknown") {
    toolTitleCache.set(toolCallId, toolTitle)
  }

  // 获取当前 assistant message ID（权限请求一定发生在 assistant 回复过程中）
  const currentMsg = store.getCurrentAssistantMsg(sessionID)
  const messageID = currentMsg?.info.id ?? ""

  console.log(`[permission] ACP requestPermission: tool=${toolTitle}, options=`, JSON.stringify(acpOptions))

  // 挂起，等待前端通过 POST /session/:id/permissions/:pid 回复
  return new Promise((resolve) => {
    const permissionID = store.addPendingPermission({
      sessionID,
      toolCallId,
      toolTitle,
      rawInput,
      acpOptions,
      resolve: (optionId: string) => {
        resolve({ outcome: { outcome: "selected", optionId } })
      },
    })

    // 推送 permission.asked 事件给前端
    emitPermissionAsked(directory, permissionID, sessionID, messageID, toolCallId, toolTitle, rawInput)
  })
}

// 从 ACP tool_call_update 中提取输出文本
function extractOutputText(u: any): string | undefined {
  if (u.rawOutput?.output) return String(u.rawOutput.output)
  if (Array.isArray(u.content)) {
    return u.content
      .map((c: any) => c?.content?.text ?? c?.text ?? "")
      .filter(Boolean)
      .join("\n")
  }
  return undefined
}

// 从 ACP tool_call 中提取文件路径（返回相对于 directory 的相对路径）
function extractFilePath(u: any, rawInput: Record<string, unknown>, directory: string): string | undefined {
  let absPath: string | undefined
  // locations 数组里有 path
  if (Array.isArray(u.locations) && u.locations.length > 0) {
    absPath = u.locations[0]?.path
  }
  // rawInput 里可能有 filePath 或 path
  if (!absPath && rawInput.filePath) absPath = String(rawInput.filePath)
  if (!absPath && rawInput.file_path) absPath = String(rawInput.file_path)
  if (!absPath && rawInput.path) absPath = String(rawInput.path)
  if (!absPath) return undefined

  // 转换为相对路径（前端 FileTree 期望相对路径）
  return path.relative(directory, absPath)
}

// 从 ACP tool_call completed 中提取新文件内容
function extractNewText(u: any): string | undefined {
  // content 数组里可能有 newText
  if (Array.isArray(u.content)) {
    for (const c of u.content) {
      if (c?.newText !== undefined) return String(c.newText)
    }
  }
  if (u.newText !== undefined) return String(u.newText)
  if (u.rawOutput?.newText !== undefined) return String(u.rawOutput.newText)
  return undefined
}
