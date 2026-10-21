#!/usr/bin/env node
/**
 * Starts a mod in its own repository and registers it here:
 *   node scripts/new_mod.mjs <name> --description "<one line>"
 *        [--repo owner/name] [--dir <path>] [--category <c>] [--off] [--beta]
 * Creates the repository from the mod template, renames its placeholders,
 * pushes, sets MARKETPLACE_REPO (this origin) and MARKETPLACE_TOKEN (when in
 * the environment), then adds the pin and the listing here, uncommitted.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { CATALOG_PATH, PLUGIN_MANIFEST } from './check_marketplace.mjs'
import { PLUGIN_NAME, SOURCES_PATH, readSources } from './sources.mjs'

export const TEMPLATE_REPO = 'VellocLabs/mod-template'
export const TEMPLATE_NAME = 'example-mod'
export const TEMPLATE_DESCRIPTION = 'Describe what this mod does.'
const DEFAULT_OWNER = 'VellocLabs'

/** Throws unless `name` can be a new listing here. */
export function assertNewName(root, name) {
  if (!PLUGIN_NAME.test(name ?? '')) throw new Error(`new-mod: "${name}" is not a plugin folder name`)
  const catalog = JSON.parse(readFileSync(join(root, CATALOG_PATH), 'utf8'))
  if (catalog.plugins.some(p => p.name === name)) throw new Error(`new-mod: "${name}" is already listed in ${CATALOG_PATH}`)
  if (readSources(root).plugins.has(name)) throw new Error(`new-mod: "${name}" is already in ${SOURCES_PATH}`)
  if (existsSync(join(root, 'plugins', name))) throw new Error(`new-mod: plugins/${name}/ already exists`)
}

/** Renames the template's placeholders in a checkout; returns the files changed. */
export function customizeCheckout(dir, { name, description }) {
  const changed = []
  const walk = sub => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const rel = sub ? `${sub}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(rel)
      else if (entry.isFile()) {
        const file = join(dir, ...rel.split('/'))
        const before = readFileSync(file, 'utf8')
        let after
        if (rel === PLUGIN_MANIFEST) {
          const manifest = JSON.parse(before)
          after = `${JSON.stringify({ ...manifest, name, description }, null, 2)}\n`
        } else {
          after = before.split(TEMPLATE_NAME).join(name).split(TEMPLATE_DESCRIPTION).join(description)
        }
        if (after !== before) {
          writeFileSync(file, after)
          changed.push(rel)
        }
      }
    }
  }
  walk('')
  return changed.sort()
}

/** Adds the repository's pin and the mod's listing here. */
export function registerMod(root, { repo, commit, name, description, category, onByDefault, betaOnly }) {
  assertNewName(root, name)
  const sourcesFile = join(root, SOURCES_PATH)
  const sources = existsSync(sourcesFile) ? JSON.parse(readFileSync(sourcesFile, 'utf8')) : { sources: [] }
  if (sources.sources.some(s => s.repo.toLowerCase() === repo.toLowerCase())) throw new Error(`new-mod: ${repo} is already in ${SOURCES_PATH}`)
  sources.sources.push({ repo, commit, plugins: [{ name, path: '.' }] })
  writeFileSync(sourcesFile, `${JSON.stringify(sources, null, 2)}\n`)
  const catalogFile = join(root, CATALOG_PATH)
  const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'))
  catalog.plugins.push({
    name,
    description,
    source: `./plugins/${name}`,
    category,
    ...(onByDefault === false ? { onByDefault: false } : {}),
    ...(betaOnly ? { betaOnly: true } : {}),
  })
  writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`)
}

export function parseArgs(argv) {
  const options = { category: 'mods', onByDefault: true, betaOnly: false }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`new-mod: ${arg} needs a value`)
      return argv[++i]
    }
    if (arg === '--description') options.description = value()
    else if (arg === '--repo') options.repo = value()
    else if (arg === '--dir') options.dir = value()
    else if (arg === '--category') options.category = value()
    else if (arg === '--off') options.onByDefault = false
    else if (arg === '--beta') options.betaOnly = true
    else if (arg.startsWith('--')) throw new Error(`new-mod: unknown option ${arg}`)
    else rest.push(arg)
  }
  if (rest.length !== 1) throw new Error('new-mod: usage: new_mod.mjs <name> --description "<one line>" [--repo owner/name] [--dir path] [--category c] [--off] [--beta]')
  options.name = rest[0]
  if (typeof options.description !== 'string' || options.description.trim() === '') throw new Error('new-mod: --description is required')
  options.repo ??= `${DEFAULT_OWNER}/${options.name}`
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(options.repo)) throw new Error(`new-mod: --repo "${options.repo}" must be owner/name`)
  return options
}

