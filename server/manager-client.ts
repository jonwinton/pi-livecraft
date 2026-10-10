import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'
import { JsonLineDecoder, MAX_SESSION_RECORD_SIZE, encodeJsonLine } from './jsonl.ts'
import type { ManagerMessage, ManagerRequest } from '../shared/types.ts'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

const connectionGracePeriodMs = 1_000

export class ManagerClient extends EventEmitter {
  readonly #host: string
  readonly #port: number
  readonly #pending = new Map<string, PendingRequest>()
  readonly #connectionWaiters = new Set<() => void>()
  #socket: Socket | null = null
  #reconnectTimer: NodeJS.Timeout | null = null
  connected = false

  constructor(host: string, port: number) {
    super()
    this.#host = host
    this.#port = port
  }

  start(): void {
    this.#connect()
  }

  /** Waits briefly for the normal startup/reconnect race before reporting manager unavailability. */
  async request(request: Omit<ManagerRequest, 'id'>, timeoutMs = 35_000): Promise<unknown> {
    if (!this.#socket?.writable || !this.connected) await this.#waitForConnection()
    if (!this.#socket?.writable || !this.connected)
      throw new Error('Pi manager is unavailable')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Manager request timed out: ${request.action}`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timeout })
      this.#socket?.write(encodeJsonLine({ ...request, id }))
    })
  }

  /** Establishes the local connection and reinstalls the required listeners after each reconnect. */
  #connect(): void {
    if (this.#socket) return
    const socket = connect({ host: this.#host, port: this.#port })
    this.#socket = socket
    const decoder = new JsonLineDecoder(
      (value) => this.#receive(value),
      MAX_SESSION_RECORD_SIZE,
    )

    socket.setNoDelay(true)
    socket.on('connect', () => {
      this.connected = true
      this.#resolveConnectionWaiters()
      this.emit('connected')
    })
    const read = (decode: () => void): void => {
      try {
        decode()
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)))
      }
    }
    socket.on('data', (chunk) => read(() => decoder.push(chunk)))
    socket.on('end', () => read(() => decoder.end()))
    socket.on('error', () => undefined)
    socket.on('close', () => {
      this.connected = false
      this.#socket = null
      this.#rejectPending(new Error('Connection to Pi manager closed'))
      this.emit('disconnected')
      this.#scheduleReconnect()
    })
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer) return
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      this.#connect()
    }, 500)
  }

  /** Resolves when a connection arrives, or after the grace period expires. */
  #waitForConnection(): Promise<void> {
    if (this.#socket?.writable && this.connected) return Promise.resolve()
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timeout)
        this.#connectionWaiters.delete(waiter)
        resolve()
      }
      const timeout = setTimeout(() => {
        this.#connectionWaiters.delete(waiter)
        resolve()
      }, connectionGracePeriodMs)
      this.#connectionWaiters.add(waiter)
    })
  }

  #resolveConnectionWaiters(): void {
    for (const waiter of this.#connectionWaiters) waiter()
  }

  /** Dispatches events and resolves requests from their RPC identifier. */
  #receive(value: unknown): void {
    if (!isManagerMessage(value)) return
    if (value.kind === 'event') {
      this.emit('event', value)
      return
    }
    const pending = this.#pending.get(value.id)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.#pending.delete(value.id)
    if (value.ok) pending.resolve(value.data)
    else pending.reject(new Error(value.error ?? 'Manager request failed'))
  }

  /** Rejects open requests when the manager connection disappears. */
  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}

function isManagerMessage(value: unknown): value is ManagerMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { kind?: unknown }
  return message.kind === 'response' || message.kind === 'event'
}
