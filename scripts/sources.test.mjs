/**
 * Plugins from other repositories: the fetch over a codeload-shaped tarball,
 * the check's pin and listing rules, the stager shipping them as
 * `plugins/<name>/`, and the pin bump.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'
import { bumpSource } from './bump_source.mjs'
import { checkMarketplace } from './check_marketplace.mjs'
import { codeloadUrl, fetchSources } from './fetch_sources.mjs'
import { TARBALL_NAME, stageSite } from './stage_site.mjs'
import { readTarEntries } from './tar_read.mjs'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function header(name, size, flag) {
  const block = Buffer.alloc(512, 0)
  block.write(name.slice(0, 100), 0, 'utf8')
  block.write('0000644\0', 100, 'ascii')
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  block.write('        ', 148, 'ascii')
  block.write(flag, 156, 'ascii')
  block.write('ustar\0', 257, 'ascii')
  block.write('00', 263, 'ascii')
  let sum = 0
  for (const b of block) sum += b
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return block
}

const padded = body => Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512, 0)])

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  let length = body.length + 1
  while (`${length}${body}`.length !== length) length += 1
  return `${length}${body}`
}

/** A gzip tar as codeload serves it: a pax global header, a wrapper directory, directory entries. */
function codeloadTarball(wrapper, entries) {
  const blocks = []
  const global = Buffer.from(paxRecord('comment', SHA_A))
  blocks.push(header('pax_global_header', global.length, 'g'), padded(global))
  blocks.push(header(`${wrapper}/`, 0, '5'))
  for (const entry of entries) {
    const path = `${wrapper}/${entry.path}`
    if (entry.link) {
      blocks.push(header(path, 0, '2'))
      continue
    }
    const body = Buffer.from(entry.content ?? '')
    if (Buffer.byteLength(path) > 100) {
      const pax = Buffer.from(paxRecord('path', path))
      blocks.push(header('PaxHeader', pax.length, 'x'), padded(pax))
    }
    blocks.push(header(path, body.length, '0'), padded(body))
  }
  blocks.push(Buffer.alloc(1024, 0))
  return gzipSync(Buffer.concat(blocks))
}

const manifest = (name, version) => JSON.stringify({ name, version })
const longName = `${'deep/'.repeat(25)}file.md`

/** `example/more-plugins`: plugins under plugins/<name>/. */
const REPO_FILES = [
  { path: 'README.md', content: 'repo readme' },
  { path: 'plugins/nested/.claude-plugin/plugin.json', content: manifest('nested', '2.1.0') },
  { path: `plugins/nested/${longName}`, content: 'long' },
]

/** `example/one-plugin`: the repository root is the plugin. */
const ROOT_FILES = [
  { path: 'README.md', content: 'repo readme' },
  { path: '.github/workflows/ci.yml', content: 'on: push' },
  { path: 'tests/rooted.test.mjs', content: 'test' },
  { path: 'package.json', content: '{}' },
  { path: 'package-lock.json', content: '{}' },
  { path: '.gitignore', content: 'node_modules/' },
  { path: 'docs/package.json', content: 'kept: only top-level entries are dev files' },
  { path: '.claude-plugin/plugin.json', content: manifest('rooted', '1.0.0') },
  { path: 'skills/hi/SKILL.md', content: '---\nname: hi\ndescription: hi\n---\n' },
]

function scratch({ local = ['alpha'], listed = ['alpha', 'rooted', 'nested'], sources }) {
  const root = mkdtempSync(join(tmpdir(), 'plugins-marketplace-sources-'))
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'velloc',
    plugins: listed.map(name => ({ name, description: `${name}.`, source: `./plugins/${name}` })),
  }))
  for (const name of local) {
    mkdirSync(join(root, 'plugins', name, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, 'plugins', name, '.claude-plugin', 'plugin.json'), manifest(name, '1.0.0'))
  }
  writeFileSync(join(root, 'sources.json'), JSON.stringify({
    sources: sources ?? [
      { repo: 'example/one-plugin', commit: SHA_B, plugins: [{ name: 'rooted', path: '.' }] },
      { repo: 'example/more-plugins', commit: SHA_A, plugins: [{ name: 'nested', path: 'plugins/nested' }] },
    ],
  }))
  return root
}

