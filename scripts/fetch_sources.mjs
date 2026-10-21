#!/usr/bin/env node
/**
 * Downloads each repository in `sources.json` from codeload at its pinned
 * commit and writes every listed plugin to `.sources/<name>/` (the folder is
 * replaced), plus `.sources/fetched.json`. Path `.` is the repository root
 * without `.github/`. Fails on a link, a path leaving the plugin, an empty
 * plugin or an invalid sources.json. `GITHUB_TOKEN`, when set, is sent.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { FETCHED_DIR, FETCHED_RECORD, readSources } from './sources.mjs'
import { readTarEntries } from './tar_read.mjs'

export function codeloadUrl(repo, commit) {
  return `https://codeload.github.com/${repo}/tar.gz/${commit}`
}

/** The tarball's entries with the one wrapper directory codeload adds removed. */
export function stripWrapper(entries) {
  return entries
    .map(entry => ({ ...entry, path: entry.path.split('/').slice(1).join('/') }))
    .filter(entry => entry.path !== '')
}

/** The files of the plugin at `path` in a stripped entry list, relative to that folder. */
export function pluginFiles(entries, path, where) {
  const prefix = path === '.' ? '' : `${path}/`
  const files = []
  for (const entry of entries) {
    const rel = entry.path.replace(/\/$/, '')
    if (!rel.startsWith(prefix) || rel === path) continue
    const inside = rel.slice(prefix.length)
    if (path === '.' && (inside === '.github' || inside.startsWith('.github/'))) continue
    if (entry.type === 'dir') continue
    if (entry.type !== 'file') throw new Error(`${where}: ${rel} is a ${entry.type === 'link' ? 'link' : 'special entry'}; a plugin ships regular files only`)
    if (inside.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error(`${where}: ${rel} leaves the plugin folder`)
    files.push({ path: inside, content: entry.content })
  }
  if (files.length === 0) throw new Error(`${where}: no files under "${path}"`)
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export async function fetchSources(root, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const token = options.token ?? process.env.GITHUB_TOKEN
  const { sources, problems } = readSources(root)
  if (problems.length > 0) throw new Error(`fetch: sources.json is invalid:\n${problems.map(p => `  ${p}`).join('\n')}`)
  const outDir = join(root, FETCHED_DIR)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const record = {}
  for (const source of sources) {
    const url = codeloadUrl(source.repo, source.commit)
    const response = await fetchImpl(url, token ? { headers: { authorization: `Bearer ${token}` } } : {})
    if (!response.ok) throw new Error(`fetch: ${source.repo}@${source.commit.slice(0, 7)}: HTTP ${response.status} from ${url}`)
    const entries = stripWrapper(readTarEntries(Buffer.from(await response.arrayBuffer())))
    for (const plugin of source.plugins) {
      const where = `${source.repo}@${source.commit.slice(0, 7)} ${plugin.name}`
      const files = pluginFiles(entries, plugin.path, where)
      const dir = join(outDir, plugin.name)
      for (const file of files) {
        const target = join(dir, ...file.path.split('/'))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.content)
      }
      record[plugin.name] = { repo: source.repo, commit: source.commit }
    }
  }
  writeFileSync(join(outDir, FETCHED_RECORD), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

if (process.argv[1]?.endsWith('fetch_sources.mjs')) {
  const root = resolve(process.argv[2] ?? '.')
  try {
    const record = await fetchSources(root)
    const names = Object.keys(record)
    console.log(names.length === 0 ? 'fetch: no sources' : `fetch: ${names.join(', ')}`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
