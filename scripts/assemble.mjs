// Assemble the publishable bundle: dist/<uck> for each uck dir, plus
// dist/node_modules with every runtime dep, and a version-stamped manifest.
// CI runs this after `npm ci`-ing each uck's deps, so node_modules exist
// where they do in the repo; anything missing is installed on the fly.

import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

// A uck is any top-level dir with an index.js that exports register().
// Excluded: dist, node_modules, .git, and helper dirs without an index.js.
// lib/ is a shared helper module (imported by ucks) — included but not
// listed as a uck in the manifest.
const ucks = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => !["dist", "node_modules", ".git", "scripts"].includes(n))
  .filter((n) => existsSync(path.join(root, n, "index.js")));
const shared = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => n === "lib" && existsSync(path.join(root, n, "package.json")));

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
    const uckPkg = JSON.parse(readFileSync(uckPkgPath, "utf8"));
    if (uckPkg.dependencies) {
      // Flatten each uck's runtime deps into the bundle's dep map so CI can
      // npm ci them in one pass, and so `f` can reify them later.
      manifest.ucks[name] = uckPkg;
    }
  } else {
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
