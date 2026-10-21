#!/usr/bin/env node
/**
 * Moves one repository's pin in sources.json:
 *   node scripts/bump_source.mjs <owner/repo> <40-hex commit> [root]
 * The repository must already be listed (adding one also means choosing its
 * plugins and writing their listings, which is done by hand). Prints
 * `unchanged` or `<old7> -> <new7>`; exit 1 on a bad argument.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SOURCES_PATH } from './sources.mjs'

const COMMIT = /^[0-9a-f]{40}$/

/** Returns `{ from, to }` (`from === to` when nothing changed). */
export function bumpSource(root, repo, commit) {
  if (typeof commit !== 'string' || !COMMIT.test(commit)) throw new Error(`bump: "${commit}" is not a full 40-character lowercase sha`)
  const file = join(root, SOURCES_PATH)
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const source = (parsed.sources ?? []).find(s => typeof s?.repo === 'string' && s.repo.toLowerCase() === String(repo).toLowerCase())
  if (!source) throw new Error(`bump: ${repo} is not in ${SOURCES_PATH}; add it and its listings by hand first`)
  const from = source.commit
  if (from !== commit) {
    source.commit = commit
    writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`)
  }
  return { from, to: commit }
}

if (process.argv[1]?.endsWith('bump_source.mjs')) {
  const [repo, commit, root = '.'] = process.argv.slice(2)
  try {
    const { from, to } = bumpSource(resolve(root), repo, commit)
    console.log(from === to ? 'unchanged' : `${String(from).slice(0, 7)} -> ${to.slice(0, 7)}`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