function fakeFetch(tarballs, seen = []) {
  return async (url, init) => {
    seen.push({ url, init })
    const body = tarballs[url]
    if (!body) return new Response('missing', { status: 404 })
    return new Response(body, { status: 200 })
  }
}

const served = (files = REPO_FILES, commit = SHA_A) => ({
  [codeloadUrl('example/one-plugin', SHA_B)]: codeloadTarball(`one-plugin-${SHA_B.slice(0, 7)}`, ROOT_FILES),
  [codeloadUrl('example/more-plugins', commit)]: codeloadTarball(`more-plugins-${commit.slice(0, 7)}`, files),
})

test('the tar reader follows pax paths and skips the global header', () => {
  const entries = readTarEntries(codeloadTarball('w', REPO_FILES))
  assert.equal(entries[0].path, 'w/')
  assert.equal(entries[0].type, 'dir')
  const long = entries.find(e => e.path.endsWith('file.md'))
  assert.equal(long.path, `w/plugins/nested/${longName}`)
  assert.equal(long.content.toString(), 'long')
  assert.ok(!entries.some(e => e.path === 'pax_global_header' || e.path === 'PaxHeader'))
})

test('fetches each plugin to .sources/<name>/, a root plugin without its development files', async () => {
  const root = scratch({})
  const seen = []
  const record = await fetchSources(root, { fetchImpl: fakeFetch(served(), seen), token: 't0k' })
  assert.deepEqual(record, {
    rooted: { repo: 'example/one-plugin', commit: SHA_B },
    nested: { repo: 'example/more-plugins', commit: SHA_A },
  })
  assert.equal(seen.length, 2, 'one download per repository')
  assert.equal(seen[0].init.headers.authorization, 'Bearer t0k')
  assert.ok(existsSync(join(root, '.sources', 'rooted', 'README.md')))
  assert.ok(existsSync(join(root, '.sources', 'rooted', 'skills', 'hi', 'SKILL.md')))
  for (const dev of ['.github', 'tests', 'package.json', 'package-lock.json', '.gitignore']) {
    assert.ok(!existsSync(join(root, '.sources', 'rooted', dev)), dev)
  }
  assert.ok(existsSync(join(root, '.sources', 'rooted', 'docs', 'package.json')))
  assert.equal(readFileSync(join(root, '.sources', 'nested', ...longName.split('/')), 'utf8'), 'long')
  assert.ok(!existsSync(join(root, '.sources', 'nested', 'plugins')))
  assert.deepEqual(checkMarketplace(root), [])
})

test('a link, a missing path or an HTTP error fails the fetch', async () => {
  const root = scratch({})
  await assert.rejects(
    fetchSources(root, { fetchImpl: fakeFetch(served([...REPO_FILES, { path: 'plugins/nested/evil', link: true }])) }),
    /plugins\/nested\/evil is a link/,
  )
  await assert.rejects(
    fetchSources(root, { fetchImpl: fakeFetch(served(REPO_FILES.filter(f => !f.path.startsWith('plugins/')))) }),
    /no files under "plugins\/nested"/,
  )
  await assert.rejects(fetchSources(root, { fetchImpl: fakeFetch({}) }), /HTTP 404/)
})

