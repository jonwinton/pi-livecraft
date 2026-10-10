import assert from 'node:assert/strict'
import test from 'node:test'
import { JsonLineDecoder, MAX_SESSION_RECORD_SIZE } from '../server/jsonl.ts'

test('decodes session records larger than the default JSONL limit', () => {
  const values: unknown[] = []
  const decoder = new JsonLineDecoder((value) => values.push(value), MAX_SESSION_RECORD_SIZE)
  const payload = 'x'.repeat(5 * 1024 * 1024)

  decoder.push(`${JSON.stringify({ payload })}\n`)

  assert.equal(values.length, 1)
  assert.equal((values[0] as { payload: string }).payload.length, payload.length)
})

test('reassembles records split across chunks, including a final record without a newline', () => {
  const values: unknown[] = []
  const decoder = new JsonLineDecoder((value) => values.push(value), 64)
  decoder.push('{"a":')
  decoder.push(Buffer.from('1}\r\n{"b":"\u00e9'))
  decoder.push('"}\n{"c":3}')
  decoder.end()
  assert.deepEqual(values, [{ a: 1 }, { b: 'é' }, { c: 3 }])
})

test('rejects an oversized record and keeps decoding later records', () => {
  const values: unknown[] = []
  const decoder = new JsonLineDecoder((value) => values.push(value), 16)
  assert.throws(() => decoder.push('"x'.padEnd(17, 'x')), /exceeds/)
  decoder.push('\n{"ok":true}\n')
  assert.deepEqual(values.slice(-1), [{ ok: true }])
})
