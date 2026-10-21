/**
 * Reads a gzip tar as GitHub's codeload serves it: ustar headers with a
 * prefix field, pax extended headers (`x`, per entry; `g`, global and
 * ignored) and GNU long names (`L`). Returns `{ path, type, content }` per
 * entry; `type` is `file`, `dir`, `link` or `other`. Content is kept for
 * files only.
 */
import { gunzipSync } from 'node:zlib'

const field = (block, start, length) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')

function octal(block, start, length) {
  const text = field(block, start, length).trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  if (!Number.isFinite(value) || value < 0) throw new Error(`tar: bad number "${text}" in a header`)
  return value
}

/** `path` from a pax record block (`<len> key=value\n` lines), when present. */
function paxPath(bytes) {
  const text = bytes.toString('utf8')
  let at = 0
  let path
  while (at < text.length) {
    const space = text.indexOf(' ', at)
    if (space < 0) break
    const length = Number.parseInt(text.slice(at, space), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = text.slice(space + 1, at + length - 1)
    const eq = record.indexOf('=')
    if (eq > 0 && record.slice(0, eq) === 'path') path = record.slice(eq + 1)
    at += length
  }
  return path
}

const TYPES = { '0': 'file', '\0': 'file', '7': 'file', '5': 'dir', '1': 'link', '2': 'link' }

export function readTarEntries(gz) {
  const bytes = gunzipSync(gz)
  const entries = []
  let offset = 0
  let nextPath
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every(b => b === 0)) break
    const size = octal(header, 124, 12)
    const flag = String.fromCharCode(header[156])
    const bodyStart = offset + 512
    if (bodyStart + size > bytes.length) throw new Error('tar: an entry runs past the end of the archive')
    const body = bytes.subarray(bodyStart, bodyStart + size)
    offset = bodyStart + Math.ceil(size / 512) * 512
    if (flag === 'g') continue
    if (flag === 'x') {
      nextPath = paxPath(body) ?? nextPath
      continue
    }
    if (flag === 'L') {
      nextPath = body.toString('utf8').replace(/\0.*$/s, '')
      continue
    }
    const name = field(header, 0, 100)
    const prefix = field(header, 345, 155)
    const path = nextPath ?? (prefix ? `${prefix}/${name}` : name)
    nextPath = undefined
    const type = TYPES[flag] ?? 'other'
    entries.push({ path, type, ...(type === 'file' ? { content: Buffer.from(body) } : {}) })
  }
  return entries
}
