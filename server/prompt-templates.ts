import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject, PromptTemplate } from '../shared/types.ts'
import { isObject } from '../shared/is-object.ts'

/**
 * Loads the bodies of prompt templates Pi reports for the active session.
 * Pi remains the source of discovery; unreadable templates are omitted so a stale path cannot fail
 * a session snapshot.
 */
export async function loadPromptTemplates(commands: JsonObject[]): Promise<PromptTemplate[]> {
  const templates = commands.flatMap((command) => {
    if (command.source !== 'prompt' || typeof command.name !== 'string') return []
    const path = promptTemplatePath(command)
    return path
      ? [{
        name: command.name,
        path,
        description: typeof command.description === 'string' ? command.description : undefined,
      }]
      : []
  })
  const contents = await Promise.all(templates.map(async (template) => {
    try {
      return {
        name: template.name,
        content: stripPromptFrontmatter(await readFile(template.path, 'utf8')),
        description: template.description,
      }
    } catch {
      return null
    }
  }))
  return contents.filter((template) => template !== null)
}

/** Saves a draft in Pi's project or user prompt-template directory without replacing a template. */
export async function savePromptTemplate(
  cwd: string,
  scope: 'global' | 'project',
  name: string,
  content: string,
): Promise<PromptTemplate> {
  const directory = scope === 'project'
    ? join(cwd, '.pi', 'prompts')
    : join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'prompts')
  // A repository can ship `.pi` as a symlink; following it would write outside the workspace.
  if (scope === 'project') {
    for (const path of [join(cwd, '.pi'), directory]) {
      if ((await lstat(path).catch(() => null))?.isSymbolicLink())
        throw new Error('Project prompts must be stored inside the working directory')
    }
  }
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${name}.md`), content, { encoding: 'utf8', flag: 'wx' })
  return { name, content, description: firstNonEmptyLine(content) }
}

/** Uses Pi's description fallback for a newly saved template. */
function firstNonEmptyLine(content: string): string | undefined {
  return content.split(/\r?\n/).find((line) => line.trim())?.trim()
}

/** Returns the template path from both current and legacy Pi command response shapes. */
function promptTemplatePath(command: JsonObject): string | null {
  if (typeof command.path === 'string') return command.path
  return isObject(command.sourceInfo) && typeof command.sourceInfo.path === 'string'
    ? command.sourceInfo.path
    : null
}

/** Removes optional YAML frontmatter, which Pi uses for template metadata rather than prompt text. */
export function stripPromptFrontmatter(template: string): string {
  if (!template.startsWith('---\n') && !template.startsWith('---\r\n')) return template
  const firstLineEnd = template.indexOf('\n') + 1
  const closing = /^(---|\.\.\.)\r?\n/m.exec(template.slice(firstLineEnd))
  return closing ? template.slice(firstLineEnd + closing.index + closing[0].length) : template
}
