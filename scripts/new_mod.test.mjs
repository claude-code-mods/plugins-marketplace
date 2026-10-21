/**
 * The new-mod scaffold with `gh` and `git` replaced: the placeholders it
 * renames, what it registers, the commands it runs, and the token handling.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkMarketplace } from './check_marketplace.mjs'
import { TEMPLATE_DESCRIPTION, TEMPLATE_NAME, TEMPLATE_REPO, assertNewName, newMod, originRepo, parseArgs } from './new_mod.mjs'

const SHA = 'c'.repeat(40)

function marketplace() {
  const root = mkdtempSync(join(tmpdir(), 'new-mod-'))
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'velloc', plugins: [{ name: 'taken', description: 't', source: './plugins/taken' }] }))
  mkdirSync(join(root, 'plugins', 'taken', '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, 'plugins', 'taken', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'taken', version: '1.0.0' }))
  writeFileSync(join(root, 'sources.json'), JSON.stringify({ sources: [] }))
  return root
}

/** Writes what a clone of the template holds. */
function writeTemplate(dir) {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'HEAD'), `untouched ${TEMPLATE_NAME}`)
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: TEMPLATE_NAME, version: '0.1.0', description: TEMPLATE_DESCRIPTION }))
  writeFileSync(join(dir, 'README.md'), `# ${TEMPLATE_NAME}\n\n${TEMPLATE_DESCRIPTION}\n`)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: TEMPLATE_NAME }))
}

function fakeRun({ failClones = 0 } = {}) {
  const calls = []
  let clones = 0
  const run = (command, args, opts = {}) => {
    calls.push({ command, args, input: opts.input })
    if (command === 'git' && args[0] === 'clone') {
      clones += 1
      if (clones <= failClones) throw new Error('git clone failed: empty repository')
      writeTemplate(args[2])
    }
    if (command === 'git' && args[0] === 'rev-parse') return SHA
    if (command === 'git' && args[2] === 'remote') return 'https://github.com/Example/the-marketplace.git'
    return ''
  }
  return { run, calls }
}

const options = extra => parseArgs(['fresh-mod', '--description', 'Says "hi" in the status line.', ...extra])

test('creates the repository from the template, renames it, pushes, and registers it', async () => {
  const root = marketplace()
  const dir = join(root, '..', `scaffold-${Date.now()}`)
  const { run, calls } = fakeRun({ failClones: 2 })
  const lines = []
  const out = await newMod(root, { ...options(['--beta', '--off']), dir }, { run, log: l => lines.push(l), token: 's3cret', waitMs: 1 })
  assert.equal(out.commit, SHA)

  assert.equal(calls[0].args.join(' '), `-C ${root} remote get-url origin`, 'the marketplace is resolved before anything is created')
  assert.deepEqual(calls[1].args.slice(0, 5), ['repo', 'create', 'VellocLabs/fresh-mod', '--public', '--template'])
  assert.equal(calls[1].args[5], TEMPLATE_REPO)
  const variable = calls.find(c => c.command === 'gh' && c.args[0] === 'variable')
  assert.deepEqual(variable.args, ['variable', 'set', 'MARKETPLACE_REPO', '--repo', 'VellocLabs/fresh-mod', '--body', 'Example/the-marketplace'])
  assert.equal(calls.filter(c => c.args[0] === 'clone').length, 3, 'retried until the template was there')
  assert.ok(calls.some(c => c.command === 'git' && c.args.join(' ') === 'push -q origin HEAD:main'))
  const secret = calls.find(c => c.command === 'gh' && c.args[0] === 'secret')
  assert.deepEqual(secret.args, ['secret', 'set', 'MARKETPLACE_TOKEN', '--repo', 'VellocLabs/fresh-mod'])
  assert.equal(secret.input, 's3cret')
  assert.ok(!lines.join('\n').includes('s3cret'), 'the token is never logged')

  const manifest = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.equal(manifest.name, 'fresh-mod')
  assert.equal(manifest.description, 'Says "hi" in the status line.')
  assert.equal(manifest.version, '0.1.0')
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), '# fresh-mod\n\nSays "hi" in the status line.\n')
  assert.equal(readFileSync(join(dir, '.git', 'HEAD'), 'utf8'), `untouched ${TEMPLATE_NAME}`)

  assert.deepEqual(JSON.parse(readFileSync(join(root, 'sources.json'), 'utf8')).sources, [
    { repo: 'VellocLabs/fresh-mod', commit: SHA, plugins: [{ name: 'fresh-mod', path: '.' }] },
  ])
  const listing = JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8')).plugins.at(-1)
  assert.deepEqual(listing, { name: 'fresh-mod', description: 'Says "hi" in the status line.', source: './plugins/fresh-mod', category: 'mods', onByDefault: false, betaOnly: true })
  assert.ok(checkMarketplace(root).some(p => /fresh-mod.*not fetched; run npm run fetch/.test(p)), 'the next build fetches it')
})

