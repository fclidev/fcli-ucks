// Plan/emit ONE npm package per uck (kenny's decision 2026-11-23).
//
//   node scripts/peruck.mjs            # dry-run: print every manifest, change nothing
//   node scripts/peruck.mjs --write    # write <uck>/package.json in place
//
// WHY THIS EXISTS, and the two measured facts it encodes (both were wrong in the
// original design note, so they are recorded here rather than assumed):
//
// 1. `lib/` HAS ONE REAL CONSUMER AND IT IS NOT CREDS. Grepping the tree for real
//    import statements yields exactly one hit:
//        providers/index.js:47  export { uckMain, isMain } from "../lib/uckmain.js";
//    `lib/credsresolve.js` DOES NOT EXIST in this repository, and `lib/creds-error.js`
//    is referenced by nothing except a comment in its own header. So "creds is the
//    shared library, lib/ belongs to creds" is not implementable as written: creds
//    has no import-time dependency on lib/ at all. What IS true is the second half of
//    that decision -- ucks reach creds through `ctx.registry.creds.credsApi` at run()
//    time, because f passes `registry` into run() only (f dist/index.js:1191), never
//    into register(). That is a runtime contract, not a package dependency, which is
//    exactly why per-uck packages can be published without a lib package.
//    This script therefore does NOT invent a lib dependency. It keeps providers'
//    relative ../lib/uckmain.js import working by ALSO copying uckmain.js into each
//    consumer (see vendorUckMain), and flags the one import that would break.
//
// 2. NO UCK IMPORTS `@fcli.dev/f`. That was my own false finding: I pattern-matched
//    a comment (`providers/index.js:20` is a commented-out `// from ../lib/uckmain.js`)
//    and generalised from the PERSONAL bucket, where gh imports @octokit/rest and fj
//    imports @llamaduck/forgejo-ts. Measured here: `grep -rlE "@fcli\.dev/f"
//    --include=index.js` returns NOTHING, so `f` is not a declared dependency of the
//    official ucks at all and this script adds no peerDependency for it. The real
//    shared contract is the RUNTIME one (ctx.registry.creds.credsApi at run()), which
//    no manifest can express - a per-uck package can therefore be published with only
//    each uck's own third-party deps. Any uck that DOES import a bare specifier must
//    declare it, which is what `bareImports` below is for.
//
// Publish is deliberately NOT part of this script: npm auth is kenny's and
// `npm whoami` against the registry returns E401 on this box.

import { readFileSync, writeFileSync, existsSync, readdirSync, cpSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const write = process.argv.includes("--write");

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

// The uck's own version comes from the bundle today; a per-uck version is only
// meaningful once CI stamps it, so it is inherited rather than invented.
const version = pkg.version;

// A uck is any top-level dir with an index.js exporting register() (same rule
// assemble.mjs uses, kept in one place so the two scripts cannot disagree).
const uckDirs = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => !["dist", "node_modules", ".git", "scripts", "lib"].includes(n))
  .filter((n) => existsSync(path.join(root, n, "index.js")))
  .filter((n) => /export\s+(async\s+)?function\s+register|export\s+\{[^}]*\bregister\b/.test(readFileSync(path.join(root, n, "index.js"), "utf8")));

const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
// read() parses JSON; a .description fallback must never feed it a .js file.
const readText = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

