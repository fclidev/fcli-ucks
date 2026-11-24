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

await t("(C) discovery answers in-process and spawns NOTHING (the dump child is gone)", async () => {
  // This assertion used to require a `setProvidersUck` peer seam, because
  // discovery lived in a SIBLING uck and could only be reached by injecting it or
  // by spawning `f providers --dump`. Discovery is now this module's own
  // collect(), so the seam is gone - and the behaviour it existed to prove is now
  // the only path. Assert the behaviour directly: a real store scan, zero spawns.
  globalThis.__execCalls.length = 0;
  resetProviders(); setProbeCredsRead(storeRead);
  // Aim discovery at a throwaway uck store holding `behav`. Discovery resolves
  // join(HOME, ".f", "ucks"), and this suite already set HOME to TMP above, so
  // the store has to be built under TMP rather than passed in.
  const UCKS = path.join(TMP, ".f", "ucks", "fixture", "behav");
  fs.mkdirSync(UCKS, { recursive: true });
  fs.copyFileSync(entry, path.join(UCKS, "index.js"));
  if (typeof prov.__setStoreRootForTests === "function") prov.__setStoreRootForTests(TMP);
  globalThis.__execStub = { ret: JSON.stringify([]) };
  const out = await listProviders();
  const dump = globalThis.__execCalls.filter((c) => c[0] === "f" && (c[1] ?? []).includes("--dump"));
  assert.equal(dump.length, 0,
    `discovery still spawns \`f providers --dump\` (${dump.length}x) now that discovery is in-module`);
  const found = out.find((x) => x.name === "behav");
  if (!found) throw new Error("in-module discovery did not find the fixture provider at all");
  if (found.live !== true) throw new Error("discovery found the provider but did not mark it live - status() will spawn");
});

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
try { fs.rmSync(STUB, { force: true }); } catch {}
process.exit(fail ? 1 : 0);
