import { useCallback, useEffect, useRef, useState } from 'react'
import { Tooltip } from '../../components/Tooltip.tsx'
import type {
  GitFileDiff,
  GitPushResult,
  GitResetResult,
  GitRevertResult,
  GitSnapshot,
} from '../../../shared/types.ts'
import { resolveFileIcon } from '../../../shared/file-icon.ts'
import { WidgetLayout } from '../right-sidebar/WidgetLayout.tsx'
import { parseGitDiff } from './git-diff.ts'

/** Local git-error target — which element to shake on failure. */
type ErrorTarget = 'push' | 'commit' | 'discard' | 'refresh'

/** Owns Git-specific selection, actions, and diff rendering inside the sidebar. */
export function GitWidget(
  { snapshot, onCommit, onDiscard, onFileSelect, onPush, onRefresh, onReset, onRevert }: {
    snapshot: GitSnapshot
    onCommit: (message: string) => Promise<void>
    onDiscard: (path?: string) => Promise<void>
    onFileSelect: (path: string, commitHash?: string) => Promise<GitFileDiff>
    onPush: () => Promise<GitPushResult>
    onRefresh: () => Promise<void>
    onReset: (hash: string) => Promise<GitResetResult>
    onRevert: (hash: string) => Promise<GitRevertResult>
  },
) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [fileDiff, setFileDiff] = useState<GitFileDiff | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [exitingCommits, setExitingCommits] = useState<ReadonlySet<string>>(new Set())
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [errorTarget, setErrorTarget] = useState<ErrorTarget | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** Identifies the latest diff request; selecting again or going Back makes older responses stale. */
  const diffRequestRef = useRef(0)
  const hasChanges = snapshot.files.length > 0

  /** Clears any stuck error highlight after the shake animation ends. */
  useEffect(() => {
    if (!errorTarget) return
    clearTimeout(errorTimerRef.current)
    errorTimerRef.current = setTimeout(() => setErrorTarget(null), 500)
    return () => clearTimeout(errorTimerRef.current)
  }, [errorTarget])

  /** Clears the current Git error so the next action can report independently. */
  const clearError = useCallback(() => {
    setErrorMessage(null)
    setErrorTarget(null)
  }, [])

  /** Reports a failed Git action inside the widget and highlights its control when available. */
  function reportError(error: unknown, target?: ErrorTarget): void {
    setErrorMessage(error instanceof Error ? error.message : 'Git command failed.')
    setErrorTarget(target ?? null)
  }

  /** Loads the requested diff before replacing the widget's file list. */
  async function selectFile(path: string, commitHash?: string): Promise<void> {
    clearError()
    setSelectedPath(path)
    const request = ++diffRequestRef.current
    try {
      const diff = await onFileSelect(path, commitHash)
      if (request === diffRequestRef.current) setFileDiff(diff)
    } catch (error) {
      if (request !== diffRequestRef.current) return
      setSelectedPath(null)
      reportError(error)
    }
  }

  /** Commits all changes with the current message, then refreshes. */
  async function commit(): Promise<void> {
    setBusy(true)
    clearError()
    try {
      await onCommit(message)
      setMessage('')
      await onRefresh()
    } catch (error) {
      reportError(error, 'commit')
    } finally {
      setBusy(false)
    }
  }

  /** Pushes commits ahead of the tracked branch, fading them out before refresh. */
  async function push(): Promise<void> {
    setBusy(true)
    clearError()
    try {
      const result = await onPush()
      if (result.pushError) throw new Error(result.pushError)
      // ponytail: fade all then refresh; per-commit fade not worth the wiring
      setExitingCommits(new Set(snapshot.commits.map((c) => c.hash)))
      await new Promise((r) => setTimeout(r, 300))
      await onRefresh()
      setExitingCommits(new Set())
    } catch (error) {
      reportError(error, 'push')
    } finally {
      setBusy(false)
    }
  }

  /** Discards one file or all uncommitted changes after confirmation, then refreshes. */
  async function discard(path?: string): Promise<void> {
    const target = path ? `changes to ${path}` : 'all uncommitted changes'
    if (!window.confirm(`Discard ${target}? This will delete new files and revert modifications.`))
      return
    setBusy(true)
    clearError()
    try {
      await onDiscard(path)
      await onRefresh()
    } catch (error) {
      reportError(error, 'discard')
    } finally {
      setBusy(false)
    }
  }

  /** Resets the latest commit after confirming that its changes stay local, fading its row before refresh. */
  async function resetCommit(hash: string): Promise<void> {
    if (
      !window.confirm(
        `Reset latest commit ${hash.slice(0, 7)}? Its changes will be kept in the working tree.`,
      )
    ) return
    setBusy(true)
    clearError()
    try {
      await onReset(hash)
      setExitingCommits(new Set([hash]))
      await new Promise((r) => setTimeout(r, 300))
      await onRefresh()
      setExitingCommits(new Set())
    } catch (error) {
      reportError(error, 'commit')
    } finally {
      setBusy(false)
    }
  }

  /** Reverts the chosen commit after confirmation, then refreshes so the new revert commit appears. */
  async function revertCommit(hash: string): Promise<void> {
    if (!window.confirm(`Revert commit ${hash.slice(0, 7)}?`)) return
    setBusy(true)
    clearError()
    try {
      await onRevert(hash)
      await onRefresh()
    } catch (error) {
      reportError(error, 'commit')
    } finally {
      setBusy(false)
    }
  }

  /** Manual Git refresh with local error handling. */
  async function handleRefresh(): Promise<void> {
    clearError()
    try {
      await onRefresh()
    } catch (error) {
      reportError(error, 'refresh')
    }
  }

  return (
    <WidgetLayout
      footer={!selectedPath && (
        <form
          className='git-actions'
          onSubmit={(event) => {
            event.preventDefault()
            void commit()
          }}
        >
          <input
            aria-label='Commit message'
            disabled={busy}
            onChange={(event) => setMessage(event.target.value)}
            placeholder='Commit message'
            value={message}
          />
          <div className='git-action-buttons'>
            <button
              className={errorTarget === 'commit' ? 'shake' : ''}
              disabled={busy || !hasChanges || !message.trim()}
              type='submit'
            >
              Commit
            </button>
            <button
              className={errorTarget === 'push' ? 'shake' : ''}
              disabled={busy || snapshot.ahead === 0}
              onClick={() => void push()}
              type='button'
            >
              Push{snapshot.ahead > 0 ? ` ${snapshot.ahead}` : ''}
            </button>
            <button
              className={`git-discard${errorTarget === 'discard' ? ' shake' : ''}`}
              disabled={busy || !hasChanges}
              onClick={() => void discard()}
              type='button'
            >
              Reset
            </button>
          </div>
        </form>
      )}
      header={fileDiff || selectedPath
        ? (
          <>
            <Tooltip label='Back'>
              <button
                aria-label='Back to Git files'
                className='git-back'
                onClick={() => {
                  diffRequestRef.current += 1
                  setFileDiff(null)
                  setSelectedPath(null)
                }}
                type='button'
              >
                ←
              </button>
            </Tooltip>
            <Tooltip label={selectedPath ?? ''}>
              <strong>{selectedPath}</strong>
            </Tooltip>
          </>
        )
        : (
          <>
            <div>
              <strong>{snapshot.branch}</strong>
              <span>
                {hasChanges
                  ? `${snapshot.files.length} file${snapshot.files.length > 1 ? 's' : ''} modified`
                  : 'Clean tree'}
              </span>
            </div>
            <Tooltip label='Refresh'>
              <button
                aria-label='Refresh Git state'
                className={`git-refresh${errorTarget === 'refresh' ? ' shake' : ''}`}
                onClick={() => void handleRefresh()}
                type='button'
              >
                ↻
              </button>
            </Tooltip>
          </>
        )}
    >
      {errorMessage && <p className='git-error' role='alert'>{errorMessage}</p>}
      {fileDiff || selectedPath
        ? fileDiff ? <GitDiff diff={fileDiff.diff} /> : <p className='git-empty'>Loading diff…</p>
        : (
          <>
            {hasChanges && (
              <ul className='git-file-list'>
                {snapshot.files.map((file) => (
                  <li className='git-file-item' key={file.path}>
                    {file.status === 'added' || file.status === 'modified'
                      ? (
                        <button
                          className='git-file-button'
                          onClick={() => void selectFile(file.path)}
                          type='button'
                        >
                          <GitFileRow file={file} />
                        </button>
                      )
                      : <GitFileRow file={file} />}
                    <Tooltip label={`Discard changes to ${file.path}`}>
                      <button
                        aria-label={`Discard changes to ${file.path}`}
                        className='git-file-discard'
                        disabled={busy}
                        onClick={() => void discard(file.path)}
                        type='button'
                      >
                        ↶
                      </button>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            )}
            {snapshot.commits.length > 0 && (
              <section
                className={`git-commits${
                  exitingCommits.size === snapshot
                      .commits
                      .length
                    ? ' exiting'
                    : ''
                }`}
                aria-label='Unpushed commits'
              >
                <h2>
                  Unpushed commits <small>{snapshot.commits.length}</small>
                </h2>
                {snapshot.commits.map((commit, index) => (
                  <div
                    className={`git-commit${
                      exitingCommits.has(commit.hash)
                        ? ' exiting'
                        : ''
                    }`}
                    key={commit.hash}
                  >
                    <details>
                      <summary>
                        <Tooltip label={commit.subject}>
                          <code>{commit.hash.slice(0, 7)}</code>
                          <span>{commit.subject}</span>
                        </Tooltip>
                      </summary>
                      {commit.files.length > 0
                        ? (
                          <ul className='git-file-list git-commit-files'>
                            {commit
                              .files
                              .map((file) => (
                                <li
                                  className='git-file-item'
                                  key={file.path}
                                >
                                  {file.status === 'added' || file.status === 'modified'
                                    ? (
                                      <button
                                        className='git-file-button'
                                        onClick={() => void selectFile(file.path, commit.hash)}
                                        type='button'
                                      >
                                        <GitFileRow file={file} />
                                      </button>
                                    )
                                    : <GitFileRow file={file} />}
                                </li>
                              ))}
                          </ul>
                        )
                        : <p className='git-empty'>No files modified.</p>}
                    </details>
                    <div className='git-commit-actions'>
                      <Tooltip label='Revert this commit'>
                        <button
                          aria-label={`Revert commit ${commit.hash.slice(0, 7)}`}
                          className='git-commit-action git-revert'
                          disabled={busy}
                          onClick={() => void revertCommit(commit.hash)}
                          type='button'
                        >
                          ↶
                        </button>
                      </Tooltip>
                      {index === 0 && (
                        <Tooltip label='Reset this commit'>
                          <button
                            aria-label={`Reset commit ${commit.hash.slice(0, 7)}`}
                            className='git-commit-action git-reset'
                            disabled={busy}
                            onClick={() => void resetCommit(commit.hash)}
                            type='button'
                          >
                            🗑︎
                          </button>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            )}
            {!hasChanges && snapshot.ahead === 0 && (
              <p className='git-empty'>No changes to commit.</p>
            )}
          </>
        )}
    </WidgetLayout>
  )
}

/** Displays common file metadata in Git lists. */
function GitFileRow({ file }: { file: GitSnapshot['files'][number] }) {
  const fileIcon = resolveFileIcon(file.path)
  const statusLabel = gitStatusLabel(file.status)

  return (
    <>
      <Tooltip hint={`${fileIcon.label} file`} label={statusLabel}>
        <span
          aria-label={`${statusLabel} ${fileIcon.label} file`}
          className={`git-file-status ${file.status}`}
          role='img'
        >
          <span
            aria-hidden='true'
            className='git-file-icon'
            data-color={fileIcon.color}
          >
            {fileIcon.glyph}
          </span>
        </span>
      </Tooltip>
      <Tooltip label={file.path}>
        <span className='git-file-path'>{file.path}</span>
      </Tooltip>
      <span className='git-file-counts'>
        <b>+{file.additions ?? '—'}</b>
        <i>−{file.deletions ?? '—'}</i>
      </span>
    </>
  )
}

/** Displays a Git diff with line numbers before and after the change. */
function GitDiff({ diff }: { diff: string }) {
  const lines = parseGitDiff(diff)
  if (lines.length === 0) return <p className='git-empty'>No textual differences to display.</p>

  return (
    <section className='git-diff' aria-label='File diff'>
      {lines.map((line, index) => (
        <div className={`git-diff-line ${line.kind}`} key={index}>
          <span>{line.oldLine ?? ''}</span>
          <span>{line.newLine ?? ''}</span>
          <i aria-hidden='true'>
            {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
          </i>
          <code>{line.content}</code>
        </div>
      ))}
    </section>
  )
}

function gitStatusLabel(status: 'added' | 'deleted' | 'modified' | 'renamed'): string {
  return { added: 'Added', deleted: 'Deleted', modified: 'Modified', renamed: 'Renamed' }[status]
}