/** Runs a command; throws with its stderr on a non-zero exit. */
function runCommand(command, args, { cwd, input } = {}) {
  const result = spawnSync(command, args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout.trim()
}

const sleep = ms => new Promise(done => setTimeout(done, ms))

/** This marketplace's `owner/name`, read from the checkout's `origin` remote. */
export function originRepo(root, run) {
  const url = run('git', ['-C', root, 'remote', 'get-url', 'origin'])
  const match = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  if (!match) throw new Error(`new-mod: origin "${url}" is not a GitHub repository`)
  return `${match[1]}/${match[2]}`
}

export async function newMod(root, options, deps = {}) {
  const run = deps.run ?? runCommand
  const log = deps.log ?? (line => console.log(line))
  const token = deps.token ?? process.env.MARKETPLACE_TOKEN
  const waitMs = deps.waitMs ?? 3000
  const dir = resolve(options.dir ?? join(dirname(root), basename(options.repo)))
  assertNewName(root, options.name)
  if (existsSync(dir)) throw new Error(`new-mod: ${dir} already exists`)
  const marketplace = deps.marketplaceRepo ?? originRepo(root, run)

  run('gh', ['repo', 'create', options.repo, '--public', '--template', TEMPLATE_REPO, '--description', options.description])
  log(`created ${options.repo} from ${TEMPLATE_REPO}`)
  // GitHub fills a templated repository asynchronously; retry until it has a main.
  for (let attempt = 1; ; attempt += 1) {
    try {
      run('git', ['clone', `https://github.com/${options.repo}.git`, dir])
      run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir })
      break
    } catch (error) {
      if (attempt >= 10) throw error
      rmSync(dir, { recursive: true, force: true })
      await sleep(waitMs)
    }
  }
  const changed = customizeCheckout(dir, options)
  run('git', ['add', '-A'], { cwd: dir })
  run('git', ['commit', '-q', '-m', `Start ${options.name} from the mod template`], { cwd: dir })
  run('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: dir })
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: dir })
  log(`renamed the placeholders in ${changed.length} files and pushed ${commit.slice(0, 7)} -> ${dir}`)

  // A signed-in token without Actions access cannot set these; the mod is still created and registered.
  const redact = text => (token ? String(text).split(token).join('***') : String(text))
  const variableCommand = `gh variable set MARKETPLACE_REPO --repo ${options.repo} --body ${marketplace}`
  try {
    run('gh', ['variable', 'set', 'MARKETPLACE_REPO', '--repo', options.repo, '--body', marketplace])
    log(`set MARKETPLACE_REPO to ${marketplace}`)
  } catch (error) {
    log(`MARKETPLACE_REPO not set (${redact(error.message)}); set it with: ${variableCommand}`)
  }
  const secretCommand = `gh secret set MARKETPLACE_TOKEN --repo ${options.repo}`
  if (token) {
    try {
      run('gh', ['secret', 'set', 'MARKETPLACE_TOKEN', '--repo', options.repo], { input: token })
      log('set MARKETPLACE_TOKEN')
    } catch (error) {
      log(`MARKETPLACE_TOKEN not set (${redact(error.message)}); set it with: ${secretCommand}`)
    }
  } else {
    log(`MARKETPLACE_TOKEN is not in the environment; set it with: ${secretCommand}`)
  }

  registerMod(root, { ...options, commit })
  log(`registered ${options.name} in ${SOURCES_PATH} and ${CATALOG_PATH}; next: npm run build, then commit and merge here`)
  return { dir, commit }
}

if (process.argv[1]?.endsWith('new_mod.mjs')) {
  try {
    const options = parseArgs(process.argv.slice(2))
    await newMod(resolve('.'), options)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
