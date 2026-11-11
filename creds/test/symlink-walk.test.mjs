// Tests for the symlink-blind uck walk / import list in creds/index.js.
//
//   node creds/test/symlink-walk.test.mjs
//
// THE BUG. `f creds pack '<dir>/...'` walks <dir> to find ucks and then walks
// each uck to find files. Both gates asked a `Dirent` whether it was a directory.
// `fs.readdirSync(..., { withFileTypes: true })` builds a Dirent from the readdir
// entry itself and does NOT follow the link, so `Dirent.isDirectory()` is FALSE
// for a symlink even when the link points at a real directory. A uck tree staged
// as symlinks — a linked checkout, a store assembled out of per-uck links — was
// therefore invisible: the walk returned zero files and the import list threw
// "no ucks (dirs with index.js) under <dir>" for a directory that plainly
// contained some. Zero results, no message about why.
//
// The fix resolves directory-ness with `fs.statSync` (which follows links, and
// throws on a broken one — a throw means "not a directory"), which is the shape
// already used by uck/index.js:58 and :291, and by providers/index.js since
// 59b1560. This suite is the creds half of that same conversion.
//
// NON-VACUITY. Every assertion here is driven through the REAL CLI
// (`f creds pack --dry-run <dir>/...`) via test/run-command.mjs, so it executes
// `expandTargets()` and `walk()` in this working tree — not a hand-made call into
// a helper. Against the pre-fix code, cases 1/2/3 fail on the "no ucks" throw and
// case 5 fails because stderr carries no warning at all.
//
// ISOLATION. Same contract as cli.test.mjs / api.test.mjs: a throwaway HOME under
// the REAL home (never /tmp — `f` clones the uck store into any HOME lacking one,
// which would run a stale copy of the code under test), one store per process,
// HOME set before import so the uck captures it at module load. The fixture tree
// lives under SAFE_CWD (outside this repo) so nothing here can be picked up by a
// loader that intercepts this tree, and so api.test.mjs's UCKS_ROOT scan never
// sees it.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(path.resolve(import.meta.filename));
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

const TMP = fs.mkdtempSync(path.join(REAL_HOME, ".f-creds-sym-"));
const SAFE_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "f-creds-sym-run-"));
fs.mkdirSync(path.join(TMP, ".f"), { recursive: true });
const ENV = { ...process.env, HOME: TMP };

