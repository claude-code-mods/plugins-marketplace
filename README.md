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
themes.json                          theme plugins in other repositories; the `listed` ones are published
previews/<name>/                     the preview pictures themes.json names
scripts/fetch_sources.mjs            downloads them into .sources/<name>/ (never committed)
scripts/bump_source.mjs              moves one repository's pin
scripts/new_mod.mjs                  starts a mod in its own repository and registers it
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

A plugin may live in another public GitHub repository; the usual shape is one
mod per repository with the plugin at its root (`VellocLabs/Nebius-Mod`).
`sources.json` pins each repository to one commit and names the plugins
taken from it:

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
  repository root is the plugin, without its top-level `.github/`, `tests/`,
  `node_modules/`, `package.json`, `package-lock.json` and `.gitignore`.
- Every plugin named here also needs its listing in
  `.claude-plugin/marketplace.json` (`source: "./plugins/<name>"`, plus
  `description`, `onByDefault`, `betaOnly`), and no `plugins/<name>/`
  folder of its own here.
- `npm run fetch` downloads each repository at its commit from GitHub's
  codeload and writes the plugins to `.sources/<name>/`; the check reads
  them there and refuses a fetch that does not match the pin. The stager
  ships them as `plugins/<name>/`, and `index.json` lists the pins under
  `sources`.

A new mod, in one command (needs `gh` signed in):

```bash
MARKETPLACE_TOKEN=<token> node scripts/new_mod.mjs <name> --description "<one line>" \
  [--repo VellocLabs/<Repo>] [--dir <path>] [--category mods] [--off] [--beta]
```

It creates the repository from the template `VellocLabs/mod-template` (root
layout, an example hook, tests, CI, the pin workflow), renames the
template's placeholders, pushes, sets `MARKETPLACE_REPO` and, when the
environment has it, the `MARKETPLACE_TOKEN` secret, and adds the repository to `sources.json` and its listing
to the catalog. `--off` installs it switched off, `--beta` lists it on the
beta channel only. Then `npm run build`, commit, and merge here.

A source repository carries the variable `MARKETPLACE_REPO` (this
repository's owner/name) and the secret `MARKETPLACE_TOKEN` (a fine-grained
token on this repository with Contents and Pull requests read/write). With
them, every push to a source repository's
`main` opens, or moves, one pull request here that changes the pin
(`templates/bump-marketplace-pin.yml`, which the template carries); CI
fetches and checks it, and merging it is the release. Without either, or
before the repository is listed on `main` here, the workflow does nothing.
By hand: `node scripts/bump_source.mjs owner/name <sha>`. An existing
repository joins the same way: its entry in `sources.json`, its listing,
and the workflow copied into its `.github/workflows/`.

The version rule holds there too: a client upgrades an installed plugin
only when its `plugin.json` `version` is higher, so a change in the other
repository bumps it before it is pinned here.

## Themes

`themes.json` records theme plugins that live in other GitHub repositories.
A script outside this repository maintains it; nothing here rewrites it.

```json
{
  "version": 1,
  "plugins": [
    {
      "name": "a-theme", "listed": false,
      "repo": "owner/name", "path": ".", "commit": "<full 40-character sha>",
      "version": "1.0.0", "description": "One line.", "author": "Who",
      "looks": [
        { "id": "night", "name": "Night", "appearance": "dark",
          "preview": "previews/a-theme/night.svg",
          "use": { "command": "pick-look", "args": "night" } }
      ]
    }
  ]
}
```

- `listed` decides publication. `false` keeps the record here and publishes
  nothing; `true` (which needs a `version`) publishes it with the next build.
- The stager adds one listing per listed record to the `marketplace.json`
  inside the tarball; `.claude-plugin/marketplace.json` in this repository
  is not changed. The listing has `category: "theme"`, a `theme` block with
  the looks as written, and a `source` a client installs from directly:
  `{ "source": "github", "repo", "sha" }` when `path` is `.`, otherwise
  `{ "source": "git-subdir", "url": "https://github.com/<repo>", "path", "sha" }`.
- A theme's code is never shipped: no `plugins/<name>/` folder, no entry in
  `sources.json`, and it is not in `index.json` `plugins`. A client shows it
  in its theme directory and installs it only when the person picks it.
- A look's `preview` is a picture under `previews/` here (svg, webp, png,
  jpg, jpeg or gif, at most 1.5 MB) or a
  `https://raw.githubusercontent.com/<owner>/<repo>/<40-hex sha>/...` address.
  The local pictures of listed records are copied to `site/previews/` and
  served at the same relative path.
- The check validates every record, listed or not: names unique and not used
  by the catalog or `sources.json`, `repo` as `owner/name`, a full commit
  sha, a `path` inside the repository, look ids `[a-z0-9][a-z0-9-]*` unique
  per plugin, `use.command` one word and `use.args` `[a-z0-9-]{0,64}`.

## What the origin serves

| Path | Content | Cache |
| --- | --- | --- |
| `/marketplace.tar.gz` | this repository's `.claude-plugin/` and `plugins/`, plus every fetched plugin as `plugins/<name>/`, as a gzip tar with one wrapper directory | `no-cache` |
| `/index.json` | `{ name, buildId, generatedAt, sourceCommit, tarball, sha256, size, plugins, sources }` | `no-cache` |
| `/previews/<name>/<file>` | the preview pictures of the listed themes | `no-cache` |

Any other path is a 404.

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
