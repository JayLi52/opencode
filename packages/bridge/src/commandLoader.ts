/**
 * commandLoader.ts — 加载命令/技能模板
 *
 * 扫描路径：
 *   1. 用户工作目录: <directory>/.opencode/commands/   (命令)
 *   2. 用户工作目录: <directory>/.opencode/skills/     (用户自定义技能，优先级高)
 *   3. bridge 安装目录: <bridge>/skills/               (产品内置技能)
 */

import { readdir, readFile } from "node:fs/promises"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// bridge 安装目录（commandLoader.ts 所在目录的上一级，即 packages/bridge/）
const __dirname = dirname(fileURLToPath(import.meta.url))
const BRIDGE_ROOT = resolve(__dirname, "..")

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

  // 加载 skills：用户目录优先，然后 bridge 内置目录
  const skillSearchPaths = [
    join(directory, ".opencode", "skills"),  // 用户自定义（优先）
    join(BRIDGE_ROOT, "skills"),             // bridge 内置
  ]

  for (const skillsDir of skillSearchPaths) {
    try {
      const entries = await readdir(skillsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        // 同名 skill 跳过（用户目录先扫描，所以用户的优先）
        if (commands.some((c) => c.name === entry.name)) continue

        const skillFile = join(skillsDir, entry.name, "SKILL.md")
        try {
          const content = await readFile(skillFile, "utf-8")

          // 加载 references/ 目录下的所有 .md 文件，拼接到 template 后面
          const skillDir = join(skillsDir, entry.name)
          const refsContent = await loadSkillReferences(skillDir)
          const fullTemplate = refsContent
            ? `${content}\n\n---\n\n# 参考文档\n\n${refsContent}`
            : content

          commands.push({
            name: entry.name,
            description: content.split("\n")[0]?.replace(/^#\s*/, "") || entry.name,
            template: fullTemplate,
            source: "skill",
          })
        } catch {
          // SKILL.md 不存在，忽略
        }
      }
    } catch {
      // 目录不存在，忽略
    }
  }

  return commands
}

/**
 * 加载 skill 目录下 references/ 中的所有 .md 文件，拼接为一个字符串
 */
async function loadSkillReferences(skillDir: string): Promise<string> {
  const refsDir = join(skillDir, "references")
  try {
    const files = await readdir(refsDir)
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort()
    if (mdFiles.length === 0) return ""

    const parts: string[] = []
    for (const file of mdFiles) {
      const content = await readFile(join(refsDir, file), "utf-8")
      parts.push(content.trim())
    }
    return parts.join("\n\n---\n\n")
  } catch {
    return ""
  }
}

/**
 * 渲染命令模板
 * 替换 {{args}} 等变量
 */
export async function renderTemplate(template: string, args: string, cwd: string): Promise<string> {
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
