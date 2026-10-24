// Tests for the permanent file-based unlock (`f creds unlock --permanent`).
//
//   node fcli-ucks/creds/test/permanent.test.mjs
//
// What this suite is really guarding: a permanent unlock is a deliberate
// weakening of the store's threat model, so the dangerous readings must all be
// impossible. Specifically — that a permanent daemon has NO expiry, that the key
// file is never used when it is group/world-readable, that `f creds lock` truly
// stops the auto-restart (otherwise "locked" is a lie), and that a key file that
// no longer matches the box degrades to locked rather than to a prompt or a
// provider round trip.
//
// Same isolation rules as cli.test.mjs: throwaway HOME under the real home (NOT
// /tmp — `f` clones the uck store into any HOME lacking one), and commands run
// through test/run-command.mjs so THIS working tree is what executes.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const here = path.dirname(path.resolve(import.meta.filename));
const CREDS = path.dirname(here);
const REAL_HOME = os.homedir();

let pass = 0, fail = 0;
const t = async (label, fn) => {
  try { await fn(); pass++; console.log(`ok   ${label}`); }
  catch (e) { fail++; console.log(`FAIL ${label}\n     ${String(e?.message ?? e).split("\n").join("\n     ")}`); }
};

const TMP = fs.mkdtempSync(path.join(REAL_HOME, ".f-creds-perm-"));
const TMP2NAME = ".f-creds-perm2-";
const SAFE_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "f-creds-perm-run-"));
fs.mkdirSync(path.join(TMP, ".f"), { recursive: true });
const ENV = { ...process.env, HOME: TMP };

const run = (args, { allowFail = false, input = "" } = {}) => {
  const r = spawnSync(process.execPath, [path.join(here, "run-command.mjs"), ...args], {
    encoding: "utf8", env: ENV, cwd: SAFE_CWD, timeout: 30000, input,
  });
  const code = r.status ?? 1;
  if (code !== 0 && !allowFail) {
    throw new Error(`creds ${args.join(" ")} -> exit ${code}\n${(r.stderr ?? "").trim()}`);
  }
  return { code, out: r.stdout ?? "", err: r.stderr ?? "" };
};

const F = path.join(TMP, ".f");
const KEY = path.join(F, ".creds-unlock.key");
const MARK = path.join(F, ".creds-unlock");
const LOCK = path.join(F, ".creds-daemon");
const PASS = "perm-test-pass";

const lockInfo = () => {
  try { return JSON.parse(fs.readFileSync(LOCK, "utf8")); } catch { return null; }
};
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// A permanent daemon has NO expiry by design, so a test HOME whose store is left
// permanently unlocked keeps its daemon alive forever after the HOME is deleted.
// `teardown()` stops whatever our lockfile points at; cheap and safe to call
// liberally, and registered on process exit as a last resort.
const teardown = () => {
  const lf = lockInfo();
  if (lf?.pid && pidAlive(lf.pid)) {
    try { process.kill(lf.pid, "SIGTERM"); } catch {}
  }
  fs.rmSync(MARK, { force: true });
};
process.on("exit", teardown);

// A store with one real cred, opened the ordinary way.
const seedStore = () => {
  run(["unlock", PASS, "--ttl", "600"]);
  run(["set", "alpha", "value-alpha"]);
  run(["lock"]);
};

await t("setup: ordinary unlock + set + lock", async () => {
  seedStore();
  assert.equal(lockInfo(), null, "lock left a lockfile behind");
});

await t("--permanent writes a 0600 key file and unlocks with no expiry", async () => {
  // Seed the key file with the known passkey: --permanent must not overwrite it.
  fs.writeFileSync(KEY, PASS + "\n", { mode: 0o600 });
  const r = run(["unlock", "--permanent"]);
  assert.match(r.err, /unlocked permanently/, r.err);
  assert.equal(fs.statSync(KEY).mode & 0o777, 0o600, "key file mode");
  const lf = lockInfo();
  assert.ok(lf?.permanent, `lockfile must record permanence: ${JSON.stringify(lf)}`);
  assert.equal(lf.ttl, null, `permanent lockfile must not carry a numeric ttl: ${lf.ttl}`);
  assert.ok(fs.existsSync(MARK), "no permanent-unlock marker written");
});

