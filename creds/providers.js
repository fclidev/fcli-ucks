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
import { pathToFileURL } from "node:url";

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
/**
 * The providers uck object, handed over by `setProvidersUck()`.
 *
 * creds never imports it: N4 forbids reaching out of the uck directory, and a
 * static import would also make the creds uck depend on load order. The
 * registry is the one sanctioned peer accessor (N20), and it exists only at run
 * time (N19/G11), which is why this is injected rather than imported.
 */
let providersUckRef = null;

/**
 * Point discovery at the providers uck's in-process view. Called from creds'
 * run() with `ctx.registry.providers`. Null/absent is normal — the test driver
 * and any caller that passes no ctx — and simply leaves the spawn path in place.
 */
export function setProvidersUck(obj) {
  providersUckRef = obj && typeof obj === "object" ? obj : null;
}

/** Test seam: the peer object discovery would consult, or null. */
export function providersUck() {
  return providersUckRef;
}

/**
 * Ask the providers uck for its providers IN-PROCESS, live objects attached.
 *
 * Returns the rows, or null to mean "ask the child instead". Every failure mode
 * returns null rather than throwing: a peer that is absent, is not the real uck
 * object, does not export the accessor, or throws inside discovery must leave
 * the spawn path exactly as it was. Discovery is not allowed to become less
 * reliable in order to become cheaper.
 */
