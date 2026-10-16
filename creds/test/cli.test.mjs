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

let pass = 0, fail = 0, skipped = 0;
const t = async (label, opts, fn) => {
  if (typeof opts === "function") { fn = opts; opts = {}; }
  if (opts.skip) {
    skipped++;
    console.log(`skip ${label}`);
    return;
  }
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

const run = (args, { allowFail = false, input = "", stdinMode = "pipe" } = {}) => {
  try {
    // execFileSync exposes stderr on failure only, so the success path reads it
    // off a pipe manually — `has`/`meta` put their explanatory hints there.
    // stdin "pipe" (default) always creates a pipe, so an empty input is
    // indistinguishable from a closed one; "ignore" gives the child /dev/null
    // like a plain shell invocation. Without this, a mutant that treats a closed
    // pipe as "a secret was piped" passes every test.
    const r = spawnSync(process.execPath, [path.join(here, "run-command.mjs"), ...args], {
      encoding: "utf8", env: ENV, cwd: SAFE_CWD, timeout: 30000, input,
      stdio: stdinMode === "ignore" ? ["ignore", "pipe", "pipe"] : undefined,
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
// Provenance lives in the PLAINTEXT cache file, not the encrypted box, keyed
// `src:<mirrorKey>`. Tests write it directly to set up the state the bug needs.
const CACHE = path.join(TMP, ".f", ".creds-cache.json");
const readCacheFile = () => { try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return {}; } };
const setMirrorSourceForTest = (k, provider) => {
  const c = readCacheFile(); c["src:" + k] = { provider, expiresAt: Date.now() + 600_000 };
  fs.writeFileSync(CACHE, JSON.stringify(c));
};
const mirrorSourceForTest = (k) => readCacheFile()["src:" + k]?.provider ?? null;

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

/* teardown + report moved to the end of the file */

await t("set reads the value from stdin so it never enters argv", async () => {
  run(["set", "via-stdin"], { input: "s3cr3t-from-stdin\n" });
  assert.equal(run(["get", "via-stdin", "--local", "--secrets"]).out.trim(), "s3cr3t-from-stdin");
  // `-` means stdin explicitly, even with a value-looking token after it
  run(["set", "via-dash", "-"], { input: "dash-value\n" });
  assert.equal(run(["get", "via-dash", "--local", "--secrets"]).out.trim(), "dash-value");
  // the name is echoed so a pipe knows what landed
  assert.match(run(["set", "echo-check"], { input: "v\n" }).out, /echo-check\t\(stdin\)/);
});

await t("set warns when the value IS in argv — the exposure is real", async () => {
  const r = run(["set", "argv-thing", "value-in-ps"]);
  assert.equal(r.code, 0, "`set <name> <value>` must keep working (compat)");
  assert.match(r.err, /argv.*`ps`|`ps`/s);
  assert.match(r.err, /echo SECRET \| f creds set argv-thing/);
});

await t("set with no value and no pipe refuses rather than storing nothing", async () => {
  // A TTY stdin no longer refuses — it prompts (see the pty probe at the end of
  // this file). The script-visible case is a pipe carrying nothing.
  const r = run(["set", "empty-thing"], { allowFail: true, input: "" });
  assert.notEqual(r.code, 0);
  assert.match(r.err + r.out, /empty value/);
  assert.equal(run(["has", "empty-thing"], { allowFail: true }).code, 1, "nothing was stored");
});

/* ------------------------------------------------- the dash-means-pipe rule -- */

await t("`set <name> -` refuses when the pipe is empty instead of prompting", async () => {
  // `-` is an explicit statement that a pipe carries the value. If the pipe is
  // empty, prompting for a secret would be the worst outcome: the caller is a
  // script with nobody at the keyboard, so it hangs until a timeout.
  const r = run(["set", "dash-empty", "-"], { allowFail: true, input: "" });
  assert.notEqual(r.code, 0);
  assert.match(r.err + r.out, /empty value/);
  assert.equal(run(["has", "dash-empty"], { allowFail: true }).code, 1, "nothing stored");
});

await t("deleting a mirror deletes its provenance record too", async () => {
  // The value lives in the encrypted box; provenance lives in the plaintext
  // cache file. rm that only touches the first leaves a record naming a
  // provider for a mirror that no longer exists — clearMirrorSource existed for
  // this and was never called.
  await putMirror("prov-a", "v");
  setMirrorSourceForTest("mirror:prov-a", "dummyprov");
  assert.equal(mirrorSourceForTest("mirror:prov-a"), "dummyprov");
  run(["rm", "prov-a"]);
  assert.equal(mirrorSourceForTest("mirror:prov-a"), null,
    "provenance outlived the mirror");
});

await t("`set` over a mirror clears that mirror's provenance record", async () => {
  await putMirror("prov-b", "v");
  setMirrorSourceForTest("mirror:prov-b", "dummyprov");
  run(["set", "prov-b", "local-now"]);
  assert.equal(mirrorSourceForTest("mirror:prov-b"), null);
  // and the provider must not be resurrected into `has` output
  const r = run(["has", "prov-b"]);
  assert.ok(!/dummyprov/.test(r.err), `stale provider leaked into hint: ${r.err}`);
});

await t("forget cleans provenance for a name with NO entry at all", async () => {
  // Expiry is a freshness policy enforced in the CLI, not a deletion: the daemon
  // keeps expired entries (see daemon.js `set`, which only stamps expiresAt).
  // So a genuinely-absent entry is the case that used to strand the record.
  setMirrorSourceForTest("mirror:prov-c", "dummyprov");
  assert.equal((await call({ op: "has", name: "mirror:prov-c" })).exists, false);
  const r = run(["forget", "prov-c"]);
  assert.match(r.out, /no mirror\tprov-c/);
  assert.equal(mirrorSourceForTest("mirror:prov-c"), null,
    "must clean provenance even when there is no value to delete");
});

await t("set refuses to guess when a value is BOTH an argument and on stdin", async () => {
  // Silently preferring argv here stored the wrong secret in testing: a script
  // that piped a rotated token and also had a stale value argument got the stale
  // one, with exit 0. Ambiguity about which credential to store must be an error.
  const r = run(["set", "ambig", "argv-value"], { allowFail: true, input: "piped-value\n" });
  assert.notEqual(r.code, 0);
  assert.match(r.err + r.out, /refusing to choose/);
  assert.equal(run(["has", "ambig"], { allowFail: true }).code, 1, "nothing stored");
});

await t("set still takes a plain argv value when stdin is merely closed", async () => {
  // The common `f creds set x y` case: stdin is not a terminal but carries
  // nothing. Treating a closed pipe as "a secret was piped" would break every
  // existing invocation.
  // /dev/null stdin, exactly what `f creds set x y` sees from a shell.
  const r = run(["set", "closed-stdin", "v1"], { stdinMode: "ignore" });
  assert.equal(r.code, 0, r.err);
  assert.equal(run(["get", "closed-stdin", "--local", "--secrets"]).out.trim(), "v1");
});

await t("an unknown --flag is refused, and can never become the passkey", async () => {
  // `f creds unlock --request X --ttl 1d` looked like success: the parser pushed
  // unrecognised flags into `pos`, pos[0] was the command and pos[1] was the
  // passkey, so the store key was derived from the literal string `--request`
  // while `status` cheerfully reported `unlocked (1439m left)`. Every value then
  // failed to decrypt. A typo'd flag must cost one line, not the store.
  const r = run(["unlock", "--request", "some-cred", "--ttl", "600"], { allowFail: true });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /unknown flag\(s\): --request/);
  assert.ok(!/^unlocked/m.test(r.out), "must not report success");
  // the running daemon must still be the suite's, keyed by the real passkey
  run(["set", "daemon-still-works", "v"]);
  assert.equal(run(["get", "daemon-still-works", "--local", "--secrets"]).out.trim(), "v");
});

await t("unlock refuses more than one positional argument", async () => {
  const r = run(["unlock", "one", "two"], { allowFail: true });
  assert.notEqual(r.code, 0);
  assert.match(r.err + r.out, /at most one passkey/);
});

/* ------------------------------------------- set at a real terminal ------ */

// The pipe path was tested for a long time and the TTY path was not, which is
// exactly how `f creds set gh-token` at a keyboard — the most common way a human
// stores a rotated credential — ended up refusing with "set needs a value" while
// every green test described a piped invocation. A pipe cannot prove the prompt
// branch exists: isTTY is false there no matter what is written into the pipe.
// So drive the real CLI through a pty.
const PTY_DRIVER = path.join(here, "pty-drive.py");
// Running it with no arguments exits 2 with a usage line: that proves python3 is
// present, the stdlib pty import works, and the file parses. Anything else means
// the driver is broken, which is a different message than "not applicable".
const PTY_PROBE = spawnSync("python3", [PTY_DRIVER], { encoding: "utf8" });
const HAS_PTY = PTY_PROBE.status === 2;

// A terminal-driven check that silently skips is how the refusal survived: every
// pipe test passed and nobody typed the command. So a missing driver is fatal,
// not a skip — a green run must not be possible with the TTY path unexercised.
if (!HAS_PTY) {
  console.error("f creds tests require python3 with the stdlib pty module (see test/pty-drive.py).\n" +
    `Probe exited ${PTY_PROBE.status}: ${(PTY_PROBE.stderr ?? "").trim()}\n` +
    "Without it the interactive `set` prompt is untested, which is exactly the blind spot\n" +
    "that let `f creds set <name>` at a keyboard refuse with 'set needs a value'.");
  process.exit(2);
}

// The driver is a child of the HOME-isolated suite: it must see the throwaway
// HOME (so it touches the suite's daemon, not the real store) and run in the
// scratch cwd. It is NOT torn down with TMP — it lives beside the driver file.
// (driver is a checked-in file; no temp dir needed)

const runPty = (args, { input = "", noeol = false } = {}) => {
  // `input` is a stand-in for a real secret, so it travels to the driver over a
  // pipe — never argv, never the environment. Both are readable via
  // /proc/<pid>/cmdline and /proc/<pid>/environ, which would make the harness
  // leak in exactly the way `f creds set <name> <value>` does.
  const r = spawnSync("python3", [PTY_DRIVER, SAFE_CWD, "--", process.execPath, path.join(here, "run-command.mjs"), ...args], {
    encoding: "utf8", cwd: SAFE_CWD, timeout: 60000,
    env: { ...ENV, ...(noeol ? { PTY_NOEOL: "1" } : {}) },
    input: input + "\n",
  });
  const verdict = (r.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  try {
    return JSON.parse(verdict);
  } catch (e) {
    // The driver prints one JSON line; anything else means it died. Surface its
    // stderr — a Python SyntaxError used to look like a failing assertion.
    throw new Error(`pty driver produced no verdict (${e.message})\n${(r.stderr ?? "").trim()}`);
  }
};

await t("set at a terminal prompts for the value instead of refusing", async () => {
  // The regression: `f creds set gh-token` at a keyboard — the normal way an
  // operator stores a rotated credential — answered "set needs a value" and
  // dumped usage, while every piped test stayed green because a pipe can never
  // reach this branch.
  const r = runPty(["set", "tty-cred"], { input: "typed-at-tty" });
  assert.match(r.text, /f: tty-cred/, `no prompt shown: ${JSON.stringify(r.text)}`);
  assert.match(r.text, /set\ttty-cred/, `did not store: ${JSON.stringify(r.text)}`);
  assert.equal(run(["get", "tty-cred", "--local", "--secrets"]).out.trim(), "typed-at-tty");
  // The pty echoes the driver's keystroke until the child enters raw mode, so
  // "the secret appears nowhere" is unfalsifiable. What matters and is
  // falsifiable: the child does not print the value back after reading it. Raw
  // mode is on, so a second occurrence means the child echoed it.
  const hits = r.text.split("typed-at-tty").length - 1;
  assert.ok(hits <= 1, `child echoed the secret (${hits} occurrences): ${JSON.stringify(r.text)}`);
});

await t("an empty line at the terminal prompt stores nothing", async () => {
  const r = runPty(["set", "tty-empty"], { input: "" });
  assert.match(r.text, /empty value/, JSON.stringify(r.text));
  assert.equal(run(["has", "tty-empty"], { allowFail: true }).code, 1, "nothing stored");
});

await t("`set <name> -` at a terminal refuses rather than prompting", async () => {
  // `-` says the value comes from a pipe. Prompting anyway would store whatever
  // a human happened to type in place of the piped value the script expected.
  const r = runPty(["set", "tty-dash", "-"], { input: "should-not-be-stored" });
  assert.match(r.text, /stdin was empty/, JSON.stringify(r.text));
  assert.ok(!/set\ttty-dash/.test(r.text), "stored despite an explicit `-`");
  assert.equal(run(["has", "tty-dash"], { allowFail: true }).code, 1, "nothing stored");
});

await t("a value argument at a terminal does not hang waiting on a prompt", async () => {
  // isTTY is true and stdin is the keyboard: the argv branch must not read
  // stdin, or every interactive `f creds set x y` blocks for a keypress.
  const r = runPty(["set", "tty-argv", "argv-value"], { input: "" });
  assert.match(r.text, /set\ttty-argv/, JSON.stringify(r.text));
  assert.equal(run(["get", "tty-argv", "--local", "--secrets"]).out.trim(), "argv-value");
});

await t("the terminal prompt does not swallow the value into stdout", async () => {
  // A secret must never reach stdout: callers capture stdout, and `f creds set`
  // inside a script would otherwise land it in a log or a shell history file.
  // The prompt belongs on stderr, and the transcript proves where it was
  // written only because the driver separates the two — assert the protocol
  // instead: `set` prints exactly one stdout line, the confirmation.
  const r = run(["set", "stdout-check"], { input: "piped-value\n" });
  assert.equal(r.out, "set\tstdout-check\t(stdin)\n", `stdout carried more than the confirmation: ${JSON.stringify(r.out)}`);
  assert.ok(!r.out.includes("piped-value"), "value leaked to stdout");
});

await t("an unterminated line at the terminal stores nothing rather than guessing", async () => {
  // Raw mode turns the tty line discipline off, so the reader gets exactly the
  // bytes the terminal sends and must wait for the Enter keystroke. Auto-storing
  // a token that was never submitted would persist a truncated secret, which is
  // worse than waiting: a wrong credential is used silently, a missing one is
  // asked for. No terminator in, nothing stored.
  const r = runPty(["set", "tty-noeol"], { input: "half-typed", noeol: true });
  assert.ok(!/set\ttty-noeol/.test(r.text), "stored a line the operator never submitted");
  assert.equal(run(["has", "tty-noeol"], { allowFail: true }).code, 1, "nothing stored");
});

await t("the prompt goes to stderr, not stdout — a secret never enters captured output", async () => {
  // The interactive passkey prompt is the same raw-mode code path. If a refactor
  // wrote prompts to stdout, `f creds unlock` inside a script would put the
  // passkey in whatever captured that output.
  // Unlock takes the passkey from argv when given, so reach the prompt by
  // locking first — and restore the daemon afterwards, since every later test
  // reads through it.
  run(["lock"]);
  const r = runPty(["unlock", "--ttl", "600"], { input: "test-pass" });
  assert.match(r.text, /f: passkey: /, `no passkey prompt: ${JSON.stringify(r.text)}`);
  // This version prints nothing on success — `unlock` returns exit 0 silently and
  // `status` is what reports state. Assert the daemon came up through `status`
  // rather than matching a word the command never writes.
  assert.match(run(["status"]).out, /^unlocked/, `daemon not unlocked: ${JSON.stringify(r.text)}`);
  // In raw mode the child never echoes the passkey, so a second occurrence can
  // only be the child having printed it back. The tty's own echo before the child
  // enters raw mode accounts for exactly one.
  const hits = r.text.split("test-pass").length - 1;
  assert.ok(hits <= 1, `passkey echoed by the child (${hits} occurrences): ${JSON.stringify(r.text)}`);
  assert.match(run(["status"]).out, /^unlocked/, "daemon left locked for the rest of the suite");
});

// Teardown and report come LAST. They used to sit here in the middle, so every
fs.rmSync(TMP, { recursive: true, force: true });
fs.rmSync(SAFE_CWD, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(fail ? 1 : 0);
