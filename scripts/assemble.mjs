// Assemble the publishable bundle: dist/<uck> for each uck dir, plus
// dist/node_modules with every runtime dep, and a version-stamped manifest.
// CI runs this after `npm ci`-ing each uck's deps, so node_modules exist
// where they do in the repo; anything missing is installed on the fly.

import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

// A uck is any top-level dir with an index.js that exports register().
// Excluded: dist, node_modules, .git, and helper dirs without an index.js.
// There is no shared helper module: measured 2026-11-23, no uck imported anything
// under lib/, so the old "lib/ is imported by ucks" claim below this line was false
// and the copy it justified shipped dead files. See the `shared` list further down.
const ucks = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => !["dist", "node_modules", ".git", "scripts"].includes(n))
  .filter((n) => existsSync(path.join(root, n, "index.js")));
// No "shared" dir any more. `lib/` used to be copied wholesale into dist/ because it
// had a package.json, which shipped lib/creds-error.js (dead, superseded by the
// private classifyThrown in the creds uck) and lib/uckmain.js (unreachable: dist/
// providers used its own vendored copy). Both are gone: the probe-entry guard is an
// implied contract, CONTRACT.md §P4. If a real shared runtime module ever appears it
// needs a REAL importer, and then this list should be explicit rather than "any dir
// named lib with a package.json" - that rule shipped nothing useful for its whole life.
const shared = [];

// Rebuild from scratch. dist/ is gitignored and cpSync never deletes, so a
// stale dir survives every later build and npm pack ships it: ls/ and w/ were
// removed from the source tree and still went out in 0.2.0 because of this.
// node_modules is included because it is assembled per-build from uck deps.
if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
mkdirSync(path.join(dist, "node_modules"), { recursive: true });

const manifest = { name: pkg.name, version: pkg.version, ucks: {} };

for (const name of [...shared, ...ucks].sort()) {
  const src = path.join(root, name);
  const out = path.join(dist, name);
  const files = readdirSync(src);
  // Copy the uck dir, but never its own node_modules or test files.
  mkdirSync(out, { recursive: true });
  for (const f of files) {
    if (f === "node_modules") continue;
    if (f.endsWith(".test.js") || f === "test" || f === "test.js") continue;
    cpSync(path.join(src, f), path.join(out, f), { recursive: true });
  }
  const uckPkgPath = path.join(out, "package.json");
  if (shared.includes(name)) {
    manifest.shared = manifest.shared ?? [];
    manifest.shared.push(name);
  } else if (existsSync(uckPkgPath)) {
    // Record the uck either way. The condition here used to be
    // `if (uckPkg.dependencies)`, so a uck with no dependencies was copied into dist/
    // and left out of the manifest: @fcli.dev/ucks@0.2.0 shipped 8 ucks and declared 1.
    // Nothing broke because `f` discovers ucks by walking for index.js and reads only
    // .version from this file -- but the manifest misdescribed the artifact it sits in,
    // and the first consumer that enumerates ucks from it would see one uck in a bundle
    // of eight. Deps still come from the same object below.
    const uckPkg = JSON.parse(readFileSync(uckPkgPath, "utf8"));
    // A uck dir that exports register() but has no name is the same misdescription
    // class: the bundle would claim a uck it cannot identify. Fail, don't record {}.
    if (!uckPkg.name) {
      console.error(`ERROR: ${name}/package.json has no "name" - it would ship unidentified.`);
      process.exitCode = 1;
    }
    manifest.ucks[name] = uckPkg;
  } else {
    // A register()-exporting dir with NO package.json used to be recorded as `{}` and
    // shipped. `f` loads it from dist/<name>/index.js (so it works in the bundle), but
    // it can never be published per-uck and the manifest describes it as an empty
    // object. Loud, not silent: this is the same "misdescribes the artifact" trap as
    // the 0.2.0 dep bug in the comment above.
    console.error(`ERROR: ${name}/ exports register() but has no package.json - cannot be published per-uck.`);
    console.error(`       run: node scripts/peruck.mjs --write`);
    process.exitCode = 1;
    manifest.ucks[name] = {};
  }
}

// Collect the union of all runtime deps.
const allDeps = {};
for (const meta of Object.values(manifest.ucks))
  for (const [k, v] of Object.entries(meta.dependencies ?? {}))
    allDeps[k] = v;

writeFileSync(
  path.join(dist, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n"
);
// Emit the dep map for the CI step that installs node_modules.
writeFileSync(path.join(dist, "deps.json"), JSON.stringify(allDeps, null, 2) + "\n");

console.log(`assembled ${ucks.length} ucks: ${ucks.join(", ")}`);
console.log(`runtime deps: ${Object.keys(allDeps).join(", ") || "(none)"}`);
