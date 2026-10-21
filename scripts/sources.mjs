/**
 * `sources.json`: plugins kept in other GitHub repositories, each pinned to
 * a commit, fetched into `.sources/<name>/` and shipped as `plugins/<name>/`.
 *   { "sources": [ { "repo": "owner/repo", "commit": "<40-hex sha>",
 *                    "plugins": [ { "name": "<listing name>", "path": "plugins/<x>" | "." } ] } ] }
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SOURCES_PATH = 'sources.json'
export const FETCHED_DIR = '.sources'
/** What the last fetch wrote: `{ "<name>": { repo, commit } }`. */
export const FETCHED_RECORD = 'fetched.json'

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/
const COMMIT = /^[0-9a-f]{40}$/
export const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** True when `path` is `.` or a relative posix path that stays inside the repository. */
function isInsidePath(path) {
  if (path === '.') return true
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.endsWith('/')) return false
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

/**
 * `sources.json` under `root`, validated. A missing file is no sources.
 * Returns `{ sources, plugins, problems }`: `plugins` maps a plugin name to
 * `{ repo, commit, path }`.
 */
export function readSources(root) {
  const problems = []
  const plugins = new Map()
  const file = join(root, SOURCES_PATH)
  if (!existsSync(file)) return { sources: [], plugins, problems }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { sources: [], plugins, problems: [`${SOURCES_PATH}: ${error.message}`] }
  }
  if (!parsed || !Array.isArray(parsed.sources)) {
    return { sources: [], plugins, problems: [`${SOURCES_PATH}: "sources" must be an array`] }
  }
  const repos = new Set()
  parsed.sources.forEach((source, index) => {
    const where = `${SOURCES_PATH} sources[${index}]`
    if (!source || typeof source !== 'object') return problems.push(`${where}: not an object`)
    const { repo, commit } = source
    if (typeof repo !== 'string' || !REPO.test(repo)) return problems.push(`${where}: "repo" must be "owner/name"`)
    const key = repo.toLowerCase()
    if (repos.has(key)) problems.push(`${where}: "${repo}" is listed twice; one repository has one pin`)
    repos.add(key)
    if (typeof commit !== 'string' || !COMMIT.test(commit)) problems.push(`${where} (${repo}): "commit" must be a full 40-character lowercase sha`)
    if (!Array.isArray(source.plugins) || source.plugins.length === 0) return problems.push(`${where} (${repo}): "plugins" must be a non-empty array`)
    source.plugins.forEach((plugin, at) => {
      const pwhere = `${where}.plugins[${at}]`
      if (!plugin || typeof plugin !== 'object') return problems.push(`${pwhere}: not an object`)
      const { name, path } = plugin
      if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) return problems.push(`${pwhere}: "name" must be a plugin folder name`)
      if (typeof path !== 'string' || !isInsidePath(path)) problems.push(`${pwhere} (${name}): "path" must be "." or a relative path inside the repository`)
      if (plugins.has(name)) problems.push(`${pwhere} (${name}): "${name}" is listed twice`)
      else plugins.set(name, { repo, commit, path })
    })
  })
  return { sources: parsed.sources, plugins, problems }
}

/** The `.sources/fetched.json` record, or `{}` when nothing was fetched. */
export function readFetchedRecord(root) {
  try {
    return JSON.parse(readFileSync(join(root, FETCHED_DIR, FETCHED_RECORD), 'utf8')) ?? {}
  } catch {
    return {}
  }
}

/** The folder a listing's files are read from, and how a message names it. */
export function pluginFolder(root, name, externalPlugins) {
  const relative = externalPlugins.has(name) ? `${FETCHED_DIR}/${name}` : `plugins/${name}`
  return { dir: join(root, ...relative.split('/')), shown: relative }
}
