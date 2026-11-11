// The regression this repo shipped at 1bcca79d, pinned.
//
//   node --test creds/test/providers-same-instance.test.mjs
//
// `fromChildProcess()` is handed the dump's STDOUT, which is a list of paths.
// Importing a path yields a SECOND instance of the provider module - separate
// from the one the providers uck already imported to produce the dump. So the
// in-process handle went to an instance nobody prints from, the CLI's status
// line came from the child, and the spawn was paid anyway (plus one nested
// `f creds status` the old tree did not make). Measured on a live vault: 7
// nested spawns per `f creds status`, of which 5 were `creds get vaultwarden.*`
// because the handle's read shape ({token,reason}) never matched what the
// provider inspects ({value,error}).
//
// The fix is a registry hand-off: discovery asks the providers uck IN-PROCESS
// and gets the live credentialProvider OBJECT back. So the properties worth
// locking down are:
//   (1) discovery, with the peer wired, produces a provider whose status() is
//       the SAME OBJECT the peer discovered - identity, not equality;
//   (2) that path spawns NOTHING;
//   (3) the handle's read is legible to a provider written against the
//       `{value, error}` shape the spawn path used to hand it - a hit must be
//       a hit, and `missing` must read as "no such cred";
//   (4) with no peer wired, the OLD SPAWN PATH still runs (the fallback is
//       observable, so (1)/(2) cannot pass vacuously);
//   (5) the handle's surface is still only version + rawCredRead.
//
// execFileSync is stubbed with a node:module loader hook for the same reason the
// in-process suite does it: providers.js binds it statically, and a test that
// cannot OBSERVE the spawn cannot prove its absence.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(path.resolve(import.meta.filename));
const CREDS = path.dirname(HERE);                 // the creds uck
const BUCKET = path.dirname(CREDS);               // the bucket root (holds providers/)
const REAL_HOME = os.homedir();

let pass = 0, fail = 0;
const t = async (label, fn) => {
  try { await fn(); pass++; console.log(`ok   ${label}`); }
  catch (e) { fail++; console.log(`FAIL ${label}\n     ${String(e?.message ?? e).split("\n").join("\n     ")}`); }
};

/* ---------------------------------------------------------------- fixtures */

const TMP = fs.mkdtempSync(path.join(REAL_HOME, ".f-creds-sameinst-"));
// NOT under creds/ - the hook stubs node:child_process for anything whose parent
// URL contains "/creds/", so a fixture in there would be stubbed too.
const PROV_DIR = path.join(TMP, "prov");
fs.mkdirSync(PROV_DIR, { recursive: true });
process.env.HOME = TMP;
delete process.env.F_CREDS_NO_PROVIDER;

