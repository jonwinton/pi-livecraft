import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import {
  readWorkspaceFile,
  resolveWorkspaceFilePath,
  WorkspaceFileError,
} from '../server/workspace-file.ts'

test('reads a text file from the workspace and rejects its root', async () => {
  const path = await resolveWorkspaceFilePath(process.cwd(), 'package.json')
  const file = await readWorkspaceFile(process.cwd(), 'package.json')
  assert.equal(path, file.path)
  assert.equal(relative(process.cwd(), file.path), 'package.json')
  assert.match(file.content, /"name": "pi-livecraft"/)
  await assert.rejects(readWorkspaceFile(process.cwd(), '.'), (error: unknown) => {
    assert.equal(error instanceof WorkspaceFileError, true)
    assert.equal((error as WorkspaceFileError).status, 403)
    return true
  })
})

test('allows opening an absolute file outside the workspace without widening reads', async () => {
  const workspacePath = await realpath('src')
  const externalPath = await realpath('package.json')
  assert.equal(
    await resolveWorkspaceFilePath(workspacePath, externalPath, true),
    externalPath,
  )
  await assert.rejects(
    resolveWorkspaceFilePath(workspacePath, externalPath),
    (error: unknown) => {
      assert.equal(error instanceof WorkspaceFileError, true)
      assert.equal((error as WorkspaceFileError).status, 403)
      return true
    },
  )
})

test('reads a workspace file whose name starts with two dots but rejects parent paths', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-livecraft-file-')))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(workspace)
    await writeFile(join(workspace, '..notes.txt'), 'notes\n')
    await writeFile(join(root, 'secret.txt'), 'secret\n')
    assert.equal((await readWorkspaceFile(workspace, '..notes.txt')).content, 'notes\n')
    await assert.rejects(readWorkspaceFile(workspace, '../secret.txt'), { status: 403 })
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
