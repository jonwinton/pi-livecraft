import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Tooltip } from '../../components/Tooltip.tsx'
import type { SessionSummary, TodoItem, TodoSessionLink } from '../../../shared/types.ts'
import { updateTodos } from '../../api.ts'
import { reorderTodoItems, sortTodoItemsForDisplay } from './todo-order.ts'
import { promptSessionTitle } from '../composer/prompt-title.ts'
import { sessionIndicator } from '../workspace/session-indicator.ts'
import { SessionStatusIndicator } from '../workspace/SessionStatusIndicator.tsx'
import { cachedTodos, cacheTodos, loadTodos } from './todo-cache.ts'

/** Displays and edits the persistent task list for the current workspace. */
export function TodoWidget(
  {
    activeSessionId,
    compactingSessionIds,
    completedSessionIds,
    onNavigateSession,
    onOpenCountChange,
    onSendPrompt,
    onStartSession,
    sessions,
    workspacePath,
  }: {
    activeSessionId: string
    compactingSessionIds: ReadonlySet<string>
    completedSessionIds: ReadonlySet<string>
    onNavigateSession: (link: { id: string; sessionPath: string }) => void
    onOpenCountChange: (count: number | null) => void
    onSendPrompt: (message: string) => Promise<SessionSummary | null>
    onStartSession: (message: string) => Promise<SessionSummary | null>
    sessions: SessionSummary[]
    workspacePath: string
  },
) {
  const draftStorageKey = `pi-livecraft.todo-draft.${workspacePath}`
  // Null until this workspace's list loads, so a failed load cannot pose as an empty list.
  const [todos, setTodos] = useState<TodoItem[] | null>(null)
  const [newText, setNewText] = useState(() => readDraft(draftStorageKey))
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [reloadRequest, setReloadRequest] = useState(0)
  const [busy, setBusy] = useState(false)
  const [startingId, setStartingId] = useState<string | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dragOriginalTodos = useRef<TodoItem[] | null>(null)
  const dragTodos = useRef<TodoItem[] | null>(null)
  const dragMoved = useRef(false)
  const sessionNameSyncKey = useRef('')
  const todosWorkspace = useRef<string | null>(null)

  /** Restores the draft when the workspace changes. */
  useEffect(() => {
    setNewText(readDraft(draftStorageKey))
  }, [draftStorageKey])

  /** Reloads the list when the workspace changes and ignores stale responses. */
  useEffect(() => {
    let cancelled = false
    setError('')
    setTodos(null)
    sessionNameSyncKey.current = ''
    todosWorkspace.current = null
    void loadTodos(workspacePath, reloadRequest > 0)
      .then((nextTodos) => {
        if (cancelled) return
        todosWorkspace.current = workspacePath
        setTodos(nextTodos)
        onOpenCountChange(openCount(nextTodos))
      })
      .catch((cause) => {
        if (!cancelled) setError(messageOf(cause))
      })
    return () => {
      cancelled = true
    }
  }, [onOpenCountChange, reloadRequest, workspacePath])

  /**
   * Persists an edit before replacing the visible state. The edit applies to the last list the
   * server confirmed, not a render snapshot, so writes issued after an await keep newer tasks.
   */
  const save = useCallback(async (
    update: (current: TodoItem[]) => TodoItem[],
  ): Promise<boolean> => {
    const current = cachedTodos(workspacePath)
    if (!current) return false
    setBusy(true)
    setError('')
    try {
      const savedTodos = await updateTodos(workspacePath, update(current))
      cacheTodos(workspacePath, savedTodos)
      setTodos(savedTodos)
      onOpenCountChange(openCount(savedTodos))
      return true
    } catch (cause) {
      setError(messageOf(cause))
      return false
    } finally {
      setBusy(false)
    }
  }, [onOpenCountChange, workspacePath])

  /** Persists current session names when a linked session is renamed elsewhere. */
  useEffect(() => {
    if (busy || !todos || todosWorkspace.current !== workspacePath) return
    const nextTodos = todos.map((todo) => {
      if (!todo.session) return todo
      const name = sessionNameForTodo(todo, sessions)
      return name === todo.session.name
        ? todo
        : { ...todo, session: { ...todo.session, name } }
    })
    if (nextTodos.every((todo, index) => todo === todos[index])) return
    const syncKey = JSON.stringify(
      nextTodos.map((todo) => [todo.id, todo.session?.name ?? null]),
    )
    if (syncKey === sessionNameSyncKey.current) return
    sessionNameSyncKey.current = syncKey
    void save(() => nextTodos)
  }, [busy, save, sessions, todos, workspacePath])

  /** Persists the draft so a page reload cannot discard typed text. */
  function setDraft(next: string): void {
    setNewText(next)
    try {
      if (next) window.localStorage.setItem(draftStorageKey, next)
      else window.localStorage.removeItem(draftStorageKey)
    } catch {
      // Storage can be unavailable in private browsing; the in-memory draft still works.
    }
  }

  /** Adds a non-empty task while keeping the input if saving fails. */
  async function addTodo(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const text = newText.trim()
    if (!text) return
    if (
      await save((current) => [...current, {
        id: crypto.randomUUID(),
        text,
        completed: false,
      }])
    ) {
      setDraft('')
      textareaRef.current?.focus()
    }
  }

  /** Saves edited text or cancels editing when it has not changed. */
  async function commitEdit(todo: TodoItem): Promise<void> {
    const text = editingText.trim()
    if (!text || busy) return
    if (
      text === todo.text
      || await save((current) =>
        current.map((item) => item.id === todo.id ? { ...item, text } : item)
      )
    ) {
      setEditingId(null)
      setEditingText('')
    }
  }

  function editWithKeyboard(
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    todo: TodoItem,
  ): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void commitEdit(todo)
    } else if (event.key === 'Escape') {
      setEditingId(null)
      setEditingText('')
    }
  }

  /** Permanently removes a task without interrupting the flow with a confirmation. */
  async function removeTodo(todo: TodoItem): Promise<void> {
    await save((current) => current.filter((item) => item.id !== todo.id))
  }

  /** Starts a drag while retaining the order to restore if saving fails. */
  function beginDrag(event: ReactPointerEvent<HTMLSpanElement>, todoId: string): void {
    if (busy || editingId !== null || startingId !== null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragOriginalTodos.current = todos
    dragTodos.current = todos
    dragMoved.current = false
    setDraggedId(todoId)
  }

  /** Visually reorders the list according to the task under the captured pointer. */
  function moveDraggedTodo(event: ReactPointerEvent<HTMLSpanElement>): void {
    if (!draggedId || !dragTodos.current) return
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(
      '[data-todo-id]',
    )
    const targetId = target?.dataset.todoId
    if (!targetId || targetId === draggedId) return

    const nextTodos = reorderTodoItems(
      dragTodos.current,
      draggedId,
      targetId,
      event.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2,
    )
    if (nextTodos === dragTodos.current) return
    dragTodos.current = nextTodos
    dragMoved.current = true
    setTodos(nextTodos)
  }

  /** Persists the dropped order and restores the previous order if writing fails. */
  async function finishDrag(event: ReactPointerEvent<HTMLSpanElement>): Promise<void> {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    const nextTodos = dragTodos.current
    const previousTodos = dragOriginalTodos.current
    const shouldSave = dragMoved.current
    setDraggedId(null)
    dragTodos.current = null
    dragOriginalTodos.current = null
    dragMoved.current = false
    if (!shouldSave || !nextTodos || !previousTodos || await save(() => nextTodos)) return
    setTodos(previousTodos)
    onOpenCountChange(openCount(previousTodos))
  }

  /** Cancels the current drag and restores the initial order without persisting it. */
  function cancelDrag(): void {
    if (dragOriginalTodos.current) setTodos(dragOriginalTodos.current)
    setDraggedId(null)
    dragTodos.current = null
    dragOriginalTodos.current = null
    dragMoved.current = false
  }

  /** Builds a session link from a returned summary, falling back to a computed name. */
  function sessionLink(summary: SessionSummary, computedName?: string): TodoSessionLink | null {
    if (!summary.sessionPath) return null
    return { id: summary.id, name: computedName ?? summary.name, sessionPath: summary.sessionPath }
  }

  /** Opens a new session with the task text ready to edit. */
  async function startSession(todo: TodoItem): Promise<void> {
    setStartingId(todo.id)
    try {
      const summary = await onStartSession(todo.text)
      if (summary) {
        const link = sessionLink(summary)
        if (link)
          await save((current) =>
            current.map((item) => item.id === todo.id ? { ...item, session: link } : item)
          )
      }
    } finally {
      setStartingId(null)
    }
  }

  /** Opens a new session and sends the task text immediately. */
  async function sendPrompt(todo: TodoItem): Promise<void> {
    setStartingId(todo.id)
    try {
      const summary = await onSendPrompt(todo.text)
      if (summary) {
        const link = sessionLink(summary, promptSessionTitle(todo.text))
        if (link)
          await save((current) =>
            current.map((item) => item.id === todo.id ? { ...item, session: link } : item)
          )
      }
    } finally {
      setStartingId(null)
    }
  }

  const loading = todos === null && !error
  const visibleTodos = sortTodoItemsForDisplay((todos ?? []).filter((todo) => !todo.completed))
  const remaining = openCount(todos ?? [])

  return (
    <>
      <header className='widget-header'>
        <div className='todo-heading'>
          <strong>Todo</strong>
          <span>
            {loading
              ? 'Loading…'
              : remaining === 0
              ? 'All clear'
              : `${remaining} task${remaining === 1 ? '' : 's'} to do`}
          </span>
        </div>
        <span className='todo-count' aria-label={`${remaining} tasks remaining`}>
          {loading ? '—' : remaining}
        </span>
      </header>
      <div className='widget-content todo-content'>
        {loading
          ? (
            <div aria-label='Loading tasks' className='todo-skeleton' role='status'>
              <i />
              <i />
              <i />
            </div>
          )
          : (
            <>
              {error && (
                <div className='todo-error' role='alert'>
                  <span>{error}</span>
                  <button onClick={() => setReloadRequest((current) => current + 1)} type='button'>
                    Retry
                  </button>
                </div>
              )}
              {visibleTodos.length === 0 && !error
                ? (
                  <div className='todo-empty'>
                    <strong>No tasks</strong>
                    <span>Write down an idea to pick up later in this workspace.</span>
                  </div>
                )
                : (
                  <ul className='todo-list'>
                    {visibleTodos.map((todo) => (
                      <li
                        className={`${todo.completed ? 'completed ' : ''}${
                          todo.session ? 'todo-linked ' : ''
                        }${
                          todo.session && activeSessionId === todo.session.id
                            ? 'todo-session-active '
                            : ''
                        }${draggedId === todo.id ? 'dragging' : ''}`}
                        data-todo-id={todo.id}
                        key={todo.id}
                      >
                        {!todo.session && (
                          <Tooltip label='Move'>
                            <span
                              aria-hidden='true'
                              className='todo-drag'
                              onPointerCancel={cancelDrag}
                              onPointerDown={(event) => beginDrag(event, todo.id)}
                              onPointerMove={moveDraggedTodo}
                              onPointerUp={(event) => void finishDrag(event)}
                            >
                              ⠿
                            </span>
                          </Tooltip>
                        )}
                        {todo.session
                          && ((() => {
                            const s = sessionForTodo(todo, sessions)
                            const ind = s
                              ? sessionIndicator(
                                s,
                                activeSessionId,
                                compactingSessionIds,
                                completedSessionIds,
                              )
                              : null
                            return ind
                              ? <SessionStatusIndicator status={ind} />
                              : <span aria-hidden='true' className='todo-indicator-placeholder' />
                          })())}
                        <input
                          aria-label={`${todo.completed ? 'Reopen' : 'Mark'} “${todo.text}”`}
                          checked={todo.completed}
                          disabled={busy}
                          onChange={() =>
                            void save((current) =>
                              current.map((item) =>
                                item.id === todo.id
                                  ? { ...item, completed: !item.completed }
                                  : item
                              )
                            )}
                          type='checkbox'
                        />
                        {editingId === todo.id
                          ? (
                            <textarea
                              aria-label={`Edit "${todo.text}"`}
                              autoFocus
                              className='todo-edit'
                              disabled={busy}
                              maxLength={500}
                              onBlur={() => void commitEdit(todo)}
                              onChange={(event) => setEditingText(event.target.value)}
                              onKeyDown={(event) => editWithKeyboard(event, todo)}
                              rows={1}
                              value={editingText}
                            />
                          )
                          : todo.session
                          ? (
                            <Tooltip label={`Open session "${sessionNameForTodo(todo, sessions)}"`}>
                              <button
                                className={`todo-text todo-session-link${
                                  activeSessionId === todo.session.id ? ' active' : ''
                                }`}
                                disabled={busy || startingId !== null}
                                onClick={() => onNavigateSession(todo.session!)}
                                type='button'
                              >
                                <span className='todo-session-text'>{todo.text}</span>
                                <span className='todo-session-name'>
                                  {sessionNameForTodo(todo, sessions)}
                                </span>
                              </button>
                            </Tooltip>
                          )
                          : (
                            <Tooltip label='Edit'>
                              <button
                                className='todo-text'
                                disabled={busy || startingId !== null}
                                onClick={() => {
                                  setEditingId(todo.id)
                                  setEditingText(todo.text)
                                }}
                                type='button'
                              >
                                {todo.text}
                              </button>
                            </Tooltip>
                          )}
                        <div className='todo-actions'>
                          {!todo.session && (
                            <>
                              <Tooltip label='Open a new session'>
                                <button
                                  aria-label={`Open a new session with “${todo.text}”`}
                                  className='todo-start'
                                  disabled={busy || editingId !== null || startingId !== null}
                                  onClick={() => void startSession(todo)}
                                  type='button'
                                >
                                  {startingId === todo.id ? '…' : '↗'}
                                </button>
                              </Tooltip>
                              <Tooltip label='Open a session and send the prompt'>
                                <button
                                  aria-label={`Open a new session and send “${todo.text}”`}
                                  className='todo-send'
                                  disabled={busy || editingId !== null || startingId !== null}
                                  onClick={() => void sendPrompt(todo)}
                                  type='button'
                                >
                                  {startingId === todo.id ? '…' : '↑'}
                                </button>
                              </Tooltip>
                            </>
                          )}
                          <Tooltip label='Delete'>
                            <button
                              aria-label={`Delete “${todo.text}”`}
                              className='todo-delete'
                              disabled={busy || startingId !== null}
                              onClick={() => void removeTodo(todo)}
                              type='button'
                            >
                              ×
                            </button>
                          </Tooltip>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
            </>
          )}
      </div>
      <footer className='widget-footer'>
        <form className='todo-add' onSubmit={(event) => void addTodo(event)}>
          <textarea
            aria-label='New task'
            disabled={busy || todos === null}
            maxLength={500}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder='Add a task to this workspace…'
            ref={textareaRef}
            rows={1}
            value={newText}
          />
          <Tooltip label='Add'>
            <button
              aria-label='Add task'
              disabled={busy || todos === null || !newText.trim()}
              type='submit'
            >
              <svg aria-hidden='true' viewBox='0 0 16 16'>
                <path
                  d='M8 3.5v9M3.5 8h9'
                  fill='none'
                  stroke='currentColor'
                  strokeLinecap='round'
                  strokeWidth='1.5'
                />
              </svg>
            </button>
          </Tooltip>
        </form>
      </footer>
    </>
  )
}

/** Finds the live session summary for a linked todo, matching by id or path. */
function sessionForTodo(todo: TodoItem, sessions: SessionSummary[]): SessionSummary | undefined {
  const link = todo.session
  if (!link) return undefined
  return sessions.find(
    (session) =>
      session.id === link.id
      || (session.sessionPath !== undefined && session.sessionPath === link.sessionPath),
  )
}

/** Resolves the current display name for a linked session, falling back to its stored name. */
function sessionNameForTodo(todo: TodoItem, sessions: SessionSummary[]): string {
  return sessionForTodo(todo, sessions)?.name ?? todo.session?.name ?? ''
}

function openCount(todos: TodoItem[]): number {
  return todos.filter((todo) => !todo.completed).length
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function readDraft(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}