/** Which shared things a uck actually imports, by reading its source. */
function importsOf(name) {
  const src = readFileSync(path.join(root, name, "index.js"), "utf8");
  // `require()` counts too: config/index.js does `const { JSONPath } =
  // require("jsonpath-plus")` through createRequire, and a from/import-only scan
  // called it dependency-free - the import then fails in a clean store (verified:
  // config is the one uck that cannot be imported in this checkout). Prose such as
  // "// from 'absent'" also matches, so bare names are REPORTED, never silently added.
  const specifiers = [...src.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const own = new Set();
  const bare = new Set();
  for (const s of specifiers) {
    if (s.startsWith("node:")) continue;
    if (s.startsWith(".")) {
      const resolved = path.normalize(path.join(root, name, s));
      const rel = path.relative(root, resolved);
      if (rel.startsWith("..")) own.add(`ESCAPES-TREE:${rel}`);
      else own.add(rel.split(path.sep)[0]);
    } else {
      own.add(s);
      bare.add(s.split("/").slice(0, s.startsWith("@") ? 2 : 1).join("/"));
    }
  }
  return { own: [...own].sort(), bare: [...bare].sort() };
}

const plans = [];
for (const name of uckDirs) {
  const pjPath = path.join(root, name, "package.json");
  const cur = read(pjPath);
  const imports = importsOf(name);
  const usesUckMain = imports.own.some((s) => s === "lib" || s.startsWith("lib/"));
  // A bare specifier that is not declared is an install-time break: the uck imports
  // fine in the repo (root node_modules) and fails in a clean store.
  const undeclared = imports.bare.filter((m) => !(cur.dependencies ?? {})[m] && !(cur.peerDependencies ?? {})[m]);

  const next = {
    ...cur,
    name: cur.name ?? `fcli-ucks-${name}`,
    version: cur.version ?? version,
    description: cur.description ?? `f ${name}`,
    // Never invent a license. The repo is GPL-3.0-only and only the operator can
    // relicense a uck; inheriting the bundle's license is the safe default.
    license: cur.license ?? pkg.license,
    keywords: [...new Set([...(cur.keywords ?? []), "fcli", "fcli-uck", "uck", "cli"])],
    // Ship exactly what a uck needs to register: no dist/, no tests, no node_modules.
    files: cur.files ?? ["index.js", "SKILL.md", "uckmain.js"].filter(
      (f) => existsSync(path.join(root, name, f)) || f === "uckmain.js"
    ),
    type: cur.type ?? "module",
  };
  if (usesUckMain) {
    next.files = next.files?.includes("uckmain.js") ? next.files : [...(next.files ?? []), "uckmain.js"];
  }

  const diffs = Object.keys(next)
    .filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(next[k]))
    .map((k) => `${k}: ${JSON.stringify(cur[k] ?? null)} -> ${JSON.stringify(next[k])}`);

  plans.push({ name, pjPath, next, diffs, imports: imports.own, undeclared, usesUckMain });
}

// Report before touching anything -- a manifest change that silently drops a field
// is how @fcli.dev/ucks@0.2.0 shipped 8 ucks and declared 1.
let changed = 0;
for (const p of plans) {
  const flag = p.diffs.length ? "CHANGE" : "same  ";
  if (p.diffs.length) changed++;
  console.log(`${flag} ${p.name}  imports=[${p.imports.join(", ")}]${p.usesUckMain ? "  <-- relative lib/ import, must vendor uckmain.js" : ""}${p.undeclared.length ? `  !! UNDECLARED BARE DEPS: ${p.undeclared.join(", ")}` : ""}`);
  for (const d of p.diffs) console.log(`         ${d}`);
}
console.log(`\n${plans.length} ucks, ${changed} would change (${write ? "WRITING" : "dry-run, nothing written"})`);

if (write) {
  for (const p of plans) {
    if (!p.diffs.length) continue;
    writeFileSync(p.pjPath, JSON.stringify(p.next, null, 2) + "\n");
    console.log(`wrote ${path.relative(root, p.pjPath)}`);
  }
  // The one irreducible duplication (providers/index.js:47 imports ../lib/uckmain.js,
  // which cannot resolve across package boundaries).
  for (const p of plans.filter((x) => x.usesUckMain)) {
    const dest = path.join(root, p.name, "uckmain.js");
    if (!existsSync(dest)) {
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(path.join(root, "lib", "uckmain.js"), dest);
      console.log(`vendored lib/uckmain.js -> ${p.name}/uckmain.js`);
    }
  }
}

// Sanity assertion: the plan must cover every register()-exporting dir, and the
// count must match what the repo actually contains.
const counted = execFileSync("grep", ["-rlE", "export (async )?function register|export \\{[^}]*register", "--include=index.js", root], { encoding: "utf8" })
  .split("\n").filter(Boolean)
  .filter((l) => !l.includes("node_modules") && !l.includes("/dist/")).length;
console.log(`assertion: plan covers ${plans.length} ucks, repo has ${counted} register()-exporting index.js -> ${plans.length === counted ? "MATCH" : "MISMATCH (fix this script before publishing)"}`);
process.exitCode = plans.length === counted ? 0 : 1;