await t("status says permanent, not a countdown", async () => {
  const r = run(["status"]);
  assert.match(r.out, /^unlocked \(permanent/, r.out);
  assert.doesNotMatch(r.out, /\d+m \d+s left/, `permanent unlock must not report time left: ${r.out}`);
  assert.match(r.out, /creds-unlock\.key/, `status should name the key file: ${r.out}`);
});

await t("the daemon really has no deadline (survives a wait a TTL would kill)", async () => {
  // The permanent branch skips the expiry timer entirely; a short-lived mutant
  // that kept `setTimeout(shutdown, ttl*1000)` with ttl=0 would die immediately.
  const lf = lockInfo();
  assert.ok(pidAlive(lf.pid), "permanent daemon is not running");
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(pidAlive(lockInfo().pid), "permanent daemon exited on its own");
  assert.equal(run(["get", "alpha"]).code, 0);
});

await t("marker + key file restart the daemon on a plain read (reboot simulation)", async () => {
  const lf = lockInfo();
  // Kill the daemon the way a reboot/OOM would: no SIGTERM handler, no cleanup.
  process.kill(lf.pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(run(["status"]).out.trim().startsWith("locked"), true, "should read as locked");
  const r = run(["get", "alpha", "--secrets"]);
  assert.match(r.err, /unlocked permanently \(key file\)/, r.err);
  assert.match(r.out, /value-alpha/, r.out);
  assert.ok(pidAlive(lockInfo().pid), "auto-unlock did not start a daemon");
});

await t("a world-readable key file is refused, and the marker is cleared", async () => {
  run(["unlock", "--permanent"]);
  fs.chmodSync(KEY, 0o644);
  process.kill(lockInfo().pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 200));
  const r = run(["get", "alpha"], { allowFail: true });
  assert.notEqual(r.code, 0, "must not serve a cred via an exposed key file");
  assert.match(r.err + r.out, /mode 644|group\/world-readable/, r.err + r.out);
  assert.equal(fs.existsSync(MARK), false, "marker must be removed so this does not warn forever");
  fs.chmodSync(KEY, 0o600);
});

await t("a key file that does not match the box degrades to locked, never a prompt", async () => {
  const good = fs.readFileSync(KEY, "utf8");
  fs.writeFileSync(KEY, "definitely-not-the-passkey\n", { mode: 0o600 });
  // The direct request must fail (and must NOT install a marker): a permanent
  // unlock whose key cannot open the box is not configured, it is broken.
  const direct = run(["unlock", "--permanent"], { allowFail: true });
  assert.notEqual(direct.code, 0, "a wrong key file must not report success");
  assert.match(direct.err, /wrong passkey/, direct.err);
  assert.equal(fs.existsSync(MARK), false, "a failed permanent unlock left a marker behind");

  // Now the auto path: marker present, key file wrong.
  fs.writeFileSync(MARK, JSON.stringify({ keyFile: KEY, since: Date.now() }), { mode: 0o600 });
  // stdin is an empty pipe: a mutant that falls back to promptPasskey() would
  // read "" and report "no passkey"; the correct answer names the real cause.
  const r = run(["get", "alpha"], { allowFail: true, input: "" });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /permanent unlock failed/, r.err);
  assert.match(r.err, /wrong passkey/, `should say why: ${r.err}`);
  assert.equal(fs.existsSync(MARK), false, "a broken permanent unlock must not stay configured");
  fs.writeFileSync(KEY, good, { mode: 0o600 });
});

