#!/usr/bin/env node
/**
 * Builds `site/` (refuses a tree the check does not pass):
 *   marketplace.tar.gz   `.claude-plugin/`, `plugins/` and each fetched plugin as `plugins/<name>/`,
 *                        a gzip POSIX tar under one wrapper directory; sorted, mtime 0, reproducible
 *   index.json           { name, buildId, generatedAt, sourceCommit, tarball, sha256, size, plugins, sources }
 *   _headers             both files `no-cache`; everything else `no-store`
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, posix, relative, resolve, sep } from 'node:path'
import { execSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { CATALOG_PATH, checkMarketplace } from './check_marketplace.mjs'
import { FETCHED_DIR, readSources } from './sources.mjs'

export const TARBALL_NAME = 'marketplace.tar.gz'
export const INDEX_NAME = 'index.json'
const SHIPPED_DIRS = ['.claude-plugin', 'plugins']

/**
 * Every regular file the tarball holds, sorted by `path` (posix, as shipped);
 * `file` is where it is read from. A fetched plugin's `.sources/<name>/x` ships
 * as `plugins/<name>/x`.
 */
export function shippedFiles(root) {
  const out = []
  const walk = (dir, shipAs) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, shipAs)
      else if (entry.isFile()) out.push({ path: shipAs(relative(root, full).split(sep).join(posix.sep)), file: full })
    }
  }
  for (const dir of SHIPPED_DIRS) walk(join(root, dir), path => path)
  for (const name of readSources(root).plugins.keys()) {
    walk(join(root, FETCHED_DIR, name), path => `plugins/${path.slice(FETCHED_DIR.length + 1)}`)
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

function ustarHeader(name, size) {
  const header = Buffer.alloc(512, 0)
  // A path over 100 bytes splits at a slash into prefix (155) + name (100).
  let prefix = ''
  let base = name
  if (Buffer.byteLength(base) > 100) {
    const at = base.lastIndexOf('/', 100)
    if (at <= 0) throw new Error(`stage: path too long for a tar header: ${name}`)
    prefix = base.slice(0, at)
    base = base.slice(at + 1)
    if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(base) > 100) throw new Error(`stage: path too long for a tar header: ${name}`)
  }
  header.write(base, 0, 'utf8')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.write('        ', 148, 'ascii')
  header.write('0', 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  if (prefix) header.write(prefix, 345, 'utf8')
  let sum = 0
  for (let i = 0; i < 512; i += 1) sum += header[i]
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return header
}

/** The tarball bytes: each of `files` (`{ path, file }`, see shippedFiles) under `wrapper/`. */
export function buildTarball(files, wrapper) {
  const blocks = []
  for (const { path, file } of files) {
    const content = readFileSync(file)
    blocks.push(ustarHeader(`${wrapper}/${path}`, content.length), content)
    const pad = (512 - (content.length % 512)) % 512
    if (pad > 0) blocks.push(Buffer.alloc(pad, 0))
  }
  blocks.push(Buffer.alloc(1024, 0))
  return gzipSync(Buffer.concat(blocks), { level: 9 })
}

export const HEADERS = `# The two files a client reads: the edge revalidates every request, so a
# new build is seen within one round trip and an old one is never pinned.
/${INDEX_NAME}
  ! Cache-Control
  Cache-Control: no-cache
  Access-Control-Allow-Origin: *
/${TARBALL_NAME}
  ! Cache-Control
  Cache-Control: no-cache
  Access-Control-Allow-Origin: *
/*
  ! Cache-Control
  Cache-Control: no-store
`

const COMMIT_SHA = /^[0-9a-f]{7,40}$/i

/** The commit being staged: a CI-provided sha when it is one, else the checkout's HEAD. */
export function sourceCommit(root) {
  const fromCi = [process.env.SOURCE_COMMIT, process.env.WORKERS_CI_COMMIT_SHA].find(v => v && COMMIT_SHA.test(v))
  if (fromCi) return fromCi
  try {
    return execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'unknown'
  }
}

/** Stage `root` into `outDir`; returns the index written. */
export function stageSite(root, outDir, options = {}) {
  const problems = checkMarketplace(root)
  if (problems.length > 0) throw new Error(`stage: the check fails:\n${problems.map(p => `  ${p}`).join('\n')}`)
  const commit = options.sourceCommit ?? sourceCommit(root)
  const short = commit.slice(0, 7)
  const runId = options.runId ?? process.env.GITHUB_RUN_ID ?? process.env.WORKERS_CI_BUILD_UUID?.slice(0, 8) ?? 'local'
  const catalog = JSON.parse(readFileSync(join(root, CATALOG_PATH), 'utf8'))
  const files = shippedFiles(root)
  const tarball = buildTarball(files, `plugins-marketplace-${short}`)
  const index = {
    name: catalog.name,
    buildId: `${short}-${runId}`,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sourceCommit: commit,
    tarball: TARBALL_NAME,
    sha256: createHash('sha256').update(tarball).digest('hex'),
    size: tarball.length,
    plugins: catalog.plugins.map(p => p.name),
    sources: readSources(root).sources.map(s => ({ repo: s.repo, commit: s.commit, plugins: s.plugins.map(p => p.name) })),
  }
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, TARBALL_NAME), tarball)
  writeFileSync(join(outDir, INDEX_NAME), `${JSON.stringify(index, null, 2)}\n`)
  writeFileSync(join(outDir, '_headers'), HEADERS)
  return index
}

if (process.argv[1]?.endsWith('stage_site.mjs')) {
  const root = resolve(process.argv[2] ?? '.')
  const outDir = resolve(process.argv[3] ?? join(root, 'site'))
  try {
    const index = stageSite(root, outDir)
    console.log(`staged ${index.buildId}: ${index.plugins.length} plugins, ${index.size} bytes, sha256 ${index.sha256.slice(0, 12)}… -> ${outDir}`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
  void statSync
}
