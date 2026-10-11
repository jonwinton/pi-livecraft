import type { TodoItem } from '../../../shared/types.ts'
import { getTodos } from '../../api.ts'

interface TodoCacheEntry {
  todos?: TodoItem[]
  request?: Promise<TodoItem[]>
}

const todoCache = new Map<string, TodoCacheEntry>()

/** Shares one workspace todo request between the rail badge and the mounted widget. */
export function loadTodos(cwd: string, force = false): Promise<TodoItem[]> {
  const current = todoCache.get(cwd)
  if (!force && current?.todos) return Promise.resolve(current.todos)
  if (!force && current?.request) return current.request

  const request = getTodos(cwd)
    .then((todos) => {
      todoCache.set(cwd, { todos })
      return todos
    })
    .finally(() => {
      const entry = todoCache.get(cwd)
      if (entry?.request === request) todoCache.set(cwd, { todos: entry.todos })
    })
  todoCache.set(cwd, { todos: current?.todos, request })
  return request
}

/** Returns the last list the server confirmed for a workspace, or undefined if none loaded. */
export function cachedTodos(cwd: string): TodoItem[] | undefined {
  return todoCache.get(cwd)?.todos
}

/** Updates the shared snapshot after a successful todo write. */
export function cacheTodos(cwd: string, todos: TodoItem[]): void {
  todoCache.set(cwd, { todos })
}
