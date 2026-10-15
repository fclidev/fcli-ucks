// Offline tests for the `f creds` CLI surface: the rm/forget/has/meta contract
// around provider mirrors, and a check that USAGE advertises only commands that
// actually dispatch.
//
//   node fcli-ucks/creds/test/cli.test.mjs
//
// Why the last check exists: `has` and `meta` were listed in USAGE for a long
// time while hitting `default: usage()` and exiting 1. Nothing noticed because
// reading the help text looked like evidence. This suite refuses to let help and
// dispatch drift apart again.
//
// Runs against a REAL daemon in a throwaway HOME (same isolation lesson as the
// vaultwarden e2e: temp HOME must not be under /tmp, because `f` clones the uck
// store into any HOME lacking one and walks *up* from cwd to find a package root).

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

/* ------------------------------------------- isolated HOME + real daemon */

// NOT under /tmp — see header. Also not under `here`, which would make the
// package-root walk find this uck's own package.json.
const TMP = fs.mkdtempSync(path.join(REAL_HOME, ".f-creds-test-"));
const SAFE_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "f-creds-run-"));
fs.mkdirSync(path.join(TMP, ".f"), { recursive: true });

const ENV = { ...process.env, HOME: TMP };

const run = (args, { allowFail = false, input = "" } = {}) => {
  try {
    // execFileSync exposes stderr on failure only, so the success path reads it
    // off a pipe manually — `has`/`meta` put their explanatory hints there.
    const r = spawnSync(process.execPath, [path.join(here, "run-command.mjs"), ...args], {
      encoding: "utf8", env: ENV, cwd: SAFE_CWD, timeout: 30000, input,
    });
    const code = r.status ?? 1;
    // spawnSync reports non-zero without throwing, so the old "did it fail?"
    // signal has to be checked explicitly or allowFail tests pass silently.
    if (code !== 0 && !allowFail) {
      throw new Error(`creds ${args.join(" ")} -> exit ${code}\n${(r.stderr ?? "").trim()}`);
    }
    return { code, out: r.stdout ?? "", err: r.stderr ?? "" };
  } catch (e) {
    if (!allowFail) throw e;
    return { code: e.status ?? 1, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
};

// A fake provider, injected so nothing needs a network. Mirrors are written by
// hand (via the daemon socket) rather than through a real provider round trip:
// these tests are about the CLI's naming contract, not provider discovery.
const DAEMON_FILE = path.join(TMP, ".f", ".creds-daemon");
const sockPath = () => JSON.parse(fs.readFileSync(DAEMON_FILE, "utf8")).socket;

// index.js does not export its socket helper, so speak the same bytes directly.
const net = await import("node:net");
const call = (o) => new Promise((resolve, reject) => {
  const c = net.default.connect(sockPath(), () => c.write(JSON.stringify(o)));
  let buf = "";
  c.on("data", (d) => (buf += d));
  c.on("end", () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
  c.on("error", reject);
});

try {
  run(["unlock", "test-pass", "--ttl", "600"]);
  if (!fs.existsSync(DAEMON_FILE)) throw new Error(`daemon state file never appeared at ${DAEMON_FILE}`);
} catch (e) {
  console.log(`FAIL could not start an isolated daemon: ${e.message}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(SAFE_CWD, { recursive: true, force: true });
  process.exit(1);
}

const putMirror = async (name, value, ttlSec = 3600) => {
  const r = await call({ op: "set", name: `mirror:${name}`, value, expiresAt: Date.now() + ttlSec * 1000 });
  if (!r.ok) throw new Error(`seed failed: ${r.error}`);
};

/* ------------------------------------------------------------------ tests */

await t("rm on a real local cred removes it and reports it", async () => {
  run(["set", "plain-cred", "v1"]);
  const r = run(["rm", "plain-cred"]);
  assert.match(r.out, /^removed\s+plain-cred$/m);
  const gone = run(["get", "plain-cred", "--local", "--secrets"], { allowFail: true });
  assert.equal(gone.code, 1, "a removed cred must not resolve");
});

await t("rm on a mirror-only name drops the mirror (not 'no such cred')", async () => {
  await putMirror("mir-cred", "from-provider");
  const r = run(["rm", "mir-cred"]);
  assert.match(r.out, /removed\s+mirror:mir-cred/, `expected a mirror removal line, got: ${r.out}`);
  assert.ok(!/no such cred/.test(r.err), "must not claim the name does not exist");
  const still = await call({ op: "has", name: "mirror:mir-cred" });
  assert.equal(still.exists, false, "the mirror entry must actually be gone");
});

await t("rm on a mirror says the provider still answers — the honest caveat", async () => {
  await putMirror("still-there", "v");
  const r = run(["rm", "still-there"]);
  // Without this line a bare `rm` reads as a successful deletion of the secret,
  // which is the exact footgun that made this asymmetry dangerous.
  assert.match(r.out, /still answers for 'still-there'/);
  assert.match(r.out, /next get re-mirrors/);
});

await t("rm on a truly absent name exits 1 and names the mirror key it checked", async () => {
  const r = run(["rm", "never-existed"], { allowFail: true });
  assert.equal(r.code, 1);
  assert.match(r.err, /no such cred: never-existed/);
  assert.match(r.err, /mirror:never-existed/, "must say WHICH key it looked for");
  assert.match(r.err, /creds has never-existed/, "must point at the command that answers 'what is this?'");
});

await t("rm mirror:<name> is accepted explicitly, same outcome", async () => {
  await putMirror("prefixed", "v");
  const r = run(["rm", "mirror:prefixed"]);
  assert.match(r.out, /removed\s+mirror:prefixed/);
  assert.equal((await call({ op: "has", name: "mirror:prefixed" })).exists, false);
});

await t("set on a name removes that name's mirror (local supersedes)", async () => {
  await putMirror("supersede", "old");
  run(["set", "supersede", "new-local"]);
  assert.equal((await call({ op: "has", name: "mirror:supersede" })).exists, false,
    "an explicit local value must clear the mirror so ls cannot show two truths");
  assert.equal(run(["get", "supersede", "--local", "--secrets"]).out.trim(), "new-local");
});

await t("forget and rm agree on a mirror (one concept, not two vocabularies)", async () => {
  await putMirror("agree-a", "v");
  await putMirror("agree-b", "v");
  const byForget = run(["forget", "agree-a"]);
  const byRm = run(["rm", "agree-b"]);
  // `forget` reports the bare name the operator typed; the internal `mirror:`
  // key used to leak here, which read like an error about a name nobody wrote.
  assert.match(byForget.out, /^forgot\tagree-a$/m);
  assert.ok(!/mirror:agree-a/.test(byForget.out), "must not echo the internal mirror key");
  assert.match(byRm.out, /removed\tmirror:agree-b/);
  for (const n of ["agree-a", "agree-b"]) {
    assert.equal((await call({ op: "has", name: `mirror:${n}` })).exists, false, `${n} must be gone either way`);
  }
});

await t("forget on a plain name says 'no mirror' and never deletes the cred", async () => {
  run(["set", "keepme", "safe"]);
  const r = run(["forget", "keepme"]);
  assert.match(r.out, /no mirror\tkeepme/);
  assert.equal(run(["get", "keepme", "--local", "--secrets"]).out.trim(), "safe",
    "forget must not be able to destroy a real cred by a bare name");
});

await t("has distinguishes local from mirror, and exits 1 when absent", async () => {
  run(["set", "local-thing", "v"]);
  await putMirror("mirror-thing", "v");
  assert.match(run(["has", "local-thing"]).out, /^exists\tlocal-thing\tlocal/m);
  assert.match(run(["has", "mirror-thing"]).out, /^exists\tmirror-thing\tmirror/m);
  const absent = run(["has", "nowhere"], { allowFail: true });
  assert.equal(absent.code, 1);
  assert.match(absent.out, /^absent\tnowhere$/m);
});

await t("has tells you what rm would touch — and says nothing false", async () => {
  run(["set", "hint-local", "v"]);
  await putMirror("hint-mirror", "v");
  // The hint goes to stderr, so capture it: the success path returns err:"" .
  const a = run(["has", "hint-local"], { captureErr: true });
  assert.match(a.err, /removes the local value/);
  assert.ok(!/still answers|provider still/.test(a.err),
    "a local value has no provider behind it; claiming one is the bug this guards");
  const b = run(["has", "hint-mirror"], { captureErr: true });
  assert.match(b.err, /removes only the mirror cache/);
  assert.match(b.err, /provider still answers/);
});

await t("meta reports kind and expiry without decrypting anything", async () => {
  await putMirror("meta-mirror", "super-secret-value");
  const r = run(["meta", "mirror:meta-mirror"]);
  assert.match(r.out, /kind\tmirror/);
  assert.match(r.out, /expiresAt\t\d{4}-\d\d-\d\dT/);
  assert.ok(!r.out.includes("super-secret-value"), "meta must never print the value");
});

await t("ls --all names the mirror's provider; ls --json is real JSON", async () => {
  await putMirror("tagged", "v");
  const all = run(["ls", "--all"]);
  const line = all.out.split("\n").find((l) => l.startsWith("mirror:tagged"));
  assert.ok(line, "mirror must appear under --all");
  assert.match(line, /mirror;/, `expected annotation, got: ${line}`);
  assert.match(line, /expires \d{4}-/, "expiry must be shown, not 'no expiry'");

  const rows = JSON.parse(run(["ls", "--json"]).out);
  const row = rows.find((x) => x.name === "mirror:tagged");
  assert.ok(row, "--json must include mirrors");
  assert.ok(/^mirror/.test(row.source), `source should name the kind, got ${row.source}`);
  assert.ok(row.expiresAt, "--json must carry expiresAt");
});

await t("ls without --all hides mirrors and says how many", async () => {
  await putMirror("hidden-one", "v");
  const out = run(["ls"]).out;
  assert.ok(!out.split("\n").some((l) => l.startsWith("mirror:")), "mirrors must be hidden by default");
  assert.match(out, /\(\d+ provider mirror\(s\) hidden — --all\)/);
});

/* -------- USAGE must not advertise commands that do not dispatch ---------- */

await t("every command in USAGE actually reaches a case (not default: usage())", async () => {
  const src = fs.readFileSync(path.join(CREDS, "index.js"), "utf8");
  // Commands are the first token of a two-space-indented usage line.
  const advertised = new Set();
  for (const line of src.split("\n")) {
    const m = line.match(/^\s*"""?\s*"? {2}([a-z][a-z-]*) ?/);
    if (m) advertised.add(m[1]);
  }
  const dispatched = new Set([...src.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]));
  // 'pack'/'unpack' are top-level aliases for `files pack/unpack`.
  const aliases = new Set(["pack", "unpack"]);
  const ghosts = [...advertised].filter((c) => !dispatched.has(c) && !aliases.has(c) && c !== "sub");
  assert.deepEqual(ghosts, [],
    `USAGE advertises commands with no case: ${ghosts.join(", ")} — they exit 1 while looking supported`);
  // The regression that motivated this: help listed has/meta, dispatch did not.
  assert.ok(dispatched.has("has") && dispatched.has("meta"), "has/meta must dispatch");
});

await t("the previously-ghosted commands work end to end", async () => {
  run(["set", "ghost-check", "v"]);
  assert.equal(run(["has", "ghost-check"]).code, 0);
  assert.equal(run(["meta", "ghost-check"]).code, 0);
});

/* ---------------------------------------------- rm must not over-delete --- */

await t("rm on a name with BOTH a local value and a mirror clears both", async () => {
  // The `set` path deletes the mirror, so this state needs direct construction.
  run(["set", "both", "local-value"]);
  await putMirror("both", "mirror-value");
  const r = run(["rm", "both"]);
  assert.match(r.out, /removed\tboth/);
  assert.match(r.out, /removed\tmirror:both/);
  assert.equal((await call({ op: "has", name: "both" })).exists, false);
  assert.equal((await call({ op: "has", name: "mirror:both" })).exists, false,
    "a lingering mirror would keep serving the value after a delete that claimed success");
});

/* -------------------------------------------- the ls state-is-observable -- */

await t("a name cannot be a local cred AND a mirror at once via the CLI", async () => {
  // `set` deletes that name's mirror, so the dual state is unreachable by
  // design — assert that invariant rather than the annotation it would feed,
  // since asserting an unreachable branch is how a test stays green while
  // describing behaviour the tool cannot produce.
  run(["set", "dual", "v"]);
  await putMirror("dual", "m");   // direct daemon write, bypassing `set`'s guard
  const r = run(["meta", "dual"]);
  assert.match(r.out, /kind\tlocal/, `got: ${r.out}`);
  const mirror = await call({ op: "has", name: "mirror:dual" });
  assert.equal(mirror.exists, true, "the hand-written mirror is still there (daemon-level)");
  // The CLI never *creates* this state:
  run(["set", "dual2", "v"]);
  assert.equal((await call({ op: "has", name: "mirror:dual2" })).exists, false,
    "`set` must clear the mirror so ls/has cannot show two truths for one name");
});

/* ----------------------------------------------------------- cleanup ----- */

try { run(["lock"]); } catch { /* best effort */ }
fs.rmSync(TMP, { recursive: true, force: true });
fs.rmSync(SAFE_CWD, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
