// Tests for the config uck. Run from the fcli-ucks bucket root:
//   npx vitest run config/config.test.js
//
// Two traps this file is shaped around, both learned the hard way:
//
// 1. A test that shells out to `f` does NOT test this working tree. `f` loads
//    ucks from the flattened store, and on a throwaway HOME it clones the
//    bucket from *origin* — so the assertion runs against whatever is published,
//    and passes or fails for reasons unrelated to the file being edited. (It
//    did exactly that: the fix was correct and nine tests still failed.)
// 2. The store cannot simply be symlinked either: ~/.f/ucks/config would be
//    discovered as a uck named "config" (C5/G10), so no scratch name is safe at
//    the store root, and a bucket dir named `config` shadowed by the real one
//    wins on discovery order.
//
// So: load ./index.js directly, through the same shape core uses (register(ctx)
// then run(argv, args, ctx)), with HOME pointed at a throwaway dir. That covers
// argv parsing and error handling too, not just the helpers, and the file under
// test is unambiguously this one.

import { test, expect, describe } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The runner is invoked with a path relative to the repo root, and the child's
// cwd is the repo root, so ./config/run-uck.mjs resolves however vitest is
// started (from the bucket root or via `npx vitest run config/config.test.js`).
const HERE = new URL("./", import.meta.url).pathname;
const REPO = join(HERE, "..");

/**
 * Invoke the uck in a CHILD PROCESS, the way core does (register(ctx), then
 * run(argv, args, ctx)), and return what the user would see.
 *
 * A child, not an in-process import, because run() signals failure through
 * process.exitCode — and a test process must not carry that between cases. The
 * first version imported the module and read process.exitCode afterwards, so a
 * test that exited 1 left the flag set and the next test's "success" read as a
 * failure (and vice versa): failures moved around depending on test order, and
 * order-dependent failures are the kind that come back later as "flaky".
 */
