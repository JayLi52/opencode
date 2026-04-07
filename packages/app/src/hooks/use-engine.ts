import { createSignal, createMemo } from "solid-js"
import { useSDK } from "@/context/sdk"

interface Engine {
  id: string
  name: string
}

export function useEngine() {
  const sdk = useSDK()
  const [switching, setSwitching] = createSignal(false)

  const engine = createMemo(() => {
    return "default"
  })

  const options = createMemo(() => [
    { value: "default", label: "Default" },
  ])

  const label = (e: string) => {
    return options().find((o) => o.value === e)?.label ?? e
  }

  const switchEngine = async (e: string) => {
    setSwitching(true)
    try {
      // Engine switching logic
    } finally {
      setSwitching(false)
    }
  }

  return {
    engine,
    options,
    label,
    switchEngine,
    switching,
  }
}
