import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { RecentSession } from '../shared/types.ts'
import { isObject } from '../shared/is-object.ts'

const sessionDirectory = resolvePiSessionDirectory(process.env, homedir())

/** Resolves Pi's session storage using its configured profile before the default profile. */
export function resolvePiSessionDirectory(
  environment: { PI_CODING_AGENT_SESSION_DIR?: string; PI_CODING_AGENT_DIR?: string },
  homeDirectory: string,
): string {
  return environment.PI_CODING_AGENT_SESSION_DIR
    ?? (environment.PI_CODING_AGENT_DIR
      ? join(environment.PI_CODING_AGENT_DIR, 'sessions')
      : join(homeDirectory, '.pi', 'agent', 'sessions'))
}

interface PiSessionHeader {
  type: 'session'
  id: string
  timestamp: string
  cwd: string
}

const MAX_SESSIONS = 30
const CANDIDATE_BUFFER = 100
const HEAD_CHUNK_BYTES = 64 * 1024
const HEADER_PROBE_BYTES = 16 * 1024
const TAIL_CHUNK_BYTES = 64 * 1024
const TAIL_SCAN_BUDGET = 2 * 1024 * 1024

/** Reads only the metadata required to resume a Pi session. */
export async function listRecentPiSessions(
  cwd: string,
  directory = sessionDirectory,
): Promise<RecentSession[]> {
  const paths = await listSessionFiles(directory)
  // A file may disappear between listing and stat; skip it rather than fail the whole list.
  const files = (await Promise.all(paths.map(async (path) => {
    try {
      return [{ path, mtime: (await stat(path)).mtimeMs }]
    } catch {
      return []
    }
  })))
    .flat()
    .sort((a, b) => b.mtime - a.mtime)

  // Every workspace shares one store, so a workspace's sessions may be far down the newest list.
  // Match cheap headers in batches, and read full metadata only for this workspace's files.
  // Pi appends each message, so a file's activity is never newer than its mtime: once the list is
  // full and its last entry is at least as new as every unread file, no unread file can rank in.
  const sessions: RecentSession[] = []
  for (let index = 0; index < files.length; index += CANDIDATE_BUFFER) {
    if ((sessions[MAX_SESSIONS - 1]?.updatedAt ?? -Infinity) >= files[index].mtime) break
    const batch = files.slice(index, index + CANDIDATE_BUFFER)
    const cwds = await Promise.all(batch.map(({ path }) => readHeaderCwd(path)))
    const matches = await Promise.all(
      batch.flatMap(({ path, mtime }, batchIndex) =>
        cwds[batchIndex] === cwd ? [readPiSession(path, mtime)] : []
      ),
    )
    sessions.push(...matches.filter((session): session is RecentSession => session?.cwd === cwd))
    sessions.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  return sessions.slice(0, MAX_SESSIONS)
}

/** Verifies that a file belongs to the Pi session directory before loading its metadata. */
export async function loadPiSession(path: string): Promise<RecentSession> {
  const [canonicalPath, canonicalDirectory] = await Promise.all([
    realpath(path),
    realpath(sessionDirectory),
  ])
  const relativePath = relative(canonicalDirectory, canonicalPath)
  if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
    throw new Error('Pi session file must be stored in the Pi session directory')
  const session = await readPiSession(canonicalPath, (await stat(canonicalPath)).mtimeMs)
  if (!session) throw new Error('Invalid Pi session file')
  return session
}

/** Recursively scans Pi storage while retaining only session JSONL files. */
async function listSessionFiles(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }

  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listSessionFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

/** Extracts a session's identity, name, and latest activity without loading its full history. */
async function readPiSession(path: string, updatedAt: number): Promise<RecentSession | null> {
  let canonicalPath: string
  try {
    canonicalPath = await realpath(path)
  } catch {
    return null
  }
  let lines: string[]
  try {
    lines = await readSessionLines(canonicalPath)
  } catch {
    return null
  }

  const header = parseHeader(lines[0])
  if (!header) return null
  let cwd: string
  try {
    cwd = await realpath(header.cwd)
  } catch {
    return null
  }
  let hasMessage = false
  let name: string | undefined
  let prompt: string | undefined
  let lastMessageAt: number | undefined
  for (let index = 1; index < lines.length; index += 1) {
    const value = parseLine(lines[index])
    if (!value) continue
    if (value.type === 'session_info' && typeof value.name === 'string' && value.name.trim()) {
      name = value.name.trim()
      continue
    }
    if (value.type !== 'message') continue
    hasMessage = true
    if (typeof value.timestamp === 'string') {
      const timestamp = Date.parse(value.timestamp)
      if (!Number.isNaN(timestamp) && (lastMessageAt === undefined || timestamp > lastMessageAt))
        lastMessageAt = timestamp
    }
    if (prompt === undefined && isObject(value.message) && value.message.role === 'user') {
      const content = textContent(value.message.content)
      if (content && !content.startsWith('/')) prompt = shortenPrompt(content)
    }
  }
  if (!hasMessage) return null
  const createdAt = Date.parse(header.timestamp)
  return {
    id: header.id,
    cwd,
    name: name || prompt || 'New session',
    sessionPath: canonicalPath,
    updatedAt: lastMessageAt ?? (Number.isNaN(createdAt) ? updatedAt : createdAt),
  }
}

/** Reads only the head and the newest entries of a session file instead of its full history:
 *  the header, name, and first prompt live near the start, and the newest activity at the end.
 *  Gigabytes of middle history never need to be parsed to render the recent-session list.
 *  A single entry may itself be huge (tool outputs), so the end is scanned backward in chunks
 *  until a complete JSON line is found rather than assuming a fixed tail fits. */
async function readSessionLines(path: string): Promise<string[]> {
  const size = (await stat(path)).size
  if (size <= HEAD_CHUNK_BYTES + TAIL_CHUNK_BYTES) return (await readFile(path, 'utf8')).split('\n')
  let handle: FileHandle | undefined
  try {
    handle = await open(path, 'r')
    const head = Buffer.alloc(HEAD_CHUNK_BYTES)
    const { bytesRead: headBytes } = await handle.read(head, 0, HEAD_CHUNK_BYTES, 0)
    let tail = ''
    let position = size
    let scanned = 0
    while (position > HEAD_CHUNK_BYTES && scanned < TAIL_SCAN_BUDGET && !hasParseableLine(tail)) {
      const chunkSize = Math.min(TAIL_CHUNK_BYTES, position - HEAD_CHUNK_BYTES)
      position -= chunkSize
      const chunk = Buffer.alloc(chunkSize)
      const { bytesRead } = await handle.read(chunk, 0, chunkSize, position)
      tail = chunk.subarray(0, bytesRead).toString('utf8') + tail
      scanned += chunkSize
    }
    const headText = head.subarray(0, headBytes).toString('utf8')
    // Joining non-adjacent regions would glue the head's cut-off line onto the tail's first line.
    return position === HEAD_CHUNK_BYTES
      ? (headText + tail).split('\n')
      : [...headText.split('\n'), ...tail.split('\n')]
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Reads only the header line to learn which canonical workspace a session belongs to. */
async function readHeaderCwd(path: string): Promise<string | null> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(HEADER_PROBE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEADER_PROBE_BYTES, 0)
    const header = parseHeader(buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0])
    return header ? await realpath(header.cwd) : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** True when the accumulated text contains at least one complete JSON line. */
function hasParseableLine(text: string): boolean {
  return text.split('\n').some((line) => parseLine(line) !== null)
}

function parseHeader(line: string | undefined): PiSessionHeader | null {
  const value = parseLine(line)
  if (
    !value || value.type !== 'session' || typeof value.id !== 'string'
    || typeof value.timestamp !== 'string' || typeof value.cwd !== 'string'
  ) return null
  return { type: 'session', id: value.id, timestamp: value.timestamp, cwd: value.cwd }
}

function parseLine(line: string | undefined): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line ?? '')
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

function textContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter((part): part is Record<string, unknown> =>
      isObject(part) && part.type === 'text' && typeof part.text === 'string'
    )
    .map((part) => part.text)
    .join(' ')
    .trim()
  return text || undefined
}

function shortenPrompt(prompt: string): string {
  const words = prompt.split(/\s+/)
  return words.length > 8 ? `${words.slice(0, 8).join(' ')}…` : prompt
}
function isNotFound(error: unknown): boolean {
  return isObject(error) && error.code === 'ENOENT'
}