async function runConfig(argv, { home, cwd }) {
  const res = spawnSync(process.execPath, [join("config", "run-uck.mjs"), cwd, ...argv], {
    encoding: "utf8",
    cwd: REPO,
    env: { ...process.env, HOME: home },
  });
  const file = join(cwd, "f.config.json");
  return {
    out: res.stdout ?? "",
    err: res.stderr ?? "",
    code: res.status ?? -1,
    doc: exists(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined,
  };
}

const exists = (p) => {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Awaited on purpose. The first version of this helper did not await the
 * callback, so every async test's assertions ran *after* the temp HOME was
 * removed — the failures looked like product bugs (ENOENT, exit 1) and were
 * entirely the harness.
 */
async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "f-config-test-"));
  const cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  // Create ~/.f/ucks. The store-source guard compares against the real store
  // path and deliberately no-ops when the store is absent (nothing can be inside
  // a store that isn't there) — so without this line every guard assertion
  // "passes" by never running. That is exactly what it did first time.
  mkdirSync(join(home, ".f", "ucks"), { recursive: true });
  const file = join(cwd, "f.config.json");
  try {
    return await fn({ home, cwd, file });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const write = (file, doc) => writeFileSync(file, JSON.stringify(doc));

describe("add creates the array instead of losing the value (C7)", () => {
  test("the uck's own usage example works", async () =>
    withHome(async ({ home, cwd, file }) => {
      // `f config add ucks github:user/repo` is printed by this uck's usage
      // text. Before the fix it wrote {} and exited 0: applyAdd's fallback was
      // setPathCreate(doc, path, undefined), which assigned undefined — so the
      // key never survived JSON.stringify and the value was gone.
      const r = await runConfig(["add", "ucks", "github:user/repo"], { home, cwd, file });
      expect(r.code).toBe(0);
      expect(r.doc.ucks).toEqual(["github:user/repo"]);
    }));

  test("appends to an existing array", async () =>
    withHome(async ({ home, cwd, file }) => {
      write(file, { ucks: ["first"] });
      const r = await runConfig(["add", "ucks", "second"], { home, cwd, file });
      expect(r.doc.ucks).toEqual(["first", "second"]);
    }));

  test("explicit [$] append on a fresh config", async () =>
    withHome(async ({ home, cwd, file }) => {
      const r = await runConfig(["add", "ucks[$]", "x"], { home, cwd, file });
      expect(r.doc.ucks).toEqual(["x"]);
    }));

  test("objects, not just strings", async () =>
    withHome(async ({ home, cwd, file }) => {
      write(file, { ucks: [{ source: "a" }] });
      const r = await runConfig(["add", "ucks", JSON.stringify({ source: "b", name: "n" })], {
        home,
        cwd,
        file,
      });
      expect(r.doc.ucks).toEqual([{ source: "a" }, { source: "b", name: "n" }]);
    }));

  test("a positional path is refused, not turned into a {\"0\": …} object", async () =>
    withHome(async ({ home, cwd, file }) => {
      // The old fallback built {"ucks":{"0":["b"]}} — an object where core
      // expects an array, so every later f command failed to read the source.
      const r = await runConfig(["add", "ucks[0]", "z"], { home, cwd, file });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/position/);
      expect(r.err).toMatch(/f config add ucks/); // names the operation that works
      expect(r.doc).toBeUndefined(); // nothing written
    }));

  test("an index past the end is refused instead of creating a hole", async () =>
    withHome(async ({ home, cwd, file }) => {
      // A hole serialises as null, and core reads a null source as undefined ->
      // "Uck source not found: undefined" on every subsequent f command.
      write(file, { ucks: ["a"] });
      const before = readFileSync(file, "utf8");
      const r = await runConfig(["add", "ucks[5]", "b"], { home, cwd, file });
      expect(r.code).toBe(1);
      expect(readFileSync(file, "utf8")).toBe(before);
    }));

  test("sibling keys survive", async () =>
    withHome(async ({ home, cwd, file }) => {
      write(file, { skills: [{ name: "s", path: "p" }] });
      const r = await runConfig(["add", "ucks", "u"], { home, cwd, file });
      expect(r.doc).toEqual({ skills: [{ name: "s", path: "p" }], ucks: ["u"] });
    }));

  test("a second add on the created array works (the array is real)", async () =>
    withHome(async ({ home, cwd, file }) => {
      await runConfig(["add", "ucks", "a"], { home, cwd, file });
      const r = await runConfig(["add", "ucks", "b"], { home, cwd, file });
      expect(r.doc.ucks).toEqual(["a", "b"]);
    }));
});

describe("store-source guard (C1a, enforced when the source is written)", () => {
  test("refuses a source inside the store and writes nothing", async () =>
    withHome(async ({ home, cwd, file }) => {
      mkdirSync(join(home, ".f", "ucks", "mybucket"), { recursive: true });
      write(file, { ucks: ["github:keep/me"] });
      const before = readFileSync(file, "utf8");
      const r = await runConfig(["add", "ucks", join(home, ".f", "ucks", "mybucket")], {
        home,
        cwd,
        file,
      });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/point into the store/);
      expect(readFileSync(file, "utf8")).toBe(before);
    }));

  test("refuses the store dir itself", async () =>
    withHome(async ({ home, cwd, file }) => {
      const r = await runConfig(["add", "ucks", join(home, ".f", "ucks")], { home, cwd, file });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/point into the store/);
    }));

  test("git URLs, npm specs and external paths are untouched", async () =>
    withHome(async ({ home, cwd, file }) => {
      const specs = [
        "github:a/b",
        "https://example.com/x.git",
        "@scope/pkg",
        join(home, "work", "myucks"),
      ];
      for (const spec of specs) {
        const r = await runConfig(["add", "ucks", spec], { home, cwd, file });
        expect(r.code, `should accept ${spec}, got: ${r.err}`).toBe(0);
      }
      expect(readFileSync(file, "utf8")).toBeDefined();
      expect(JSON.parse(readFileSync(file, "utf8")).ucks).toHaveLength(specs.length);
    }));
});

