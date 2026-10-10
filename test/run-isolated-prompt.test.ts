import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('refreshes isolated credentials from the main Pi profile on every run', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'pi-isolated-home-'))
  const mainDir = join(home, 'main-agent')
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  }
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(home, { force: true, recursive: true })
  })
  // ISOLATED_AGENT_DIR is derived from the home directory when the module loads.
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.PI_CODING_AGENT_DIR = mainDir
  const { ensureIsolatedAgentDir } = await import('../server/run-isolated-prompt.ts')
  const isolatedDir = join(home, '.pi', 'livecraft-isolated')

  await mkdir(mainDir, { recursive: true })
  await writeFile(join(mainDir, 'auth.json'), '{"token":"old"}')
  await writeFile(join(mainDir, 'models.json'), '{}')
  await ensureIsolatedAgentDir()
  await writeFile(join(mainDir, 'auth.json'), '{"token":"rotated"}')
  await rm(join(mainDir, 'models.json'))
  await ensureIsolatedAgentDir()

  assert.equal(await readFile(join(isolatedDir, 'auth.json'), 'utf8'), '{"token":"rotated"}')
  await assert.rejects(readFile(join(isolatedDir, 'models.json')), { code: 'ENOENT' })
})
