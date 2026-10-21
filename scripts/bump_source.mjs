#!/usr/bin/env node
/**
 * Moves one repository's pin in sources.json:
 *   node scripts/bump_source.mjs [--if-listed] <owner/repo> <40-hex commit> [root]
 * The repository must already be listed (scripts/new_mod.mjs or a hand edit
 * adds it with its listings). `--if-listed` turns an unlisted repository into
 * `not listed`, exit 0. Prints `unchanged` or `<old7> -> <new7>`; exit 1 on a
 * bad argument.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SOURCES_PATH } from './sources.mjs'

const COMMIT = /^[0-9a-f]{40}$/

/** Returns `{ from, to }` (`from === to` when nothing changed), or `{ listed: false }` with `ifListed`. */
export function bumpSource(root, repo, commit, options = {}) {
  if (typeof commit !== 'string' || !COMMIT.test(commit)) throw new Error(`bump: "${commit}" is not a full 40-character lowercase sha`)
  const file = join(root, SOURCES_PATH)
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const source = (parsed.sources ?? []).find(s => typeof s?.repo === 'string' && s.repo.toLowerCase() === String(repo).toLowerCase())
  if (!source) {
    if (options.ifListed) return { listed: false }
    throw new Error(`bump: ${repo} is not in ${SOURCES_PATH}; add it and its listings first`)
  }
  const from = source.commit
  if (from !== commit) {
    source.commit = commit
    writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`)
  }
  return { from, to: commit }
}

if (process.argv[1]?.endsWith('bump_source.mjs')) {
  const args = process.argv.slice(2)
  const ifListed = args[0] === '--if-listed'
  const [repo, commit, root = '.'] = ifListed ? args.slice(1) : args
  try {
    const result = bumpSource(resolve(root), repo, commit, { ifListed })
    if (result.listed === false) console.log(`not listed: ${repo} is not in ${SOURCES_PATH} on this branch yet`)
    else console.log(result.from === result.to ? 'unchanged' : `${String(result.from).slice(0, 7)} -> ${result.to.slice(0, 7)}`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