describe("errors are one line plus the fix (R3), not a stack trace", () => {
  test("a rejected write prints no Node stack and exits 1", async () =>
    withHome(async ({ home, cwd, file }) => {
      // add, not set: `set` replaces an existing key, so the bad value would be
      // the only one there and the guard legitimately accepts it. `add` leaves a
      // good source alongside the bad one — the case the guard exists for — and
      // it has to fail as one line, not as a stack trace out of a helper.
      write(file, { ucks: ["github:keep/me"] });
      mkdirSync(join(home, ".f", "ucks", "y"), { recursive: true });
      const r = await runConfig(["add", "ucks", join(home, ".f", "ucks", "y")], { home, cwd, file });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/^f: /);
      expect(r.err).not.toMatch(/\n\s+at .*:\d+:\d+\)/);
    }));

  test("a usage error still delivers stdout written before it", async () =>
    withHome(async ({ home, cwd, file }) => {
      // The point of exitCode over exit() (CONTRACT.md C5) is not the code, it is
      // that buffered stdout survives. process.exit(1) also exits 1, so asserting
      // the code alone would not detect reverting this — an earlier mutation
      // proved that. A piped stdout is what an agent sees, and exit() drops data
      // sitting in it.
      write(file, { ucks: ["u"] });
      const runner = join("config", "run-uck.mjs");
      // `get` prints the doc, then a follow-up bad op would be separate; instead
      // drive it directly: print something large, then usage().
      const script = join(home, "drain.mjs");
      writeFileSync(
        script,
        `import { register } from ${JSON.stringify(join(HERE, "index.js"))};\n` +
          `const ctx = { fVersion: "0.3.1", contractVersion: 1, argv: ["bogus-op"], env: process.env, cwd: () => process.cwd(), registry: {} };\n` +
          `const u = register(ctx);\n` +
          `process.stdout.write("x".repeat(300000));\n` +
          `await u.run(["bogus-op"], { _: ["bogus-op"] }, ctx);\n`
      );
      const r = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        cwd,
        env: { ...process.env, HOME: home },
      });
      expect(r.stdout.length).toBeGreaterThanOrEqual(300000);
      expect(r.status).toBe(1);
    }));

  test("missing operands still print usage", async () =>
    withHome(async ({ home, cwd, file }) => {
      const r = await runConfig(["add", "ucks"], { home, cwd, file });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/usage: f config/);
    }));
});

describe("list", () => {
  test("reports the sources and the file they came from", async () =>
    withHome(async ({ home, cwd, file }) => {
      write(file, { ucks: ["github:a/b"] });
      const r = await runConfig(["list"], { home, cwd, file });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/github:a\/b/);
    }));
});

describe("set / get / remove", () => {
  test("round-trip", async () =>
    withHome(async ({ home, cwd, file }) => {
      await runConfig(["set", "ucks[0]", "./a"], { home, cwd, file });
      expect(JSON.parse(readFileSync(file, "utf8")).ucks[0]).toBe("./a");
      const got = await runConfig(["get", "ucks[0]"], { home, cwd, file });
      expect(got.out.trim()).toBe("./a");
      await runConfig(["remove", "ucks[0]"], { home, cwd, file });
      expect(JSON.parse(readFileSync(file, "utf8")).ucks).toEqual([]);
    }));

  test("programmatic add stores a real array, not String(array)", async () =>
    withHome(async ({ home, cwd, file }) => {
      // parseValue() was called with String(value), so a genuine array argument
      // became the string "a". The CLI only ever passes strings, but configApi is
      // exported for other ucks to call.
      const mod = await import(`${pathToFileURL(join(HERE, "index.js")).href}?v=${Math.random()}`);
      const api = mod.configApi ?? mod.default.configApi;
      const prev = process.env.HOME;
      process.env.HOME = home;
      try {
        api.add(file, "ucks", ["a", "b"]);
      } finally {
        process.env.HOME = prev;
      }
      expect(JSON.parse(readFileSync(file, "utf8")).ucks).toEqual([["a", "b"]]);
    }));
});
