// Plan/emit ONE npm package per uck (kenny's decision 2026-11-23).
//
//   node scripts/peruck.mjs            # dry-run: print every manifest, change nothing
//   node scripts/peruck.mjs --write    # write <uck>/package.json in place
//
// WHY THIS EXISTS, and the two measured facts it encodes (both were wrong in the
// original design note, so they are recorded here rather than assumed):
//
// 1. THERE IS NO SHARED lib/ ANY MORE, AND NONE IS NEEDED. Measured 2026-11-23:
//      - NO uck imported anything under lib/. Not providers, not creds, not any.
//        providers' `export { uckMain, isMain } from "./uckmain.js"` had ZERO
//        importers (grep isMain matched only that export line) and providers has no
//        main() to guard, so the whole vendoring chain existed to ship a dead file.
//      - lib/creds-error.js had no importer either; CONTRACT.md §6.1 already moved
//        `classifyCredsError` into the creds uck as the PRIVATE `classifyThrown`
//        (creds/index.js:1334, used :1175), consumers get §7.2 kinds from resolveCred.
//      - lib/credsresolve.js never existed in THIS repo (it does in the personal
//        bucket, which is a separate cleanup).
//    So the probe-entry guard is now an IMPLIED CONTRACT documented in CONTRACT.md
//    §P4 with the canonical snippet. Why implied rather than shared: a published
//    per-uck package contains only <uck>/, so `../lib/uckmain.js` resolves to nothing
//    after install; putting it in creds would make providers import creds while creds
//    discovers providers by importing every uck (an import cycle, and against §P4's
//    self-registration); and the guard is ~12 lines that copy cleanly. Measured before
//    deciding: a guard-free provider satisfies P4 (status/has/resolve all exit 0 with
//    correct stdout), and a crash exits 1 with or without the guard - classifyThrown
//    returns `provider` for both, and `has`/`status` reach the same fallback. The
//    guard's only real edge is a one-line `f: ...` stderr instead of a Node stack.
//    What IS still true: ucks reach creds through ctx.registry.creds.credsApi at run()
//    time (f passes `registry` into run() only, f dist/index.js:1191, never into
//    register()). That is a runtime contract no manifest can express - which is
//    exactly why per-uck packages publish with no shared package at all.
//    GUARD KEPT: `escapes` below is a hard error for any `../` import, and
//    providers/index.js specifically may never import ../lib/ again.
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

/**
 * Third-party deps a uck genuinely needs, derived from its code (not prose).
 * A package that requires a module it does not declare installs fine and then
 * throws `Cannot find module` at load - the uck VANISHES with one stderr line
 * while `f uck check` still calls the source tree valid. Measured 2026-11-23:
 * `config/index.js` does `require("jsonpath-plus")` yet its manifest declared NO
 * dependencies, so the packed tarball had no way to get jsonpath-plus.
 * A bare name is a dep UNLESS it resolves inside this repo (root package name,
 * a top-level dir, or a lib/* helper - those are siblings or vendored, not npm).
 */
