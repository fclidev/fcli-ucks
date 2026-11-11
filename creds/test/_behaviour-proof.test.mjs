// Behavioural proof that main (1bcca79d) is broken, written so it LOADS on both
// main and the fix: it uses only seams that exist on both (fromChildProcess,
// listProviders, setProbeCredsRead, probeCredsHandle) and asserts the two things
// the fix is supposed to change. Run against 1bcca79d -> RED. Run against the
// fix -> GREEN.
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(path.resolve(import.meta.filename));
const CREDS = path.dirname(HERE);
const REAL_HOME = os.homedir();
let pass = 0, fail = 0;
const t = async (l, fn) => { try { await fn(); pass++; console.log(`ok   ${l}`); } catch (e) { fail++; console.log(`FAIL ${l}\n     ${String(e?.message ?? e).split("\n").join("\n     ")}`); } };

const TMP = fs.mkdtempSync(path.join(REAL_HOME, ".f-behav-"));
const PROV_DIR = path.join(TMP, "prov"); fs.mkdirSync(PROV_DIR, { recursive: true });
process.env.HOME = TMP; delete process.env.F_CREDS_NO_PROVIDER;

globalThis.__execCalls = []; globalThis.__execStub = null;
const STUB = path.join(HERE, "_execstub3.mjs");
fs.writeFileSync(STUB, `
export const spawn = () => { throw new Error("stub"); };
export const spawnSync = () => { throw new Error("stub"); };
export function execFileSync(...a){ globalThis.__execCalls.push(a); const o=globalThis.__execStub;
  if(!o) throw new Error("stub: unexpected "+JSON.stringify(a[1]??a[0])); return o.ret; }
export default { execFileSync };
`);
registerHooks({ resolve(spec, ctx, next) {
  if (spec === "node:child_process" && /\/creds\/(index|providers|test)\.js$/.test(ctx.parentURL ?? ""))
    return { url: pathToFileURL(STUB).href, shortCircuit: true };
  return next(spec, ctx);
}});

const prov = await import(path.join(CREDS, "providers.js"));
const { listProviders, setProbeCredsRead, probeCredsHandle, resetProviders } = prov;

const entry = path.join(PROV_DIR, "p.js");
fs.writeFileSync(entry, `
export const credentialProvider = {
  name: "behav",
  resolve: async (name, credsApi = null) => {
    const r = credsApi && typeof credsApi.rawCredRead === "function" ? await credsApi.rawCredRead([name]) : null;
    return r && r.value != null ? "HANDLE-SAW-VALUE:" + r.value : "HANDLE-SAW-NO-VALUE";
  },
  status: (credsApi = null) => ({ ready: !!(credsApi && credsApi.rawCredRead), note: "n" }),
};
`);
const live = (await import(pathToFileURL(entry).href)).credentialProvider;

// THE SHAPE THE REAL STORE RETURNS. rawCredRead answers { token, reason }
// (CONTRACT.md C3 / §7.2) - this is not a fixture invention.
const storeRead = async (names) => ({ token: "REAL-TOKEN", src: "socket:x (local only)", localOnly: true });

await t("(A) the handle's read is legible to a provider written against {value,error}", async () => {
  resetProviders(); setProbeCredsRead(storeRead);
  const h = probeCredsHandle();
  const r = await h.rawCredRead(["tok"]);
  // On main this is undefined: the handle passes rawCredRead's {token} straight
  // through, and the merged provider reads res.value.
  assert.notEqual(r.value, undefined,
    `the probe handle returned no \`value\` for a real store hit (got keys ${Object.keys(r)}) - a provider reading res.value spawns instead`);
  assert.equal(r.value, "REAL-TOKEN");
});

await t("(B) a provider reached through the handle sees the store value", async () => {
  resetProviders(); setProbeCredsRead(storeRead);
  const seen = [];
  const spy = { ...live, resolve: async (n, api = null) => { const v = await live.resolve(n, api); seen.push(v); return v; } };
  globalThis.__execStub = { ret: JSON.stringify([{ name: "behav", entry, canWrite: false }]) };
  const [p] = await listProviders();
  // Call the provider the way the caller does. On main the caller imports the
  // PATH (a second instance) and the handle still carries the wrong shape, so
  // the provider reports it saw no value.
  const out = await (p.live ? p.resolve("tok") : spy.resolve("tok", probeCredsHandle()));
  assert.match(String(out), /^HANDLE-SAW-VALUE:/,
    `the provider could not read the store through the handle (got: ${out})`);
});

await t("(C) discovery with the providers peer wired spawns NOTHING", async () => {
  // Clear the spawn log: this assertion is about THIS test's spawns, and (B)
  // legitimately paid for a dump on the pre-fix path.
  globalThis.__execCalls.length = 0;
  globalThis.__peerCalled = 0;
  resetProviders(); setProbeCredsRead(storeRead);
  if (typeof prov.setProvidersUck !== "function") {
    // Main has no peer seam at all: discovery can only be answered by spawning
    // the dump. That IS the defect, so record it as a failure rather than skip.
    globalThis.__execStub = { ret: JSON.stringify([{ name: "behav", entry, canWrite: false }]) };
    await listProviders();
    const dump = globalThis.__execCalls.filter((c) => c[0] === "f" && (c[1] ?? []).includes("--dump"));
    assert.equal(dump.length, 0,
      `discovery spawned \`f providers --dump\` ${dump.length}x because no in-process peer seam exists`);
    return;
  }
  // setProvidersUck AFTER resetProviders(): reset clears the peer along with
  // the process-local provider table.
  prov.setProvidersUck({ name: "providers", run: () => {}, discoverInProcess: async () => {
    globalThis.__peerCalled = (globalThis.__peerCalled ?? 0) + 1;
    return [{ name: "behav", entry, canWrite: false, provider: live }];
  } });
  // resetProviders() again: discovery is memoised per process (`discovered`), and
  // test (B) already paid for it. Without this, listProviders() returns the
  // cached table and never consults the peer - which would make this assertion
  // pass for the wrong reason on the fix and fail for the wrong reason on main.
  resetProviders();
  globalThis.__execStub = { ret: JSON.stringify([]) };
  // Diagnostic: is the peer actually visible at the moment discovery runs?
  if (typeof prov.providersUck === "function") {
    const pu = prov.providersUck();
    if (!pu || typeof pu.discoverInProcess !== "function") {
      throw new Error(`peer not visible to discovery at call time (providersUck()=${JSON.stringify(pu && Object.keys(pu))})`);
    }
  }
  const [p] = await listProviders();
  if (p.live !== true) throw new Error("discovery did not mark the peer provider live - status() will spawn");
  await p.status();
  assert.equal(globalThis.__execCalls.length, 0,
    `expected 0 spawns on the in-process path, saw ${globalThis.__execCalls.length}: ${JSON.stringify(globalThis.__execCalls.map((c) => [c[0], c[1]]))} | peer called ${globalThis.__peerCalled ?? 0}x`);
});

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
try { fs.rmSync(STUB, { force: true }); } catch {}
process.exit(fail ? 1 : 0);
