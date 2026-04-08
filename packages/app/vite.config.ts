import { defineConfig } from "vite"
import desktopPlugin from "./vite"
import { visualizer } from "rollup-plugin-visualizer"

const isMicroApp = process.env.BUILD_MODE === "micro-app"

export default defineConfig({
  base: isMicroApp ? process.env.VITE_BASE_PATH ?? "/" : "/",
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.platform': JSON.stringify('browser'),
    'process.version': JSON.stringify('v18.0.0'),
  },
  plugins: [
    desktopPlugin,
    ...(isMicroApp && process.env.ANALYZE === 'true'
      ? [visualizer({
          open: true,
          filename: 'dist/stats.html',
          gzipSize: true,
          brotliSize: true,
        })]
      : [])
  ] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
    cors: true,
  },
  build: {
    target: "esnext",
    ...(isMicroApp
      ? {
          lib: {
            entry: "./src/micro-app.tsx",
            formats: ["es"],
            fileName: () => 'index.js',
          },
          rollupOptions: {
            preserveEntrySignatures: "exports-only",
            output: {
              format: 'es',
              exports: "named",
              entryFileNames: 'index.js',
              chunkFileNames: 'chunks/[name]-[hash].js',
              assetFileNames: (assetInfo) => {
                // CSS 文件固定名称，不带 hash
                if (assetInfo.name.endsWith('.css')) {
                  return 'assets/micro-app.css'
                }
                return 'assets/[name]-[hash].[ext]'
              },
              // 提升传递性导入到入口 chunk，优化加载顺序
              hoistTransitiveImports: true,
              paths: (id) => {
                // 对于相对路径的 chunks，使用绝对 URL
                if (id.startsWith('./') || id.startsWith('../')) {
                  const microAppUrl = process.env.MICRO_APP_URL ?? 'http://localhost:3000'
                  const cleanPath = id.replace(/^\.\//, '').replace(/^\.\.\//, '')
                  return `${microAppUrl}/${cleanPath}`
                }
                return id
              },
              manualChunks: (id) => {
                // 简化分块策略，避免循环依赖
                if (id.includes('node_modules')) {
                  // Shiki 独立（最大且无依赖问题）
                  if (id.includes('shiki') || id.includes('@shikijs')) return 'vendor-shiki'
                  // 其他所有 vendor 合并到一个 chunk
                  return 'vendor'
                }
              },
            },
          },
          cssCodeSplit: true,
          minify: 'terser',
          terserOptions: {
            compress: {
              drop_console: true,
              drop_debugger: true,
            },
          },
        }
      : {
          rollupOptions: {
            input: "./index.html",
          },
        }),
  },
})
