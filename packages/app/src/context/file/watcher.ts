import type { FileNode } from "@opencode-ai/sdk/v2"

type WatcherEvent = {
  type: string
  properties: unknown
}

type WatcherOps = {
  normalize: (input: string) => string
  hasFile: (path: string) => boolean
  isOpen?: (path: string) => boolean
  loadFile: (path: string) => void
  node: (path: string) => FileNode | undefined
  isDirLoaded: (path: string) => boolean
  refreshDir: (path: string) => void
}

export function invalidateFromWatcher(event: WatcherEvent, ops: WatcherOps) {
  if (event.type !== "file.watcher.updated") return
  const props =
    typeof event.properties === "object" && event.properties ? (event.properties as Record<string, unknown>) : undefined
  const rawPath = typeof props?.file === "string" ? props.file : undefined
  const kind = typeof props?.event === "string" ? props.event : undefined
  if (!rawPath) return
  if (!kind) return

  const path = ops.normalize(rawPath)
  console.log(`[watcher] invalidate: kind=${kind}, rawPath=${rawPath}, normalized="${path}"`)
  if (!path) {
    console.warn(`[watcher] normalized path is empty, skipping`)
    return
  }
  if (path.startsWith(".git/")) return

  if (ops.hasFile(path) || ops.isOpen?.(path)) {
    ops.loadFile(path)
  }

  if (kind === "change") {
    const dir = (() => {
      if (path === "") return ""
      const node = ops.node(path)
      if (node?.type !== "directory") return
      return path
    })()
    if (dir === undefined) return
    if (!ops.isDirLoaded(dir)) return
    ops.refreshDir(dir)
    return
  }
  if (kind !== "add" && kind !== "unlink") return

  const parent = path.split("/").slice(0, -1).join("/")
  const parentLoaded = ops.isDirLoaded(parent)
  console.log(`[watcher] kind=${kind}, path="${path}", parent="${parent}", parentLoaded=${parentLoaded}`)

  if (!parentLoaded) {
    // 向上查找最近的已加载目录并刷新它
    // 这样即使直接父目录未展开，祖先目录也能感知到变化
    const segments = parent.split("/")
    for (let i = segments.length - 1; i >= 0; i--) {
      const ancestor = segments.slice(0, i).join("/")
      if (ops.isDirLoaded(ancestor)) {
        console.log(`[watcher] parent not loaded, refreshing ancestor="${ancestor}"`)
        ops.refreshDir(ancestor)
        return
      }
    }
    console.warn(`[watcher] no loaded ancestor found for parent="${parent}"`)
    return
  }

  ops.refreshDir(parent)
}
