// Credential providers — the lookup layer behind `f creds`.
//
// A **provider** is another uck that can answer "do you know cred <name>?" from
// some other store (a password manager, a secrets service, a provisioning API).
// The local encrypted box always wins; providers are only consulted on a local
// **miss**. Providers register themselves at load time (see `registerProvider`),
// so the creds uck never has to know they exist — `creds/index.js` loads every
// registered provider lazily on the first miss.
//
// ## Provider interface
//
//     {
//       name: "vaultwarden",        // short id, shown in provenance + status
//       resolve(name): string|Buffer|null|undefined,   // null/undefined = don't know it
//       has?(name): boolean|Promise<boolean>,          // optional pre-filter
//       status?(): { ready, note?, hint? },            // for `f creds status`
//       mirrorTtlSec?: number,      // floor on how long a mirrored hit may go
//                                   //   un-revalidated (0 = revalidate every time)
//     }
//
// `resolve` may be async. Returning `null`/`undefined`/`""` means "not mine";
// **throwing** is an availability failure (locked, offline, bad password), which
// is surfaced to the caller instead of being reported as "no such credential".
//
// ## Mirrors
//
// A provider hit is **mirrored** into the local encrypted box as
// `mirror:<name>` so later reads are offline and fast. Mirrors are never
// authoritative and are never exposed as ordinary creds:
//
//   - fresh mirror (within its ttl) + local miss  -> serve the mirror, no network
//   - stale/absent mirror + local miss            -> ask the provider again;
//     a provider **hit** overwrites the mirror, a provider **miss** serves the
//     stale mirror if one exists and records a negative cache entry so the next
//     lookup fails fast instead of paying for the provider again.
//
// A mirror is only ever refreshed from a live provider hit — a miss never
// updates or deletes vault-sourced content.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const F = path.join(process.env.HOME ?? "", ".f");
const CACHE = path.join(F, ".creds-cache.json");

/** Everything under this prefix is vault-sourced, never a plain cred. */
export const MIRROR_PREFIX = "mirror:";
const MISS_PREFIX = "miss:";
const SRC_PREFIX = "src:";

/** Providers registered in this process (by the creds uck's own register()). */
const localProviders = new Map();
const collisions = [];
let discovered = false;
const discoveryError = { message: null };

/** Test isolation: forget process-local providers (and collision history). */
export function resetProviders() {
  localProviders.clear();
  collisions.length = 0;
  discoveryOverride = null;
  discoveryError.message = null;
  discovered = false;
}

/**
 * Replace discovery entirely (tests only). Pass a list of provider objects, or
 * null to restore normal `f providers --dump` discovery.
 *
 * Without this, exercising the ladder offline means either shelling out to the
 * real `f` or mutating the real store — neither belongs in a unit test.
 */
export function setDiscoveryOverride(list) {
  discoveryOverride = Array.isArray(list) ? list : null;
  discovered = true;
}
let discoveryOverride = null;

/* ------------------------------------------------------------------ config */

/**
 * Provider settings from ~/.f/f.config.json. Each provider may pin `mirrorTtlSec`;
 * a top-level `mirrorTtlSec` is the default. Unknown provider names are ignored,
 * so a provider that isn't installed costs nothing.
 *
 *   { "providers": { "vaultwarden": { "mirrorTtlSec": 3600 } }, "mirrorTtlSec": 3600 }
 */
export function providerConfig(name) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(F, "f.config.json"), "utf8"));
  } catch {
    return {};
  }
  const table = cfg.providers ?? cfg.credProviders ?? {};
  const per = table?.[name];
  const base = typeof cfg.mirrorTtlSec === "number" ? cfg.mirrorTtlSec : undefined;
  const out = {};
  if (typeof per === "number") out.mirrorTtlSec = per;
  else if (per && typeof per === "object") {
    if (typeof per.mirrorTtlSec === "number") out.mirrorTtlSec = per.mirrorTtlSec;
    if (per.enabled === false) out.enabled = false;
  }
  if (out.mirrorTtlSec === undefined && base !== undefined) out.mirrorTtlSec = base;
  if (out.enabled === undefined) out.enabled = true;
  return out;
}

/** Mirror ttl for a provider, in ms, or null when nothing is configured —
 *  distinct from an explicit `0` ("revalidate every time"). Callers must not
 *  test this for truthiness; `0` is a real answer. */
