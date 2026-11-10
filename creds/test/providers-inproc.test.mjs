// Tests for the CALLER half of the in-process credential probe (CONTRACT.md §5 P4, §6.1 C3).
//
//   node --test creds/test/providers-inproc.test.mjs
//
// `fromChildProcess()` turns one `f providers --dump` row into a provider. Every
// row used to be a PATH, and a path cannot carry a store handle — so asking a
// provider "are you ready?" meant spawning it, and the child answered from a
// process with no creds uck in its registry. That is the measured
// `not ready: no creds uck in this f tree` beside a healthy vault.
//
// The fix hands the handle to a provider that DECLARES it
// (`status: (credsApi = null) => …`, `resolve: async (name, credsApi = null) => …` —
// kensand/kensand-fcli-ucks#6) and keeps the spawn path for everyone else. So the
// properties worth locking down are exactly the three the design turns on:
//   (a) a handle-aware provider is called IN-PROCESS and NO child is spawned;
//   (b) with no store read wired there is no handle, and the OLD SPAWN PATH RUNS
//       (observable: the fake execFileSync records that it was exec'd);
//   (c) a provider that does not accept the trailing arg still works, on spawn.
//
// `execFileSync` is stubbed with a node:module loader hook, because providers.js
// binds it statically — monkey-patching `child_process` would not reach the
// already-bound import, and a test that cannot OBSERVE the spawn cannot prove the
// fallback either. Test (V2) asserts the hook is live, so a silent hook failure
// cannot masquerade as "no spawn happened".

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(path.resolve(import.meta.filename));
const CREDS = path.dirname(HERE);           // the creds uck under test
const REAL_HOME = os.homedir();

let pass = 0, fail = 0;
const t = async (label, fn) => {
  try {
    await fn();
    pass++;
    console.log(`ok   ${label}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${label}\n     ${String(e?.message ?? e).split("\n").join("\n     ")}`);
  }
};

/* ---------------------------------------------------------------- fixtures */

// Throwaway HOME under the real home (NOT /tmp — `f` clones the uck store into
// any HOME lacking one, which would run a stale copy of the code under test).
const TMP = fs.mkdtempSync(path.join(REAL_HOME, ".f-creds-inproc-"));
// NOT under creds/ — the loader hook stubs node:child_process for anything whose
// parent URL contains "/creds/", so a fixture in there would be stubbed too and
// importProvider() would fail for the wrong reason.
const PROV_DIR = path.join(TMP, "prov");
fs.mkdirSync(PROV_DIR, { recursive: true });
process.env.HOME = TMP;
delete process.env.F_CREDS_NO_PROVIDER;

