import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, utimes, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir as osTmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'
import { listRecentPiSessions, resolvePiSessionDirectory } from '../server/pi-session-store.ts'

// macOS exposes the temporary directory through a symlink; compare canonical paths.
const tmpdir = (): string => realpathSync(osTmpdir())

async function fixture(): Promise<{ directory: string; workspace: string }> {
  return {
    directory: await mkdtemp(join(tmpdir(), 'pi-sessions-')),
    workspace: await mkdtemp(join(tmpdir(), 'pi-workspace-')),
  }
}

test('resolves Pi session storage with Pi environment precedence', () => {
  const homeDirectory = join('home', 'user')
  const agentDirectory = join('infrastructure', '.pi', 'agent')
  const sessionDirectory = join('custom', 'sessions')

  assert.equal(
    resolvePiSessionDirectory({
      PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
      PI_CODING_AGENT_DIR: agentDirectory,
    }, homeDirectory),
    sessionDirectory,
  )
  assert.equal(
    resolvePiSessionDirectory({ PI_CODING_AGENT_DIR: agentDirectory }, homeDirectory),
    join(agentDirectory, 'sessions'),
  )
  assert.equal(
    resolvePiSessionDirectory({}, homeDirectory),
    join(homeDirectory, '.pi', 'agent', 'sessions'),
  )
})

test('sorts canonical Pi sessions by their last message timestamp', async () => {
  const { directory, workspace } = await fixture()
  const sessions = join(directory, 'project')
  await mkdir(sessions)
  await writeSession(
    join(sessions, 'older.jsonl'),
    `${workspace}${sep}`,
    'older',
    'Older session',
    undefined,
    '2026-07-19T11:00:00.000Z',
  )
  await writeSession(
    join(sessions, 'newer.jsonl'),
    workspace,
    'newer',
    'Newer session',
    'Renamed session',
  )
  const recent = await listRecentPiSessions(workspace, directory)
  assert.deepEqual(recent.map(({ id, name, cwd }) => ({ id, name, cwd })), [
    { id: 'older', name: 'Older session', cwd: workspace },
    { id: 'newer', name: 'Renamed session', cwd: workspace },
  ])
  assert.deepEqual(recent.map(({ sessionPath }) => sessionPath), [
    await realpath(join(sessions, 'older.jsonl')),
    await realpath(join(sessions, 'newer.jsonl')),
  ])
})

test('returns every session in the canonical working directory and omits stale cwd records', async () => {
  const { directory, workspace } = await fixture()
  await Promise.all(
    Array.from({ length: 11 }, (_, index) =>
      writeSession(
        join(directory, `${index}.jsonl`),
        workspace,
        String(index),
        `Session ${index}`,
      )),
  )
  await writeSession(join(directory, 'stale.jsonl'), join(directory, 'missing'), 'stale', 'Stale')
  assert.equal((await listRecentPiSessions(workspace, directory)).length, 11)
})

test('uses the first non-command user prompt and hides sessions without messages', async () => {
  const { directory, workspace } = await fixture()
  await writeFile(
    join(directory, 'unnamed.jsonl'),
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'unnamed',
        timestamp: '2026-07-19T10:00:00.000Z',
        cwd: workspace,
      }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: '/agent' } }),
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: 'One two three four five six seven eight nine' },
      }),
    ]
      .join('\n'),
  )
  await writeFile(
    join(directory, 'empty.jsonl'),
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'empty',
        timestamp: '2026-07-19T10:00:00.000Z',
        cwd: workspace,
      }),
      JSON.stringify({ type: 'session_info', name: 'New session' }),
    ]
      .join('\n'),
  )
  const recent = await listRecentPiSessions(workspace, directory)
  assert.equal(recent.length, 1)
  assert.equal(recent[0].name, 'One two three four five six seven eight…')
})

