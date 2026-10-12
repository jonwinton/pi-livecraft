import { StringDecoder } from 'node:string_decoder'

const DEFAULT_MAX_RECORD_SIZE = 4 * 1024 * 1024
/** Pi returns a complete session history in one JSONL record; keep that path bounded separately. */
// ponytail: 64 MiB bounds local RPC buffering; chunk get_entries if larger histories become common.
export const MAX_SESSION_RECORD_SIZE = 64 * 1024 * 1024
/** Unread event bytes allowed per stream consumer before it is disconnected to recover by resync. */
export const MAX_BUFFERED_EVENT_BYTES = 16 * 1024 * 1024

/**
 * Decodes a strict JSONL stream without treating Unicode separators as line
 * endings, according to Pi's RPC protocol.
 */
export class JsonLineDecoder {
  readonly #decoder = new StringDecoder('utf8')
  readonly #onValue: (value: unknown) => void
  readonly #maxRecordSize: number
  /** Chunks of the unfinished record, joined once its newline arrives to avoid quadratic rescans. */
  readonly #partial: string[] = []
  #partialLength = 0

  constructor(onValue: (value: unknown) => void, maxRecordSize = DEFAULT_MAX_RECORD_SIZE) {
    this.#onValue = onValue
    this.#maxRecordSize = maxRecordSize
  }

  push(chunk: Buffer | string): void {
    this.#consume(typeof chunk === 'string' ? chunk : this.#decoder.write(chunk))
  }

  end(): void {
    this.#consume(this.#decoder.end())
    if (this.#partialLength > 0) this.#parse(this.#takeRecord(''))
  }

  #consume(text: string): void {
    let start = 0
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', start)) {
      const record = this.#takeRecord(text.slice(start, index))
      start = index + 1
      this.#parse(record)
    }
    const rest = text.slice(start)
    if (!rest) return
    this.#partial.push(rest)
    this.#partialLength += rest.length
    if (this.#partialLength > this.#maxRecordSize) this.#throwRecordSizeError()
  }

  /** Completes the pending record with its final piece and clears the pending chunks. */
  #takeRecord(tail: string): string {
    if (this.#partialLength + tail.length > this.#maxRecordSize) this.#throwRecordSizeError()
    const record = this.#partial.length > 0 ? this.#partial.join('') + tail : tail
    this.#partial.length = 0
    this.#partialLength = 0
    return record
  }

  #parse(line: string): void {
    const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line
    if (normalizedLine.length > 0) this.#onValue(JSON.parse(normalizedLine))
  }

  /** Drops the oversized record so a caller that keeps reading cannot grow the buffer without bound. */
  #throwRecordSizeError(): never {
    this.#partial.length = 0
    this.#partialLength = 0
    throw new Error(
      `JSONL record exceeds ${String(this.#maxRecordSize / (1024 * 1024))} MiB`,
    )
  }
}

export function encodeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}
