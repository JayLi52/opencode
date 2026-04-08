import "@/index.css"
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
let shadowRoot: ShadowRoot | null = null

export function mount(props: { container: Element }) {
  console.log("mount----", props.container)
  
  // 创建 Shadow DOM 以隔离样式
  if (!props.container.shadowRoot) {
    shadowRoot = props.container.attachShadow({ mode: 'open' })
  } else {
    shadowRoot = props.container.shadowRoot
  }
  
  // 在 Shadow DOM 中创建容器
  const appContainer = document.createElement('div')
  appContainer.classList.add('opencode-micro-app')
  shadowRoot.appendChild(appContainer)
  
  // 动态加载 CSS 到 Shadow DOM
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = 'http://localhost:3000/assets/micro-app.css'
  shadowRoot.appendChild(link)

  // bridge URL 配置优先级:
  // 1. window.__OPENCODE_BRIDGE_URL__ (运行时覆盖)
  // 2. VITE_OPENCODE_SERVER_HOST + VITE_OPENCODE_SERVER_PORT (构建时环境变量)
  // 3. Icestark 环境: /opencode/api (通过主应用代理)
  // 4. 默认: http://localhost:4096
  const envHost = import.meta.env.VITE_OPENCODE_SERVER_HOST
  const envPort = import.meta.env.VITE_OPENCODE_SERVER_PORT
  
  let defaultBridgeUrl: string
  if (envHost && envPort) {
    // 使用构建时指定的环境变量
    defaultBridgeUrl = `http://${envHost}:${envPort}`
  } else if (isInIcestark()) {
    // Icestark 环境使用相对路径（需要主应用配置代理）
    defaultBridgeUrl = "/opencode/api"
  } else {
    // 默认本地开发
    defaultBridgeUrl = "http://localhost:4096"
  }
  
  const bridgeUrl = (globalThis as any).__OPENCODE_BRIDGE_URL__ ?? defaultBridgeUrl

  const server: ServerConnection.Http = {
    type: "http",
    http: { url: bridgeUrl },
  }

  dispose = render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface
            defaultServer={ServerConnection.Key.make(bridgeUrl)}
            servers={[server]}
            disableHealthCheck
          />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    appContainer,
  )
}

export function unmount() {
  if (dispose) {
    dispose()
    dispose = null
  }
  // 清理 Shadow DOM
  if (shadowRoot) {
    shadowRoot.innerHTML = ''
    shadowRoot = null
  }
}

if (!isInIcestark()) {
  const root = document.getElementById("root")
  if (root instanceof HTMLElement) {
    mount({ container: root })
  }
}