await t("lock stops the auto-restart (otherwise 'locked' would be a lie)", async () => {
  fs.writeFileSync(KEY, PASS + "\n", { mode: 0o600 });
  run(["unlock", "--permanent"]);
  const r = run(["lock"]);
  assert.match(r.err, /removed the permanent-unlock marker/, r.err);
  assert.equal(fs.existsSync(MARK), false);
  assert.equal(fs.existsSync(KEY), true, "lock must not delete the key file without --purge");
  const after = run(["get", "alpha"], { allowFail: true });
  assert.notEqual(after.code, 0, "a locked store answered after `lock`");
  assert.match(after.err, /creds locked/, after.err);
});

await t("lock --purge removes the key file too", async () => {
  fs.writeFileSync(KEY, PASS + "\n", { mode: 0o600 });
  run(["unlock", "--permanent"]);
  const r = run(["lock", "--purge"]);
  assert.match(r.err, new RegExp("deleted " + KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), r.err);
  assert.equal(fs.existsSync(KEY), false);
  assert.equal(fs.existsSync(MARK), false);
  fs.writeFileSync(KEY, PASS + "\n", { mode: 0o600 });
});

await t("--ttl and --permanent are mutually exclusive", async () => {
  const r = run(["unlock", "--permanent", "--ttl", "1d"], { allowFail: true });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /mutually exclusive/, r.err);
});

await t("--ttl 0 is refused instead of becoming a back-door permanent unlock", async () => {
  const r = run(["unlock", PASS, "--ttl", "0"], { allowFail: true });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /--permanent/, r.err);
  assert.equal(fs.existsSync(MARK), false, "--ttl 0 must not install a permanent marker");
  assert.equal(lockInfo(), null, "--ttl 0 must not leave a daemon running");
});

await t("--permanent refuses a passkey argument rather than silently installing a key", async () => {
  fs.rmSync(KEY, { force: true });
  fs.rmSync(MARK, { force: true });
  const r = run(["unlock", "some-passkey", "--permanent"], { allowFail: true });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /does not take a passkey/, r.err);
  assert.equal(fs.existsSync(KEY), false, "must not have written a key file");
});

await t("an explicit passkey unlock does not resurrect a permanent session", async () => {
  // A configured marker must not turn `f creds unlock <passkey> --ttl 1h` into
  // a permanent unlock — that is a one-shot request with an explicit ttl.
  fs.writeFileSync(KEY, PASS + "\n", { mode: 0o600 });
  run(["unlock", "--permanent"]);
  run(["lock"]);
  const r = run(["unlock", PASS, "--ttl", "3600"]);
  const lf = lockInfo();
  assert.ok(!lf.permanent, `explicit --ttl unlock went permanent: ${JSON.stringify(lf)}`);
  assert.equal(lf.ttl, 3600);
  assert.doesNotMatch(r.err, /permanently/, r.err);
  run(["lock"]);
});

await t("--permanent with no key file on a NEW store creates one and it opens the box", async () => {
  // Generation is only meaningful for a store whose key nobody has chosen yet.
  // On an existing passphrase-keyed store it must fail (next test), so this uses
  // a second HOME with an empty box.
  const TMP2 = fs.mkdtempSync(path.join(REAL_HOME, TMP2NAME));
  fs.mkdirSync(path.join(TMP2, ".f"), { recursive: true });
  const ENV2 = { ...process.env, HOME: TMP2 };
  const key2 = path.join(TMP2, ".f", ".creds-unlock.key");
  try {
    const r = spawnSync(process.execPath, [path.join(here, "run-command.mjs"), "unlock", "--permanent"], {
      encoding: "utf8", env: ENV2, cwd: SAFE_CWD, timeout: 30000, input: "",
    });
    assert.equal(r.status, 0, (r.stderr ?? "").trim());
    assert.match(r.stderr, /wrote unlock key/, r.stderr);
    assert.match(r.stderr, /unlocked permanently/, r.stderr);
    assert.equal(fs.statSync(key2).mode & 0o777, 0o600, "generated key file mode");
    // The generated key really is the box's key: writes and reads work, and a
    // hard-killed daemon comes back from the file alone.
    const set = spawnSync(process.execPath, [path.join(here, "run-command.mjs"), "set", "beta", "value-beta"], {
      encoding: "utf8", env: ENV2, cwd: SAFE_CWD, timeout: 30000, input: "",
    });
    assert.equal(set.status, 0, (set.stderr ?? "").trim());
    const lf2 = JSON.parse(fs.readFileSync(path.join(TMP2, ".f", ".creds-daemon"), "utf8"));
    assert.ok(lf2.permanent, "new-store permanent unlock is not marked permanent");
    process.kill(lf2.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    const got = spawnSync(process.execPath, [path.join(here, "run-command.mjs"), "get", "beta", "--secrets"], {
      encoding: "utf8", env: ENV2, cwd: SAFE_CWD, timeout: 30000, input: "",
    });
    assert.equal(got.status, 0, (got.stderr ?? "").trim());
    assert.match(got.stdout, /value-beta/, got.stdout);
  } finally {
    const lf2 = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(TMP2, ".f", ".creds-daemon"), "utf8")); } catch { return null; }
    })();
    if (lf2?.pid && pidAlive(lf2.pid)) { try { process.kill(lf2.pid, "SIGTERM"); } catch {} }
    fs.rmSync(TMP2, { recursive: true, force: true });
  }
});

