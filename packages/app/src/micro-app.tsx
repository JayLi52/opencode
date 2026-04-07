import { render } from "solid-js/web"
import { isInIcestark, setLibraryName, getBasename } from "@ice/stark-app"
import { AppBaseProviders, AppInterface } from "@/app"
import { PlatformProvider, type Platform } from "@/context/platform"
import { handleNotificationClick } from "@/utils/notification-click"
import pkg from "../package.json"
import { ServerConnection } from "./context/server"

setLibraryName("opencodeApp")

const platform: Platform = {
  platform: "web",
  version: pkg.version,
  openLink: (url) => window.open(url, "_blank"),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  restart: async () => window.location.reload(),
  notify: async (title, description, href) => {
    if (!("Notification" in window)) return
    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission().catch(() => "denied")
        : Notification.permission
    if (permission !== "granted") return
    const inView = document.visibilityState === "visible" && document.hasFocus()
    if (inView) return
    const notification = new Notification(title, {
      body: description ?? "",
      icon: "https://opencode.ai/favicon-96x96-v3.png",
    })
    notification.onclick = () => {
      handleNotificationClick(href)
      notification.close()
    }
  },
  getDefaultServer: async () => null,
  setDefaultServer: () => {},
}

let dispose: (() => void) | null = null

export function mount(props: { container: Element }) {
  props.container.classList.add("opencode-micro-app")

  // bridge URL 配置:
  // - 本地开发: localhost:4096
  // - 生产环境(ingress): /opencode/api
  // 可通过 window.__OPENCODE_BRIDGE_URL__ 覆盖
  const defaultBridgeUrl = isInIcestark() ? "/opencode/api" : "http://localhost:4096"
  const bridgeUrl = (globalThis as any).__OPENCODE_BRIDGE_URL__ ?? defaultBridgeUrl

  const server: ServerConnection.Http = {
    type: "http",
    http: { url: serverUrl },
  }

  dispose = render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface
            defaultServer={ServerConnection.Key.make(serverUrl)}
            servers={[server]}
            disableHealthCheck
          />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    props.container,
  )
}

export function unmount() {
  if (dispose) {
    dispose()
    dispose = null
  }
  const container = document.querySelector(".opencode-micro-app")
  container?.classList.remove("opencode-micro-app")
}

if (!isInIcestark()) {
  const root = document.getElementById("root")
  if (root instanceof HTMLElement) {
    mount({ container: root })
  }
}