globalThis.__execCalls = [];
globalThis.__execStub = null;
const STUB = path.join(HERE, "_execstub2.mjs");
fs.writeFileSync(STUB, `
export const spawn = () => { throw new Error("stub: spawn must not be called"); };
export const spawnSync = () => { throw new Error("stub: spawnSync must not be called"); };
export function execFileSync(...a) {
  globalThis.__execCalls.push(a);
  const o = globalThis.__execStub;
  if (!o) throw new Error("stub: unexpected execFileSync " + JSON.stringify(a[1] ?? a[0]));
  if (o.throw) { const e = new Error(o.throw); e.stderr = o.stderr; throw e; }
  return o.ret;
}
export default { execFileSync };
`);

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "node:child_process" && /\/creds\/(index|providers|test)\.js$/.test(ctx.parentURL ?? "")) {
      return { url: pathToFileURL(STUB).href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const prov = await import(path.join(CREDS, "providers.js"));
const {
  fromLiveDump, listProviders, setProvidersUck, setProbeCredsRead,
  probeCredsHandle, resetProviders,
} = prov;

/** Fail loudly if the seam under test is missing - otherwise (1)/(2) pass vacuously. */
if (typeof fromLiveDump !== "function" || typeof setProvidersUck !== "function") {
  console.log("FAIL harness: fromLiveDump/setProvidersUck absent from creds/providers.js - this suite would test nothing");
  process.exit(1);
}

let seq = 0;
const writeProvider = (body, file = `p${seq++}.js`) => {
  const entry = path.join(PROV_DIR, file);
  fs.writeFileSync(entry, body);
  return entry;
};

const HANDLE_AWARE = `
export const credentialProvider = {
  name: "handleaware",
  resolve: async (name, credsApi = null) => {
    const r = credsApi && typeof credsApi.rawCredRead === "function"
      ? await credsApi.rawCredRead([name]) : null;
    return r && r.value != null ? "inproc:" + r.value : "inproc:NO-VALUE";
  },
  status: (credsApi = null) => ({
    ready: !!(credsApi && typeof credsApi.rawCredRead === "function"),
    note: credsApi && typeof credsApi.rawCredRead === "function"
      ? "ready: via in-process handle" : "not ready: no creds uck in this f tree",
  }),
};
`;

const reset = () => {
  globalThis.__execCalls.length = 0;
  globalThis.__execStub = null;
  resetProviders();
  setProbeCredsRead(null);
  setProvidersUck(null);
};

// The store read the handle wraps. In the real uck this is rawCredRead, whose
// answer shape is { token, reason } (CONTRACT.md C3 / §7.2) - NOT { value }.
const storeRead = async (names) => ({ token: "STORE:" + String(names), src: "test", localOnly: true });
const storeMiss = async (names) => ({ token: null, reason: "missing", host: String(names) });

/** Stand in for the providers uck: it hands back rows with the live object. */
const fakePeer = (rows) => ({
  name: "providers",
  run: () => {},
  discoverInProcess: async () => rows,
});

/* ------------------------------------------------------------------- suite */

await t("(1) discovery with the peer wired probes the SAME object the peer found", async () => {
  reset();
  const entry = writeProvider(HANDLE_AWARE);
  // Import the provider the way the providers uck's collect() does, so the
  // identity assertion below is against a real module instance.
  const live = (await import(pathToFileURL(entry).href)).credentialProvider;
  setProbeCredsRead(storeRead);
  setProvidersUck(fakePeer([{ name: "handleaware", entry, canWrite: false, provider: live }]));

  const [p] = await listProviders();
  assert.equal(p.live, true, "discovery did not take the in-process path");
  // THE ASSERTION THAT MATTERS: identity, not equality. `p.status()` must reach
  // the very object the peer discovered, not a second import of its path.
  const seen = [];
  const probe = { ...live, status: (api = null) => { seen.push(api); return live.status(api); } };
  setProvidersUck(fakePeer([{ name: "handleaware", entry, canWrite: false, provider: probe }]));
  resetProviders();
  const [q] = await listProviders();
  await q.status();
  assert.equal(seen.length, 1, "the peer's own status() was never reached - a second instance was probed instead");
  assert.ok(seen[0] && typeof seen[0].rawCredRead === "function", "the peer's status() got no handle");
});

await t("(2) the in-process path spawns NOTHING", async () => {
  reset();
  const entry = writeProvider(HANDLE_AWARE);
  const live = (await import(pathToFileURL(entry).href)).credentialProvider;
  setProbeCredsRead(storeRead);
  setProvidersUck(fakePeer([{ name: "handleaware", entry, canWrite: false, provider: live }]));

  const [p] = await listProviders();
  const st = await p.status();
  assert.equal(st.ready, true, `status() got no live handle: ${JSON.stringify(st)}`);
  assert.match(st.note, /in-process handle/);
  assert.equal(await p.resolve("tok"), "inproc:STORE:tok", "resolve() did not read through the handle");
  assert.equal(globalThis.__execCalls.length, 0,
    `expected NO spawn, saw ${globalThis.__execCalls.length}: ${JSON.stringify(globalThis.__execCalls.map((c) => c[1]))}`);
});

await t("(3) a store HIT is legible to a provider written against {value,error}", async () => {
  reset();
  const entry = writeProvider(HANDLE_AWARE);
  const live = (await import(pathToFileURL(entry).href)).credentialProvider;
  setProbeCredsRead(storeRead);
  setProvidersUck(fakePeer([{ name: "handleaware", entry, canWrite: false, provider: live }]));
  const [p] = await listProviders();
  // This is the measured defect: rawCredRead answers { token }, the provider
  // reads res.value. Before the fix this returned "inproc:NO-VALUE" and the
  // provider spawned instead.
  assert.equal(await p.resolve("tok"), "inproc:STORE:tok",
    "a real store hit was invisible to the provider (the {token} vs {value} mismatch)");
});

await t("(3b) a store MISS reads as 'no such cred', not as a handle decline", async () => {
  reset();
  const entry = writeProvider(`
    export const credentialProvider = {
      name: "missreader",
      resolve: async (name, credsApi = null) => {
        const r = await credsApi.rawCredRead([name]);
        if (r.value != null) return "HIT";
        // The spawn path said 'no such cred: <name>' on stderr; a provider
        // matches that phrase to mean a genuine miss.
        return /no such cred/i.test(String(r.error ?? "")) ? "MISS" : "DECLINED";
      },
      status: (credsApi = null) => ({ ready: true }),
    };
  `);
  const live = (await import(pathToFileURL(entry).href)).credentialProvider;
  setProbeCredsRead(storeMiss);
  setProvidersUck(fakePeer([{ name: "missreader", entry, canWrite: false, provider: live }]));
  const [p] = await listProviders();
  assert.equal(await p.resolve("absent"), "MISS",
    "a 'missing' reason must read as a miss, or the provider spawns to ask the same question");
});

await t("(3c) the handle keeps the C3 shape too - nothing is dropped", async () => {
  reset();
  setProbeCredsRead(storeRead);
  const h = probeCredsHandle();
  const r = await h.rawCredRead(["a"]);
  assert.equal(r.token, "STORE:a", "the C3 `token` field must survive the translation");
  assert.equal(r.value, "STORE:a", "the provider-facing `value` must be present");
  setProbeCredsRead(storeMiss);
  const m = await probeCredsHandle().rawCredRead(["ghost"]);
  assert.equal(m.token, null, "a miss must not invent a token");
  assert.equal(m.reason, "missing", "the §7.2 reason vocabulary must survive");
  assert.match(String(m.error), /no such cred/);
});

await t("(4) with NO peer wired, discovery pays for the `f providers --dump` spawn", async () => {
  reset();
  const entry = writeProvider(HANDLE_AWARE);
  setProbeCredsRead(storeRead);
  // Deliberately no setProvidersUck(): this is the pre-fix world, where the only
  // route to a provider was the dump's stdout. What the peer replaces is the
  // DUMP SPAWN, so that is what this asserts on. (The status probe cannot be
  // asserted here: providers.js imports the entry path, and Node's module cache
  // hands back the instance an earlier test already imported - a property of a
  // single-process test, not of the fix. In the real CLI the dump is a child
  // with an empty cache, which is exactly why it needed the peer.)
  globalThis.__execStub = { ret: JSON.stringify([{ name: "handleaware", entry, canWrite: false }]) };
  const [p] = await listProviders();
  const dump = globalThis.__execCalls.filter((c) => c[0] === "f" && (c[1] ?? []).includes("--dump"));
  assert.equal(dump.length, 1,
    `without a peer, discovery must spawn the dump exactly once; saw ${dump.length}`);
  assert.notEqual(p.live, true, "without a peer, discovery must not claim the live path");
});

await t("(4b) a peer that throws falls back to the dump spawn instead of erroring", async () => {
  reset();
  const entry = writeProvider(HANDLE_AWARE);
  setProbeCredsRead(storeRead);
  setProvidersUck({ name: "providers", run: () => {}, discoverInProcess: async () => { throw new Error("peer exploded"); } });
  globalThis.__execStub = { ret: JSON.stringify([{ name: "handleaware", entry, canWrite: false }]) };
  const [p] = await listProviders();
  assert.notEqual(p.live, true, "a throwing peer must degrade to the spawn path, not to an error");
  const dump = globalThis.__execCalls.filter((c) => c[0] === "f" && (c[1] ?? []).includes("--dump"));
  assert.equal(dump.length, 1, "a failed peer must pay the dump spawn, exactly as before the fix");
});

await t("(4c) a live row without a provider object delegates to the real builder", async () => {
  reset();
  const entry = writeProvider(HANDLE_AWARE);
  setProbeCredsRead(storeRead);
  const built = fromLiveDump([{ name: "handleaware", entry, canWrite: false }]);
  assert.equal(built.length, 1, "a row without a provider object must still produce a provider");
  const [p] = built;
  assert.notEqual(p.live, true, "a row with no provider object must not be marked live");
  assert.equal(p.external, entry, "the delegated provider must keep the row's entry for its spawn fallback");
});

await t("(5) write() stays on the child even for a LIVE provider", async () => {
  reset();
  const entry = writeProvider(HANDLE_AWARE);
  const live = (await import(pathToFileURL(entry).href)).credentialProvider;
  setProbeCredsRead(storeRead);
  globalThis.__execStub = { ret: "" };
  const [p] = fromLiveDump([{ name: "handleaware", entry, canWrite: true, provider: live }]);
  assert.equal(p.live, true);
  await p.write("tok", "v");
  assert.deepEqual(globalThis.__execCalls[0][1], [entry, "write", "tok"],
    "a write is not a probe; it must stay on the child even on the live path");
});

await t("(5b) the handle surface is still only version + rawCredRead", async () => {
  reset();
  setProbeCredsRead(storeRead);
  const h = probeCredsHandle();
  assert.equal(typeof h.rawCredRead, "function");
  for (const bad of ["resolveCred", "resolve", "set", "setRaw", "rm", "unlock", "lock", "permanentUnlock", "providers"]) {
    assert.equal(h[bad], undefined, `handle must NOT expose ${bad} (recursion / write surface)`);
  }
});

/* ------------------------------------------------ non-vacuity (mutation) */

await t("(V1) the spawn recorder really observes execFileSync", async () => {
  reset();
  const entry = writeProvider(HANDLE_AWARE);
  const live = (await import(pathToFileURL(entry).href)).credentialProvider;
  setProbeCredsRead(storeRead);
  setProvidersUck(fakePeer([{ name: "handleaware", entry, canWrite: false, provider: live }]));
  const [p] = await listProviders();
  await p.status();
  assert.equal(globalThis.__execCalls.length, 0, "the live path should not spawn");
  // Force the fallback in the SAME harness and prove the recorder sees it.
  setProvidersUck(null);
  resetProviders();
  globalThis.__execStub = { ret: JSON.stringify([{ name: "handleaware", entry, canWrite: false }]) };
  const [q] = await listProviders();
  globalThis.__execStub = { ret: JSON.stringify({ ready: true }) };
  await q.status();
  assert.ok(globalThis.__execCalls.length >= 1,
    "the loader hook is NOT observing execFileSync - every 'no spawn' assertion above would pass vacuously");
});

await t("(V2) the provider reports NO-HANDLE when called the pre-fix way", async () => {
  reset();
  const entry = writeProvider(HANDLE_AWARE);
  const m = await import(pathToFileURL(entry).href);
  assert.equal(m.credentialProvider.status().ready, false,
    "the provider must report not-ready without a handle, so (1)/(2) can only pass if it is threaded");
  assert.match(m.credentialProvider.status().note, /no creds uck in this f tree/);
});

await t("(V3) fromLiveDump is the only thing that marks a provider live", async () => {
  reset();
  const entry = writeProvider(HANDLE_AWARE);
  const live = (await import(pathToFileURL(entry).href)).credentialProvider;
  setProbeCredsRead(storeRead);
  const [a] = fromLiveDump([{ name: "handleaware", entry, canWrite: false, provider: live }]);
  assert.equal(a.live, true);
  const [b] = prov.fromChildProcess(JSON.stringify([{ name: "handleaware", entry, canWrite: false, provider: live }]));
  assert.notEqual(b.live, true,
    "fromChildProcess must NOT take the live path - it only has stdout text, and that is the defect");
});

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
try { fs.rmSync(STUB, { force: true }); } catch { /* best effort */ }
process.exit(fail ? 1 : 0);
