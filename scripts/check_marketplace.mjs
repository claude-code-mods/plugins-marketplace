#!/usr/bin/env node
/**
 * The gate: the catalog parses, every listing names a plugin folder that
 * exists with a plugin.json whose name matches, every plugin states a semver
 * version, the two flags are booleans, no name repeats, no path escapes.
 * A plugin named in sources.json is read from its fetched folder, which must
 * match the pinned commit, and must be listed.
 * Exit 1 with every problem listed; exit 0 silent.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SOURCES_PATH, pluginFolder, readFetchedRecord, readSources } from './sources.mjs'

export const CATALOG_PATH = '.claude-plugin/marketplace.json'
export const PLUGIN_MANIFEST = '.claude-plugin/plugin.json'
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const LOCAL_SOURCE = /^\.\/plugins\/([A-Za-z0-9][A-Za-z0-9._-]*)$/

/** Every problem found under `root`; an empty list passes. */
export function checkMarketplace(root) {
  const problems = []
  const catalogPath = join(root, CATALOG_PATH)
  let catalog
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
  } catch (error) {
    return [`${CATALOG_PATH}: ${error.message}`]
  }
  if (typeof catalog.name !== 'string' || catalog.name === '') problems.push(`${CATALOG_PATH}: "name" must be a non-empty string`)
  if (!Array.isArray(catalog.plugins)) return [...problems, `${CATALOG_PATH}: "plugins" must be an array`]

  const external = readSources(root)
  problems.push(...external.problems)
  const fetched = readFetchedRecord(root)
  const seen = new Set()
  catalog.plugins.forEach((listing, index) => {
    const where = `${CATALOG_PATH} plugins[${index}]`
    if (!listing || typeof listing !== 'object') return problems.push(`${where}: not an object`)
    const { name, source, onByDefault, betaOnly, description } = listing
    if (typeof name !== 'string' || name === '') return problems.push(`${where}: "name" must be a non-empty string`)
    if (seen.has(name)) problems.push(`${where}: "${name}" is listed twice`)
    seen.add(name)
    if (typeof description !== 'string' || description.trim() === '') problems.push(`${where} (${name}): "description" is required`)
    if (onByDefault !== undefined && typeof onByDefault !== 'boolean') problems.push(`${where} (${name}): "onByDefault" must be a boolean`)
    if (betaOnly !== undefined && typeof betaOnly !== 'boolean') problems.push(`${where} (${name}): "betaOnly" must be a boolean`)
    const match = typeof source === 'string' ? source.match(LOCAL_SOURCE) : null
    if (!match) return problems.push(`${where} (${name}): "source" must be "./plugins/<folder>" inside this repository`)
    const folder = match[1]
    if (folder !== name) problems.push(`${where} (${name}): the folder "${folder}" must be named like the listing`)
    const pin = external.plugins.get(folder)
    if (pin) {
      if (existsSync(resolve(root, 'plugins', folder))) problems.push(`${where} (${name}): plugins/${folder}/ exists and ${SOURCES_PATH} also names it; keep one`)
      const got = fetched[folder]
      if (!got) return problems.push(`${where} (${name}): comes from ${pin.repo} and is not fetched; run npm run fetch`)
      if (got.repo !== pin.repo || got.commit !== pin.commit) {
        return problems.push(`${where} (${name}): fetched from ${got.repo}@${String(got.commit).slice(0, 7)}, ${SOURCES_PATH} pins ${pin.repo}@${pin.commit.slice(0, 7)}; run npm run fetch`)
      }
    }
    const { dir, shown } = pluginFolder(root, folder, external.plugins)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return problems.push(`${where} (${name}): ${shown}/ does not exist`)
    const manifestPath = join(dir, PLUGIN_MANIFEST)
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      return problems.push(`${shown}/${PLUGIN_MANIFEST}: ${error.message}`)
    }
    if (manifest.name !== name) problems.push(`${shown}/${PLUGIN_MANIFEST}: "name" is "${manifest.name}", the listing says "${name}"`)
    if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
      problems.push(`${shown}/${PLUGIN_MANIFEST}: "version" must be a semver string (a client names the install folder and compares upgrades by it)`)
    }
    const hooksPath = join(dir, 'hooks', 'hooks.json')
    if (existsSync(hooksPath)) {
      try {
        const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'))
        for (const module of Array.isArray(hooks.modules) ? hooks.modules : []) {
          if (typeof module !== 'string' || !module.startsWith('./') || module.includes('..')) {
            problems.push(`${shown}/hooks/hooks.json: module "${module}" must be a ./ path inside hooks/`)
          } else if (!existsSync(join(dir, 'hooks', module))) {
            problems.push(`${shown}/hooks/hooks.json: module "${module}" does not exist`)
          }
        }
      } catch (error) {
        problems.push(`${shown}/hooks/hooks.json: ${error.message}`)
      }
    }
  })
  for (const [name, pin] of external.plugins) {
    if (!seen.has(name)) problems.push(`${SOURCES_PATH}: "${name}" from ${pin.repo} has no listing in ${CATALOG_PATH}`)
  }
  return problems
}

const isMain = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
if (isMain || process.argv[1]?.endsWith('check_marketplace.mjs')) {
  const root = resolve(process.argv[2] ?? '.')
  const problems = checkMarketplace(root)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`check: ${problem}`)
    process.exit(1)
  }
}
