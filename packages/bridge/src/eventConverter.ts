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
import * as fs from "node:fs/promises"
import { diffLines } from "diff"
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
// toolCallId → kind 缓存（read/edit/execute 等）
// tool_call(pending) 和 tool_call_update(in_progress) 带 kind，但 completed 不带
const toolKindCache = new Map<string, string>()

// toolCallId → { filePath, oldContent } 缓存
// 在写工具进入 running 状态时预读文件旧内容，completed 时用于计算精确 diff
const fileContentCache = new Map<string, { filePath: string; oldContent: string }>()
// toolCallId → directory 缓存（预读时记录 directory，completed 时用）
const toolDirectoryCache = new Map<string, string>()

/**
 * 安全读取文件内容，文件不存在返回空字符串（新建文件场景）
 */
async function safeReadFile(absPath: string): Promise<string> {
  try {
    return await fs.readFile(absPath, "utf-8")
  } catch {
    return ""
  }
}

/**
 * 预读文件旧内容并缓存，用于后续 diff 计算
 */
async function preReadFileContent(toolCallId: string, filePath: string, directory: string) {
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(directory, filePath)
  const relPath = path.relative(directory, absPath)
  const oldContent = await safeReadFile(absPath)
  fileContentCache.set(toolCallId, { filePath: relPath, oldContent })
  toolDirectoryCache.set(toolCallId, directory)
  console.log(`[event-converter] pre-read file for diff: ${relPath} (${oldContent.length} chars)`)
}

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

      // kind 缓存：pending/in_progress 事件带 kind，completed 不带
      const rawKind: string = u.kind ?? ""
      if (rawKind && toolCallId) {
        toolKindCache.set(toolCallId, rawKind)
      }

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
      // 只有 kind 为 edit/write/create 的工具才是文件变更，read 类工具不应记录 diff
      let toolKind: string = rawKind || (toolCallId && toolKindCache.get(toolCallId)) || ""
      // fallback: 如果 kind 为空（如 qwen-code permission 流程），通过 toolName 和 content 推断
      if (!toolKind && ocStatus === "completed") {
        const toolName: string = u._meta?.toolName ?? ""
        const hasNewText = Array.isArray(u.content) && u.content.some((c: any) => c?.newText !== undefined)
        if (toolName.includes("write") || toolName.includes("edit") || toolName.includes("create") || hasNewText) {
          toolKind = "edit"
        }
      }
      const isWriteOp = toolKind === "edit" || toolKind === "write" || toolKind === "create"

      // 写工具进入 running 状态时，预读文件旧内容（用于 completed 时计算精确 diff）
      if (ocStatus === "running" && isWriteOp && toolCallId && !fileContentCache.has(toolCallId)) {
        const earlyFilePath = extractFilePath(u, rawInput, directory)
        if (earlyFilePath) {
          preReadFileContent(toolCallId, earlyFilePath, directory).catch((err) =>
            console.warn(`[event-converter] pre-read failed for ${earlyFilePath}:`, err)
          )
        }
      }

      if (ocStatus === "completed" && isWriteOp) {
        console.log(`[event-converter] write tool completed (kind=${toolKind}):`, JSON.stringify(u).substring(0, 500))
        const filePath = extractFilePath(u, rawInput, directory)
        console.log(`[event-converter] tool completed: title=${toolTitle}, filePath=${filePath ?? "NONE"}, directory=${directory}`)
        if (filePath) {
          // 异步读取新文件内容并计算精确 diff
          computeAndBroadcastDiff(sessionID, directory, toolCallId, filePath, u).catch((err) =>
            console.error(`[event-converter] diff computation failed:`, err)
          )
        }
      } else if (ocStatus === "completed") {
        console.log(`[event-converter] non-write tool completed (kind=${toolKind}), skipping diff`)
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

  // qwen-code 的写文件走 permission 流程，不走 tool_call(pending)，
  // 所以 toolKindCache 里没有缓存。这里根据 title/content 推断 kind 并缓存
  if (toolCallId && !toolKindCache.has(toolCallId)) {
    const tc = params.toolCall as any
    const hasNewText = Array.isArray(tc?.content) && tc.content.some((c: any) => c?.newText !== undefined)
    const titleLooksLikeWrite = toolTitle.toLowerCase().startsWith("writing to")
    if (hasNewText || titleLooksLikeWrite) {
      toolKindCache.set(toolCallId, "edit")

      // 预读文件旧内容（permission 阶段文件还没被修改，是最佳预读时机）
      const earlyFilePath = extractFilePathFromPermission(params.toolCall, directory)
      if (earlyFilePath && !fileContentCache.has(toolCallId)) {
        await preReadFileContent(toolCallId, earlyFilePath, directory)
      }
    }
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
  // rawOutput 里也可能有路径信息
  if (!absPath && u.rawOutput?.filePath) absPath = String(u.rawOutput.filePath)
  if (!absPath && u.rawOutput?.file_path) absPath = String(u.rawOutput.file_path)
  if (!absPath && u.rawOutput?.path) absPath = String(u.rawOutput.path)
  // content 数组里可能有 path（某些 ACP agent 的格式）
  if (!absPath && Array.isArray(u.content)) {
    for (const c of u.content) {
      if (c?.path) { absPath = String(c.path); break }
      if (c?.filePath) { absPath = String(c.filePath); break }
      if (c?.file_path) { absPath = String(c.file_path); break }
    }
  }
  // toolCall 对象里可能有 input.path
  if (!absPath && u.toolCall?.input?.path) absPath = String(u.toolCall.input.path)
  if (!absPath && u.toolCall?.input?.filePath) absPath = String(u.toolCall.input.filePath)
  if (!absPath && u.toolCall?.input?.file_path) absPath = String(u.toolCall.input.file_path)
  if (!absPath) {
    console.log(`[event-converter] extractFilePath: no path found. locations=${JSON.stringify(u.locations)}, rawInput keys=${Object.keys(rawInput).join(",")}, rawOutput keys=${u.rawOutput ? Object.keys(u.rawOutput).join(",") : "N/A"}, toolCall.input keys=${u.toolCall?.input ? Object.keys(u.toolCall.input).join(",") : "N/A"}`)
    return undefined
  }

  // ACP agent 可能返回相对路径（如 "hello-test.txt"）或绝对路径
  // 如果是相对路径，先基于 directory 转成绝对路径，再算相对路径
  const resolvedPath = path.isAbsolute(absPath) ? absPath : path.resolve(directory, absPath)
  const rel = path.relative(directory, resolvedPath)
  console.log(`[event-converter] extractFilePath: raw=${absPath}, resolved=${resolvedPath}, directory=${directory}, relative=${rel}`)
  return rel
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

/**
 * 从 permission 请求中提取文件路径
 * permission 的 toolCall 结构和 tool_call_update 不同，单独处理
 */
function extractFilePathFromPermission(
  toolCall: { title?: string; rawInput?: Record<string, unknown> } | undefined,
  directory: string,
): string | undefined {
  if (!toolCall) return undefined
  const rawInput = toolCall.rawInput ?? {}

  // 从 title 提取：如 "Writing to README.md"
  const title = toolCall.title ?? ""
  const writingMatch = title.match(/^Writing to\s+(.+)$/i)
  if (writingMatch) {
    const fp = writingMatch[1].trim()
    if (fp) {
      const resolved = path.isAbsolute(fp) ? fp : path.resolve(directory, fp)
      return path.relative(directory, resolved)
    }
  }

  // 从 rawInput 提取
  for (const key of ["filePath", "file_path", "path"]) {
    if (rawInput[key]) {
      const fp = String(rawInput[key])
      const resolved = path.isAbsolute(fp) ? fp : path.resolve(directory, fp)
      return path.relative(directory, resolved)
    }
  }

  return undefined
}

/**
 * 计算精确 diff 并广播给前端
 * 参考 opencode/packages/opencode/src/tool/edit.ts 的 diffLines 逻辑
 *
 * 策略：
 * 1. 优先从 fileContentCache 取预读的旧内容（running/permission 阶段缓存的）
 * 2. 新内容优先从磁盘读（agent 已经写完了），fallback 到 ACP 事件里的 newText
 * 3. 用 diffLines 计算精确的 additions/deletions
 */
async function computeAndBroadcastDiff(
  sessionID: string,
  directory: string,
  toolCallId: string,
  filePath: string,
  u: any,
) {
  const absFilePath = path.resolve(directory, filePath)

  // 1. 获取旧内容：优先从缓存取
  let oldContent = ""
  const cached = fileContentCache.get(toolCallId)
  if (cached) {
    oldContent = cached.oldContent
    fileContentCache.delete(toolCallId) // 用完清理
    console.log(`[event-converter] diff: using cached old content for ${filePath} (${oldContent.length} chars)`)
  } else {
    // 没有缓存（可能 running 事件里没提取到路径），用 ACP 事件里的 oldText
    oldContent = u.rawOutput?.oldText ?? u.oldText ?? ""
    console.log(`[event-converter] diff: no cached old content for ${filePath}, using ACP oldText (${oldContent.length} chars)`)
  }

  // 2. 获取新内容：优先从磁盘读（最准确），fallback 到 ACP 事件
  let newContent = await safeReadFile(absFilePath)
  if (!newContent) {
    const acpNewText = extractNewText(u)
    if (acpNewText) newContent = acpNewText
  }

  // 3. 用 diffLines 计算精确的 additions/deletions
  let additions = 0
  let deletions = 0
  for (const change of diffLines(oldContent, newContent)) {
    if (change.added) additions += change.count ?? 0
    if (change.removed) deletions += change.count ?? 0
  }

  console.log(`[event-converter] diff result: ${filePath} +${additions} -${deletions}`)

  // 4. 存储并广播
  store.addFileDiff(sessionID, filePath, oldContent, newContent, additions, deletions)

  broadcast(directory, "session.diff", {
    sessionID,
    diff: store.getFileDiffs(sessionID),
  })

  broadcast(directory, "file.watcher.updated", {
    file: absFilePath,
    event: "add",
  })

  // 清理 directory 缓存
  toolDirectoryCache.delete(toolCallId)
}