function depsOf(name, topDirs) {
  const src = codeOnly(readFileSync(path.join(root, name, "index.js"), "utf8"));
  const specs = [...src.matchAll(/(?:require|from|import)\s*\(?\s*["'`]([^"'`\n]+)["'`]/g)].map((m) => m[1]);
  const deps = new Set();
  for (const s of specs) {
    if (s.startsWith("node:") || s.startsWith(".")) continue;
    const pkgName = s.split("/").slice(0, s.startsWith("@") ? 2 : 1).join("/");
    // Skip things that resolve within this repository, not from npm.
    if (pkgName === pkg.name) continue;
    if (topDirs.has(pkgName) || topDirs.has(`lib/${pkgName}`)) continue;
    if (pkgName.startsWith("lib/")) continue;
    deps.add(pkgName);
  }
  return [...deps].sort();
}

/** Strip comments/strings-before-scanning. A dependency scanner that reads prose
 *  INVENTS dependencies, which is strictly worse than missing one: it would have
 *  added a package literally named "daemon is still starting" to creds' manifest.
 *  Measured 2026-11-23: the old regex matched `tell 'empty' from 'absent'` and
 *  `'never existed'` inside comments, and one greedy match spanned 8 real lines of
 *  code and swallowed them - so the same scanner could swallow a REAL require() and
 *  publish a package that cannot install. Comments are removed, not skipped-by-luck.
 *  Order matters: block comments first, then line comments, then the scanner runs
 *  over code only. String literals are kept because `require(name)` is real usage. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /* ... */ (non-greedy: never span two blocks)
    .replace(/^[ \t]*\/\/.*$/gm, " ") // whole-line // comments
    // Blank out WORD-PROSE literals only, and only AFTER comments are gone. Two
    // boundary rules, each learned by breaking this scanner:
    //   - no `\n` inside the character class: the `"\n"` in real code must survive,
    //     or a following `// ... tell 'empty' from 'absent'` merges onto a code line
    //     and its prose matches as a specifier (this invented an "absent" dep);
    //   - a dot/colon/dash/slash means it is a PATH or a sentence, not a package
    //     name, so leave it alone. Otherwise `from "./providers.js"` and
    //     `require("jsonpath-plus")` get blanked and the uck publishes un-installable
    //     (the canary below is what proved that).
    .replace(/["']([A-Za-z][A-Za-z0-9 ]*)['"]/g, (_s, w) => ` ${w.replace(/[^\n]/g, " ")} `);
}

/** Which shared things a uck actually imports, by reading its code (not its prose). */
function importsOf(name) {
  const src = codeOnly(readFileSync(path.join(root, name, "index.js"), "utf8"));
  // `require()` counts too: config/index.js does `const { JSONPath } =
  // require("jsonpath-plus")` through createRequire, and a from/import-only scan
  // called it dependency-free - the import then fails in a clean store (verified:
  // config is the one uck that cannot be imported in this checkout).
  const specifiers = [...src.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"'\n]+)["']/g)].map((m) => m[1]);
  // PROOF THAT THE PROSE FILTER DID NOT BLIND THE SCANNER: piffero-plus must still be
  // present after codeOnly(). If it vanishes, this function is eating real dependencies.
  if (name === "config" && !src.includes("piffero-plus")) {
    throw new Error("peruck.mjs: prose filter destroyed a real import in config/index.js");
  }
  // Guard for the OLD vendored-uckmain shape. It used to be keyed to the
  // `providers` uck specifically; that uck is gone (its command is now
  // `f creds providers`), so the guard is general now: NO uck may import out of
  // its own directory, because a published tarball ships only <uck>/ and the
  // import target would not exist after install. That single escape made 5/7
  // ucks un-installable, and it is checked for every uck below via `escapes`.
  const own = new Set();
  const bare = new Set();
  const escapes = new Set();
  for (const s of specifiers) {
    if (s.startsWith("node:")) continue;
    if (s.startsWith(".")) {
      // The PACKAGE boundary is the uck dir, not the repo root: a published tarball
      // contains only <uck>/. So `../lib/uckmain.js` is inside THIS repo yet escapes
      // the PACKAGE - it resolves to nothing after install. Check escape from the uck
      // dir; the old repo-root test reported providers as a benign "lib" import and
      // the guard missed the very bug it was written to catch.
      const resolved = path.normalize(path.join(root, name, s));
      const fromPkg = path.relative(path.join(root, name), resolved);
      if (fromPkg.startsWith("..")) {
        escapes.add(s);
        own.add(s);
      } else {
        own.add(path.relative(root, resolved).split(path.sep)[0]);
      }
    } else {
      own.add(s);
      bare.add(s.split("/").slice(0, s.startsWith("@") ? 2 : 1).join("/"));
    }
  }
  return { own: [...own].sort(), bare: [...bare].sort(), escapes: [...escapes].sort() };
}

const plans = [];
const topDirs = new Set(uckDirs);
// Deps that are real but whose version we did not verify -> reported, never written.
const p_needsVersion = new Map();
for (const name of uckDirs) {
  const pjPath = path.join(root, name, "package.json");
  const cur = read(pjPath);
  const imports = importsOf(name);
  // Vendoring is GONE: the probe-entry guard is an implied contract (CONTRACT.md
  // §P4), so no uck gets a generated uckmain.js any more and `files` is left exactly
  // as authored. Why it was removed rather than kept as convenience: the only
  // consumer in this repo was a re-export with ZERO importers (providers has no
  // main()), the guard itself is ~12 lines that copy cleanly, and the vendoring
  // predicate had already been silently-always-false for its whole life - the
  // mechanism cost more than the file saved. Preserved below: `escapes` still fails
  // the build for any `../` import, which is the actual install-breaking class.
  // Real npm deps, so a required module is never left undeclared.
  const realDeps = depsOf(name, topDirs);
  // A bare specifier that is not declared is an install-time break: the uck imports
  // fine in the repo (root node_modules) and fails in a clean store. RealDeps now
  // covers the honest ones, so `undeclared` is what's LEFT - imports that resolve
  // inside the repo (siblings, lib/) rather than from npm: report, don't add.
  const undeclared = imports.bare.filter(
    (m) => !(cur.dependencies ?? {})[m] && !(cur.peerDependencies ?? {})[m] && !realDeps.includes(m)
  );

  const next = {
    ...cur,
    // Names are SCOPED: `@fcli.dev/<uck>`, matching the root package and the
    // fcli.dev site. Chosen 2026-11-23 by kenny over the unscoped
    // `fcli-ucks-<uck>` this script used to default to.
    // Two consequences recorded so nobody rediscovers them the hard way:
    //   1. npm TRUSTED PUBLISHING is per package, so scoped names still mean one
    //      publisher per uck on npmjs.com - scoping does not amortise that.
    //   2. npm's packed FILENAME strips the scope (`@a/b-c`@1.2.3 ->
    //      a-b-c-1.2.3.tgz). Anything computing a tarball path from a package
    //      name must flatten it; verify-install.mjs now derives it from the
    //      packDir listing instead.
    name: cur.name ?? `@fcli.dev/${name}`,
    version: cur.version ?? version,
    description: cur.description ?? `f ${name}`,
    // Never invent a license. The repo is GPL-3.0-only and only the operator can
    // relicense a uck; inheriting the bundle's license is the safe default.
    license: cur.license ?? pkg.license,
    // Trusted publishing (OIDC) requires repository.url to match the GitHub repo
    // exactly - npm's own troubleshooting says a mismatch is rejected at publish
    // time, and the per-uck manifests inherited NO repository field while the
    // bundle has had one since 0.1.0 (which is why publish.yml worked and a
    // per-uck OIDC publish would not). Inherited from the bundle so a per-uck
    // manifest cannot silently point at a different repo than the workflow that
    // publishes it. `publishConfig.access` makes the public visibility explicit
    // instead of relying on every caller remembering `--access public`.
    repository: cur.repository ?? pkg.repository,
    publishConfig: cur.publishConfig ?? { access: "public" },
    keywords: [...new Set([...(cur.keywords ?? []), "fcli", "fcli-uck", "uck", "cli"])],
    // Ship the uck AND every local sibling it imports. The `files` allowlist is a
    // WHITELIST: `index.js` alone silently drops a uck's own module directory. Two
    // measured victims of an index.js-only allowlist on 2026-11-23:
    //   - creds/index.js does `import ... from "./providers.js"` (its OWN file, not
    //     the providers uck) - the packed fcli-ucks-creds had NO providers.js, so the
    //     flagship package could not import;
    //   - providers/index.js does `export ... from "../lib/uckmain.js"` which ESCAPES
    //     the package dir and can only be satisfied by vendoring uckmain.js below.
    // So: enumerate every relative import target that lives inside the uck dir.
    files: (() => {
      const src = readFileSync(path.join(root, name, "index.js"), "utf8");
      const rel = new Set();
      // Match BOTH forms: static `from "./x.js"` (no paren) AND `require("./x.js")`.
      // A `require\(\s*`-only regex silently misses every static import sibling -
      // which is exactly how creds' `./providers.js` was dropped from the manifest.
      for (const mm of src.matchAll(/(?:from|import|require)\s*\(?\s*["'`](\.[^"'`\n]+)["'`]/g)) {
        const target = path.normalize(path.join(root, name, mm[1]));
        const inside = path.relative(path.join(root, name), target);
        // Keep only siblings inside the uck dir (a `../` import is an ESCAPE and fails
        // the build below; nothing is vendored to paper over it any more).
        if (!inside.startsWith("..") && existsSync(target)) rel.add(inside);
      }
      const base = ["index.js", "SKILL.md", ...rel];
      // Only files that actually exist on disk. The old `|| f === "uckmain.js"` carve-out
      // let a generated file into `files` before it was copied; vendoring is gone, so the
      // whitelist now reflects reality and verify-install.mjs compares it to the tarball.
      const uniq = [...new Set(base)].filter((f) => existsSync(path.join(root, name, f)));
      // Merge with any existing files field so a hand-authored entry is not lost.
      return [...new Set([...(cur.files ?? []), ...uniq])];
    })(),
    type: cur.type ?? "module",
  };
  // Declare every real third-party dep. A fake version ("^0.0.0") would make the
  // package un-installable and read as a green build, so we pin from an explicit
  // reviewed map of registry-verified versions (verified 2026-11-23 via
  // `npm view <pkg> version`, a read). An unmapped dep is reported as NEEDS-VERSION
  // and NOT written, rather than shipping a version we did not verify.
  const KNOWN_VERSIONS = { "piffero-plus": "^1.2.0" };
  if (realDeps.length) {
    next.dependencies = { ...(cur.dependencies ?? {}) };
    for (const d of realDeps) {
      if (!next.dependencies[d]) next.dependencies[d] = KNOWN_VERSIONS[d];
    }
    const missing = realDeps.filter((d) => !next.dependencies[d]);
    if (missing.length) p_needsVersion.set(name, missing);
  }

  const diffs = Object.keys(next)
    .filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(next[k]))
    .map((k) => `${k}: ${JSON.stringify(cur[k] ?? null)} -> ${JSON.stringify(next[k])}`);

  // GUARD: a packaged index.js must not import anything OUTSIDE the package dir.
  // The tarball contains only the uck dir, so `../lib/x.js` resolves to nothing in a
  // clean store and the uck VANISHES with one stderr line (measured: providers
  // imported ../lib/uckmain.js and failed to register 5/7). No amount of copying into
  // `files` helps while the import points outside the package. ESCAPES = a hard error.
  const escapes = imports.escapes;

  plans.push({ name, pjPath, next, diffs, imports: imports.own, undeclared, escapes });
}

// Report before touching anything -- a manifest change that silently drops a field
// is how @fcli.dev/ucks@0.2.0 shipped 8 ucks and declared 1.
let changed = 0;
for (const p of plans) {
  const flag = p.diffs.length ? "CHANGE" : "same  ";
  if (p.diffs.length) changed++;
  const nv = p_needsVersion.get(p.name);
  console.log(`${flag} ${p.name}  imports=[${p.imports.join(", ")}]${p.undeclared.length ? `  !! UNDECLARED BARE DEPS: ${p.undeclared.join(", ")}` : ""}${p.escapes.length ? `  !! ESCAPES PACKAGE (un-installable): ${p.escapes.join(", ")}` : ""}${nv ? `  !! NEEDS-VERSION (not written): ${nv.join(", ")}` : ""}`);
  for (const d of p.diffs) console.log(`         ${d}`);
}
console.log(`\n${plans.length} ucks, ${changed} would change (${write ? "WRITING" : "dry-run, nothing written"})`);

// Hard-fail on any escaping import or unverified dep: those produce packages that
// install cleanly and then cannot load, which is the worst failure (silent vanish).
const blocking = plans.filter((p) => p.escapes.length || p_needsVersion.has(p.name));
if (blocking.length) {
  console.log(`\nBLOCKED: ${blocking.map((p) => p.name).join(", ")} - fix escaping imports / dep versions before publishing.`);
  process.exitCode = 1;
}

if (write) {
  for (const p of plans) {
    if (!p.diffs.length) continue;
    writeFileSync(p.pjPath, JSON.stringify(p.next, null, 2) + "\n");
    console.log(`wrote ${path.relative(root, p.pjPath)}`);
  }
  // (No vendoring step: the probe-entry guard is an implied contract, CONTRACT.md §P4.)
}

// Sanity assertion: the plan must cover every register()-exporting dir, and the
// count must match what the repo actually contains.
const counted = execFileSync("grep", ["-rlE", "export (async )?function register|export \\{[^}]*register", "--include=index.js", root], { encoding: "utf8" })
  .split("\n").filter(Boolean)
  .filter((l) => !l.includes("node_modules") && !l.includes("/dist/")).length;
console.log(`assertion: plan covers ${plans.length} ucks, repo has ${counted} register()-exporting index.js -> ${plans.length === counted ? "MATCH" : "MISMATCH (fix this script before publishing)"}`);
process.exitCode = plans.length === counted ? 0 : 1;
