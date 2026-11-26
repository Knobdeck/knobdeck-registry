# Catalog output schema (v2)

What `scripts/build.mjs` writes to `public/` and the Worker serves at
`https://app.knobdeck.harshalkudale.com`. Additive changes only: new fields may appear, existing
ones keep their meaning. `schema` changes only on a breaking change (then the path moves to `/v3`).

Plugin ids here are **portable ids**: the plugin's folder / catalog id (`obs`, `discord`,
`mac-tools`). A bundle's own manifest id is per OS (`obs-macos`); it is given as
`platforms.<os>.id`. OS keys are always `macos | windows | linux`.

## `/v2/index.json` (+ `/v2/index.json.minisig`)

```jsonc
{
  "schema": 2,
  "generated": "2026-11-17T13:00:00Z",
  "plugins": [                              // sorted: featured first, then catalog sort, then name
    {
      "id": "obs",
      "name": "OBS Studio",
      "summary": "Scenes, sources, recording and streaming.",
      "description": "…",                   // manifest description
      "author": "KnobDeck",
      "tags": ["Streaming", "Broadcast"],
      "icon": "obs.svg",                    // manifest icon (file name or a Lucide name)
      "iconUrl": "https://raw.githubusercontent.com/…/obs/icons/obs.svg",   // null when not a file
      "firstParty": true,
      "badges": ["knobdeck"],               // "knobdeck" (first party) | "community"
      "featured": true,
      "repository": "https://github.com/Knobdeck/knobdeck-plugins",
      "minHost": "1.0.0",                   // null = any; policy [min_host] already applied
      "companions": ["vscode"],             // ids in /v2/companions.json
      "uses": ["window"],                   // what it reads through the SDK, union over OSes
      "latest": {
        "version": "1.3.1",
        "released": "2026-11-17T12:00:00Z",
        "platforms": {                      // only OSes it ships on and policy allows
          "macos": {
            "id": "obs-macos",              // manifest id of this bundle
            "url": "https://github.com/…/releases/download/obs-v1.3.1/obs_macos_1.3.1.knobdeck",
            "sha256": "…",
            "size": 123456,                 // bytes; null when unknown (old snapshot entries)
            "readmeUrl": "https://app.knobdeck.harshalkudale.com/plugins/obs-macos/readme.md"  // or null
          }
        }
      },
      "detail": "/v2/plugins/obs.json"
    }
  ]
}
```

A plugin disabled by policy on every OS is left out. A yanked version is never `latest`: the
newest non-yanked version is used instead.

## `/v2/plugins/<id>.json`

```jsonc
{
  "schema": 2,
  "id": "obs",
  "name": "OBS Studio",
  "repository": "https://github.com/Knobdeck/knobdeck-plugins",
  "latest": { …same as in the index… },
  "changelog": "…markdown…",              // release notes of latest; null when none
  "setup": true,                           // a setup step must run before its actions work
  "versions": [                            // newest first
    { "version": "1.3.1", "tag": "obs-v1.3.1", "released": "…", "yanked": false, "reason": null }
  ],
  "actions": {                             // keyed by local action id (see below)
    "record": {
      "type": "button",                    // button | toggle | slider | …
      "label": "Record",
      "icon": "circle",                    // or null
      "platforms": ["linux", "macos", "windows"],   // where it runs AND policy allows (sorted)
      "inputs": [{ "key": "scene", "type": "select", "label": "Scene", "default": "…", "showIf": …, "options": ["a"] }],
      // optional, as in actions.json: states, min, max, step, unit (sliders), released, held
      "disabled": [{ "platforms": ["*"], "reason": "…" }]   // policy disables of this action; omitted when none
    }
  },
  "companions": ["vscode"]
}
```

`actions` uses the same shape as `knobdeck-profiles/catalog/plugins.json` (`plugins.<id>.actions`).

## `/v2/policy.json` (+ `/v2/policy.json.minisig`)

Compiled from `catalog/policy.toml`. Apps fetch it at start and every few hours and cache it.

```jsonc
{
  "schema": 2,
  "generated": "…",
  "disable": [
    { "plugin": "mac-tools", "action": "clipboard-history", "platforms": ["*"], "reason": "…" },  // action: null = whole plugin
    { "plugin": "zoom", "action": null, "platforms": ["linux"], "reason": "…" }
  ],
  "yank": [ { "plugin": "obs", "versions": ["1.3.0"], "reason": "Crashes on connect." } ],
  "minHost": { "coding-agents": "1.2.0" }
}
```