export function mirrorTtlSec(name, provider) {
  const cfg = providerConfig(name);
  if (!cfg.enabled) return 0;
  const candidates = [cfg.mirrorTtlSec, provider?.mirrorTtlSec].filter(
    (v) => typeof v === "number" && isFinite(v),
  );
  if (!candidates.length) return 3600;
  // The config value is what the operator asked for; the provider's value is a
  // floor for how long it will go without revalidating. Honour the longer of the
  // two, so a provider that says "revalidate every time" (0) is not silently
  // overridden by a generous global default.
  return Math.max(...candidates);
}

/** Mirror ttl in ms. */
export function mirrorTtlMs(name, provider) {
  const s = mirrorTtlSec(name, provider);
  return s === null ? 3600 * 1000 : s * 1000;
}

/* --------------------------------------------------------------- discovery */

/**
 * Register a provider for this process. Called from a provider uck's exported
 * object; `creds/index.js` also calls it for its own view of the world.
 */
export function registerProvider(p) {
  if (!p || typeof p.name !== "string" || typeof p.resolve !== "function") return false;
  const prev = localProviders.get(p.name);
  // Two ucks claiming one provider name is a silent-shadowing footgun — say so.
  if (prev && prev !== p) collisions.push(`${p.name} (re-registered; last one wins)`);
  localProviders.set(p.name, p);
  return true;
}

/** Provider-name collisions seen this process, for `f creds status`. */
export function providerCollisions() {
  return [...collisions];
}

function fromChildProcess(stdout) {
  let obj;
  try {
    obj = JSON.parse(stdout);
  } catch {
    throw new Error(`providers --dump emitted unparseable JSON (${String(stdout).slice(0, 80)})`);
  }
  return (Array.isArray(obj) ? obj : [obj])
    .filter((p) => p && typeof p.name === "string" && p.hasExternalApi !== false)
    .map((p) => ({
      name: p.name,
      mirrorTtlSec: typeof p.mirrorTtlSec === "number" ? p.mirrorTtlSec : undefined,
      resolve: (name) => execFileSync(process.execPath, [p.entry, "resolve", String(name)], {
        encoding: "utf8",
        timeout: 90_000,
        maxBuffer: 32 << 20,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      has: (name) => {
        try {
          return execFileSync(process.execPath, [p.entry, "has", String(name)], {
            encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
          }).trim() === "yes";
        } catch {
          return false;
        }
      },
      status: () => {
        try {
          return JSON.parse(execFileSync(process.execPath, [p.entry, "status"], {
            encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
          }));
        } catch (e) {
          return { ready: false, note: "provider probe failed", hint: e.stderr?.toString?.().slice(0, 200) };
        }
      },
      external: p.entry,
    }));
}

/**
 * Every registered provider: this process's own, plus anything discovered from
 * `f providers --dump` (each uck's exported `credentialProvider`, evaluated in a
 * child process so a provider never has to be imported into the creds hot path).
 * Discovery runs once per process and its failure is remembered, not thrown.
 */
export async function listProviders() {
  const out = [...localProviders.values()];
  if (discoveryOverride) {
    for (const p of discoveryOverride) if (!out.some((x) => x.name === p.name)) out.push(p);
    return out;
  }
  if (!discovered) {
    discovered = true;
    try {
      const stdout = execFileSync("f", ["providers", "--dump"], {
        encoding: "utf8", timeout: 25_000, stdio: ["ignore", "pipe", "pipe"],
      });
      for (const p of fromChildProcess(stdout)) {
        if (!out.some((x) => x.name === p.name)) out.push(p);
      }
    } catch (e) {
      discoveryError.message = e?.stderr?.toString?.().trim() || e?.message || String(e);
    }
  }
  return out;
}

/** Why discovery failed, or null. Surfaced by `f creds status`. */
export function providerDiscoveryError() {
  return discoveryError.message;
}

/* ------------------------------------------------------------------ mirror */

/** Strip the mirror prefix: `mirror:github.com` -> `github.com`. */
export function mirrorName(key) {
  return key.startsWith(MIRROR_PREFIX) ? key.slice(MIRROR_PREFIX.length) : key;
}

export function isMirrorKey(key) {
  return typeof key === "string" && key.startsWith(MIRROR_PREFIX);
}

/* ------------------------------------------------------------------- cache */

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}
function writeCache(c) {
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    // Explicit 0600: writeFileSync keeps an existing file's mode, so this has to
    // be enforced rather than only requested at creation.
    fs.writeFileSync(CACHE, JSON.stringify(c, null, 2), { mode: 0o600 });
    fs.chmodSync(CACHE, 0o600);
  } catch { /* cache is an optimisation; never fatal */ }
}

