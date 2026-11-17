# KnobDeck app site

What the desktop app and plugins call, at https://app.knobdeck.harshalkudale.com. A plain Cloudflare
Worker with static assets, kept apart from the landing/payments site (`konbdeck-website`) so registry
updates never redeploy checkout or licensing.

| Path | What |
|---|---|
| `/v2/index.json` (+ `.minisig`) | Plugin catalog: one entry per plugin, latest allowed version per OS (apps with v2 support) |
| `/v2/plugins/<id>.json` | Plugin detail: actions, versions, changelog |
| `/v2/policy.json` (+ `.minisig`) | Kill switches: disabled actions/plugins, yanked versions, minimum app versions |
| `/v2/companions.json`, `/v2/themes.json` | Companion store links and versions; theme registry |
| `/plugins/registry.json` | v1 plugin registry, generated from the catalog (older apps, website `/plugins`) |
| `/plugins/<id>/readme.md` | Plugin readmes, the registries' `readmeUrl` |
| `/themes/registry.json` | Dial theme registry |
| `/profiles/registry.json`, `/profiles/<id>/profile.json` | Profile registry (Get Profiles in the app), served from `knobdeck-profiles` master by the Worker, cached 5 minutes |
| `POST /api/google/token` | OAuth token form (`authorization_code` with PKCE, or `refresh_token`) → Google tokens for the YouTube plugin; holds the client secret |

## Develop and deploy

```bash
npm install
cp .dev.vars.example .dev.vars   # local secrets
npm run dev
npx wrangler secret put GOOGLE_CLIENT_SECRET
npm run deploy
```

The Google OAuth client (Desktop app, id in `wrangler.jsonc`) is used only with
`http://127.0.0.1:47812/callback`.

## Catalog

This repo is the catalog (`PLUGIN_INFRA_PLAN.md` in the app repo): `catalog/` holds the sources,
`scripts/build.mjs` resolves them against GitHub Releases and writes `public/`, and
`.github/workflows/catalog.yml` runs it and commits; the push redeploys. Output format:
[`catalog/SCHEMA.md`](catalog/SCHEMA.md). Bundles and theme zips stay on the GitHub Releases.

| Source | What |
|---|---|
| `catalog/plugins/<id>.toml` | One per plugin: source repo/path/tag template, first party, featured, sort, tags, companions, `min_host`. Third-party entries pin `version` + `sha256`. |
| `catalog/policy.toml` | Disable an action or a plugin per OS, yank versions, require an app version. Merging an edit is enough: no plugin rebuild. |
| `catalog/companions/<id>.toml` | Companion repo, store links, `min_version`, plugins it serves. |
| `catalog/themes.toml`, `catalog/profiles.toml` | Theme repo (latest release's `registry.json`); profile repo (checked against the catalog, report only). |
| `catalog/authors.toml` | Verified third-party authors (later). |
| `catalog/state/` | What the builder already resolved (versions, hashes, actions). Written by the build; don't edit. |

A plugin's versions are its `<id>-v<version>` release tags; a plugin with none yet comes from the
newest date-tagged snapshot release. The build runs on a `plugin-released` / `theme-released` /
`companion-released` dispatch (KnobDeck Catalog GitHub App), on pushes to `catalog/`, nightly and
by hand. `index.json` and `policy.json` are signed with minisign (`scripts/sign.mjs`; public key
`catalog/minisign.pub`, private key = `CATALOG_SIGNING_KEY` secret of the `catalog` environment).

```bash
npm ci
npm run catalog            # full build (uses `gh auth token`; signs when CATALOG_SIGNING_KEY is set)
npm run catalog:offline    # rebuild from catalog/state only, e.g. to preview a policy edit
```

Profiles need no workflow: `knobdeck-profiles` has no release, and the Worker reads its
`registry.json` and profile folders from `master` (only those paths), so a merged profile is live
within the 5-minute cache.

## App updates and downloads

Not here. The app's release files and update manifests are in R2 and served by the website
(`knobdeck-website`, `/updates/*` and `/download/*`). This site never touches R2.

## New domain

Add `app.knobdeck.xyz` to `routes` in `wrangler.jsonc` and keep this one: shipped apps and plugin builds
call it. Then change `SITE` in `scripts/build.mjs` (and `knobdeck-plugins/scripts/registry.mjs` while it exists), `REGISTRY_*`/`THEMES_BASE` in
the app, `APP_SITE_URL` on the website, and the plugins repo's `KNOBDECK_*_TOKEN_URL` variables.
