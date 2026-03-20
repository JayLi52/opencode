#!/usr/bin/env bun
/**
 * Build and push bridge Docker image to Azure Container Registry (ACR)
 * 
 * Usage:
 *   bun scripts/build-bridge-acr.ts [options]
 * 
 * Options:
 *   --registry <url>        ACR registry URL (default: from env ACR_REGISTRY)
 *   --tag <tag>             Image tag (default: latest)
 *   --push                   Push to ACR after build
 *   --qwen-key <key>        Qwen API key (default: from env DASHSCOPE_API_KEY)
 *   --no-cache              Build without cache
 */

import { $ } from "bun"
import path from "node:path"
import fs from "node:fs/promises"

interface Options {
  registry: string
  tag: string
  push: boolean
  qwenKey: string
  noCache: boolean
}

async function parseArgs(): Promise<Options> {
  const args = process.argv.slice(2)
  const opts: Options = {
    registry: process.env.ACR_REGISTRY || "",
    tag: "latest",
    push: false,
    qwenKey: process.env.DASHSCOPE_API_KEY || "",
    noCache: false,
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--registry":
        opts.registry = args[++i]
        break
      case "--tag":
        opts.tag = args[++i]
        break
      case "--push":
        opts.push = true
        break
      case "--qwen-key":
        opts.qwenKey = args[++i]
        break
      case "--no-cache":
        opts.noCache = true
        break
    }
  }

  if (!opts.registry) {
    console.error("❌ Error: ACR registry URL not provided")
    console.error("   Set ACR_REGISTRY env var or use --registry flag")
    process.exit(1)
  }

  if (!opts.qwenKey) {
    console.warn("⚠️  Warning: Qwen API key not provided")
    console.warn("   Set DASHSCOPE_API_KEY env var or use --qwen-key flag")
  }

  return opts
}

async function buildDockerfile(opts: Options): Promise<string> {
  const dockerfile = `FROM node:20-slim

# 安装全局依赖
RUN npm install -g opencode-ai @qwen-code/qwen-code@latest

WORKDIR /app

# 复制 bridge 包
COPY packages/bridge .

# 安装依赖
RUN npm install

# 配置 Qwen（如果提供了 API key）
${
  opts.qwenKey
    ? `RUN mkdir -p ~/.qwen && \\
  echo 'DASHSCOPE_API_KEY=${opts.qwenKey}' > ~/.qwen/.env && \\
  cat > ~/.qwen/settings.json << 'EOF'
{
  "modelProviders": {
    "openai": [
      {
        "id": "qwen3-coder-plus",
        "name": "qwen3-coder-plus",
        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "description": "Qwen3-Coder via Dashscope",
        "envKey": "DASHSCOPE_API_KEY"
      }
    ]
  },
  "security": {
    "auth": {
      "selectedType": "openai"
    }
  },
  "model": {
    "name": "qwen3-coder-plus"
  }
}
EOF`
    : "# Qwen configuration skipped (no API key provided)"
}

# 暴露端口
EXPOSE 4096

# 环境变量配置
ENV BRIDGE_PORT=4096
ENV ACP_ENGINE=qwen-code
ENV WORK_DIR=/workspace
ENV NODE_ENV=production
${opts.qwenKey ? `ENV DASHSCOPE_API_KEY=${opts.qwenKey}` : ""}

# 创建工作目录
RUN mkdir -p /workspace

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \\
  CMD node -e "require('http').get('http://localhost:4096/global/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["npm", "start"]
`

  return dockerfile
}

async function build(opts: Options): Promise<void> {
  const root = import.meta.dir.replace(/scripts$/, "")
  const dockerfile = await buildDockerfile(opts)
  const dockerfilePath = path.join(root, "Dockerfile.bridge")

  console.log("📝 Writing Dockerfile...")
  await fs.writeFile(dockerfilePath, dockerfile)

  const imageName = `${opts.registry}/bridge:${opts.tag}`
  console.log(`🔨 Building image: ${imageName}`)

  const buildCmd = [
    "docker",
    "build",
    "-f",
    dockerfilePath,
    "-t",
    imageName,
    opts.noCache ? "--no-cache" : "",
    root,
  ]
    .filter(Boolean)
    .join(" ")

  try {
    await $`${buildCmd}`
    console.log(`✅ Image built successfully: ${imageName}`)
  } catch (err) {
    console.error("❌ Build failed:", err)
    process.exit(1)
  } finally {
    // 清理临时 Dockerfile
    await fs.rm(dockerfilePath).catch(() => {})
  }
}

async function push(opts: Options): Promise<void> {
  const imageName = `${opts.registry}/bridge:${opts.tag}`

  console.log(`📤 Pushing image to ACR: ${imageName}`)

  try {
    await $`docker push ${imageName}`
    console.log(`✅ Image pushed successfully: ${imageName}`)
  } catch (err) {
    console.error("❌ Push failed:", err)
    process.exit(1)
  }
}

async function main(): Promise<void> {
  const opts = await parseArgs()

  console.log("🚀 Bridge Docker Build & Push Script")
  console.log("=====================================")
  console.log(`Registry: ${opts.registry}`)
  console.log(`Tag: ${opts.tag}`)
  console.log(`Push: ${opts.push ? "Yes" : "No"}`)
  console.log(`Qwen Key: ${opts.qwenKey ? "***" : "Not provided"}`)
  console.log("")

  await build(opts)

  if (opts.push) {
    await push(opts)
  } else {
    console.log("💡 Tip: Use --push flag to push to ACR")
  }

  console.log("")
  console.log("✨ Done!")
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