function missEntry(name) {
  const e = readCache()[MISS_PREFIX + name];
  return e && typeof e.expiresAt === "number" ? e : null;
}

/** Seconds until the negative cache for `name` lapses (0 when not cached). */
export function missBackoffLeft(name) {
  const e = missEntry(name);
  return e ? Math.max(0, Math.ceil((e.expiresAt - Date.now()) / 1000)) : 0;
}

/**
 * Record "the provider was reachable and did not know this name".
 *
 * Only when EVERY enabled provider answered definitively. If one provider threw
 * (vault locked, network down) we know nothing about what it would have said,
 * so caching a negative result would be wrong — and would mask the real error
 * behind a bare `no such cred` for the next few minutes.
 */
export function recordMiss(name, probes, ttlSec = 300) {
  if (!probes || !probes.length) return false;
  const anyUnknown = probes.some((p) => p.outcome === "error" || p.outcome === "backoff");
  if (anyUnknown) return false;
  const c = readCache();
  c[MISS_PREFIX + name] = { expiresAt: Date.now() + ttlSec * 1000, reason: "provider miss" };
  writeCache(c);
  return true;
}

/** Drop any negative-cache entries (after an unlock, a retry, or manually). */
export function clearMisses(name) {
  const c = readCache();
  const keys = name ? [MISS_PREFIX + name] : Object.keys(c).filter((k) => k.startsWith(MISS_PREFIX));
  if (!keys.some((k) => k in c)) return 0;
  for (const k of keys) delete c[k];
  writeCache(c);
  return keys.length;
}

/* ----------------------------------------------------------------- resolve */

/**
 * Ask every enabled provider for `name`.
 *
 * Returns `{ value, provider }` on a hit, `{ miss: true, provider? }` when the
 * providers were reachable and did not know it, or `{ error }` when a provider
 * was reachable but could not answer. `probes` describes what happened, for
 * `--vault` diagnostics.
 */
/**
 * Ask every enabled provider for `name`, in registration order. The first
 * provider that answers wins; later ones are never consulted for that name
 * until its mirror expires (see `mirrorSource`).
 *
 * Returns `{ value, provider }` on a hit, `{ miss: true, provider }` when the
 * providers were reachable and did not know it, or `{ error }` when a provider
 * was reachable but could not answer. `probes` describes each attempt, for
 * `--vault` diagnostics and for deciding whether a negative cache entry is
 * actually justified.
 */
export async function askProviders(name, providers) {
  const probes = [];
  let lastMissProvider = null;
  for (const p of providers) {
    if (!providerConfig(p.name).enabled) continue;
    const backoff = missBackoffLeft(name);
    if (backoff > 0) {
      probes.push({ provider: p.name, outcome: "backoff", note: `${backoff}s left` });
      continue;
    }
    // Cheap pre-filter so a provider that definitively doesn't own this name
    // doesn't have to be paid for. Absent `has` = always ask.
    if (typeof p.has === "function") {
      let owned = false;
      try {
        owned = await p.has(name);
      } catch {
        owned = true; // pre-filter broke -> fall through to the real thing
      }
      if (!owned) {
        probes.push({ provider: p.name, outcome: "not-owned" });
        continue;
      }
    }
    let value;
    try {
      value = await p.resolve(name);
    } catch (e) {
      probes.push({ provider: p.name, outcome: "error", note: e?.message ?? String(e) });
      return { error: e?.message ?? String(e), provider: p.name, probes };
    }
    if (value == null || value === "") {
      probes.push({ provider: p.name, outcome: "miss" });
      lastMissProvider = p.name;
      continue;
    }
    probes.push({ provider: p.name, outcome: "hit" });
    return { value: value instanceof Buffer ? value.toString("utf8") : String(value), provider: p.name, probes };
  }
  return { miss: true, provider: lastMissProvider, probes };
}

/** Which provider a mirror came from. Priority matters: once a provider answers
 *  for a name, providers registered after it are skipped until this expires. */
export function mirrorSource(key) {
  const e = readCache()[SRC_PREFIX + key];
  return e?.provider ?? null;
}
export function setMirrorSource(key, provider, ttlMs) {
  const c = readCache();
  c[SRC_PREFIX + key] = { provider, expiresAt: Date.now() + ttlMs };
  writeCache(c);
}
export function clearMirrorSource(key) {
  const c = readCache();
  if (SRC_PREFIX + key in c) { delete c[SRC_PREFIX + key]; writeCache(c); }
}

