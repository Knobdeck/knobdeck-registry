// Catalog builder (PLUGIN_INFRA_PLAN.md §4). Reads catalog/*.toml, resolves every source to its
// releases on GitHub, and writes the static output the Worker serves (catalog/SCHEMA.md):
//   public/v2/index.json, public/v2/plugins/<id>.json, public/v2/policy.json, public/v2/companions.json,
//   public/v2/themes.json, public/themes/registry.json, public/plugins/registry.json (v1) + readmes,
// and signs index.json and policy.json when CATALOG_SIGNING_KEY is set.
//
// Plugin versions come from per-plugin release tags (<id>-v<version>, found with the git
// matching-refs API); a plugin with none yet is taken from the newest date-tagged snapshot release
// (v2026.11.16-1400) of its repo. What was already resolved is kept in catalog/state/<id>.json, so
// only new versions are downloaded. Files are rewritten (and re-signed) only when their content changes.
//
//   node scripts/build.mjs [--offline]     (needs GH_TOKEN / GITHUB_TOKEN or `gh auth token`, and `unzip`)
//   --offline: no network; rebuild the output from catalog/state and the TOML sources (policy edits).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { signFiles } from "./sign.mjs";

const SITE = "https://app.knobdeck.harshalkudale.com";
const OSES = ["linux", "macos", "windows"];
const OFFLINE = process.argv.includes("--offline");
const warnings = [];
const warn = (msg) => {
  warnings.push(msg);
  console.warn(`::warning::${msg}`);
};

// ---------- GitHub ----------
const TOKEN =
  process.env.GH_TOKEN ||
  process.env.GITHUB_TOKEN ||
  (OFFLINE ? "" : execFileSync("gh", ["auth", "token"]).toString().trim());

