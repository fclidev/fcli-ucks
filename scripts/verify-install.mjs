// Prove that every per-uck package is genuinely installable and loadable, in a
// CLEAN store, before anything is published.
//
//   node scripts/verify-install.mjs
//
// WHY THIS EXISTS. `f` discovers ucks by walking for index.js and silently skips a
// uck whose import throws, printing at most one stderr line. `f uck check` validates
// the SOURCE TREE, so it happily reports a tree "valid" while the published tarball
// of the same uck cannot load. The gap is the PACKAGE boundary: the tarball ships
// only <uck>/, so an import of a sibling file dropped by the `files` allowlist, or a
// `../lib/...` that escapes the package dir, resolves fine in the repo and to nothing
// after install. Measured 2026-11-23: creds imported ./providers.js (dropped by an
// index.js-only files list) and providers imported ../lib/uckmain.js (escapes) -
// 5/7 ucks registered in a clean store while `f uck check` called the tree valid.
//
// This script packs every uck, installs the tarballs into a throwaway store under a
// temp dir, then IMPORTS each installed index.js and calls register(). It asserts the
// COUNT, not the absence of an error message - a vanished uck prints almost nothing.
// It is read-only on the repo (writes only to a temp dir) and needs no npm auth.

import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Same "is a uck" rule as assemble.mjs / peruck.mjs: a top-level dir with index.js
// exporting register(). Kept identical so the three scripts cannot disagree.
const uckDirs = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => !["dist", "node_modules", ".git", "scripts", "lib"].includes(n))
  .filter((n) => existsSync(path.join(root, n, "index.js")))
  .filter((n) =>
    /export\s+(async\s+)?function\s+register|export\s+\{[^}]*\bregister\b/.test(
      // Read the committed source only; a stray edit is exactly what we want to catch.
      // Note: we check the repo file, not the packed file, for DISCOVERY - the packed
      // file is what gets imported below.
      (() => { try { return execFileSync("cat", [path.join(root, n, "index.js")], { encoding: "utf8" }); } catch { return ""; } })()
    )
  );

if (!uckDirs.length) {
  console.error("verify-install: found no ucks - wrong directory?");
  process.exit(1);
}

const packDir = mkdtempSync(path.join(tmpdir(), "peruck-pack-"));
const storeDir = mkdtempSync(path.join(tmpdir(), "peruck-store-"));

let failed = false;
try {
  // 1. Pack each uck (npm pack reads <uck>/package.json `files`, exactly what a
  //    consumer would receive).
  for (const name of uckDirs) {
    execFileSync("npm", ["pack", "--pack-destination", packDir], { cwd: path.join(root, name), stdio: "pipe" });
  }
  const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
  console.log(`packed ${tarballs.length}/${uckDirs.length} ucks`);
  if (tarballs.length !== uckDirs.length) {
    console.error(`MISMATCH: packed ${tarballs.length}, expected ${uckDirs.length}`);
    failed = true;
  }

  // 2. Install the tarballs into an isolated store. No registry, no auth: they are
  //    local files. This exercises each package's `files` + `dependencies` for real.
  writeFileSync(path.join(storeDir, "package.json"), JSON.stringify({ name: "verify-install-store", version: "1.0.0", private: true }, null, 2));
  const tgzPaths = tarballs.map((t) => path.join(packDir, t));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", ...tgzPaths], { cwd: storeDir, stdio: "pipe" });

  // 3. Import + register each INSTALLED package. The module path is resolved from
  //    the store, so a missing sibling or an escaping ../ import throws here exactly
  //    as it would inside `f`.
  const results = [];
  for (const name of uckDirs) {
    const modPath = path.join(storeDir, "node_modules", `fcli-ucks-${name}`, "index.js");
    try {
      const mod = await import("file://" + modPath);
      if (typeof mod.register !== "function") throw new Error("no register() export");
      const r = mod.register({});
      if (!r || typeof r.name !== "string") throw new Error("register() returned no name");
      results.push({ name, ok: true, registered: r.name });
    } catch (e) {
      results.push({ name, ok: false, error: String(e.message).split("\n")[0] });
    }
  }

  const ok = results.filter((r) => r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "OK  " : "FAIL"} ${r.name}${r.ok ? "  register()=" + r.registered : "  " + r.error}`);
  }
  console.log(`\n${ok.length}/${uckDirs.length} ucks install AND register from a clean store`);
  if (ok.length !== uckDirs.length) {
    console.error("NOT PUBLISHABLE: a uck that cannot import silently vanishes from `f`.");
    failed = true;
  }
} finally {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(storeDir, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;