test('reads the newest entry of a large session file even when it exceeds one tail chunk', async () => {
  const { directory, workspace } = await fixture()
  // Middle history large enough that the head+tail path is taken and real bytes are skipped.
  const padding = JSON.stringify({
    type: 'message',
    timestamp: '2026-07-19T10:00:00.000Z',
    message: { role: 'assistant', content: 'x'.repeat(150 * 1024) },
  })
  // The final record is larger than one 64 KiB tail chunk: the backward scan must keep going
  // past the first chunk to capture its start, otherwise the newest entry would be dropped.
  const finalEntry = JSON.stringify({
    type: 'message',
    timestamp: '2026-07-19T11:00:00.000Z',
    message: { role: 'user', content: 'y'.repeat(70 * 1024) },
  })
  await writeFile(
    join(directory, 'big.jsonl'),
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'big',
        timestamp: '2026-07-19T09:00:00.000Z',
        cwd: workspace,
      }),
      JSON.stringify({ type: 'session_info', name: 'Big session' }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-07-19T09:00:00.000Z',
        message: { role: 'user', content: 'first prompt' },
      }),
      padding,
      finalEntry,
    ]
      .join('\n') + '\n',
  )
  const recent = await listRecentPiSessions(workspace, directory)
  assert.equal(recent.length, 1)
  assert.equal(recent[0].name, 'Big session')
  // updatedAt reflects the final entry's timestamp; if it were ignored, this would fall back to 09:00.
  assert.equal(recent[0].updatedAt, Date.parse('2026-07-19T11:00:00.000Z'))
})

test('finds a workspace session behind more than one batch of newer sessions elsewhere', async () => {
  const { directory, workspace } = await fixture()
  const other = await mkdtemp(join(tmpdir(), 'pi-other-workspace-'))
  await writeSession(join(directory, 'target.jsonl'), workspace, 'target', 'Target session')
  await utimes(join(directory, 'target.jsonl'), new Date(0), new Date(0))
  for (let index = 0; index < 101; index += 1) {
    await writeSession(join(directory, `other-${index}.jsonl`), other, `other-${index}`, 'Other')
  }

  const recent = await listRecentPiSessions(workspace, directory)
  assert.deepEqual(recent.map(({ id }) => id), ['target'])
})

test('keeps the newest message activity when renamed sessions have newer file times', async () => {
  const { directory, workspace } = await fixture()
  const other = await mkdtemp(join(tmpdir(), 'pi-other-workspace-'))
  const renamedAt = new Date('2026-07-20T12:00:00.000Z')
  for (let index = 0; index < 100; index += 1) {
    const path = join(directory, `renamed-${index}.jsonl`)
    // Renaming appends session info, so these files are newest on disk with old messages.
    await writeSession(path, index < 30 ? workspace : other, `renamed-${index}`, 'Old')
    await utimes(path, renamedAt, renamedAt)
  }
  const activePath = join(directory, 'active.jsonl')
  await writeSession(
    activePath,
    workspace,
    'active',
    'Active',
    undefined,
    '2026-07-19T23:00:00.000Z',
  )
  const activeAt = new Date('2026-07-19T23:00:00.000Z')
  await utimes(activePath, activeAt, activeAt)

  const recent = await listRecentPiSessions(workspace, directory)
  assert.equal(recent.length, 30)
  assert.equal(recent[0].id, 'active')
})

async function writeSession(
  path: string,
  cwd: string,
  id: string,
  name: string,
  renamedName?: string,
  lastMessageTimestamp?: string,
): Promise<void> {
  const timestamp = id === 'newer' ? '2026-07-19T10:00:00.000Z' : '2026-07-19T09:00:00.000Z'
  await writeFile(
    path,
    [
      JSON.stringify({ type: 'session', version: 3, id, timestamp, cwd }),
      JSON.stringify({ type: 'session_info', name }),
      JSON.stringify({
        type: 'message',
        timestamp: lastMessageTimestamp ?? timestamp,
        message: { role: 'user', content: name },
      }),
      ...(renamedName ? [JSON.stringify({ type: 'session_info', name: renamedName })] : []),
    ]
      .join('\n'),
  )
}
