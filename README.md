# Velloc marketplace

The plugins and mods Velloc installs on its own. One catalog, one origin,
released on its own cadence: Velloc's runtime holds nothing but the origin's
address and reads two files from it. Plugins live here or in other GitHub
repositories pinned by `sources.json`; both ship in the one tarball.

Repository: `claude-code-mods/plugins-marketplace`. Origin: `https://plugins.velloc.app`,
the custom domain of the `plugins-marketplace` worker. The owner block in
`.claude-plugin/marketplace.json` names the publisher.

## Layout

```
.claude-plugin/marketplace.json      the catalog: name "velloc", one listing per plugin
plugins/<name>/                      one folder per plugin, named in the catalog as ./plugins/<name>
plugins/<name>/.claude-plugin/plugin.json   name (= folder), version (required), description
plugins/<name>/skills/<skill>/SKILL.md      a skill plugin
plugins/<name>/hooks/hooks.json             a mod: {"modules": ["./register.js"]} beside register.js
sources.json                         plugins kept in other GitHub repositories, each pinned to a commit
scripts/fetch_sources.mjs            downloads them into .sources/<name>/ (never committed)
scripts/bump_source.mjs              moves one repository's pin
scripts/check_marketplace.mjs        the gate every change passes
scripts/stage_site.mjs               builds site/ (what the origin serves)
templates/bump-marketplace-pin.yml   the workflow a source repository copies
worker/asset_gateway.mjs             the worker in front of the static files
wrangler.toml                        the Cloudflare worker
.github/workflows/                   ci.yml (check and dry stage on every push)
```

## A listing

```json
{
  "name": "velloc-starter-skills",
  "description": "What a listing says about itself.",
  "source": "./plugins/velloc-starter-skills",
  "onByDefault": true,
  "betaOnly": false
}
```

- `source` is always a `./plugins/<name>` path: the whole marketplace
  travels as one tarball, so an install needs no second download. The
  folder is either in this repository or fetched from another one
  (see *Plugins from other repositories*); a client cannot tell them apart.
- `onByDefault` (default `true`): `false` installs the plugin switched off;
  the person turns it on in Settings → Plugins & Mods.
- `betaOnly` (default `false`): `true` lists and installs the plugin only
  on the beta channel.
- `version` in the plugin's `plugin.json` is mandatory. It names the folder
  the plugin is installed into and is what a client compares to decide an
  upgrade. Bump it with every change to the plugin.

## Plugins from other repositories

A plugin may live in another public GitHub repository. `sources.json` pins
that repository to one commit and names the plugins taken from it:

```json
{
  "sources": [
    {
      "repo": "owner/name",
      "commit": "<full 40-character sha>",
      "plugins": [
        { "name": "one", "path": "plugins/one" },
        { "name": "two", "path": "." }
      ]
    }
  ]
}
```

- `path` is the plugin's folder in that repository; `.` means the
  repository root is the plugin (its `.github/` is left out).
- Every plugin named here also needs its listing in
  `.claude-plugin/marketplace.json` (`source: "./plugins/<name>"`, plus
  `description`, `onByDefault`, `betaOnly`), and no `plugins/<name>/`
  folder of its own here.
- `npm run fetch` downloads each repository at its commit from GitHub's
  codeload and writes the plugins to `.sources/<name>/`; the check reads
  them there and refuses a fetch that does not match the pin. The stager
  ships them as `plugins/<name>/`, and `index.json` lists the pins under
  `sources`.

Adding a repository: add its entry to `sources.json` and its listings to
the catalog, then copy `templates/bump-marketplace-pin.yml` into that
repository's `.github/workflows/` and give it the secret
`MARKETPLACE_TOKEN` (a fine-grained token on this repository with Contents
and Pull requests read/write). From then on every push to its `main`
opens, or moves, one pull request here that changes the pin; CI fetches and
checks it, and merging it is the release. By hand:
`node scripts/bump_source.mjs owner/name <sha>`.

The version rule holds there too: a client upgrades an installed plugin
only when its `plugin.json` `version` is higher, so a change in the other
repository bumps it before it is pinned here.

## What the origin serves

| Path | Content | Cache |
| --- | --- | --- |
| `/marketplace.tar.gz` | this repository's `.claude-plugin/` and `plugins/`, plus every fetched plugin as `plugins/<name>/`, as a gzip tar with one wrapper directory | `no-cache` |
| `/index.json` | `{ name, buildId, generatedAt, sourceCommit, tarball, sha256, size, plugins, sources }` | `no-cache` |

A client downloads the tarball on its first start, then reads `index.json`
once a day and downloads again only when `buildId` changed, checking
`sha256`. New listings are installed by their defaults; installed plugins
with a newer `version` are upgraded; a plugin the person uninstalled or
switched off is left alone.

## Working on it

```bash
npm ci                                  # wrangler, for a local deploy only
node scripts/fetch_sources.mjs          # writes .sources/ from sources.json
node scripts/check_marketplace.mjs      # the gate
node scripts/stage_site.mjs             # writes site/
npm test                                # the scripts' own tests
```

To try a build against a Velloc profile without publishing: serve `site/`
with any static server, point the `velloc` entry of
`~/.velloc/plugins/known_marketplaces.json` at `http://<host>/marketplace.tar.gz`,
and start Velloc. A client that already ran once re-checks after a day;
set `lastCheckedAt` in `~/.velloc/plugins/builtin_marketplace.json` back
to force the check.

## Releasing

Cloudflare Workers Builds deploys this repository: every push to `main` is
a release.

1. Bump `version` in the changed plugin's `plugin.json` — a client upgrades
   only to a higher version.
2. Push to `main` (or merge a pin pull request). Workers Builds runs
   `npm run build` (fetch, check, tests, stage) and `npx wrangler deploy`;
   a failing fetch or check deploys nothing.
   GitHub CI runs the same check on every push and pull request.
3. Clients pick the build up within a day (`index.json` `buildId` is
   `<commit7>-<build8>`).
4. A bad build: Cloudflare dashboard → the `plugins-marketplace` worker →
   Deployments → roll back to an earlier version. Clients that already
   upgraded keep the higher version; ship a fix with a higher version.

One-time setup (Workers & Pages → Create → Import a repository): project
name `plugins-marketplace` (it must equal `name` in `wrangler.toml`), build
command `npm run build`, deploy command `npx wrangler deploy`, preview
builds off, Cloudflare Access off; then the custom domain
`plugins.velloc.app` on the worker.