test('without a token it says how to set one and sets nothing', async () => {
  const root = marketplace()
  const { run, calls } = fakeRun()
  const lines = []
  await newMod(root, { ...options([]), dir: join(root, '..', `scaffold-nt-${Date.now()}`) }, { run, log: l => lines.push(l), token: '', waitMs: 1 })
  assert.ok(!calls.some(c => c.args[0] === 'secret'))
  assert.ok(lines.some(l => /gh secret set MARKETPLACE_TOKEN --repo VellocLabs\/fresh-mod/.test(l)))
})

test('a token without Actions access still creates and registers the mod, and says what to run', async () => {
  const root = marketplace()
  const { run: base, calls } = fakeRun()
  const run = (command, args, opts) => {
    if (command === 'gh' && (args[0] === 'variable' || args[0] === 'secret')) {
      calls.push({ command, args })
      throw new Error(`gh ${args[0]} failed: HTTP 403 for s3cret`)
    }
    return base(command, args, opts)
  }
  const lines = []
  await newMod(root, { ...options([]), dir: join(root, '..', `scaffold-403-${Date.now()}`) }, { run, log: l => lines.push(l), token: 's3cret', waitMs: 1 })
  assert.ok(lines.some(l => /set it with: gh variable set MARKETPLACE_REPO --repo VellocLabs\/fresh-mod --body Example\/the-marketplace/.test(l)))
  assert.ok(lines.some(l => /MARKETPLACE_TOKEN not set .*set it with: gh secret set MARKETPLACE_TOKEN/.test(l)))
  assert.ok(!lines.join('\n').includes('s3cret'), 'the token is never logged')
  assert.equal(JSON.parse(readFileSync(join(root, 'sources.json'), 'utf8')).sources.length, 1)
  const listing = JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8')).plugins.at(-1)
  assert.equal(listing.onByDefault, undefined)
  assert.equal(listing.betaOnly, undefined)
})

test('refuses a taken name before touching GitHub, and bad arguments', async () => {
  const root = marketplace()
  const { run, calls } = fakeRun()
  await assert.rejects(newMod(root, parseArgs(['taken', '--description', 'x']), { run, log: () => {} }), /already listed/)
  assert.equal(calls.length, 0)
  assert.throws(() => assertNewName(root, '../up'), /not a plugin folder name/)
  assert.throws(() => originRepo(root, () => 'https://gitlab.com/a/b.git'), /not a GitHub repository/)
  assert.equal(originRepo(root, () => 'git@github.com:Owner/Repo.git'), 'Owner/Repo')
  assert.throws(() => parseArgs(['x']), /--description is required/)
  assert.throws(() => parseArgs(['x', '--description', 'd', '--repo', 'no-owner']), /must be owner\/name/)
  assert.throws(() => parseArgs(['x', 'y', '--description', 'd']), /usage/)
  assert.equal(parseArgs(['x', '--description', 'd', '--repo', 'Other/X-Mod']).repo, 'Other/X-Mod')
})