await t("--permanent does NOT fabricate a key for an existing passphrase store", async () => {
  // The sharp edge of generation: a random key cannot open a box keyed by a
  // passphrase. It must fail loudly, leave the store untouched, and not install
  // a marker that would warn on every later command.
  fs.rmSync(KEY, { force: true });
  fs.rmSync(MARK, { force: true });
  const r = run(["unlock", "--permanent"], { allowFail: true });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /wrote unlock key/, r.err);
  assert.match(r.err, /wrong passkey/, `must name the real cause: ${r.err}`);
  assert.equal(fs.existsSync(MARK), false, "a failed generation must not leave a marker");
  // The box is intact and still opens with the real passkey.
  run(["lock"]);
  run(["unlock", PASS, "--ttl", "600"]);
  assert.match(run(["get", "alpha"]).out, /redacted/);
  run(["lock"]);
  fs.writeFileSync(KEY, PASS + "\n", { mode: 0o600 });
});

await t("--key-file puts the key somewhere else", async () => {
  run(["lock"]);
  const other = path.join(TMP, "custom.key");
  fs.writeFileSync(other, PASS + "\n", { mode: 0o600 });
  const r = run(["unlock", "--permanent", "--key-file", other]);
  assert.match(r.err, /unlocked permanently/, r.err);
  const mark = JSON.parse(fs.readFileSync(MARK, "utf8"));
  assert.equal(mark.keyFile, other);
  assert.match(run(["status"]).out, /custom\.key/, "status should name the custom key file");
  fs.rmSync(other, { force: true });
  run(["lock"]);
});

await t("--key-file without --permanent is refused", async () => {
  const r = run(["unlock", "--key-file", "/tmp/whatever"], { allowFail: true });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /--permanent/, r.err);
});

await t("a second --permanent unlock reports already-unlocked, not a second daemon", async () => {
  fs.writeFileSync(KEY, PASS + "\n", { mode: 0o600 });
  run(["unlock", "--permanent"]);
  const first = lockInfo().pid;
  const r = run(["unlock", "--permanent"]);
  assert.match(r.err, /already unlocked/, r.err);
  assert.match(r.err, /permanent/, r.err);
  assert.equal(lockInfo().pid, first, "second unlock replaced the daemon");
});

await t("an existing key file is never overwritten", async () => {
  fs.writeFileSync(KEY, PASS + "\n", { mode: 0o600 });
  run(["unlock", "--permanent"]);
  const before = fs.readFileSync(KEY, "utf8");
  run(["lock"]);
  run(["unlock", "--permanent"]);
  assert.equal(fs.readFileSync(KEY, "utf8"), before, "--permanent replaced an existing key file");
});

await t("lock on a never-unlocked store still says 'not unlocked'", async () => {
  run(["lock"]);
  const r = run(["lock"], { allowFail: true });
  assert.match(r.err, /not unlocked/, r.err);
});

