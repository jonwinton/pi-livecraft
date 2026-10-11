import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ISOLATED_AGENT_DIR, PiProcess } from './pi-process.ts'
import { assistantText, cheapestAvailableModel } from './prompt-improvement.ts'
import type { JsonObject } from '../shared/types.ts'
import { isObject } from '../shared/is-object.ts'

/** Matches the backend's longest isolated-prompt wait so a tool-using run is not cut short. */
const isolatedPromptTimeoutMs = 5 * 60_000

/**
 * Creates the dedicated isolated Pi profile directory and copies auth/models from the
 * user's main config so the isolated process can authenticate and list models without
 * sharing the default-settings write target. Copies are refreshed on every run because
 * OAuth tokens and API keys in the main profile change over time.
 */
export async function ensureIsolatedAgentDir(): Promise<void> {
  // The profile holds copied credentials: keep it owner-only even if it already existed.
  await mkdir(ISOLATED_AGENT_DIR, { recursive: true, mode: 0o700 })
  await chmod(ISOLATED_AGENT_DIR, 0o700)
  const mainDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
  await Promise.all(['auth.json', 'models.json'].map(async (file) => {
    const dest = join(ISOLATED_AGENT_DIR, file)
    // Rename makes the refresh atomic for a concurrent isolated Pi reading the same file.
    const temporary = `${dest}.${randomUUID()}.tmp`
    try {
      await copyFile(join(mainDir, file), temporary)
      await chmod(temporary, 0o600)
      await rename(temporary, dest)
    } catch (error) {
      await rm(temporary, { force: true })
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // The main profile has no such file (e.g. no custom models.json or logged out): mirror it.
      await rm(dest, { force: true })
    }
  }))
}

/** Configuration for an isolated, disposable Pi prompt execution. */
export interface RunIsolatedPromptOptions {
  /** Working directory for the Pi process. */
  cwd: string
  /** The prompt text to send (sent as-is to the model). */
  prompt: string
  /** System prompt for the disposable session (defaults to empty). */
  systemPrompt?: string
  /** Thinking level: 'off', 'low', 'medium', or 'high' (defaults to 'off'). */
  thinkingLevel?: string
  /** Model to use. When omitted, the cheapest available model is auto-selected. */
  model?: { provider: string; modelId: string }
  /** Extension paths to load. Omit to disable all extensions. */
  extensions?: string[]
  /** Tool names to load. Omit to disable all tools. */
  tools?: string[]
  /** Whether Pi loads AGENTS.md/CLAUDE.md from parent directories (default true). Set false to provide your own context. */
  includeContextFiles?: boolean
}

/** Result of running a prompt in an isolated Pi process. */
export interface IsolatedPromptResult {
  text: string
  /** USD cost of the isolated execution, if Pi exposes it. */
  cost?: number
}

/**
 * Runs a prompt in an isolated, disposable Pi process and returns the
 * assistant's text response with optional cost metadata.
 *
 * The process is terminated immediately after the response is extracted,
 * regardless of success or failure.
 */
export async function runIsolatedPrompt(
  options: RunIsolatedPromptOptions,
): Promise<IsolatedPromptResult> {
  await ensureIsolatedAgentDir()
  const pi = new PiProcess(options.cwd, randomUUID(), undefined, {
    isolated: true,
    systemPrompt: options.systemPrompt,
    thinkingLevel: options.thinkingLevel,
    extensions: options.extensions,
    tools: options.tools,
    includeContextFiles: options.includeContextFiles,
  })

  try {
    if (options.model) {
      await pi.request({
        type: 'set_model',
        provider: options.model.provider,
        modelId: options.model.modelId,
      })
    } else {
      const available = await pi.request({ type: 'get_available_models' })
      const cheapest = cheapestAvailableModel(available)
      if (!cheapest) throw new Error('No model is available to run the prompt')
      await pi.request({ type: 'set_model', provider: cheapest.provider, modelId: cheapest.id })
    }

    const settled = waitForPiEvent(pi, 'agent_settled')
    await Promise.all([
      pi.request({ type: 'prompt', message: options.prompt }, isolatedPromptTimeoutMs),
      settled,
    ])

    const text = assistantText(await pi.request({ type: 'get_messages' }))
    if (!text) throw new Error('The model returned no text')

    let cost: number | undefined
    try {
      const stats = await pi.request({ type: 'get_session_stats' })
      if (isObject(stats.data) && typeof stats.data.cost === 'number') cost = stats.data.cost
    } catch {
      // Stats unavailable on this Pi version; cost stays undefined.
    }

    return { text, cost }
  } finally {
    await pi.terminate()
  }
}
/** Waits for a terminal Pi event while bounding failures from a stalled disposable process. */
function waitForPiEvent(pi: PiProcess, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error(`Pi event timed out: ${type}`)),
      isolatedPromptTimeoutMs,
    )
    const onEvent = (event: JsonObject): void => {
      if (event.type === type) finish()
    }
    const onExit = (): void => finish(new Error('Pi exited before completing the prompt'))
    function finish(error?: Error): void {
      clearTimeout(timeout)
      pi.off('event', onEvent)
      pi.off('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    pi.on('event', onEvent)
    pi.once('exit', onExit)
  })
}
