import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { WorkspaceFile } from '../shared/types.ts'

const maxWorkspaceFileSize = 2 * 1024 * 1024

export class WorkspaceFileError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** Resolves an existing file, optionally allowing a tool target outside the working directory. */
export async function resolveWorkspaceFilePath(
  workspacePath: string,
  requestedPath: string,
  allowOutsideWorkspace = false,
): Promise<string> {
  const root = await realpath(workspacePath)
  let path: string
  try {
    path = await realpath(resolve(root, requestedPath))
  } catch {
    throw new WorkspaceFileError('File does not exist', 404)
  }
  if (!allowOutsideWorkspace) {
    const pathFromRoot = relative(root, path)
    if (
      !pathFromRoot || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)
      || isAbsolute(pathFromRoot)
    )
      throw new WorkspaceFileError('File must be inside the working directory', 403)
  }

  if (!(await stat(path)).isFile()) throw new WorkspaceFileError('Path must be a file', 400)
  return path
}

/** Reads an existing text file within the working directory. */
export async function readWorkspaceFile(
  workspacePath: string,
  requestedPath: string,
): Promise<WorkspaceFile> {
  const path = await resolveWorkspaceFilePath(workspacePath, requestedPath)
  const file = await stat(path)
  if (file.size > maxWorkspaceFileSize) throw new WorkspaceFileError('File exceeds 2 MiB', 413)

  return { path, content: await readFile(path, 'utf8') }
}