test('the check wants a fetch that matches the pin, one home per plugin, and a listing per source', async () => {
  const root = scratch({})
  assert.ok(checkMarketplace(root).some(p => /rooted.*not fetched; run npm run fetch/.test(p)))
  await fetchSources(root, { fetchImpl: fakeFetch(served()) })
  const sources = JSON.parse(readFileSync(join(root, 'sources.json'), 'utf8'))
  sources.sources[1].commit = SHA_B
  writeFileSync(join(root, 'sources.json'), JSON.stringify(sources))
  assert.ok(checkMarketplace(root).some(p => /fetched from example\/more-plugins@aaaaaaa, sources\.json pins example\/more-plugins@bbbbbbb/.test(p)))

  const both = scratch({ local: ['alpha', 'nested'] })
  await fetchSources(both, { fetchImpl: fakeFetch(served()) })
  assert.ok(checkMarketplace(both).some(p => /plugins\/nested\/ exists and sources\.json also names it/.test(p)))

  const orphan = scratch({ listed: ['alpha', 'rooted'] })
  await fetchSources(orphan, { fetchImpl: fakeFetch(served()) })
  assert.ok(checkMarketplace(orphan).some(p => /"nested" from example\/more-plugins has no listing/.test(p)))
})

test('the check refuses a malformed sources.json', () => {
  const root = scratch({
    listed: ['alpha'],
    sources: [
      { repo: 'not a repo', commit: SHA_A, plugins: [{ name: 'x', path: '.' }] },
      { repo: 'example/one', commit: 'main', plugins: [{ name: 'y', path: '../up' }] },
      { repo: 'Example/One', commit: SHA_A, plugins: [] },
    ],
  })
  const problems = checkMarketplace(root)
  assert.ok(problems.some(p => /"repo" must be "owner\/name"/.test(p)))
  assert.ok(problems.some(p => /"commit" must be a full 40-character/.test(p)))
  assert.ok(problems.some(p => /"path" must be "\." or a relative path/.test(p)))
  assert.ok(problems.some(p => /listed twice; one repository has one pin/.test(p)))
  assert.ok(problems.some(p => /"plugins" must be a non-empty array/.test(p)))
})

test('a fetched plugin ships as plugins/<name>/ and the index names its pin', async () => {
  const root = scratch({})
  await fetchSources(root, { fetchImpl: fakeFetch(served()) })
  const out = join(root, 'site')
  const index = stageSite(root, out, { sourceCommit: 'abcdef0123', runId: '7', generatedAt: 'x' })
  assert.deepEqual(index.sources, [
    { repo: 'example/one-plugin', commit: SHA_B, plugins: ['rooted'] },
    { repo: 'example/more-plugins', commit: SHA_A, plugins: ['nested'] },
  ])
  const paths = readTarEntries(readFileSync(join(out, TARBALL_NAME))).map(e => e.path.slice('plugins-marketplace-abcdef0/'.length))
  assert.deepEqual(paths, [
    '.claude-plugin/marketplace.json',
    'plugins/alpha/.claude-plugin/plugin.json',
    'plugins/nested/.claude-plugin/plugin.json',
    `plugins/nested/${longName}`,
    'plugins/rooted/.claude-plugin/plugin.json',
    'plugins/rooted/README.md',
    'plugins/rooted/docs/package.json',
    'plugins/rooted/skills/hi/SKILL.md',
  ])
  assert.ok(!gunzipSync(readFileSync(join(out, TARBALL_NAME))).includes(Buffer.from('fetched.json')))
})

test('the bump moves one listed pin and refuses the rest', () => {
  const root = scratch({})
  assert.deepEqual(bumpSource(root, 'Example/More-Plugins', SHA_B), { from: SHA_A, to: SHA_B })
  assert.equal(JSON.parse(readFileSync(join(root, 'sources.json'), 'utf8')).sources[1].commit, SHA_B)
  assert.deepEqual(bumpSource(root, 'example/more-plugins', SHA_B), { from: SHA_B, to: SHA_B })
  assert.throws(() => bumpSource(root, 'example/elsewhere', SHA_B), /not in sources\.json/)
  assert.deepEqual(bumpSource(root, 'example/elsewhere', SHA_B, { ifListed: true }), { listed: false })
  assert.throws(() => bumpSource(root, 'example/more-plugins', 'HEAD'), /not a full 40-character/)
})