async function gh(path, { allow404 = false } = {}) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (allow404 && res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function download(url) {
  const res = await fetch(url, { headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {} });
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const releaseCache = new Map();
const releaseByTag = (repo, tag) => {
  const key = `${repo}@${tag}`;
  if (!releaseCache.has(key)) releaseCache.set(key, gh(`repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { allow404: true }));
  return releaseCache.get(key);
};

/** Newest date-tagged snapshot release (v2026.11.16-1400) of a repo, or null. */
const snapshotCache = new Map();
function latestSnapshot(repo) {
  if (!snapshotCache.has(repo)) {
    snapshotCache.set(
      repo,
      (async () => {
        const releases = await gh(`repos/${repo}/releases?per_page=100`);
        const snap = releases.filter((r) => /^v\d{4}\.\d{2}\.\d{2}-\d{4}$/.test(r.tag_name) && !r.draft).sort((a, b) => b.tag_name.localeCompare(a.tag_name))[0];
        if (!snap) return null;
        const asset = snap.assets.find((a) => a.name === "registry.json");
        if (!asset) return null;
        return { release: snap, registry: JSON.parse((await download(asset.browser_download_url)).toString()) };
      })(),
    );
  }
  return snapshotCache.get(repo);
}

// ---------- helpers ----------
const readToml = (file) => parseToml(readFileSync(file, "utf8"));
const tomlDir = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".toml")).sort().map((f) => readToml(join(dir, f))) : [];

function semverCmp(a, b) {
  const pa = a.split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    if (pa[i] !== pb[i]) return typeof pa[i] === "number" && typeof pb[i] === "number" ? pa[i] - pb[i] : String(pa[i]).localeCompare(String(pb[i]));
  }
  return 0;
}

const stable = (v) => JSON.stringify(v, null, 2) + "\n";

/**
 * Writes JSON only when it changed, ignoring the `generated` field; returns true when written.
 * `generated` is the run's time when the file changed, else the old one is kept.
 */
const NOW = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const written = [];
function writeJson(file, obj) {
  const withTime = "generated" in obj;
  let old = null;
  if (existsSync(file)) {
    try {
      old = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
  }
  if (withTime && old) {
    const same = stable({ ...old, generated: null }) === stable({ ...obj, generated: null });
    if (same) return false;
  } else if (old && stable(old) === stable(obj)) return false;
  if (withTime) obj.generated = NOW;
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, stable(obj));
  written.push(file);
  return true;
}

function unzipJson(bundle, member) {
  try {
    return JSON.parse(execFileSync("unzip", ["-p", bundle, member], { maxBuffer: 64 << 20 }).toString());
  } catch {
    return null;
  }
}
const zipHas = (bundle, member) => {
  try {
    execFileSync("unzip", ["-l", bundle, member], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** The local action id: `<manifest id>-<local>-<8 hex>` -> `<local>`. */
const localActionId = (manifestId, actionId) =>
  actionId.startsWith(`${manifestId}-`) && /-[0-9a-f]{8}$/.test(actionId) ? actionId.slice(manifestId.length + 1, -9) : actionId;

/** An action entry in the shape of knobdeck-profiles' catalog/plugins.json. */
const actionEntry = (a) => ({
  type: a.type,
  label: a.label,
  icon: a.icon ?? null,
  platforms: [],
  inputs: (a.inputs ?? []).map((i) => ({
    key: i.key,
    type: i.type,
    ...(i.label && { label: i.label }),
    ...(i.default !== undefined && { default: i.default }),
    ...(i.showIf && { showIf: i.showIf }),
    ...(i.options && { options: i.options.map((o) => o.value ?? o) }),
  })),
  ...(a.states && { states: a.states }),
  ...(a.type === "slider" && { min: a.min ?? 0, max: a.max ?? 100, step: a.step ?? 1, unit: a.unit ?? null }),
  ...(a.released && { released: a.released }),
  ...(a.held && { held: a.held }),
});

// ---------- sources ----------
const sources = tomlDir("catalog/plugins");
const policySrc = existsSync("catalog/policy.toml") ? readToml("catalog/policy.toml") : {};
const companionsSrc = tomlDir("catalog/companions");
const themesSrc = existsSync("catalog/themes.toml") ? readToml("catalog/themes.toml") : null;
const profilesSrc = existsSync("catalog/profiles.toml") ? readToml("catalog/profiles.toml") : null;

for (const s of sources) {
  if (!/^[a-z0-9-]+$/.test(s.id ?? "")) throw new Error(`catalog/plugins: bad id ${s.id}`);
  if (!s.source?.repo) throw new Error(`${s.id}: source.repo is required`);
}
const ids = new Set(sources.map((s) => s.id));
if (ids.size !== sources.length) throw new Error("catalog/plugins: duplicate id");

// ---------- policy ----------
const platformsOf = (p) => (p === undefined || p === "*" || (Array.isArray(p) && p.includes("*")) ? ["*"] : [].concat(p));
const policy = {
  schema: 2,
  generated: null,
  disable: (policySrc.disable ?? []).map((d) => {
    if (!ids.has(d.plugin)) warn(`policy: disable names unknown plugin ${d.plugin}`);
    const platforms = platformsOf(d.platforms);
    for (const os of platforms) if (os !== "*" && !OSES.includes(os)) throw new Error(`policy: bad platform ${os}`);
    if (!d.reason) throw new Error(`policy: disable ${d.plugin}/${d.action ?? "*"} needs a reason`);
    return { plugin: d.plugin, action: d.action ?? null, platforms, reason: d.reason };
  }),
  yank: (policySrc.yank ?? []).map((y) => {
    if (!y.reason) throw new Error(`policy: yank ${y.plugin} needs a reason`);
    return { plugin: y.plugin, versions: [].concat(y.versions), reason: y.reason };
  }),
  minHost: { ...(policySrc.min_host ?? {}) },
};
const covers = (platforms, os) => platforms.includes("*") || platforms.includes(os);
const pluginDisabledOn = (id, os) => policy.disable.find((d) => d.plugin === id && d.action === null && covers(d.platforms, os));
const actionDisables = (id, action) => policy.disable.filter((d) => d.plugin === id && d.action === action);
const yankOf = (id, version) => policy.yank.find((y) => y.plugin === id && y.versions.includes(version));

// ---------- resolve plugin versions ----------
const stateDir = "catalog/state";
mkdirSync(stateDir, { recursive: true });
const loadState = (id) => (existsSync(join(stateDir, `${id}.json`)) ? JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8")) : { id, versions: [] });
const work = mkdtempSync(join(tmpdir(), "catalog-"));

/** Downloads a version's bundles from a release and reads everything the catalog needs from them. */
async function fetchVersion(src, { version, tag, release, entries, meta }) {
  const repoUrl = `https://github.com/${src.source.repo}`;
  const v = { version, tag, released: release.published_at, notes: release.body?.trim() || null, meta: meta ?? null, platforms: {}, actions: {}, setup: false, uses: null };
  const uses = new Set();
  for (const e of entries) {
    const os = e.os;
    const asset = release.assets.find((a) => a.name === e.file);
    if (!asset) {
      warn(`${src.id} ${version}: ${e.file} missing from ${tag}`);
      continue;
    }
    const bytes = await download(asset.browser_download_url);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (e.sha256 && e.sha256 !== sha256) throw new Error(`${src.id} ${version} ${os}: sha256 differs from the release's registry`);
    const pinned = src.sha256?.[os];
    if (pinned && pinned !== sha256) throw new Error(`${src.id} ${version} ${os}: sha256 differs from the pinned one`);
    const file = join(work, e.file);
    writeFileSync(file, bytes);
    const manifest = unzipJson(file, "manifest.json");
    if (!manifest) throw new Error(`${src.id} ${version} ${os}: no manifest.json in ${e.file}`);
    if (!manifest.platforms?.includes(os)) throw new Error(`${manifest.id}: manifest platforms must include ${os}`);
    const actions = unzipJson(file, "actions.json")?.actions ?? [];
    v.setup ||= !!manifest.setup_required;
    (manifest.uses ?? []).forEach((u) => uses.add(u));
    const iconInBundle = manifest.icon && /\.(svg|png)$/i.test(manifest.icon) && zipHas(file, `icons/${manifest.icon}`);
    const readmeAsset = e.readmeFile && release.assets.find((a) => a.name === e.readmeFile);
    v.platforms[os] = {
      id: manifest.id,
      url: `${repoUrl}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(e.file)}`,
      sha256,
      size: bytes.length,
      file: e.file,
      readme: readmeAsset ? readmeAsset.browser_download_url : null,
      readmeFile: e.readmeFile ?? null,
      name: manifest.name ?? null,
      description: manifest.description ?? "",
      author: manifest.author ?? null,
      icon: manifest.icon ?? null,
      iconInBundle: !!iconInBundle,
      uses: manifest.uses ?? [],
    };
    for (const a of actions) {
      const local = localActionId(manifest.id, a.id);
      const runsHere = (a.platforms?.length ? a.platforms : manifest.platforms ?? [os]).includes(os);
      const entry = (v.actions[local] ??= actionEntry(a));
      if (runsHere && !entry.platforms.includes(os)) entry.platforms.push(os);
    }
  }
  for (const a of Object.values(v.actions)) a.platforms.sort();
  v.uses = [...uses].sort();
  return v;
}

/** The versions of a plugin published as per-plugin releases (<tag template>), newest first. */
async function taggedVersions(src) {
  const template = src.source.tag ?? `${src.id}-v{version}`;
  const [prefix, suffix = ""] = template.split("{version}");
  const refs = (await gh(`repos/${src.source.repo}/git/matching-refs/tags/${encodeURIComponent(prefix)}`)) ?? [];
  return refs
    .map((r) => r.ref.replace(/^refs\/tags\//, ""))
    .filter((t) => t.startsWith(prefix) && t.endsWith(suffix))
    .map((tag) => ({ tag, version: tag.slice(prefix.length, tag.length - suffix.length) }))
    .filter((t) => /^\d+\.\d+\.\d+([-+].*)?$/.test(t.version))
    .sort((a, b) => semverCmp(b.version, a.version));
}

async function resolvePlugin(src) {
  const state = loadState(src.id);
  const known = new Set(state.versions.map((v) => v.version));
  const dir = src.source.path && src.source.path !== "." ? src.source.path : src.id;
  const tagged = await taggedVersions(src);
  // A pinned version (third-party) is the only one considered.
  const wanted = src.version ? tagged.filter((t) => t.version === src.version) : tagged;
  for (const { tag, version } of wanted) {
    if (known.has(version)) continue;
    const release = await releaseByTag(src.source.repo, tag);
    if (!release) {
      warn(`${src.id}: tag ${tag} has no release yet`);
      continue;
    }
    const entries = OSES.map((os) => ({ os, file: `${dir}_${os}_${version}.knobdeck`, readmeFile: `${dir}_${os}_readme.md` })).filter((e) =>
      release.assets.some((a) => a.name === e.file),
    );
    if (!entries.length) {
      warn(`${src.id}: release ${tag} has no bundles`);
      continue;
    }
    const metaAsset = release.assets.find((a) => a.name === `${dir}.json`);
    const meta = metaAsset ? JSON.parse((await download(metaAsset.browser_download_url)).toString()) : null;
    console.log(`${src.id} ${version}: from ${tag}`);
    state.versions.push(await fetchVersion(src, { version, tag, release, entries, meta }));
    known.add(version);
  }
  // No per-plugin release yet: the newest snapshot release of the repo (migration, plan §4.4).
  if (!tagged.length) {
    const snap = await latestSnapshot(src.source.repo);
    const reg = snap?.registry.plugins.filter((p) => p.id === dir || OSES.some((os) => p.id === `${dir}-${os}`)) ?? [];
    if (!reg.length) warn(`${src.id}: no per-plugin release and not in a snapshot release`);
    else {
      const version = reg[0].version;
      const old = state.versions.find((v) => v.version === version);
      if (!old || old.tag !== snap.release.tag_name) {
        // Same version re-published in a newer snapshot is the same build: keep what we have.
        if (!old) {
          const entries = reg.map((p) => ({ os: p.platforms[0], file: p.file, readmeFile: p.readmeFile, sha256: p.sha256 }));
          const meta = { name: reg[0].name, summary: reg[0].summary, tags: reg[0].tags, featured: reg[0].featured };
          console.log(`${src.id} ${version}: from snapshot ${snap.release.tag_name}`);
          state.versions.push(await fetchVersion(src, { version, tag: snap.release.tag_name, release: snap.release, entries, meta }));
        }
      }
    }
  }
  state.versions.sort((a, b) => semverCmp(b.version, a.version));
  writeJson(join(stateDir, `${src.id}.json`), state);
  return state;
}

// ---------- build ----------
const states = new Map();
for (const src of sources) {
  states.set(src.id, OFFLINE ? loadState(src.id) : await resolvePlugin(src));
}
// State of plugins removed from the catalog sources is dropped.
for (const f of readdirSync(stateDir)) if (!f.startsWith(".") && !ids.has(f.replace(/\.json$/, ""))) rmSync(join(stateDir, f));

const rawUrl = (repo, ref, path) => `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
const indexEntries = [];
const v1 = [];
const readmes = new Map(); // public path -> source URL

for (const src of sources) {
  const state = states.get(src.id);
  const latestV = state.versions.find((v) => !yankOf(src.id, v.version));
  if (!latestV) {
    rmSync(`public/v2/plugins/${src.id}.json`, { force: true });
    if (state.versions.length) warn(`${src.id}: every version is yanked`);
    continue;
  }
  const dir = src.source.path && src.source.path !== "." ? src.source.path : src.id;
  const any = Object.values(latestV.platforms)[0];
  const meta = latestV.meta ?? {};
  const name = src.name ?? meta.name ?? any?.name ?? src.id;
  const summary = src.summary ?? meta.summary ?? any?.description ?? "";
  const repository = `https://github.com/${src.source.repo}`;
  const iconRef = /^v\d{4}\./.test(latestV.tag) ? "master" : latestV.tag; // snapshot entries were linked at master
  const iconUrl = any?.iconInBundle ? rawUrl(src.source.repo, iconRef, `${dir === "." ? "" : dir + "/"}icons/${encodeURIComponent(any.icon)}`) : null;
  const firstParty = !!src.first_party;
  const platforms = {};
  for (const os of OSES) {
    const p = latestV.platforms[os];
    if (!p || pluginDisabledOn(src.id, os)) continue;
    const readmeUrl = p.readme ? `${SITE}/plugins/${p.id}/readme.md` : null;
    if (p.readme) readmes.set(`public/plugins/${p.id}/readme.md`, { url: p.readme, key: `${latestV.tag}/${p.readmeFile}` });
    platforms[os] = { id: p.id, url: p.url, sha256: p.sha256, size: p.size ?? null, readmeUrl };
  }
  const latest = { version: latestV.version, released: latestV.released, platforms };
  const minHost = policy.minHost[src.id] ?? src.min_host ?? null;
  const actions = {};
  for (const [id, a] of Object.entries(latestV.actions)) {
    const disabled = actionDisables(src.id, id);
    const allowed = a.platforms.filter((os) => !disabled.some((d) => covers(d.platforms, os)) && !pluginDisabledOn(src.id, os));
    actions[id] = { ...a, platforms: allowed, ...(disabled.length && { disabled: disabled.map(({ platforms, reason }) => ({ platforms, reason })) }) };
  }
  const entry = {
    id: src.id,
    name,
    summary,
    description: any?.description ?? "",
    author: any?.author ?? null,
    tags: src.tags ?? meta.tags ?? [],
    icon: any?.icon ?? null,
    iconUrl,
    firstParty,
    badges: [firstParty ? "knobdeck" : "community"],
    featured: !!(src.featured ?? meta.featured),
    repository,
    minHost,
    companions: src.companions ?? [],
    uses: latestV.uses,
    latest,
    detail: `/v2/plugins/${src.id}.json`,
  };
  writeJson(`public/v2/plugins/${src.id}.json`, {
    schema: 2,
    id: src.id,
    name,
    repository,
    latest,
    changelog: latestV.notes,
    setup: latestV.setup,
    versions: state.versions.map((v) => {
      const y = yankOf(src.id, v.version);
      return { version: v.version, tag: v.tag, released: v.released, yanked: !!y, reason: y?.reason ?? null };
    }),
    actions,
    companions: src.companions ?? [],
  });
  if (!Object.keys(platforms).length) continue; // disabled on every OS
  indexEntries.push({ sort: src.sort ?? meta.sort ?? 1000, entry });
  for (const [os, p] of Object.entries(platforms)) {
    const full = latestV.platforms[os];
    v1.push({
      sort: src.sort ?? meta.sort ?? 1000,
      p: {
        id: p.id,
        name,
        summary,
        description: full.description,
        version: latestV.version,
        author: full.author,
        repositoryUrl: repository,
        artifactUrl: p.url,
        iconUrl,
        icon: full.icon,
        readmeUrl: p.readmeUrl,
        sha256: p.sha256,
        tags: entry.tags,
        platforms: [os],
        uses: full.uses ?? null,
        featured: entry.featured,
        file: full.file,
        readmeFile: full.readmeFile,
      },
    });
  }
}

const bySort = (a, b, ea, eb) => Number(eb.featured) - Number(ea.featured) || a.sort - b.sort || ea.name.localeCompare(eb.name) || ea.id.localeCompare(eb.id);
indexEntries.sort((a, b) => bySort(a, b, a.entry, b.entry));
v1.sort((a, b) => bySort(a, b, a.p, b.p));

const indexChanged = writeJson("public/v2/index.json", { schema: 2, generated: null, plugins: indexEntries.map((e) => e.entry) });
const policyChanged = writeJson("public/v2/policy.json", policy);
const v1Old = existsSync("public/plugins/registry.json") ? JSON.parse(readFileSync("public/plugins/registry.json", "utf8")) : null;
const v1Plugins = v1.map((e) => e.p);
if (!v1Old || stable(v1Old.plugins) !== stable(v1Plugins)) {
  writeJson("public/plugins/registry.json", { tag: `catalog-${NOW}`, plugins: v1Plugins });
}

// Readmes at /plugins/<manifest id>/readme.md (v1 readmeUrl; v2 links the same files).
const readmeState = existsSync("catalog/state/.readmes.json") ? JSON.parse(readFileSync("catalog/state/.readmes.json", "utf8")) : {};
const keep = new Set([...readmes.keys()].map((p) => p.split("/")[2]));
if (existsSync("public/plugins")) {
  for (const d of readdirSync("public/plugins")) {
    if (d !== "registry.json" && !keep.has(d)) {
      rmSync(join("public/plugins", d), { recursive: true, force: true });
      delete readmeState[`public/plugins/${d}/readme.md`];
    }
  }
}
for (const [path, { url, key }] of readmes) {
  if (readmeState[path] === key && existsSync(path)) continue;
  if (OFFLINE) {
    warn(`${path}: readme out of date (offline)`);
    continue;
  }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, await download(url));
  readmeState[path] = key;
  written.push(path);
}
writeFileSync(
  "catalog/state/.readmes.json",
  stable(Object.fromEntries(Object.entries(readmeState).sort(([a], [b]) => a.localeCompare(b)))),
);

// ---------- companions ----------
const companions = [];
for (const c of companionsSrc) {
  let latest = null;
  if (!OFFLINE) {
    const rel = await gh(`repos/${c.repository.replace("https://github.com/", "")}/releases/latest`, { allow404: true });
    latest = rel?.tag_name?.replace(/^v/, "") ?? null;
  } else {
    const old = existsSync("public/v2/companions.json") ? JSON.parse(readFileSync("public/v2/companions.json", "utf8")).companions.find((o) => o.id === c.id) : null;
    latest = old?.latest ?? null;
  }
  for (const p of c.plugins ?? []) if (!ids.has(p)) warn(`companion ${c.id}: unknown plugin ${p}`);
  companions.push({
    id: c.id,
    name: c.name,
    repository: c.repository,
    runsIn: c.runs_in ?? null,
    latest,
    minVersion: c.min_version ?? null,
    plugins: c.plugins ?? [],
    stores: (c.stores ?? []).map((s) => ({ name: s.name, url: s.url })),
  });
}
for (const src of sources) for (const c of src.companions ?? []) if (!companions.some((x) => x.id === c)) warn(`${src.id}: unknown companion ${c}`);
writeJson("public/v2/companions.json", { schema: 2, companions });

// ---------- themes ----------
if (themesSrc && !OFFLINE) {
  const rel = await gh(`repos/${themesSrc.repo}/releases/latest`, { allow404: true });
  const asset = rel?.assets.find((a) => a.name === "registry.json");
  if (!asset) warn(`themes: ${themesSrc.repo} latest release has no registry.json`);
  else {
    const themes = JSON.parse((await download(asset.browser_download_url)).toString());
    if (!themes.themes?.length) throw new Error("themes: registry.json lists no themes");
    writeJson("public/themes/registry.json", themes);
    writeJson("public/v2/themes.json", themes);
  }
}

// ---------- profiles check (report only: the Worker serves profiles straight from their repo) ----------
if (profilesSrc && !OFFLINE) {
  const branch = profilesSrc.branch ?? "master";
  const raw = (p) => rawUrl(profilesSrc.repo, branch, p);
  try {
    const reg = JSON.parse((await download(raw("registry.json"))).toString());
    // os-tools is how profiles name mac-tools / win-tools / linux-tools together.
    const OS_TOOLS = { macos: "mac-tools", windows: "win-tools", linux: "linux-tools" };
    const actionsOf = (plugin) => {
      if (plugin === "os-tools") {
        const merged = {};
        for (const id of Object.values(OS_TOOLS)) {
          const d = existsSync(`public/v2/plugins/${id}.json`) ? JSON.parse(readFileSync(`public/v2/plugins/${id}.json`, "utf8")) : null;
          for (const [k, a] of Object.entries(d?.actions ?? {})) (merged[k] ??= { platforms: [] }).platforms.push(...a.platforms);
        }
        return merged;
      }
      const d = existsSync(`public/v2/plugins/${plugin}.json`) ? JSON.parse(readFileSync(`public/v2/plugins/${plugin}.json`, "utf8")) : null;
      return d?.actions ?? null;
    };
    const refs = (node, out) => {
      if (Array.isArray(node)) node.forEach((n) => refs(n, out));
      else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "action" && typeof v === "string" && v.includes("/")) out.add(v);
          else refs(v, out);
        }
      }
      return out;
    };
    for (const p of reg.profiles ?? []) {
      const profile = JSON.parse((await download(raw(`profiles/${p.id}/profile.json`))).toString());
      for (const ref of refs(profile, new Set())) {
        const [plugin, action] = [ref.slice(0, ref.indexOf("/")), ref.slice(ref.indexOf("/") + 1)];
        const actions = actionsOf(plugin);
        if (!actions) warn(`profile ${p.id}: ${ref}: plugin ${plugin} is not in the catalog`);
        else if (!actions[action]) warn(`profile ${p.id}: ${ref}: no such action`);
        else if (!actions[action].platforms.length) warn(`profile ${p.id}: ${ref}: action is disabled on every OS`);
      }
    }
  } catch (e) {
    warn(`profiles check failed: ${e.message}`);
  }
}

// ---------- sign ----------
const toSign = [];
if (indexChanged || !existsSync("public/v2/index.json.minisig")) toSign.push("public/v2/index.json");
if (policyChanged || !existsSync("public/v2/policy.json.minisig")) toSign.push("public/v2/policy.json");
if (toSign.length) {
  if (process.env.CATALOG_SIGNING_KEY) {
    signFiles(toSign, process.env.CATALOG_SIGNING_KEY);
    console.log(`signed ${toSign.join(", ")}`);
  } else {
    // An unsigned changed file must not keep an old, now wrong signature.
    for (const f of toSign) rmSync(`${f}.minisig`, { force: true });
    warn(`not signed (no CATALOG_SIGNING_KEY): ${toSign.join(", ")}`);
  }
}

rmSync(work, { recursive: true, force: true });
console.log(`${indexEntries.length} plugin(s), ${v1.length} v1 entries, ${companions.length} companion(s); ${written.length} file(s) written`);
if (process.env.GITHUB_STEP_SUMMARY && warnings.length) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## Catalog warnings\n\n${warnings.map((w) => `- ${w}`).join("\n")}\n`, { flag: "a" });
}
