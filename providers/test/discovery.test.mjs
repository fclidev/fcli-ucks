// providers/test/discovery.test.mjs
//   node --test providers/test/discovery.test.mjs
//
// The bucket/uck scans in providers/index.js used `Dirent.isDirectory()` as their
// only directory test. A `Dirent` describes the readdir ENTRY, not the target, so
// it reports false for a symlink to a directory — and a uck tree staged as
// symlinks discovered ZERO providers with no error at all. `f providers` printed
// the no-providers line and nothing pointed at the cause; a run lost two attempts
// hunting a config problem that did not exist.
//
// Two claims, both end-to-end through the real exported functions:
//   1. a symlinked bucket, and a symlinked uck inside a real bucket, both discover;
//   2. a bucket that exists but yields nothing says so on stderr.
//
// `f` resolves its store as join(HOME, ".f", "ucks") with NO env override, and
// providers/index.js captures that at module load — so HOME is set before import.
// Each test then repoints `F` and rebuilds the store, because `node --test` runs
// test FILES as concurrent processes and cases must not share one store.
// Fixtures live in a throwaway HOME outside this repo.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fprov-disc-"));
fs.mkdirSync(path.join(HOME, ".f", "ucks"), { recursive: true });
process.env.HOME = HOME;

const PROV = await import(new URL("../index.js", import.meta.url).href);

// A suite that silently tests nothing is worse than no suite: refuse to run if
// the seams this file exists to exercise are not there.
if (typeof PROV.uckDirs !== "function") {
  console.log("FAIL harness: providers/index.js exports no uckDirs() — this suite would test nothing");
  process.exit(1);
}
const SRC = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
if (!SRC.includes("isDir(")) {
  console.log("FAIL harness: providers/index.js has no symlink-following directory test (isDir) — this suite would test nothing");
  process.exit(1);
}
// The module's store root, repointed per test so cases cannot see each other.
const FROOT = path.join(HOME, ".f");
const UCKS = path.join(FROOT, "ucks");
// Symlink targets live OUTSIDE UCKS so that emptying the store cannot eat them.
const LINKS = path.join(HOME, "link-targets");
fs.mkdirSync(LINKS, { recursive: true });

/**
 * A minimal uck that exports a credentialProvider, as `collect()` requires.
 *
 * It must NOT import anything: `collect()` imports every entry it discovers, and
 * a fixture that reached for a real module would make an import failure look like
 * a discovery failure.
 */
function writeUck(dir, name, provName) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "index.js"),
    `export const credentialProvider = { name: ${JSON.stringify(provName)}, resolve: async () => null };\n` +
      `export function register() { return { name: ${JSON.stringify(name)}, run: () => {} }; }\n` +
      `export default { register };\n`,
  );
}

/** A uck dir with no `credentialProvider` — a real uck, but not a provider. */
function writePlainUck(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.js"), `export function register() { return { name: ${JSON.stringify(name)}, run: () => {} }; }\n`);
}

const captured = [];
const realWrite = process.stderr.write.bind(process.stderr);

/** Run `fn` with process.stderr.write captured, and return what it wrote. */
function captureStderr(fn) {
  const start = captured.length;
  process.stderr.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = realWrite;
  }
  return captured.slice(start).join("");
}

/**
 * Start from an empty store rooted at a FRESH directory, run `build`, then run
 * `probe` with stderr captured. Fresh root per case = no cross-case coupling and
 * no dependence on the once-per-process warning cache.
 */
function scenario(build, probe) {
  const root = fs.mkdtempSync(path.join(HOME, "store-"));
  const ucks = path.join(root, ".f", "ucks");
  fs.mkdirSync(ucks, { recursive: true });
  PROV.__setStoreRootForTests?.(root);
  // Fall back to repointing the module constant if the seam is absent: patch it
  // by re-importing is not possible, so the seam is required — assert it exists.
  if (typeof PROV.__setStoreRootForTests !== "function") {
    throw new Error("FAIL harness: no store-root seam — cases would share one store and race");
  }
  build(ucks);
  return { ucks, err: captureStderr(probe) };
}

// ---------------------------------------------------------------------------
test("(1a) a symlinked BUCKET discovers its providers", async () => {
  const { err } = scenario(
    (ucks) => {
      const real = path.join(LINKS, "linked-bucket");
      writeUck(path.join(real, "alpha"), "alpha", "alpha-provider");
      fs.symlinkSync(real, path.join(ucks, "linked"), "dir");
    },
    () => PROV.uckDirs(),
  );
  const dirs = PROV.uckDirs();
  assert.deepEqual(dirs.map((d) => d.name).sort(), ["alpha"], "a symlinked bucket must contribute its ucks");
  assert.equal(err, "", "a working symlinked bucket must not warn");
  const { found } = await PROV.collect({ verbose: false });
  assert.deepEqual(found.map((p) => p.name).sort(), ["alpha-provider"]);
});

test("(1b) a symlinked UCK inside a real bucket is discovered", async () => {
  scenario(
    (ucks) => {
      const real = path.join(LINKS, "real-uck");
      writeUck(real, "beta", "beta-provider");
      const bucket = path.join(ucks, "b1");
      fs.mkdirSync(bucket, { recursive: true });
      fs.symlinkSync(real, path.join(bucket, "beta"), "dir");
    },
    () => PROV.uckDirs(),
  );
  const dirs = PROV.uckDirs();
  assert.deepEqual(dirs.map((d) => d.name).sort(), ["beta"]);
  const { found } = await PROV.collect({ verbose: false });
  assert.deepEqual(found.map((p) => p.name).sort(), ["beta-provider"]);
});

