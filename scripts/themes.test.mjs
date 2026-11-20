/**
 * Theme plugins from themes.json: the stager folds the listed ones into the
 * shipped catalog and copies their previews without shipping their code; the
 * check refuses a record a client could not trust.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkMarketplace } from './check_marketplace.mjs'
import { BUILTIN_DIR, HEADERS, INDEX_NAME, TARBALL_NAME, stageSite } from './stage_site.mjs'
import { readTarEntries } from './tar_read.mjs'
import { PREVIEW_MAX_BYTES } from './themes.mjs'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const RAW = `https://raw.githubusercontent.com/someone/pack/${SHA_B}/shots/cosmos.png`
const STAGE = { sourceCommit: 'abcdef0123456789', runId: '7', generatedAt: 'x' }
const WRAPPER = 'plugins-marketplace-abcdef0/'

const record = (name, extra = {}) => ({
  name,
  listed: false,
  repo: `someone/${name}`,
  path: '.',
  commit: SHA_A,
  version: '1.0.0',
  description: `${name}.`,
  author: 'Someone',
  looks: [{ id: name, name, preview: `previews/${name}/${name}.svg` }],
  ...extra,
})

/** A marketplace with one ordinary plugin, the given theme records, and a picture for every local preview not named `missing`. */
function scratchThemes(records) {
  const root = mkdtempSync(join(tmpdir(), 'plugins-marketplace-themes-'))
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'velloc', plugins: [{ name: 'alpha', description: 'alpha.', source: './plugins/alpha' }] }),
  )
  mkdirSync(join(root, 'plugins', 'alpha', '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, 'plugins', 'alpha', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'alpha', version: '1.0.0' }))
  writeFileSync(join(root, 'themes.json'), JSON.stringify({ version: 1, plugins: records }))
  for (const r of records) {
    for (const preview of [r.preview, ...(r.looks ?? []).map(look => look?.preview)]) {
      if (typeof preview !== 'string' || !/^previews\/[a-z0-9./-]+$/.test(preview) || preview.includes('..') || preview.includes('missing')) continue
      mkdirSync(join(root, preview, '..'), { recursive: true })
      writeFileSync(join(root, preview), `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${preview} --></svg>`)
    }
  }
  return root
}

/** The staged tarball's regular files, wrapper removed: `{ paths, catalog }`. */
function stagedTarball(out) {
  const entries = readTarEntries(readFileSync(join(out, BUILTIN_DIR, TARBALL_NAME))).filter(e => e.type === 'file')
  assert.ok(entries.every(e => e.path.startsWith(WRAPPER)))
  const files = new Map(entries.map(e => [e.path.slice(WRAPPER.length), e.content]))
  return { paths: [...files.keys()], catalog: JSON.parse(files.get('.claude-plugin/marketplace.json').toString('utf8')) }
}

const problemsOf = records => checkMarketplace(scratchThemes(records))

test('a listed theme is folded into the shipped catalog; an unlisted one is not', () => {
  const root = scratchThemes([
    record('rooted', {
      listed: true,
      official: true,
      title: 'Not published',
      preview: 'previews/rooted/cover.svg',
      looks: [
        { id: 'day', name: 'Day', description: 'Bright.', appearance: 'light', preview: 'previews/rooted/day.svg', use: { command: 'pick-look', args: 'day' } },
        { id: 'night', preview: RAW, extra: 'dropped' },
      ],
    }),
    record('nested', { listed: true, repo: 'someone/many', path: 'themes/nested', author: undefined, onEnable: { command: 'nested', args: 'on' } }),
    record('hidden'),
  ])
  const onDisk = readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8')
  const out = join(root, 'site')
  const index = stageSite(root, out, STAGE)

  const { paths, catalog } = stagedTarball(out)
  assert.deepEqual(catalog.plugins, [
    { name: 'alpha', description: 'alpha.', source: './plugins/alpha' },
    {
      name: 'rooted',
      description: 'rooted.',
      version: '1.0.0',
      category: 'theme',
      author: { name: 'Someone' },
      source: { source: 'github', repo: 'someone/rooted', sha: SHA_A },
      theme: {
        official: true,
        looks: [
          { id: 'day', name: 'Day', description: 'Bright.', appearance: 'light', preview: 'previews/rooted/day.svg', use: { command: 'pick-look', args: 'day' } },
          { id: 'night', preview: RAW },
        ],
      },
    },
    {
      name: 'nested',
      description: 'nested.',
      version: '1.0.0',
      category: 'theme',
      source: { source: 'git-subdir', url: 'https://github.com/someone/many', path: 'themes/nested', sha: SHA_A },
      theme: { looks: [{ id: 'nested', name: 'nested', preview: 'previews/nested/nested.svg' }], onEnable: { command: 'nested', args: 'on' } },
    },
  ])
  assert.equal(catalog.name, 'velloc')

  // No theme code, and no preview, travels in the tarball.
  assert.deepEqual(paths, ['.claude-plugin/marketplace.json', 'plugins/alpha/.claude-plugin/plugin.json'])

  // The catalog in the repository is untouched; the index still describes the tarball.
  assert.equal(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'), onDisk)
  const tarball = readFileSync(join(out, BUILTIN_DIR, TARBALL_NAME))
  assert.equal(index.sha256, createHash('sha256').update(tarball).digest('hex'))
  assert.equal(index.size, tarball.length)
  assert.deepEqual(JSON.parse(readFileSync(join(out, BUILTIN_DIR, INDEX_NAME), 'utf8')), index)
  assert.deepEqual(index.plugins, ['alpha'])

  // Exactly the listed looks' local previews are copied, byte for byte.
  for (const preview of ['previews/rooted/day.svg', 'previews/nested/nested.svg']) {
    assert.deepEqual(readFileSync(join(out, BUILTIN_DIR, preview)), readFileSync(join(root, preview)))
  }
  assert.equal(existsSync(join(out, BUILTIN_DIR, 'previews', 'hidden')), false)
  assert.equal(existsSync(join(out, BUILTIN_DIR, 'previews', 'rooted', 'cover.svg')), false)
  assert.match(HEADERS, /\/previews\/\*\n {2}! Cache-Control\n {2}Cache-Control: no-cache\n/)
  assert.match(HEADERS, /\/\*\n {2}! Cache-Control\n {2}Cache-Control: no-store\n$/)
})

test('with nothing listed the tarball is the one a tree without themes.json stages', () => {
  const withThemes = scratchThemes([record('hidden'), record('other')])
  const without = scratchThemes([])
  const a = stageSite(withThemes, join(withThemes, 'site'), STAGE)
  writeFileSync(join(without, 'themes.json'), '{ "version": 1, "plugins": [] }')
  const b = stageSite(without, join(without, 'site'), STAGE)
  assert.equal(a.sha256, b.sha256)
  assert.equal(existsSync(join(withThemes, 'site', BUILTIN_DIR, 'previews')), false)
  assert.deepEqual(stagedTarball(join(withThemes, 'site')).catalog.plugins.map(p => p.name), ['alpha'])
})

test('a valid themes.json passes, listed or not, and an invalid one is not staged', () => {
  assert.deepEqual(problemsOf([record('one', { listed: true }), record('two', { looks: [{ id: 'two', preview: RAW }] })]), [])
  const root = scratchThemes([record('one', { commit: 'abc' })])
  assert.throws(() => stageSite(root, join(root, 'site'), STAGE), /the check fails/)
})

test('the check refuses a name used twice or by another plugin', () => {
  assert.ok(problemsOf([record('one'), record('one')]).some(p => /"one" is listed twice/.test(p)))
  assert.ok(problemsOf([record('alpha')]).some(p => /"alpha" is also a plugin in \.claude-plugin\/marketplace\.json/.test(p)))
  const root = scratchThemes([record('pinned')])
  writeFileSync(join(root, 'sources.json'), JSON.stringify({ sources: [{ repo: 'o/r', commit: SHA_A, plugins: [{ name: 'pinned', path: '.' }] }] }))
  assert.ok(checkMarketplace(root).some(p => /themes\.json.*"pinned" is also a plugin in sources\.json/.test(p)))
})

test('the check refuses a bad repo, commit, path or version, on unlisted records too', () => {
  const refused = (extra, pattern) => assert.ok(problemsOf([record('one', extra)]).some(p => pattern.test(p)), `${JSON.stringify(extra)} -> ${pattern}`)
  refused({ repo: 'https://github.com/a/b' }, /"repo" must be "owner\/name"/)
  refused({ repo: 'justaname' }, /"repo"/)
  refused({ commit: 'A'.repeat(40) }, /"commit"/)
  refused({ commit: 'abc1234' }, /"commit"/)
  refused({ path: '../other' }, /"path"/)
  refused({ path: 'themes/../../x' }, /"path"/)
  refused({ path: '/abs' }, /"path"/)
  refused({ listed: 'yes' }, /"listed" must be a boolean/)
  refused({ listed: true, version: undefined }, /a listed theme needs a "version"/)
  refused({ version: 'latest' }, /"version" must be a semver string/)
  refused({ looks: [] }, /"looks"/)
  assert.deepEqual(problemsOf([record('one', { version: undefined })]), [])
})

test('the check refuses a bad look id, preview or use', () => {
  const look = extra => [record('one', { looks: [{ id: 'one', preview: 'previews/one/one.svg', ...extra }] })]
  const refused = (extra, pattern) => assert.ok(problemsOf(look(extra)).some(p => pattern.test(p)), `${JSON.stringify(extra)} -> ${pattern}`)
  refused({ id: 'Upper' }, /"id"/)
  refused({ id: '-lead' }, /"id"/)
  refused({ id: 'a_b' }, /"id"/)
  refused({ appearance: 'sepia' }, /"appearance"/)
  refused({ preview: undefined }, /"preview" is required/)
  refused({ preview: 'previews/one/missing.svg' }, /does not exist/)
  refused({ preview: 'previews/one/one.html' }, /must be a svg\/webp\/png\/jpg\/jpeg\/gif file under previews\//)
  refused({ preview: 'plugins/alpha/one.svg' }, /under previews\//)
  refused({ preview: 'previews/../themes.svg' }, /under previews\//)
  refused({ preview: 'https://raw.githubusercontent.com/someone/pack/main/cosmos.png' }, /pinned by a full commit sha/)
  refused({ preview: `https://example.com/someone/pack/${SHA_B}/cosmos.png` }, /raw\.githubusercontent\.com/)
  refused({ preview: `https://raw.githubusercontent.com/someone/pack/${SHA_B}/cosmos.js` }, /raw\.githubusercontent\.com/)
  refused({ use: { command: 'two words' } }, /"use\.command"/)
  refused({ use: { command: '/slash' } }, /"use\.command"/)
  refused({ use: {} }, /"use\.command"/)
  refused({ use: { command: 'pick', args: 'Has Space' } }, /"use\.args"/)
  refused({ use: { command: 'pick', args: 'x'.repeat(65) } }, /"use\.args"/)
  assert.deepEqual(problemsOf(look({ use: { command: 'pick' } })), [])
  assert.deepEqual(problemsOf(look({ use: { command: 'pick', args: '' } })), [])
  assert.ok(
    problemsOf([record('one', { looks: [{ id: 'same', preview: RAW }, { id: 'same', preview: RAW }] })]).some(p => /look "same" is listed twice/.test(p)),
  )
})

test('the check refuses an onEnable that is not one command word and one short argument', () => {
  const refused = (onEnable, pattern) =>
    assert.ok(problemsOf([record('one', { onEnable })]).some(p => pattern.test(p)), JSON.stringify(onEnable))
  refused('custom-theme', /"onEnable" must be an object/)
  refused({ command: '/custom-theme' }, /"onEnable\.command"/)
  refused({ command: 'two words' }, /"onEnable\.command"/)
  refused({ command: 'pick', args: 'ON; rm' }, /"onEnable\.args"/)
  refused({ command: 'pick', prompt: 'x' }, /takes command and args alone/)
  assert.deepEqual(problemsOf([record('one', { onEnable: { command: 'custom-theme' } })]), [])
  assert.deepEqual(problemsOf([record('one', { onEnable: { command: 'rainy-window', args: 'on' } })]), [])
})

test('the check refuses a local preview over the size limit', () => {
  const root = scratchThemes([record('one')])
  writeFileSync(join(root, 'previews', 'one', 'one.svg'), Buffer.alloc(PREVIEW_MAX_BYTES + 1, 0x20))
  assert.ok(checkMarketplace(root).some(p => /over the \d+ limit/.test(p)))
  writeFileSync(join(root, 'previews', 'one', 'one.svg'), Buffer.alloc(PREVIEW_MAX_BYTES, 0x20))
  assert.deepEqual(checkMarketplace(root), [])
})
