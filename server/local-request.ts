import type { IncomingHttpHeaders } from 'node:http'

const localHostnames = new Set(['127.0.0.1', 'localhost'])

/**
 * Accepts only requests addressed to and sent from a local page. The Host check defeats DNS
 * rebinding; the Origin check blocks cross-site requests that browsers send without preflight.
 */
export function isLocalRequest(headers: IncomingHttpHeaders): boolean {
  if (!headers.host || !isLocalUrl(`http://${headers.host}`)) return false
  return headers.origin === undefined || isLocalUrl(headers.origin)
}

/** Requires the JSON media type so cross-site pages cannot send a body without CORS preflight. */
export function isJsonRequest(headers: IncomingHttpHeaders): boolean {
  return headers['content-type']?.split(';')[0].trim().toLowerCase() === 'application/json'
}

function isLocalUrl(value: string): boolean {
  try {
    return localHostnames.has(new URL(value).hostname)
  } catch {
    return false
  }
}
