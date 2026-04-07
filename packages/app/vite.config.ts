import { defineConfig } from "vite"
import desktopPlugin from "./vite"

const isMicroApp = process.env.BUILD_MODE === "micro-app"

export default defineConfig({
  base: isMicroApp ? process.env.VITE_BASE_PATH ?? "/" : "/",
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.platform': JSON.stringify('browser'),
    'process.version': JSON.stringify('v18.0.0'),
  },
  plugins: [desktopPlugin] as any,
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
            formats: ["umd"],
            fileName: "index",
            name: "opencodeApp",
          },
          rollupOptions: {
            preserveEntrySignatures: "exports-only",
            output: {
              exports: "named",
              entryFileNames: 'index.js',
              chunkFileNames: '[name]-[hash].js',
              paths: (id) => {
                // 确保微应用内部模块引用使用正确的路径前缀
                if (id.startsWith('./') || id.startsWith('../')) {
                  const basePath = process.env.VITE_BASE_PATH?.replace(/\/$/, '') ?? ''
                  return `${basePath}/${id.replace(/^\.\//, '')}`
                }
                return id
              },
            },
          },
          cssCodeSplit: false,
        }
      : {
          rollupOptions: {
            input: "./index.html",
          },
        }),
  },
})
