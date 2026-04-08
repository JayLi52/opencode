/**
 * use-engine.ts — 引擎切换 hook
 *
 * 管理当前 ACP 引擎状态（qwen-code / opencode），
 * 提供切换方法，监听 SSE engine.switched 事件同步状态。
 */

import { createSignal, onCleanup, onMount } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { useSDK } from "@/context/sdk"

export type EngineType = "qwen-code" | "opencode"

const ENGINE_LABELS: Record<EngineType, string> = {
  "qwen-code": "Qwen Code",
  opencode: "OpenCode",
}

export function useEngine() {
  const sdk = useSDK()
  const navigate = useNavigate()
  const [engine, setEngine] = createSignal<EngineType>("qwen-code")
  const [switching, setSwitching] = createSignal(false)

  // 启动时获取当前引擎
  onMount(async () => {
    try {
      const res = await fetch(`${sdk.url}/engine`)
      const data = await res.json()
      if (data.engine) setEngine(data.engine)
    } catch (e) {
      console.error("[engine] failed to fetch current engine:", e)
    }
  })

  // 监听 SSE engine.switched 事件
  const stop = sdk.event.listen((e: any) => {
    if (e.details?.type === "engine.switched") {
      const props = e.details.properties as { engine?: string }
      if (props?.engine) {
        setEngine(props.engine as EngineType)
        setSwitching(false)
      }
    }
  })
  onCleanup(stop)

  const switchEngine = async (newEngine: EngineType) => {
    if (newEngine === engine() || switching()) return
    setSwitching(true)
    try {
      const res = await fetch(`${sdk.url}/engine/switch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": sdk.directory,
        },
        body: JSON.stringify({ engine: newEngine }),
      })
      const data = await res.json()
      if (data.changed && data.session) {
        setEngine(newEngine)
        // 跳转到新 session
        const slug = base64Encode(sdk.directory)
        navigate(`/${slug}/session/${data.session.id}`)
      }
    } catch (e) {
      console.error("[engine] switch failed:", e)
    } finally {
      setSwitching(false)
    }
  }

  return {
    engine,
    switching,
    switchEngine,
    label: (e?: EngineType) => ENGINE_LABELS[e ?? engine()] ?? engine(),
    options: ["qwen-code", "opencode"] as EngineType[],
  }
}
