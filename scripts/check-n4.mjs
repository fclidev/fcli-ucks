// N4 gate — CONTRACT.md N4: a uck may import sibling files in its own directory
// (`./helper.js`); reaching OUT with `../` is forbidden.
//
//   node scripts/check-n4.mjs
//
// Why this file exists: nothing else enforces N4. `f uck check` implements N2, N3/N7,
// G10, N8, N9, N13, N10, N6, S2 and P8 — not N4 — and the CI parse-check adds no N4
// rule either. So the one N4 violation this repo had (`providers/index.js` re-exporting
// `../lib/uckmain.js`) sat unnoticed until it was read by hand, and it broke every
// command on any local-source copy that omitted lib/ (CONTRACT.md N4, ROADMAP-1.0.md).
// Without a gate, N4 will silently be re-broken.
//
// What counts as a violation: a static `import`/`export`/`require` of a path starting
// with `../`, in a uck's own source. Test files are exempt (see TESTS_ARE_EXEMPT).
//
// Deliberately dependency-free and offline: no imports outside node: builtins.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// The ucks, in bundle order. A uck is a top-level dir with an index.js; this list is
// explicit rather than scanned so that a stray dir cannot quietly escape the gate.
const UCKS = ["config", "creds", "providers", "search", "skills", "uck", "v"];

// TESTS_ARE_EXEMPT — why test files may use `../`, and why that is not a hole:
// The two hits in this repo are `creds/test/run-command.mjs:15` and
// `search/test/cli.test.mjs:12`, both `import { register } from "../index.js"` — a
// test reaching for its OWN uck's entry point. N4's forbidden list is specifically
// (1) `../..` out of the uck directory, (2) a sibling BUCKET by store path
// (`../../<other-bucket>/lib/…`), (3) a sibling bucket via ctx.registry-then-import.
// A single `../` that stays inside the same uck is none of those, and it is how every
// suite here is already written. Two more reasons not to gate it: tests are never
// shipped (scripts/assemble.mjs skips `*.test.js`, `test/` and `test.js` when it
// builds dist/), so nothing exempted here can reach a user; and banning it would
// force tests to sit beside sources, which is a worse layout. The exemption is
// deliberately narrow — it exempts TEST FILES, not `../` in general, and the gate
// still fails on any `../` in a uck's shipped source. Tighten this to `^\.\./index\.js$`
// if a test ever starts reaching further.
const TEST_FILE = /\.test\.(js|mjs)$/;
const TEST_DIR = `${path.sep}test${path.sep}`;

// `import "x"` / `import ... from "x"` / `export ... from "x"` / `require("x")` /
// dynamic `import("x")`. Only string literals that begin with `../` are violations.
const PATTERNS = [
  /(?:^|[\s;{}()])(?:import|export)\s[^;\n]*?\bfrom\s*["'](\.\.\/[^"']*)["']/g,
  /(?:^|[\s;{}()])(?:import|export)\s*["'](\.\.\/[^"']*)["']/g,
  /\brequire\s*\(\s*["'](\.\.\/[^"']*)["']\s*\)/g,
  /\bimport\s*\(\s*["'](\.\.\/[^"']*)["']\s*\)/g,
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && /\.(js|mjs)$/.test(e.name)) yield full;
  }
}

/** Strip comments so a documented example in prose is not read as an import. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1);
}

const violations = [];
let scanned = 0;

for (const uck of UCKS) {
  const dir = path.join(root, uck);
  try {
    if (!statSync(dir).isDirectory()) continue;
  } catch {
    violations.push(`${uck}: uck directory missing`);
    continue;
  }
  for (const file of walk(dir)) {
    if (TEST_FILE.test(file) || file.includes(TEST_DIR)) continue;
    scanned++;
    const src = readFileSync(file, "utf8");
    const lines = codeOnly(src).split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const re of PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(lines[i])) !== null) {
          violations.push(`${path.relative(root, file)}:${i + 1}: imports "${m[1]}" (N4: no "../")`);
        }
      }
    }
  }
}

if (violations.length) {
  process.stderr.write(`check-n4: N4 VIOLATION (${violations.length})\n`);
  for (const v of violations) process.stderr.write(`  ${v}\n`);
  process.stderr.write(
    '\nCONTRACT.md N4: a uck may import "./sibling.js" only. A "../" import breaks under\n' +
      "bucket flattening and under a local-source copy that omits lib/. Copy the helper\n" +
      "into the uck directory instead (N4 option 1) — do not add a shared bucket dir.\n"
  );
  process.exit(1);
}

console.log(`check-n4: ok — ${UCKS.length} ucks, ${scanned} source files, no "../" imports`);
