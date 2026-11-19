/**
 * `themes.json`: theme plugins kept in other GitHub repositories, each pinned
 * to a commit. A record with `listed: true` is published as a catalog listing
 * a client installs from that repository; its code never ships from here.
 *   { "version": 1, "plugins": [ { name, listed, repo, path, commit, version?,
 *       title?, description?, author?, official?, preview?,
 *       looks: [ { id, name?, description?, appearance?, preview, use?: { command, args? } } ] } ] }
 *
 * Security: every record is third-party data. A look is accepted only with a
 * plain id, a preview that is a picture under `previews/` here or a
 * commit-pinned raw.githubusercontent.com picture, and a `use` of one command
 * word and one short lowercase argument.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const THEMES_PATH = 'themes.json'
export const PREVIEWS_DIR = 'previews'
/** The largest local preview file the check accepts. */
export const PREVIEW_MAX_BYTES = 1.5 * 1024 * 1024

const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/
const COMMIT = /^[0-9a-f]{40}$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const LOOK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const COMMAND_WORD = /^[A-Za-z0-9_-]{1,64}$/
const LOOK_ARGS = /^[a-z0-9-]{0,64}$/
const PICTURE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.(svg|webp|png|jpg|jpeg|gif)$/
const PINNED_RAW_PREFIX = /^https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[0-9a-f]{40}\//
const APPEARANCES = ['light', 'dark', 'both']
const PREVIEW_MAX_LENGTH = 512
const LOOK_FIELDS = ['id', 'name', 'description', 'appearance', 'preview', 'use']

/** True when `path` is `.` or a relative posix path that stays inside the repository. */
function isInsidePath(path) {
  if (path === '.') return true
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.endsWith('/')) return false
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function isPicturePath(path) {
  return PICTURE_PATH.test(path) && !path.split('/').some(part => part === '.' || part === '..')
}

/** True when `preview` names a file of this repository's `previews/` folder. */
export function isLocalPreview(preview) {
  return typeof preview === 'string' && preview.startsWith(`${PREVIEWS_DIR}/`) && isPicturePath(preview)
}

/** What is wrong with a preview, or null. A local one must exist under `root`. */
function previewProblem(root, preview) {
  if (typeof preview !== 'string' || preview === '') return '"preview" is required'
  if (preview.length > PREVIEW_MAX_LENGTH) return `"preview" is longer than ${PREVIEW_MAX_LENGTH} characters`
  if (/^[a-z][a-z0-9+.-]*:/i.test(preview)) {
    const prefix = PINNED_RAW_PREFIX.exec(preview)
    if (prefix && isPicturePath(preview.slice(prefix[0].length))) return null
    return `"preview" ${preview} must be a raw.githubusercontent.com picture pinned by a full commit sha`
  }
  if (!isLocalPreview(preview)) return `"preview" ${preview} must be a svg/webp/png/jpg/jpeg/gif file under ${PREVIEWS_DIR}/`
  const file = join(root, ...preview.split('/'))
  if (!existsSync(file) || !statSync(file).isFile()) return `"preview" ${preview} does not exist`
  const size = statSync(file).size
  if (size > PREVIEW_MAX_BYTES) return `"preview" ${preview} is ${size} bytes, over the ${PREVIEW_MAX_BYTES} limit`
  return null
}

function optionalString(value) {
  return value === undefined || typeof value === 'string'
}

/**
 * `themes.json` under `root`, validated. A missing file is no themes.
 * `taken` maps a name already used by the catalog or sources.json to the file
 * that uses it. Returns `{ records, listed, problems }`; `listed` holds the
 * records to publish.
 */