/**
 * Full miss path, owning the mirror + negative cache policy:
 *
 *   fresh mirror               -> serve it (no provider traffic)
 *   stale/none                 -> ask providers
 *     hit                      -> refresh mirror (ttl), clear negative cache, serve
 *     all reachable + no match -> serve stale mirror if present, else report the
 *                                miss; either way set a short negative cache
 *     provider unreachable     -> surface the error (serve stale mirror only when
 *                                `staleOnProviderError` is set, which is not the
 *                                default: an unreachable vault is worth hearing
 *                                about rather than silently serving old secrets)
 * @param store.getCred   read a key raw (no provider fallback)
 * @param store.setMirror (key, value, ttlMs) -> store a mirror
 * @param store.isFresh   (mirrorKey, ttlSec) -> is that mirror still fresh?
 *                        `ttlSec` is a seconds upper bound, never a grant.
 * @param store.isUnlocked optional -> can the store be read at all? Supplying it
 *                        matters: getCred yields null for both "no mirror" and
 *                        "store locked", and conflating them means calling a
 *                        provider on a store that could not save the answer.
 */
export async function resolveViaProvider(name, { getCred, setMirror, isFresh, isUnlocked } = {}) {
  if (isUnlocked && !(await isUnlocked())) {
    return { error: `cannot look up '${name}': the creds store is locked (f creds unlock)`, provider: null };
  }
  let providers = await listProviders();
  const enabled = providers.filter((p) => providerConfig(p.name).enabled);
  if (!enabled.length) {
    return { none: true, note: discoveryError.message ? `provider discovery failed: ${discoveryError.message}` : "no credential providers registered" };
  }

  const mirrored = await getCred(MIRROR_PREFIX + name).catch(() => null);
  const key = MIRROR_PREFIX + name;
  if (mirrored != null && mirrored !== "") {
    const src = mirrorSource(key);
    // The provider that produced this mirror governs its freshness. Taking the
    // max across all providers would let a lax one extend how long a strict
    // one's value is trusted without revalidation.
    const owner = src ? enabled.find((p) => p.name === src) : null;
    const ttlSec = owner ? (mirrorTtlSec(owner.name, owner) ?? 3600) : Math.max(...enabled.map((p) => mirrorTtlSec(p.name, p) ?? 3600));
    if (ttlSec > 0 && (await isFresh(key, ttlSec))) {
      return { value: mirrored, mirror: "fresh", provider: src ?? undefined };
    }
    // Revalidate with whoever produced this mirror first — asking a different
    // provider could overwrite a value the first one still owns.
    if (src) {
      const ordered = [...enabled].sort((a, b) => (a.name === src ? -1 : b.name === src ? 1 : 0));
      const res = await askProviders(name, ordered);
      if (res.value != null) {
        await setMirror(key, res.value, mirrorTtlMs(src, enabled.find((p) => p.name === src)));
        setMirrorSource(key, src, mirrorTtlMs(src, enabled.find((p) => p.name === src)));
        clearMisses(name);
        return { value: res.value, provider: src, mirrored: true, revalidated: true };
      }
      if (res.miss) {
        const cached = recordMiss(name, res.probes);
        return { value: mirrored, mirror: "stale", provider: src, warning: `provider '${src}' no longer has '${name}'; serving the last mirror${cached ? "" : " (another provider was unreachable, so this name is not negative-cached)"} — run 'f creds forget ${name}' to stop` };
      }
      // Unreachable: keep serving the last known-good mirror rather than
      // failing over to a different store for the same name.
      return { value: mirrored, mirror: "stale", provider: src, warning: `provider '${src}' unavailable (${res.error}); serving the last mirror` };
    }
  }

  const res = await askProviders(name, enabled);
  if (res.error) return res;
  if (res.miss) {
    recordMiss(name, res.probes);
    if (mirrored != null && mirrored !== "") {
      return { value: mirrored, mirror: "stale", warning: `no provider has '${name}'; serving the last mirror (run 'f creds forget ${name}' to stop)` };
    }
    return res;
  }

  const prov = enabled.find((p) => p.name === res.provider);
  const ttlSec = mirrorTtlSec(res.provider, prov) ?? 3600;
  const ttlMs = ttlSec * 1000;
  await setMirror(key, res.value, ttlMs);
  setMirrorSource(key, res.provider, ttlMs);
  clearMisses(name);
  return { value: res.value, provider: res.provider, mirrored: true, ttlSec };
}
