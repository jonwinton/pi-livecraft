import assert from 'node:assert/strict'
import test from 'node:test'
import { isJsonRequest, isLocalRequest } from '../server/local-request.ts'

test('accepts local pages, including the Vite proxy, and rejects foreign hosts or origins', () => {
  assert.equal(isLocalRequest({ host: '127.0.0.1:43121' }), true)
  assert.equal(
    isLocalRequest({ host: 'localhost:5173', origin: 'http://localhost:5173' }),
    true,
  )
  assert.equal(isLocalRequest({ host: '127.0.0.1:43121', origin: 'https://evil.example' }), false)
  assert.equal(isLocalRequest({ host: '127.0.0.1:43121', origin: 'null' }), false)
  assert.equal(isLocalRequest({ host: 'rebound.evil.example:43121' }), false)
  assert.equal(isLocalRequest({}), false)
})

test('requires a JSON content type so cross-site simple requests are refused', () => {
  assert.equal(isJsonRequest({ 'content-type': 'application/json; charset=utf-8' }), true)
  assert.equal(isJsonRequest({ 'content-type': 'text/plain' }), false)
  assert.equal(isJsonRequest({}), false)
})
