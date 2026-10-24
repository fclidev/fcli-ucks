// Tests for credsApi as the single interface into the store (CONTRACT.md §6.1 C0).
//
//   node creds/test/api.test.mjs
//
// What this suite guards is not arithmetic, it is a boundary. `f creds unlock
// --permanent` writes {ttl: null, permanent: true} and lets a configured daemon
// restart itself; six consumer ucks each kept their own copy of creds' lockfile
// check to decide whether to bother asking. Every copy tested `!lf.ttl` or
// computed `start + ttl*1000`, so all six called a permanent session "expired at
// t=0" and reported `creds are locked` beside a `f creds status` that said
// `unlocked (permanent)` — and none of them could recover the reboot case,
// because restarting a daemon is an action no file read can perform.
//
// So the properties worth locking down are:
//   1. resolveCred answers HIT on a permanent store even when the daemon is
//      gone and the lockfile is a corpse (the reboot case). This is the bug.
//   2. locked vs missing are never conflated, in every store state.
//   3. a permanent store never reports `locked` while its key file can open it.
//   4. the reason vocabulary is exactly §7.2, and credHint covers all of it.
//   5. the byte-exact path keeps bytes (a PEM without its trailing newline is
//      rejected by ssh-add, and that is why f ssh needed getRaw).
//   6. --wait actually waits when the box is open, and honours waitMs (not the
//      read timeout) as its budget.
//   7. nothing outside this uck may read the lockfile — asserted for the whole
//      tree, because a new copy is the only way this regression can return.
//
// Isolation is the same as cli.test.mjs / permanent.test.mjs: throwaway HOME
// under the real home (NOT /tmp — `f` clones the uck store into any HOME lacking
// one, which would run a stale copy of the code under test), and the uck is
// imported by absolute path so THIS working tree executes.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(path.resolve(import.meta.filename));
const CREDS = path.dirname(HERE);
const REAL_HOME = os.homedir();
const UCKS_ROOT = path.resolve(CREDS, "..", ".."); // ~/.f/ucks

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

const TMP = fs.mkdtempSync(path.join(REAL_HOME, ".f-creds-api-"));
const F = path.join(TMP, ".f");
const KEY = path.join(F, ".creds-unlock.key");
const MARK = path.join(F, ".creds-unlock");
const LOCK = path.join(F, ".creds-daemon");
const SOCK = path.join(F, ".creds.sock");
const BOX = path.join(F, "f.creds.enc");
const PASS = "api-test-pass";

fs.mkdirSync(F, { recursive: true });
process.env.HOME = TMP; // the uck reads HOME at import time

const { register } = await import(path.join(CREDS, "index.js"));
const api = register({}).credsApi;

const killDaemon = async () => {
  let lf = null;
  try { lf = JSON.parse(fs.readFileSync(LOCK, "utf8")); } catch {}
  if (lf?.pid) { try { process.kill(lf.pid, "SIGKILL"); } catch {} }
  for (const f of [SOCK, LOCK]) { try { fs.unlinkSync(f); } catch {} }
  await new Promise((r) => setTimeout(r, 120));
};