test("(1c) a real-directory bucket still works (regression control)", async () => {
  scenario(
    (ucks) => writeUck(path.join(ucks, "plain", "gamma"), "gamma", "gamma-provider"),
    () => PROV.uckDirs(),
  );
  const dirs = PROV.uckDirs();
  assert.deepEqual(dirs.map((d) => d.name).sort(), ["gamma"]);
  const { found } = await PROV.collect({ verbose: false });
  assert.deepEqual(found.map((p) => p.name).sort(), ["gamma-provider"]);
});

test("(1d) a symlink to a FILE, and a broken link, are not buckets", async () => {
  const { err } = scenario(
    (ucks) => {
      const f = path.join(LINKS, "not-a-dir.txt");
      fs.writeFileSync(f, "nope\n");
      fs.symlinkSync(f, path.join(ucks, "dangling-file"), "file");
      fs.symlinkSync(path.join(LINKS, "does-not-exist"), path.join(ucks, "broken"), "dir");
    },
    () => PROV.uckDirs(),
  );
  assert.deepEqual(PROV.uckDirs(), [], "a file symlink and a broken link are not uck dirs");
  // Neither is a bucket, so there is no bucket to warn about — the store is empty.
  assert.equal(err, "");
});

// ---------------------------------------------------------------------------
test("(2a) an existing bucket that yields nothing warns on stderr", async () => {
  const { err } = scenario(
    (ucks) => fs.mkdirSync(path.join(ucks, "empty-bucket"), { recursive: true }),
    () => PROV.uckDirs(),
  );
  assert.match(err, /warning/, "an empty bucket must warn — this is the silent-zero fix");
  assert.match(err, /empty-bucket/, "the warning must name the bucket");
  assert.match(err, /scanned 0/, "the warning must give the count scanned");
});

test("(2b) a bucket holding only FILES warns, and counts what it scanned", async () => {
  // A bucket of loose files is the other way a tree gets staged wrong, and it is
  // exactly as silent as the symlink case. NB: a bucket of non-provider UCKS is
  // NOT warned about — uckDirs() found them fine, and collect() already prints
  // "(no credential providers…)" for that. This warning is about the scan.
  const { err } = scenario(
    (ucks) => {
      const bucket = path.join(ucks, "loose-files");
      fs.mkdirSync(bucket, { recursive: true });
      for (const n of ["one.txt", "two.txt", "three.txt"])
        fs.writeFileSync(path.join(bucket, n), "x\n");
    },
    () => PROV.uckDirs(),
  );
  assert.match(err, /warning/, "a bucket of loose files must warn");
  assert.match(err, /loose-files/, "the warning must name the bucket");
  assert.match(err, /scanned 3/, "the count is of entries scanned");
});

test("(2e) a bucket of non-provider ucks does NOT warn (that is collect()'s line)", async () => {
  const { err } = scenario(
    (ucks) => {
      for (const n of ["one", "two", "three"]) writePlainUck(path.join(ucks, "no-providers", n), n);
    },
    () => PROV.uckDirs(),
  );
  assert.equal(err, "", "non-provider ucks were found by the scan — warning here would be a false alarm");
  const { found } = await PROV.collect({ verbose: false });
  assert.equal(found.length, 0, "control: collect() really does find no providers here, so its own line is the signal");
});

test("(2c) a bucket that DOES yield a uck does not warn", async () => {
  const { err } = scenario(
    (ucks) => writeUck(path.join(ucks, "good", "delta"), "delta", "delta-provider"),
    () => PROV.uckDirs(),
  );
  assert.equal(err, "", "a healthy bucket must stay silent: " + JSON.stringify(err));
});

test("(2d) the warning is suppressed under the recursion marker", async () => {
  process.env.F_CREDS_NO_PROVIDER = "1";
  try {
    const { err } = scenario(
      (ucks) => fs.mkdirSync(path.join(ucks, "quiet-bucket"), { recursive: true }),
      () => PROV.uckDirs(),
    );
    assert.equal(err, "", "a probe child's stderr must stay clean: " + JSON.stringify(err));
  } finally {
    delete process.env.F_CREDS_NO_PROVIDER;
  }
});

// ---------------------------------------------------------------------------
// Non-vacuity for the harness itself.
test("(V1) the stderr capture really observes process.stderr.write", () => {
  const err = captureStderr(() => process.stderr.write("SENTINEL-LINE\n"));
  assert.equal(err, "SENTINEL-LINE\n", "the capture hook is not observing writes — every stderr assertion above is vacuous");
});

test("(V2) collect() is driven by uckDirs(), so the scan IS the real path", async () => {
  scenario(
    (ucks) => {
      const real = path.join(LINKS, "v2-bucket");
      writeUck(path.join(real, "eps"), "eps", "eps-provider");
      fs.symlinkSync(real, path.join(ucks, "v2"), "dir");
    },
    () => PROV.uckDirs(),
  );
  const dirs = PROV.uckDirs();
  const { found } = await PROV.collect({ verbose: false });
  assert.equal(dirs.length, found.length, "collect() and uckDirs() disagree about the store");
  assert.equal(found.length, 1);
});

test("(V3) discoverInProcess() also sees a symlinked bucket (the creds path)", async () => {
  scenario(
    (ucks) => {
      const real = path.join(LINKS, "v3-bucket");
      writeUck(path.join(real, "zeta"), "zeta", "zeta-provider");
      fs.symlinkSync(real, path.join(ucks, "v3"), "dir");
    },
    () => PROV.uckDirs(),
  );
  const rows = await PROV.discoverInProcess();
  assert.ok(Array.isArray(rows), "discoverInProcess returned null — it found no buckets at all");
  assert.deepEqual(rows.map((r) => r.name).sort(), ["zeta-provider"]);
  assert.ok(rows[0].provider, "the live credentialProvider object must ride with the row");
});