export function readThemes(root, taken = new Map()) {
  const file = join(root, THEMES_PATH)
  if (!existsSync(file)) return { records: [], listed: [], problems: [] }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { records: [], listed: [], problems: [`${THEMES_PATH}: ${error.message}`] }
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.plugins)) {
    return { records: [], listed: [], problems: [`${THEMES_PATH}: "plugins" must be an array`] }
  }
  const problems = []
  if (parsed.version !== 1) problems.push(`${THEMES_PATH}: "version" must be 1`)
  const seen = new Set()
  parsed.plugins.forEach((record, index) => {
    const where = `${THEMES_PATH} plugins[${index}]`
    if (!record || typeof record !== 'object' || Array.isArray(record)) return problems.push(`${where}: not an object`)
    const { name, listed, repo, path, commit, version, looks } = record
    if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) return problems.push(`${where}: "name" must be a plugin name`)
    const at = `${where} (${name})`
    if (seen.has(name)) problems.push(`${at}: "${name}" is listed twice`)
    seen.add(name)
    if (taken.has(name)) problems.push(`${at}: "${name}" is also a plugin in ${taken.get(name)}`)
    if (typeof listed !== 'boolean') problems.push(`${at}: "listed" must be a boolean`)
    if (typeof repo !== 'string' || !REPO.test(repo)) problems.push(`${at}: "repo" must be "owner/name"`)
    if (typeof commit !== 'string' || !COMMIT.test(commit)) problems.push(`${at}: "commit" must be a full 40-character lowercase sha`)
    if (typeof path !== 'string' || !isInsidePath(path)) problems.push(`${at}: "path" must be "." or a relative path inside the repository`)
    if (version !== undefined && (typeof version !== 'string' || !SEMVER.test(version))) problems.push(`${at}: "version" must be a semver string`)
    if (listed === true && version === undefined) problems.push(`${at}: a listed theme needs a "version"`)
    for (const key of ['title', 'description', 'author']) {
      if (!optionalString(record[key])) problems.push(`${at}: "${key}" must be a string`)
    }
    if (record.official !== undefined && typeof record.official !== 'boolean') problems.push(`${at}: "official" must be a boolean`)
    if (record.preview !== undefined) {
      const problem = previewProblem(root, record.preview)
      if (problem) problems.push(`${at}: ${problem}`)
    }
    if (!Array.isArray(looks) || looks.length === 0) return problems.push(`${at}: "looks" must be a non-empty array`)
    const ids = new Set()
    looks.forEach((look, lookIndex) => {
      const lwhere = `${at} looks[${lookIndex}]`
      if (!look || typeof look !== 'object' || Array.isArray(look)) return problems.push(`${lwhere}: not an object`)
      if (typeof look.id !== 'string' || !LOOK_ID.test(look.id)) problems.push(`${lwhere}: "id" must match [a-z0-9][a-z0-9-]* and be at most 64 characters`)
      else if (ids.has(look.id)) problems.push(`${lwhere}: look "${look.id}" is listed twice`)
      else ids.add(look.id)
      for (const key of ['name', 'description']) {
        if (!optionalString(look[key])) problems.push(`${lwhere}: "${key}" must be a string`)
      }
      if (look.appearance !== undefined && !APPEARANCES.includes(look.appearance)) problems.push(`${lwhere}: "appearance" must be light, dark or both`)
      const problem = previewProblem(root, look.preview)
      if (problem) problems.push(`${lwhere}: ${problem}`)
      if (look.use !== undefined) {
        const use = look.use
        if (!use || typeof use !== 'object' || Array.isArray(use)) return problems.push(`${lwhere}: "use" must be an object`)
        if (typeof use.command !== 'string' || !COMMAND_WORD.test(use.command)) problems.push(`${lwhere}: "use.command" must be a single command word`)
        if (use.args !== undefined && (typeof use.args !== 'string' || !LOOK_ARGS.test(use.args))) problems.push(`${lwhere}: "use.args" must match [a-z0-9-]{0,64}`)
      }
    })
  })
  const records = parsed.plugins.filter(record => record && typeof record === 'object')
  return { records, listed: records.filter(record => record.listed === true), problems }
}

/** The catalog listing a client reads for one (valid, listed) record. */
export function themeListing(record) {
  const listing = { name: record.name }
  if (typeof record.description === 'string' && record.description !== '') listing.description = record.description
  listing.version = record.version
  listing.category = 'theme'
  if (typeof record.author === 'string' && record.author !== '') listing.author = { name: record.author }
  listing.source =
    record.path === '.'
      ? { source: 'github', repo: record.repo, sha: record.commit }
      : { source: 'git-subdir', url: `https://github.com/${record.repo}`, path: record.path, sha: record.commit }
  const theme = {}
  if (record.official === true) theme.official = true
  theme.looks = record.looks.map(look => {
    const copy = {}
    for (const key of LOOK_FIELDS) if (look[key] !== undefined) copy[key] = look[key]
    return copy
  })
  listing.theme = theme
  return listing
}

/** The local preview files the listed records' looks refer to: sorted, each once. */
export function listedPreviewFiles(listed) {
  const paths = new Set()
  for (const record of listed) {
    for (const look of record.looks) if (isLocalPreview(look.preview)) paths.add(look.preview)
  }
  return [...paths].sort()
}