// Every execFileSync the uck under test performs is recorded here; none of them
// are allowed to actually run.
globalThis.__execCalls = [];
globalThis.__execStub = null;
const STUB = path.join(HERE, "_execstub.mjs");
fs.writeFileSync(STUB, `
// creds/index.js and creds/test.js import spawn from this module; the hook
// replaces the whole specifier, so re-export the names they bind even though
// this suite only ever intercepts execFileSync.
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
    // Only the uck under test gets the stub; the harness itself keeps the real one.
    if (spec === "node:child_process" && /\/creds\/(index|providers|test)\.js$/.test(ctx.parentURL ?? "")) {
      return { url: pathToFileURL(STUB).href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const prov = await import(path.join(CREDS, "providers.js"));
const { fromChildProcess, setProbeCredsRead, probeCredsHandle, resetProviders } = prov;

/** Fail loudly if the seam under test is missing — otherwise (a) passes vacuously. */
if (typeof setProbeCredsRead !== "function" || typeof probeCredsHandle !== "function") {
  console.log("FAIL harness: setProbeCredsRead/probeCredsHandle absent from creds/providers.js — this suite would test nothing");
  process.exit(1);
}

/** Write a provider module to disk, as `f providers --dump` would point at it. */
let seq = 0;
function writeProvider(body, file = `prov${seq++}.js`) {
  const entry = path.join(PROV_DIR, file);
  fs.writeFileSync(entry, body);
  return entry;
}

/** One dump row, through the REAL builder. */
const rows = (...entries) => fromChildProcess(JSON.stringify(entries));

const reset = () => {
  globalThis.__execCalls.length = 0;
  globalThis.__execStub = null;
  resetProviders();
  setProbeCredsRead(null);
};

// The store read the handle wraps. In the real uck this is rawCredRead.
const storeRead = async (names) => ({ token: "STORE:" + String(names), src: "test" });

// A provider written the way PR #6 writes it: handle as the LAST OPTIONAL arg.
const HANDLE_AWARE = `
export const credentialProvider = {
  name: "handleaware",
  resolve: async (name, credsApi = null) => {
    const seen = credsApi && typeof credsApi.rawCredRead === "function" ? "HANDLE" : "NO-HANDLE";
    return "inproc:" + name + ":" + seen;
  },
  status: (credsApi = null) => ({
    ready: !!(credsApi && typeof credsApi.rawCredRead === "function"),
    note: credsApi && typeof credsApi.rawCredRead === "function"
      ? "ready: via in-process handle"
      : "not ready: no creds uck in this f tree",
  }),
};
`;

// A provider written to the bare §5 shape: resolve(name), status(). No handle.
const BARE = `
export const credentialProvider = {
  name: "bare",
  resolve: (name) => "in-process-should-not-run:" + name,
  status: () => ({ ready: true, note: "in-process-should-not-run" }),
};
`;

/* ------------------------------------------------------------------ suite */

await t("(a) handle-aware provider is called in-process and NO spawn occurs", async () => {
  reset();
  const entry = writeProvider(HANDLE_AWARE);
  setProbeCredsRead(storeRead);
  const [p] = rows({ name: "handleaware", entry, canWrite: false });

  const st = await p.status();
  assert.equal(st.ready, true, `status() did not get a live handle: ${JSON.stringify(st)}`);
  assert.match(st.note, /in-process handle/);

  assert.equal(await p.resolve("tok"), "inproc:tok:HANDLE", "resolve() did not receive the handle as its 2nd arg");
  assert.equal(globalThis.__execCalls.length, 0,
    `expected NO spawn, saw ${globalThis.__execCalls.length}: ${JSON.stringify(globalThis.__execCalls.map((c) => c[1]))}`);
});

await t("(b) with no store read wired, the OLD SPAWN PATH RUNS (fallback is observable)", async () => {
  reset();
  const entry = writeProvider(HANDLE_AWARE);
  // Deliberately NOT calling setProbeCredsRead: no handle exists in this process.
  assert.equal(probeCredsHandle(), null, "no handle may exist when no store read is wired");

  globalThis.__execStub = { ret: JSON.stringify({ ready: false, note: "spawned" }) };
  const [p] = rows({ name: "handleaware", entry, canWrite: false });

  const st = await p.status();
  assert.equal(st.note, "spawned", "status() must come from the child when there is no handle");
  assert.equal(st.ready, false, "the spawn answer must not be upgraded to ready");
  assert.equal(globalThis.__execCalls.length, 1, `expected exactly 1 spawn, saw ${globalThis.__execCalls.length}`);
  assert.deepEqual(globalThis.__execCalls[0][1], [entry, "status"], "spawn must use the P4 probe protocol");

  globalThis.__execCalls.length = 0;
  globalThis.__execStub = { ret: "spawned:tok" };
  assert.equal(await p.resolve("tok"), "spawned:tok");
  assert.deepEqual(globalThis.__execCalls[0][1], [entry, "resolve", "tok"], "resolve must fall back to the P4 probe");
});

await t("(c) a provider that does not accept the second arg still works (on spawn)", async () => {
  reset();
  const entry = writeProvider(BARE);
  setProbeCredsRead(storeRead);   // handle IS available; arity must still refuse it

  globalThis.__execStub = { ret: JSON.stringify({ ready: true, note: "from-child" }) };
  const [p] = rows({ name: "bare", entry, canWrite: false });

  const st = await p.status();
  assert.equal(st.note, "from-child", "a bare provider must not be handed the handle");
  assert.deepEqual(globalThis.__execCalls[0][1], [entry, "status"]);

  globalThis.__execCalls.length = 0;
  globalThis.__execStub = { ret: "child:tok" };
  assert.equal(await p.resolve("tok"), "child:tok");
  assert.deepEqual(globalThis.__execCalls[0][1], [entry, "resolve", "tok"]);
});

await t("(c2) an unimportable entry falls back to spawn instead of throwing", async () => {
  reset();
  setProbeCredsRead(storeRead);
  globalThis.__execStub = { ret: JSON.stringify({ ready: true, note: "child-after-bad-import" }) };
  const [p] = rows({ name: "ghost", entry: path.join(PROV_DIR, "does-not-exist.js"), canWrite: false });
  const st = await p.status();
  assert.equal(st.note, "child-after-bad-import");
  assert.equal(globalThis.__execCalls.length, 1, "an unimportable provider must still be probed by child");
});

await t("(d) the handle is the C3 read and nothing else", async () => {
  reset();
  setProbeCredsRead(storeRead);
  const h = probeCredsHandle();
  assert.ok(h, "a handle must exist once the store read is wired");
  assert.equal(typeof h.rawCredRead, "function", "handle must expose rawCredRead (CONTRACT.md C3)");
  const r = await h.rawCredRead(["a", "b"]);
  assert.equal(r.token, "STORE:a,b", "rawCredRead must reach the real store read");
  // The recursion guard: resolveCred runs the provider ladder, so a provider
  // holding it could call straight back into the listProviders() that asked it.
  for (const forbidden of ["resolveCred", "resolve", "set", "setRaw", "rm", "unlock", "lock", "permanentUnlock", "providers"]) {
    assert.equal(h[forbidden], undefined, `handle must NOT expose ${forbidden} (recursion / write surface)`);
  }
  reset();
  assert.equal(probeCredsHandle(), null, "unwiring the store read must remove the handle");
});

await t("(e) has() honours the same handle-detection rule", async () => {
  reset();
  const entry = writeProvider(`
    export const credentialProvider = {
      name: "handleaware2",
      resolve: async (name, credsApi = null) => "v",
      has: (name, credsApi = null) => name === "mine",
    };
  `);
  setProbeCredsRead(storeRead);
  const [p] = rows({ name: "handleaware2", entry, canWrite: false });
  assert.equal(await p.has("mine"), true);
  assert.equal(await p.has("other"), false);
  assert.equal(globalThis.__execCalls.length, 0, "handle-aware has() must not spawn");
});

await t("(f) a throwing in-process status reports failure and does not re-spawn", async () => {
  reset();
  const entry = writeProvider(`
    export const credentialProvider = {
      name: "thrower",
      resolve: async (name, credsApi = null) => { throw new Error("vault offline"); },
      status: (credsApi = null) => { throw new Error("vault offline"); },
    };
  `);
  setProbeCredsRead(storeRead);
  globalThis.__execStub = { ret: JSON.stringify({ ready: true, note: "child" }) };
  const [p] = rows({ name: "thrower", entry, canWrite: false });
  const st = await p.status();
  assert.equal(st.ready, false, "a throwing provider must not claim ready (P3)");
  assert.match(String(st.hint), /vault offline/);
  assert.equal(globalThis.__execCalls.length, 0, "a failed in-process status must not silently re-run the child");
});

await t("(g) write() stays on the child even for a handle-aware provider", async () => {
  reset();
  const entry = writeProvider(HANDLE_AWARE);
  setProbeCredsRead(storeRead);
  globalThis.__execStub = { ret: "" };
  const [p] = rows({ name: "handleaware", entry, canWrite: true });
  await p.write("tok", "v");
  assert.deepEqual(globalThis.__execCalls[0][1], [entry, "write", "tok"], "writes are not probes; they stay on the child");
});

await t("(h) the real creds uck wires the store read at register()", async () => {
  reset();
  const { register } = await import(path.join(CREDS, "index.js"));
  register({});
  const h = probeCredsHandle();
  assert.ok(h, "register() must wire the store read so a handle can exist");
  assert.equal(typeof h.rawCredRead, "function");
  setProbeCredsRead(null);
});

/* ------------------------------------------------ non-vacuity (mutation) */

await t("(V1) the spawn recorder really observes execFileSync (else (a)/(b) are vacuous)", async () => {
  reset();
  const entry = writeProvider(HANDLE_AWARE);
  setProbeCredsRead(storeRead);
  const [p] = rows({ name: "handleaware", entry, canWrite: false });
  await p.status();
  assert.equal(globalThis.__execCalls.length, 0, "hook should be suppressing spawn for a handle-aware provider");
  // Now force the fallback in the SAME harness and prove the recorder sees it.
  setProbeCredsRead(null);
  globalThis.__execStub = { ret: JSON.stringify({ ready: true }) };
  await p.status();
  assert.equal(globalThis.__execCalls.length, 1,
    "the loader hook is NOT observing execFileSync — every 'no spawn' assertion above would pass vacuously");
});

await t("(V2) a caller that does not pass the handle reports NO-HANDLE (assertion (a) depends on it)", async () => {
  reset();
  const entry = writeProvider(HANDLE_AWARE);
  // Call the provider the way the PRE-CHANGE caller did: no second argument.
  const m = await import(pathToFileURL(entry).href);
  assert.equal(await m.credentialProvider.resolve("tok"), "inproc:tok:NO-HANDLE");
  assert.equal(m.credentialProvider.status().ready, false,
    "the provider reports not-ready without a handle — so (a) can only pass if the handle is threaded");
  assert.match(m.credentialProvider.status().note, /no creds uck in this f tree/);
});

await t("(V3) handle detection is the gate, not mere presence of status()", async () => {
  reset();
  // Same method bodies as HANDLE_AWARE, declared with the bare arity: must NOT
  // be handed the handle. This is what pins the feature-detect to `fn.length`.
  const entry = writeProvider(`
    export const credentialProvider = {
      name: "arities",
      // No default anywhere in the parameter list => the declaration carries no
      // handle slot, so detection must refuse to hand it one even though the
      // body would happily accept a second argument.
      resolve: (...a) => "in-process:" + a[0],
      status: () => ({ ready: true, note: "in-process" }),
    };
  `);
  setProbeCredsRead(storeRead);
  globalThis.__execStub = { ret: JSON.stringify({ ready: false, note: "child" }) };
  const [p] = rows({ name: "arities", entry, canWrite: false });
  const st = await p.status();
  assert.equal(st.note, "child", "a 0-arity status() must not be handed the handle");
  globalThis.__execCalls.length = 0;
  globalThis.__execStub = { ret: "child" };
  assert.equal(await p.resolve("tok"), "child");
});

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
try { fs.rmSync(STUB, { force: true }); } catch { /* best effort */ }
process.exit(fail ? 1 : 0);