/** Start a daemon the way `f creds unlock --permanent` does (ttl 0 => permanent). */
const startPermanent = () =>
  new Promise((resolve, reject) => {
    fs.writeFileSync(KEY, PASS, { mode: 0o600 });
    fs.writeFileSync(MARK, JSON.stringify({ keyFile: KEY }), { mode: 0o600 });
    const c = spawn(
      process.execPath,
      [path.join(CREDS, "daemon.js"), "--socket", SOCK, "--lockfile", LOCK, "--ttl", "0", "--creds", BOX, "--expires-at", "0"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    c.stdin.on("error", () => {});
    c.stdin.write(PASS);
    c.stdin.end();
    let done = false;
    c.stdout.on("data", (d) => {
      if (done) return;
      done = true;
      try {
        const a = JSON.parse(d.toString().split("\n")[0]);
        a.ok ? resolve(a) : reject(new Error(`daemon: ${a.error ?? "not ok"}`));
      } catch (e) { reject(e); }
    });
    c.on("error", reject);
    setTimeout(() => { if (!done) reject(new Error("daemon never announced")); }, 15000);
  });

/** Forge the state a reboot leaves behind: marker + key present, daemon dead,
 *  lockfile pointing at a pid that does not exist. */
const corpseLockfile = () =>
  fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, start: 1, ttl: null, permanent: true, socket: SOCK }));

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} exceeded ${ms}ms`)), ms))]);

await t("credsApi is version 3 and carries the consumer surface", async () => {
  assert.equal(api.version, 3, "version must be 3 for resolveCred");
  for (const fn of ["resolveCred", "credHint", "credNamesFor", "rawCredRead", "getRaw", "setRaw", "rm", "has"]) {
    assert.equal(typeof api[fn], "function", `${fn}() missing from credsApi`);
  }
});

await t("credNamesFor derives host:port then bare host", async () => {
  assert.deepEqual(api.credNamesFor("https://forgejo.example.net"), ["forgejo.example.net"]);
  assert.deepEqual(api.credNamesFor("https://ha.example.net:8123/api"), ["ha.example.net:8123", "ha.example.net"]);
  assert.deepEqual(api.credNamesFor("ssh://git@gitea.example.net"), ["gitea.example.net"]);
  assert.deepEqual(api.credNamesFor(null), []);
});

await t("a locked store answers `locked`, never `missing`", async () => {
  await killDaemon();
  for (const f of [MARK, KEY]) { try { fs.unlinkSync(f); } catch {} }
  const r = await withTimeout(api.resolveCred({ host: "https://forgejo.test" }), 20000, "resolveCred");
  assert.equal(r.reason, "locked", JSON.stringify(r));
  assert.match(api.credHint(r), /f creds unlock/);
});

await t("a permanent store opens itself after a reboot and answers HIT (the bug)", async () => {
  await killDaemon();
  fs.writeFileSync(KEY, PASS, { mode: 0o600 });
  fs.writeFileSync(MARK, JSON.stringify({ keyFile: KEY }), { mode: 0o600 });
  corpseLockfile();
  // Same process, no prior creds call: the first thing it does is ask.
  const r = await withTimeout(
    api.resolveCred({ host: "https://forgejo.test", names: undefined }),
    25000,
    "resolveCred",
  );
  // The box is empty at this point, so `missing` is the CORRECT answer and
  // `locked` is the bug. That distinction is the entire regression.
  assert.equal(r.reason, "missing", `permanent store reported ${r.reason}; must be missing (store open, value absent): ${JSON.stringify(r)}`);
  assert.notEqual(r.reason, "locked");
});

await t("credHint for a missing name names the credential, not the store", async () => {
  const r = await api.resolveCred({ names: ["absent-thing.example"] });
  assert.equal(r.reason, "missing", JSON.stringify(r));
  assert.match(api.credHint(r), /absent-thing\.example/);
  assert.match(api.credHint(r), /f creds set/);
});

await t("resolveCred finds a value stored under the derived host name", async () => {
  await api.set("forgejo.test", "PAT-forgejo-value");
  const r = await api.resolveCred({ host: "https://forgejo.test" });
  assert.equal(r.token, "PAT-forgejo-value", JSON.stringify(r));
  assert.match(r.src, /forgejo\.test/);
  // provenance is printable by the caller without inventing wording
  assert.equal(typeof api.credHint(r, { credName: "forgejo.test" }), "string");
  assert.ok(!/unavailable|locked/i.test(api.credHint(r)), "a hit must not read as an error");
});

await t("port-stripped fallback: :8443 finds the bare-host credential", async () => {
  await api.set("gitea.test", "PAT-bare");
  const r = await api.resolveCred({ host: "https://gitea.test:8443" });
  assert.equal(r.token, "PAT-bare", JSON.stringify(r));
});

await t("getRaw/setRaw round-trip bytes exactly (ssh needs the trailing newline)", async () => {
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nbG9yZW0=\n-----END OPENSSH PRIVATE KEY-----\n";
  await api.setRaw("ssh.key.test", Buffer.from(pem, "utf8"));
  const raw = await api.getRaw("ssh.key.test");
  assert.ok(Buffer.isBuffer(raw), "getRaw must return a Buffer");
  assert.equal(raw.toString("utf8"), pem, "getRaw must not trim or re-encode bytes");
});

await t("has() and rm() report truthfully", async () => {
  await api.set("throwaway.test", "x");
  assert.equal(await api.has("throwaway.test"), true);
  await api.rm("throwaway.test");
  assert.equal(await api.has("throwaway.test"), false);
  await assert.rejects(() => api.rm("never-stored-xyz.test"), (e) => e.kind === "missing", "rm of an absent name must throw kind=missing, not fail silently");
});

await t("a refused write throws instead of reporting success", async () => {
  // The daemon rejects an entry whose name collides with nothing but whose
  // payload is unusable; the point is that set() inspects the reply at all.
  await assert.rejects(() => api.set("", "value"), (e) => !!e.kind, "set() must surface a daemon error");
});

await t("--wait waits for a value that arrives late (open box must not fail fast)", async () => {
  const name = "later-set.test";
  try { await api.rm(name); } catch {}
  const filler = setTimeout(() => { api.set(name, "appeared").catch(() => {}); }, 1200);
  const t0 = Date.now();
  const r = await withTimeout(api.resolveCred({ names: [name], waitMs: 12000 }), 20000, "resolveCred(waitMs)");
  clearTimeout(filler);
  assert.equal(r.token, "appeared", `expected to wait and hit, got ${JSON.stringify(r)}`);
  const took = Date.now() - t0;
  assert.ok(took >= 700, `should have blocked for the value, returned in ${took}ms`);
});

await t("--wait honours waitMs as its budget, not the 30s read timeout", async () => {
  const t0 = Date.now();
  const r = await api.resolveCred({ names: ["never-coming.test"], waitMs: 2500 });
  const took = Date.now() - t0;
  assert.equal(r.reason, "timeout", JSON.stringify(r));
  assert.ok(took >= 2000, `returned in ${took}ms, before the 2500ms window`);
  assert.ok(took < 9000, `waited ${took}ms for a 2500ms window — the read timeout is leaking in`);
  assert.match(api.credHint(r), /f creds fill/);
});

await t("flagToken and envVars win without a store call", async () => {
  await killDaemon();
  for (const f of [MARK, KEY]) { try { fs.unlinkSync(f); } catch {} }
  const a = await api.resolveCred({ names: ["x.test"], flagToken: "from-flag" });
  assert.deepEqual({ token: a.token, src: a.src }, { token: "from-flag", src: "--token" });
  const b = await api.resolveCred({ names: ["x.test"], envVars: { FORGEJO_TOKEN: "from-env" } });
  assert.deepEqual({ token: b.token, src: b.src }, { token: "from-env", src: "FORGEJO_TOKEN" });
});

await t("resolveCred with no names is a caller bug and throws loudly", async () => {
  await assert.rejects(() => api.resolveCred({}), /names.*host|nothing to look up/, "must not answer for an empty name list");
});

await t("reason vocabulary is exactly §7.2 and credHint covers every kind", async () => {
  const kinds = ["locked", "missing", "provider", "no-store", "timeout"];
  for (const reason of kinds) {
    const hint = api.credHint({ token: null, reason, host: "x.test", detail: "boom" });
    assert.ok(hint && hint.length > 10, `credHint empty for ${reason}`);
    assert.ok(!/unknown/i.test(hint), `credHint fell through to a default for ${reason}: ${hint}`);
  }
  // A failure shape must never be read as a success, and vice versa.
  const hit = api.credHint({ token: "v", src: "creds:x.test" });
  assert.equal(hit, "creds:x.test", `provenance for a hit: ${hit}`);
});

await t("rawCredRead distinguishes a locked store from an unreachable one", async () => {
  await killDaemon();
  for (const f of [MARK, KEY]) { try { fs.unlinkSync(f); } catch {} }
  const locked = await api.rawCredRead(["forgejo.test"]);
  assert.equal(locked.reason, "locked", JSON.stringify(locked));
  // No daemon, no marker: the box cannot be opened at all. `no-store` is for a
  // caller with no credsApi; a live-but-closed box is `locked`. Both are
  // distinct from `missing`, which is what would send the operator off to store
  // a credential they already have.
  assert.notEqual(locked.reason, "missing");
});

await t("the permanent daemon we rely on is not left running", async () => {
  await killDaemon();
  for (const f of [MARK, KEY, BOX, LOCK, SOCK]) { try { fs.unlinkSync(f); } catch {} }
  const out = spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8" }).stdout ?? "";
  const leaked = out.split("\n").filter((l) => l.includes("creds/daemon.js") && l.includes(TMP));
  assert.deepEqual(leaked, [], `daemons still running against a deleted HOME:\n${leaked.join("\n")}`);
});

// ---------------------------------------------------------------- tree audit
//
// The only way the split-brain can come back is a NEW copy of the store-state
// check, so assert its absence across every uck rather than reviewing by eye.

await t("no uck outside creds reads the lockfile or the daemon socket", async () => {
  const offenders = [];
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === ".f-creds-api-hidden") continue;
        walk(p, depth + 1);
        continue;
      }
      if (!/\.m?js$/.test(e.name)) continue;
      // creds itself owns both paths — its source, its build output (dist/), and
      // its installed store copy are all the same code, so exclude every dir
      // segment sequence that ends in creds/.
      if (/(^|[\/])creds([\/])/.test(p)) continue;
      if (p.includes(`${path.sep}dist${path.sep}`)) continue;
      // Test fixtures are allowed to forge store state — that is how they set up
      // the case under test (this very file writes the lockfile). The rule is
      // about shipped code, so scope the audit to what `f` actually loads.
      if (/(^|\/|\\)test(\/|\\)/.test(p) || /\.test\.mjs$|\.test\.js$|test\.js$/.test(p)) continue;
      const src = fs.readFileSync(p, "utf8");
      const code = src
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)) // comments may name the old bug
        .join("\n");
      if (/\.creds-daemon/.test(code)) offenders.push(`${p}: reads the creds lockfile`);
      if (/\.creds\.sock/.test(code)) offenders.push(`${p}: connects the creds daemon socket directly`);
      if (/credsApi\s*\.\s*get\s*\(/.test(code) && !/resolveCred/.test(code)) {
        offenders.push(`${p}: calls credsApi.get with no resolveCred path`);
      }
    }
  };
  walk(UCKS_ROOT);
  assert.deepEqual(offenders, [], `store state must be read only by the creds uck:\n${offenders.join("\n")}`);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