const cleanup = () => {
  for (const d of [TMP, SAFE_CWD]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
};
process.on("exit", cleanup);

/** Invoke the creds uck in THIS tree. Mirrors cli.test.mjs's runner. */
const run = (args, { allowFail = false } = {}) => {
  const r = spawnSync(process.execPath, [path.join(here, "run-command.mjs"), ...args], {
    encoding: "utf8", env: ENV, cwd: SAFE_CWD, timeout: 30000, input: "",
  });
  const code = r.status ?? 1;
  if (code !== 0 && !allowFail) {
    throw new Error(`creds ${args.join(" ")} -> exit ${code}\n${(r.stderr ?? "").trim()}`);
  }
  return { code, out: r.stdout ?? "", err: r.stderr ?? "" };
};

// ---------------------------------------------------------------- fixture tree
// real/            — the actual uck bodies, reached only through links
//   alpha/index.js, alpha/conf/a.json
//   beta/index.js, beta/conf/b.json
// tree/            — the "store": every uck is a SYMLINK into real/
//   alpha -> ../real/alpha
//   beta  -> ../real/beta
//   gamma/         — a plain directory with NO index.js (a non-uck, must not count)
//   broken -> nowhere
// flat/            — a bucket that HAS entries but yields zero ucks
//   notes.txt, gamma/
const FIX = path.join(SAFE_CWD, "fix");
const mk = (p, body = "x") => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
mk(path.join(FIX, "real", "alpha", "index.js"), "// alpha\n");
mk(path.join(FIX, "real", "alpha", "conf", "a.json"), "{\"a\":1}\n");
mk(path.join(FIX, "real", "beta", "index.js"), "// beta\n");
mk(path.join(FIX, "real", "beta", "conf", "b.json"), "{\"b\":2}\n");

const TREE = path.join(FIX, "tree");
fs.mkdirSync(TREE, { recursive: true });
fs.symlinkSync(path.join(FIX, "real", "alpha"), path.join(TREE, "alpha"), "dir");
fs.symlinkSync(path.join(FIX, "real", "beta"), path.join(TREE, "beta"), "dir");
mk(path.join(TREE, "gamma", "readme.md"), "not a uck\n");
fs.symlinkSync(path.join(FIX, "nowhere"), path.join(TREE, "broken"), "dir");

const FLAT = path.join(FIX, "flat");
fs.mkdirSync(FLAT, { recursive: true });
mk(path.join(FLAT, "notes.txt"), "nothing here\n");
mk(path.join(FLAT, "gamma", "readme.md"), "still not a uck\n");

// Sanity on the fixture itself: a Dirent must report the link as NOT a directory,
// otherwise this whole suite would be testing nothing. This is the premise.
await t("the fixture really is symlink-blind to a Dirent (premise holds)", async () => {
  const ents = fs.readdirSync(TREE, { withFileTypes: true });
  const alpha = ents.find((e) => e.name === "alpha");
  assert.ok(alpha, "fixture lost its alpha link");
  assert.ok(alpha.isSymbolicLink(), "alpha must be a symlink for this suite to mean anything");
  assert.equal(alpha.isDirectory(), false,
    "Dirent.isDirectory() reported true for a symlink — Node changed semantics, suite is vacuous");
  assert.equal(fs.statSync(path.join(TREE, "alpha")).isDirectory(), true,
    "statSync does not follow the link — fixture is broken");
});

await t("the store is unlocked so pack can run at all", async () => {
  run(["unlock", "sym-test-pass", "--ttl", "600"]);
  assert.match(run(["status"]).out, /^unlocked/m, "store never unlocked");
});

// ------------------------------------------------------------------ the fix
await t("a symlinked uck dir is walked: its files are found", async () => {
  const { out } = run(["pack", "--dry-run", `${TREE}/...`]);
  const lines = out.split("\n").filter(Boolean);
  const keys = lines.map((l) => l.split("\t")[1] ?? "");
  for (const want of [
    path.join(TREE, "alpha", "index.js"),
    path.join(TREE, "alpha", "conf", "a.json"),
    path.join(TREE, "beta", "index.js"),
    path.join(TREE, "beta", "conf", "b.json"),
  ]) {
    assert.ok(keys.includes("file:" + want),
      `missing ${want} in pack output:\n${out.trim()}`);
  }
  assert.equal(lines.length, 4, `expected exactly 4 files, got ${lines.length}:\n${out.trim()}`);
});

await t("a non-uck dir and a broken link are still excluded", async () => {
  const { out } = run(["pack", "--dry-run", `${TREE}/...`]);
  assert.ok(!out.includes("gamma"), "gamma has no index.js and must not be packed");
  assert.ok(!out.includes("broken"), "a broken symlink must not be packed");
  assert.ok(!out.includes("notes.txt"), "flat/ must not be reached from tree/");
});

await t("a symlinked uck packs for real, not just in dry-run", async () => {
  run(["pack", `${TREE}/...`]);
  const { out } = run(["files", "ls"]);
  assert.ok(out.includes(path.join(TREE, "alpha", "conf", "a.json")),
    `real pack did not store the symlinked file:\n${out}`);
});

await t("an empty-but-nonexistent bucket still throws its clear error", async () => {
  const r = run(["pack", "--dry-run", `${FLAT}/...`], { allowFail: true });
  assert.notEqual(r.code, 0, "a dir with no ucks must fail");
  assert.match(r.err + r.out, /no ucks \(dirs with index.js\)/,
    `expected the 'no ucks' error, got:\n${r.err}\n${r.out}`);
});

await t("a bucket with entries that yields 0 ucks warns on stderr", async () => {
  const r = run(["pack", "--dry-run", `${FLAT}/...`], { allowFail: true });
  assert.match(
    r.err,
    /f creds: warning: .*flat yielded 0 ucks \(scanned 2 entr(?:y|ies)\)/,
    `expected the empty-bucket warning on stderr, got stderr=${JSON.stringify(r.err)}`,
  );
});

await t("the warning is singular for exactly one entry", async () => {
  const ONE = path.join(FIX, "one");
  fs.mkdirSync(ONE, { recursive: true });
  mk(path.join(ONE, "solo.txt"), "one entry, no ucks\n");
  const r = run(["pack", "--dry-run", `${ONE}/...`], { allowFail: true });
  assert.match(r.err, /yielded 0 ucks \(scanned 1 entry\)/,
    `expected '1 entry' (singular), got stderr=${JSON.stringify(r.err)}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
