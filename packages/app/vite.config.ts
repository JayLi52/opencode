import { defineConfig } from "vite"
import desktopPlugin from "./vite"

const isMicroApp = process.env.BUILD_MODE === "micro-app"

export default defineConfig({
  base: isMicroApp ? "http://localhost:3000/" : "/",
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
                if (id.startsWith('./') || id.startsWith('../')) {
                  return `http://localhost:3000/${id.replace(/^\.\//, '')}`
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