await t("credsApi v2 surface: permanentUnlock() reports the config without starting anything", async () => {
  // A uck inspects permanent-unlock config via the API; if that call started a
  // daemon, a status read would silently open the store.
  fs.writeFileSync(KEY, PASS + "\n", { mode: 0o600 });
  fs.writeFileSync(MARK, JSON.stringify({ keyFile: KEY, since: Date.now() }), { mode: 0o600 });
  run(["lock"]);   // ensure closed, marker cleared
  fs.writeFileSync(MARK, JSON.stringify({ keyFile: KEY, since: Date.now() }), { mode: 0o600 });
  const script = path.join(TMP, "api.mjs");
  // The module path goes in via env: interpolating it into a template literal
  // needs two rounds of escaping, and the generated file came out a syntax
  // error — the test asserted on nothing at all.
  fs.writeFileSync(
    script,
    `const { register } = await import(process.env.CREDS_INDEX);\n` +
    `const api = register({}).credsApi;\n` +
    `console.log(JSON.stringify({\n` +
    `  version: api.version,\n` +
    `  hasPermanentUnlock: typeof api.permanentUnlock === "function",\n` +
    `  keyFile: api.permanentUnlock(),\n` +
    `  describe: api.describeStatus(),\n` +
    `  status: api.status(),\n` +
    `}));\n`
  );
  const r = spawnSync(process.execPath, [script], {
    encoding: "utf8", env: { ...ENV, CREDS_INDEX: path.join(CREDS, "index.js") }, cwd: SAFE_CWD, timeout: 30000,
  });
  assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const j = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.ok(j.version >= 2, `credsApi.version should be >= 2 for permanent unlock, got ${j.version}`);
  assert.ok(j.hasPermanentUnlock, "credsApi.permanentUnlock missing");
  assert.equal(j.keyFile, KEY, "permanentUnlock() should report the configured key file");
  assert.equal(j.status.unlocked, false, "status() must report locked");
  assert.match(j.describe, /^locked$/, `describeStatus() on a locked store: ${j.describe}`);
  assert.equal(lockInfo(), null, "inspecting permanentUnlock() started a daemon");
  fs.rmSync(MARK, { force: true });
});

await t("credsApi.get() starts a permanent daemon (the v2 behaviour change)", async () => {
  fs.writeFileSync(KEY, PASS + "\n", { mode: 0o600 });
  fs.writeFileSync(MARK, JSON.stringify({ keyFile: KEY, since: Date.now() }), { mode: 0o600 });
  run(["lock"]);
  fs.writeFileSync(MARK, JSON.stringify({ keyFile: KEY, since: Date.now() }), { mode: 0o600 });
  const script = path.join(TMP, "api2.mjs");
  fs.writeFileSync(
    script,
    `const { register } = await import(process.env.CREDS_INDEX);\n` +
    `const api = register({}).credsApi;\n` +
    `console.log("VALUE=" + (await api.get("alpha")));\n`
  );
  const r = spawnSync(process.execPath, [script], {
    encoding: "utf8", env: { ...ENV, CREDS_INDEX: path.join(CREDS, "index.js") }, cwd: SAFE_CWD, timeout: 30000,
  });
  assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /VALUE=value-alpha/, `stdout: ${r.stdout}`);
  teardown();
});

// Stop our own daemon before deleting the HOMEs, so the leak check below starts
// from a clean slate.
teardown();
fs.rmSync(TMP, { recursive: true, force: true });
fs.rmSync(SAFE_CWD, { recursive: true, force: true });

// Nothing we started should still be listening: a permanent daemon left running
// against a deleted HOME would live until the machine reboots.
const leaked = (() => {
  const out = spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8" }).stdout ?? "";
  return out.split("\n").filter((l) => l.includes("creds/daemon.js") && (l.includes(TMP) || l.includes(TMP2NAME)));
})();
await t("the suite leaks no daemon into the next session", async () => {
  assert.deepEqual(leaked, [], `daemons still running against a deleted HOME:\n${leaked.join("\n")}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
