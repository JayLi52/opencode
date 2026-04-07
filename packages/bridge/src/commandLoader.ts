/**
 * commandLoader.ts — 加载命令/技能模板
 */

import { readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

export interface CommandInfo {
  name: string
  description?: string
  template: string
  source: "command" | "skill"
}

/**
 * 加载目录下的命令和技能
 */
export async function loadCommands(directory: string): Promise<CommandInfo[]> {
  const commands: CommandInfo[] = []
  
  // 尝试加载 .opencode/commands 目录
  const commandsDir = join(directory, ".opencode", "commands")
  try {
    const entries = await readdir(commandsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const filePath = join(commandsDir, entry.name)
        const content = await readFile(filePath, "utf-8")
        const name = entry.name.replace(".md", "")
        commands.push({
          name,
          description: content.split("\n")[0]?.replace(/^#\s*/, "") || name,
          template: content,
          source: "command",
        })
      }
    }
  } catch {
    // 目录不存在，忽略
  }
  
  // 尝试加载 .opencode/skills 目录
  const skillsDir = join(directory, ".opencode", "skills")
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillFile = join(skillsDir, entry.name, "SKILL.md")
        try {
          const content = await readFile(skillFile, "utf-8")
          commands.push({
            name: entry.name,
            description: content.split("\n")[0]?.replace(/^#\s*/, "") || entry.name,
            template: content,
            source: "skill",
          })
        } catch {
          // SKILL.md 不存在，忽略
        }
      }
    }
  } catch {
    // 目录不存在，忽略
  }
  
  return commands
}

/**
 * 渲染命令模板
 * 替换 {{args}} 等变量
 */
export async function renderTemplate(template: string, args: string, cwd: string): Promise<string> {
  // 简单变量替换
  let rendered = template
    .replace(/\{\{args\}\}/g, args)
    .replace(/\{\{cwd\}\}/g, cwd)
  
  // 执行 shell 命令替换 {{shell:cmd}}
  const shellMatches = rendered.match(/\{\{shell:([^}]+)\}\}/g)
  if (shellMatches) {
    for (const match of shellMatches) {
      const cmd = match.replace(/\{\{shell:|\}\}/g, "")
      try {
        const { execSync } = await import("node:child_process")
        const result = execSync(cmd, { cwd, encoding: "utf-8" }).trim()
        rendered = rendered.replace(match, result)
      } catch {
        rendered = rendered.replace(match, `[shell error: ${cmd}]`)
      }
    }
  }
  
  return rendered
}