async function discoverViaPeer() {
  const peer = providersUckRef;
  if (!peer || typeof peer.discoverInProcess !== "function") return null;
  try {
    const rows = await peer.discoverInProcess();
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

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

/**
 * The handle we hand a provider that asks for one: the sanctioned C3 read
 * (`credsApi.rawCredRead`, CONTRACT.md §6.1) and nothing else.
 *
 * A provider probe must NOT get the full `credsApi`. `credsApi.resolveCred` runs
 * the provider ladder, so a provider that called it from inside `status`/`resolve`
 * would come straight back into `listProviders()` — the cycle this file already
 * guards at the discovery edge. `rawCredRead` reads the store directly and never
 * consults providers, so it cannot recurse.
 */
async function probeHandleRead(names, ...rest) {
  const res = await probeCredsRead(names, ...rest);
  if (!res || typeof res !== "object") return res;
  // The store's own answer shape is `{ token, reason }` (CONTRACT.md C3 + §7.2:
  // reason ∈ locked|missing|provider|no-store|timeout), and that is what every
  // other credsApi consumer reads. A probe provider, however, is written against
  // the shape `f creds get` prints and `resolveCred` returns — `{ value, error }`
  // — because that is the shape the spawn path handed it (`f creds get` on
  // stdout, or its `no such cred` stderr). Handing a provider the raw store
  // shape is what made the in-process read useless even when the handle was
  // threaded correctly: a real hit came back as `{ token: <44 chars> }`, the
  // provider looked at `res.value`, saw undefined, and spawned anyway. Measured
  // on a live vault: 5 such spawns per `f creds status`.
  //
  // So translate at the boundary, and keep BOTH shapes on the way out: `token`
  // and `reason` for anything written against C3, `value` and `error` for the
  // provider-facing shape. Nothing is dropped, so this cannot break a consumer
  // that is already reading the store shape.
  const out = { ...res };
  if (out.value === undefined) out.value = res.token ?? null;
  if (out.error === undefined) {
    // `missing` is the store's word for "not in the box"; the spawn path said
    // `no such cred: <name>` and providers match on that phrase, so say it too.
    out.error = res.reason === "missing"
      ? `no such cred: ${res.host ?? (Array.isArray(names) ? names[0] : names)}`
      : (res.reason ?? null);
  }
  return out;
}

function probeHandle() {
  return { version: 3, rawCredRead: probeHandleRead };
}

/**
 * Import a discovered provider's own module so it can be called in-process.
 *
 * `f providers --dump` gives us `{ name, entry, … }` — a path, not a module — so
 * the only way to call the provider without a child is to import its entry.
 * `import()` resolves `node_modules` from the importing module, not the target's
 * directory, which is exactly CONTRACT.md P7; so we push the provider's own
 * directory onto NODE_PATH for the duration of the import and restore it after.
 * Any failure (no such file, a throw at module scope) returns null and the caller
 * keeps the spawn path.
 */
async function importProvider(entry) {
  if (typeof entry !== "string" || entry === "") return null;
  const url = pathToFileURL(path.resolve(entry)).href;
  const dir = path.dirname(path.resolve(entry));
  const saved = process.env.NODE_PATH;
  try {
    process.env.NODE_PATH = saved ? `${dir}${path.delimiter}${saved}` : dir;
    // node caches by resolved URL, so a second lookup is free.
    const mod = await import(url);
    const p = mod?.credentialProvider ?? mod?.default?.credentialProvider ?? mod?.default ?? mod;
    return p && typeof p === "object" && typeof p.resolve === "function" ? p : null;
  } catch {
    return null;
  } finally {
    if (saved === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = saved;
  }
}

/**
 * Does the provider's own code read the trailing parameter?
 *
 * `fn.length` counts parameters **before the first default**, so PR #6's
 * `status: (credsApi = null) => …` reports **0** and
 * `resolve: async (name, credsApi = null) => …` reports **1** — identical to a
 * provider written without any handle at all. Arity therefore cannot distinguish
 * them, and a gate built on it silently keeps every real provider on the spawn
 * path (measured: `status.length === 0` for the exact PR #6 declaration).
 *
 * So read the source instead. A defaulted parameter is unambiguous in text:
 * `name =` inside the parameter list. This is a heuristic over the provider's own
 * declared signature — it errs toward the spawn path (a provider whose source
 * cannot be read, or whose params are all positional, keeps the old behaviour),
 * which is the safe direction, and it is asserted directly by the test suite
 * rather than inferred.
 */
const srcCache = new Map();
function readsTrailingArg(fn, bare) {
  if (typeof fn !== "function") return false;
  if (fn.length > bare) return true;              // plain `(name, credsApi)` — no default
  let src = srcCache.get(fn);
  if (src === undefined) {
    try {
      src = Function.prototype.toString.call(fn);
    } catch {
      src = null;
    }
    srcCache.set(fn, src);
  }
  if (typeof src !== "string") return false;
  const open = src.indexOf("(");
  if (open < 0) return false;
  // Scan for the matching close, ignoring nested parens (defaulted object args,
  // nested arrow defaults) so we look at the parameter list and not the body.
  let depth = 0, close = -1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close < 0) return false;
  const params = src.slice(open + 1, close);
  // A parameter with a default value => the declaration carries the handle slot.
  return /(^|[,({\s])[^()=]*=/.test(params);
}

/**
 * Build the provider view of one `f providers --dump` row.
 *
 * Every method starts on the **child-process probe protocol** (CONTRACT.md P4):
 * `node <entry> resolve <name> | has <name> | status`. That is the fallback and it
 * is never removed — a provider whose module cannot be imported here, or that does
 * not declare the handle, behaves exactly as it always has.
 *
 * On top of that, a provider that declares the trailing `credsApi` argument is
 * offered an **in-process** call with the C3 handle. That is the point of this
 * half: the dump row is a *path*, and a provider that reads the creds store needs
 * a live handle, which a path cannot carry. Spawning it to ask "are you ready?"
 * is what produced `not ready: no creds uck in this f tree` on a box with a
 * perfectly good vault — the child had no handle to be given.
 *
 * `probeCredsRead` is the store read the handle wraps. It is injected by
 * `creds/index.js` (the only place with a store to read); left unset, no handle
 * exists and nothing but the spawn path can run.
 */
let probeCredsRead = null;

/** Wire the store read that `probeHandle()` wraps. Called once from register(). */
export function setProbeCredsRead(fn) {
  probeCredsRead = typeof fn === "function" ? fn : null;
}

/** Test seam: the handle a handle-aware provider would receive, or null. */
export function probeCredsHandle() {
  return probeCredsRead ? probeHandle() : null;
}

/**
 * The three child-process probe commands (CONTRACT.md P4), hoisted so BOTH
 * builders — `fromChildProcess()` (path from stdout) and `fromLiveDump()` (live
 * object) — fall back to the identical command line. Bodies are verbatim from
 * the original closures; only their home moved. A row's `entry` is the only
 * input, so a live-object provider degrades to exactly the child the old code
 * would have run.
 */
function spawnResolveOf(row) {
  return (name) => execFileSync(process.execPath, [row.entry, "resolve", String(name)], {
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 32 << 20,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function spawnHasOf(row) {
  return (name) => {
    try {
      return execFileSync(process.execPath, [row.entry, "has", String(name)], {
        encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
      }).trim() === "yes";
    } catch {
      return false;
    }
  };
}
function spawnStatusOf(row) {
  return () => {
    try {
      return JSON.parse(execFileSync(process.execPath, [row.entry, "status"], {
        encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
      }));
    } catch (e) {
      return { ready: false, note: "provider probe failed", hint: e.stderr?.toString?.().slice(0, 200) };
    }
  };
}

/**
 * Build provider objects from `f providers --dump` output. Exported for the test
 * harness only, so the suite can exercise THE REAL builder on a crafted dump row
 * instead of re-typing it (a re-typed copy tests the typing, not the code).
 */
export function fromChildProcess(stdout) {
  let obj;
  try {
    obj = JSON.parse(stdout);
  } catch {
    throw new Error(`providers --dump emitted unparseable JSON (${String(stdout).slice(0, 80)})`);
  }
  return (Array.isArray(obj) ? obj : [obj])
    // Presence of a name IS discovery (CONTRACT.md P8). `hasExternalApi` was
    // removed: there is no opt-out, and a uck that should not be probed
    // should not carry credentialProvider at all.
    .filter((p) => p && typeof p.name === "string")
    .map((p) => {
      // Spawn fallbacks: the hoisted helpers below, bound to this row's entry.
      const spawnResolve = spawnResolveOf(p);
      const spawnHas = spawnHasOf(p);
      const spawnStatus = spawnStatusOf(p);

      // In-process module, resolved lazily and once. `undefined` = not tried yet,
      // `null` = tried and unavailable (so we never re-import on every lookup).
      let mod;
      const inProcess = async () => {
        if (mod === undefined) mod = await importProvider(p.entry);
        return mod;
      };

      return {
        name: p.name,
        canWrite: p.canWrite === true,   // advertised by the provider; gates `creds set` dual-write
        mirrorTtlSec: typeof p.mirrorTtlSec === "number" ? p.mirrorTtlSec : undefined,
        // A handle-aware provider is called here with the C3 handle; anything
        // else (or an unimportable module) takes the spawn path unchanged.
        resolve: async (name) => {
          const m = await inProcess();
          const handle = probeCredsRead ? probeHandle() : null;
          if (m && handle && readsTrailingArg(m.resolve, 1)) return await m.resolve(String(name), handle);
          return spawnResolve(name);
        },
        has: async (name) => {
          const m = await inProcess();
          const handle = probeCredsRead ? probeHandle() : null;
          if (m && handle && readsTrailingArg(m.has, 1)) {
            try {
              return (await m.has(String(name), handle)) === true;
            } catch {
              return false; // pre-filter broke -> ask the real thing (askProviders' rule)
            }
          }
          return spawnHas(name);
        },
        // Value on stdin: the same reason `set` refuses argv (any process can read a
        // secret from `ps` for the command's lifetime). A provider that advertises
        // canWrite handles `write <name>` on its probe CLI; otherwise this throws.
        // Writes stay on the child: the brief scopes the handle to `status:` and
        // `resolve:`, and a write is not a probe.
        write: (name, value) => {
          if (p.canWrite !== true) throw new Error(`provider '${p.name}' does not accept writes`);
          return execFileSync(process.execPath, [p.entry, "write", String(name)], {
            input: String(value), encoding: "utf8", timeout: 90_000, stdio: ["pipe", "pipe", "pipe"],
          });
        },
        // THE ROW THIS IS ALL ABOUT. `f creds status` reads this, and the spawn
        // form is what reported `not ready: no creds uck in this f tree` — the
        // child had no store handle to ask with. With a handle-aware provider we
        // call it here and hand it the C3 read.
        status: async () => {
          const m = await inProcess();
          const handle = probeCredsRead ? probeHandle() : null;
          if (m && handle && readsTrailingArg(m.status, 0)) {
            try {
              return await m.status(handle);
            } catch (e) {
              // P3: a provider that cannot answer must say so, not be rewritten.
              // Report the failure the way the spawn path reports its own, and do
              // NOT silently re-run the child (that would double the probe cost).
              return { ready: false, note: "provider probe failed", hint: String(e?.message ?? e).slice(0, 200) };
            }
          }
          return spawnStatus();
        },
        external: p.entry,
      };
    });
}

/**
 * Build a provider from an IN-PROCESS dump row — one that carries `provider`,
 * the live `credentialProvider` object the providers uck imported in this
 * process.
 *
 * This is the fix. `fromChildProcess()` above receives only the dump's stdout,
 * so the best it can do is import the row's PATH — which yields a SECOND
 * instance of the provider module. The handle then goes to an instance nobody
 * prints from, the CLI shows the child's answer, and the spawn is paid anyway.
 * Here the object IS the one whose `status()` produced the row, so the
 * in-process result is the printed result and no child runs at all.
 *
 * Everything that is not a probe is deliberately unchanged: `write` still execs
 * the entry (a write is not a probe), and the fallbacks are the same hoisted
 * spawn helpers `fromChildProcess()` uses, bound to the same `entry`. A row
 * without a usable live object is handed to `fromChildProcess()` verbatim, so a
 * provider the peer could not import behaves exactly as it always has.
 */
export function fromLiveDump(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row.name !== "string") continue;
    const p = row.provider;
    if (!p || typeof p !== "object" || typeof p.resolve !== "function") {
      // No live object: the path builder and its spawn fallback handle this
      // exactly as before. Going through the real builder (rather than re-typing
      // its spawn code) keeps the two paths from drifting.
      out.push(...fromChildProcess(JSON.stringify([row])));
      continue;
    }
    const handle = () => (probeCredsRead ? probeHandle() : null);
    const spawnResolve = spawnResolveOf(row);
    const spawnHas = spawnHasOf(row);
    const spawnStatus = spawnStatusOf(row);
    out.push({
      name: p.name ?? row.name,
      canWrite: row.canWrite === true,
      mirrorTtlSec: typeof row.mirrorTtlSec === "number" ? row.mirrorTtlSec : undefined,
      // Same rule as fromChildProcess(): the handle is the LAST OPTIONAL
      // argument, so a provider written to the bare P4 shape is called as-is,
      // and detection stays on the parameter-list text (never fn.length).
      resolve: async (name) => {
        const h = handle();
        if (h && readsTrailingArg(p.resolve, 1)) return await p.resolve(String(name), h);
        return spawnResolve(name);
      },
      has: async (name) => {
        const h = handle();
        if (typeof p.has === "function" && h && readsTrailingArg(p.has, 1)) {
          try {
            return (await p.has(String(name), h)) === true;
          } catch {
            return false; // pre-filter broke -> ask the real thing (askProviders' rule)
          }
        }
        return spawnHas(name);
      },
      // Writes stay on the child even here: the handle is a probe credential and
      // a write is not a probe. Identical rule, identical command, to
      // fromChildProcess().write().
      write: (name, value) => {
        if (row.canWrite !== true) throw new Error(`provider '${row.name}' does not accept writes`);
        return execFileSync(process.execPath, [row.entry, "write", String(name)], {
          input: String(value), encoding: "utf8", timeout: 90_000, stdio: ["pipe", "pipe", "pipe"],
        });
      },
      // THE ROW THIS IS ALL ABOUT — `f creds status` prints this, and it now
      // comes from the same instance that produced the dump row.
      status: async () => {
        const h = handle();
        if (typeof p.status === "function" && h && readsTrailingArg(p.status, 0)) {
          try {
            return await p.status(h);
          } catch (e) {
            // P3: a provider that cannot answer must say so, not be rewritten.
            // Report it the way the spawn path reports its own failure, and do
            // NOT silently re-run the child (that would double the probe cost).
            return { ready: false, note: "provider probe failed", hint: String(e?.message ?? e).slice(0, 200) };
          }
        }
        return spawnStatus();
      },
      external: row.entry,
      // Diagnostic: which builder produced this provider. "Same instance" is
      // otherwise invisible from the outside, so the suite asserts on this.
      live: true,
    });
  }
  return out;
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
  // Cut the cycle here, at the edge we ourselves cross.
  //
  // Discovery spawns `f providers --dump`, which execs each provider's `status`
  // probe. A provider that reads the creds store from `status` ends up back in
  // `f creds status`, which calls listProviders(), which dumps again — unbounded.
  // That is not hypothetical: a configured vaultwarden provider reached ~2,600
  // live processes from one command.
  //
  // Honouring an inherited marker is what makes this terminate, because the
  // top-level `f providers --dump` has no marker to inherit and stops by
  // construction (it never calls listProviders).
  if (process.env.F_CREDS_NO_PROVIDER === "1") return out;
  if (!discovered) {
    discovered = true;
    // THE IN-PROCESS SHORTCUT. `f` loads every uck in ONE process, so the
    // providers uck is already here and has already imported every provider.
    // Asking it directly replaces the `f providers --dump` child entirely, and
    // — the part that actually matters — hands back the provider OBJECTS, so the
    // instance creds probes is the instance whose `status()` produced the row.
    // The dump's stdout could only ever carry a path, and a path cannot carry a
    // store handle; that is why the handle used to be built, offered, and thrown
    // away. Null (no peer, foreign ctx, peer error) falls through to the spawn.
    const live = await discoverViaPeer();
    if (live) {
      for (const p of fromLiveDump(live)) {
        if (!out.some((x) => x.name === p.name)) out.push(p);
      }
      return out;
    }
    try {
      const stdout = execFileSync("f", ["providers", "--dump"], {
        encoding: "utf8", timeout: 25_000, stdio: ["ignore", "pipe", "pipe"],
        // Every provider child inherits this, so any nested discovery attempt
        // returns early instead of spawning another dump.
        env: { ...process.env, F_CREDS_NO_PROVIDER: "1" },
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