`platforms`: `"*"` = every OS, else a list of `macos | windows | linux`. `plugin` is the portable id.
An app matches an installed plugin by its manifest id's portable id (`obs-macos` → `obs`;
`mac-tools`, `win-tools`, `linux-tools` are their own ids) and an action by its local id.

**Local action id**: a full action id is `<manifest id>-<local id>-<8 hex>`
(`browser-plugin-linux-find-in-page-1c286de0` → `find-in-page`; `win-tools-emoji-panel-dcaa70ad` →
`emoji-panel`), i.e. strip the `<manifest id>-` prefix and the last 9 characters.

## `/v2/companions.json`

```jsonc
{
  "schema": 2,
  "companions": [
    {
      "id": "vscode",
      "name": "KnobDeck VS Code Companion",
      "repository": "https://github.com/Knobdeck/knobdeck-vscode-companion",
      "runsIn": "VS Code, VSCodium, Cursor, Windsurf",
      "summary": "Editor extension, needed to control VS Code",  // one short line the app shows; null if none
      "latest": "1.2.0",                    // from the companion's latest v* release; null if none
      "minVersion": "1.2.0",                // oldest companion version the current plugin works with
      "plugins": ["vscode"],
      "stores": [ { "name": "Visual Studio Marketplace", "url": "https://…" } ]
    }
  ]
}
```

## `/v2/themes.json`

The themes release's `registry.json`, unchanged (`{ tag, themes: [{ id, name, author, version, zipUrl, sha256, preview }] }`).
`/themes/registry.json` is the same file.

## `/plugins/registry.json` (v1, for apps without v2 support)

The old shape, generated from the same data: one entry per plugin × OS, `id` = manifest id
(`obs-macos`), `artifactUrl`/`sha256` of the latest allowed version, `tag` = `catalog-<generated>`.
Policy-disabled plugins/OSes are left out; action disables can't be expressed in v1.

## Adapters (`/v3/adapters.json`)

Adapters are separate programs the app downloads, runs and manages (Adapters screen), for things a plugin
can't be, such as running plugins made for another product. `v3` is a new file, not a new version of the plugin
index: `v2` stays as it is. Source: `catalog/adapters/<id>.toml` (`id`, `repo`, `name`, `summary`, `description`,
`author`, `has_ui`, optional `min_host`). The builder takes the newest `v<major>.<minor>.<patch>` release of
`repo` that has `<id>-<version>-<platform>.zip` for every platform: `linux-x86_64`, `macos-aarch64`,
`macos-x86_64`, `windows-x86_64`. Resolved versions are kept in `catalog/state/.adapters.json`.

```json
{ "schema": 3, "adapters": [{
  "id": "knobdeck-sd-plugin-adapter", "name": "…", "summary": "…", "description": "…", "author": "…",
  "repository": "https://github.com/…", "version": "0.1.0", "releasedAt": "…", "minHost": null, "hasUi": true,
  "platforms": { "linux-x86_64": { "url": "…zip", "sha256": "…", "size": 123 }, "…": {} } }] }
```

Signed like `index.json` (`adapters.json.minisig`). The zip holds `adapter.json` (how the app runs, stops and
opens the program), the executables and a licence. A `<id>-released` repository dispatch
(`adapter-released`, from the adapter repo's release workflow) rebuilds the catalog.

## Signatures

`<file>.minisig` is a [minisign](https://jedisct1.github.io/minisign/) signature (algorithm `ED`:
Ed25519 over the BLAKE2b-512 hash of the file) made with the key whose public half is
`catalog/minisign.pub`:

```
untrusted comment: minisign public key 17DE3528577F3943
RWRDOX9XKDXeF7cT/p2hlIUAUJeBNABDTvTqR2PwIzAJ+bZroH7TK+oJ
```

Trusted comment: `timestamp:<unix seconds>\tfile:<name>`. Verify with `minisign -Vm <file> -P <key>`
or the `minisign-verify` crate. The private key is the `CATALOG_SIGNING_KEY` secret of the
`catalog` environment.
