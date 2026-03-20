/**
 * 测试 spawn 逻辑的脚本
 */

import { spawn } from "node:child_process"
import launch from "cross-spawn"

console.log("=== 测试 spawn 逻辑 ===\n")

// 1. 查找命令路径
console.log("1. 使用 cross-spawn 查找命令路径:")
const nodePath = launch.sync("which", ["node"]).stdout?.toString().trim()
const qwenPath = launch.sync("which", ["qwen"]).stdout?.toString().trim()

console.log("   node path:", nodePath)
console.log("   qwen path:", qwenPath)
console.log()

// 2. 测试不同的 spawn 方式
const testCases = [
  {
    name: "直接使用命令名 (shell: false)",
    command: "node",
    args: ["--version"],
    options: { shell: false },
  },
  {
    name: "直接使用命令名 (shell: true)",
    command: "node",
    args: ["--version"],
    options: { shell: true },
  },
  {
    name: "使用绝对路径 (shell: false)",
    command: nodePath || "node",
    args: ["--version"],
    options: { shell: false },
  },
  {
    name: "使用绝对路径 (shell: true)",
    command: nodePath || "node",
    args: ["--version"],
    options: { shell: true },
  },
  {
    name: "使用 cross-spawn (shell: false)",
    command: nodePath || "node",
    args: ["--version"],
    options: { shell: false },
    useCrossSpawn: true,
  },
  {
    name: "使用 cross-spawn (shell: true)",
    command: nodePath || "node",
    args: ["--version"],
    options: { shell: true },
    useCrossSpawn: true,
  },
]

async function runTest(testCase, index) {
  return new Promise((resolve) => {
    console.log(`${index + 1}. 测试：${testCase.name}`)
    console.log(`   Command: ${testCase.command}`)
    console.log(`   Args: ${testCase.args.join(" ")}`)
    console.log(`   Options: shell=${testCase.options.shell}, useCrossSpawn=${!!testCase.useCrossSpawn}`)

    const startTime = Date.now()
    let output = ""
    let error = null

    try {
      const proc = testCase.useCrossSpawn
        ? launch(testCase.command, testCase.args, testCase.options)
        : spawn(testCase.command, testCase.args, testCase.options)

      proc.stdout?.on("data", (data) => {
        output += data.toString()
      })

      proc.stderr?.on("data", (data) => {
        output += data.toString()
      })

      proc.on("error", (err) => {
        error = err
        console.log(`   ❌ Error: ${err.message}`)
        console.log(`   Code: ${err.code}`)
        console.log(`   Path: ${err.path}`)
        resolve({ success: false, error: err })
      })

      proc.on("exit", (code) => {
        const duration = Date.now() - startTime
        if (code === 0) {
          console.log(`   ✅ Success (${duration}ms): ${output.trim()}`)
          resolve({ success: true, output, duration })
        } else {
          console.log(`   ❌ Exit code: ${code}`)
          console.log(`   Output: ${output.trim()}`)
          resolve({ success: false, code, output, duration })
        }
      })
    } catch (err) {
      const duration = Date.now() - startTime
      console.log(`   ❌ Exception: ${err.message}`)
      resolve({ success: false, error: err, duration })
    }
  })
}

async function main() {
  for (let i = 0; i < testCases.length; i++) {
    await runTest(testCases[i], i)
    console.log()
  }

  // 测试 qwen 命令
  if (qwenPath) {
    console.log("=== 测试 qwen 命令 ===\n")
    
    const qwenTests = [
      {
        name: "直接执行 qwen (shell: false)",
        command: qwenPath,
        args: ["--version"],
        options: { shell: false },
      },
      {
        name: "使用 node 执行 qwen (shell: false)",
        command: nodePath || "node",
        args: [qwenPath, "--version"],
        options: { shell: false },
      },
      {
        name: "使用 node 执行 qwen (shell: true)",
        command: nodePath || "node",
        args: [qwenPath, "--version"],
        options: { shell: true },
      },
    ]

    for (let i = 0; i < qwenTests.length; i++) {
      await runTest(qwenTests[i], i)
      console.log()
    }
  } else {
    console.log("⚠️  未找到 qwen 命令，跳过 qwen 测试")
  }
}

main().catch(console.error)
