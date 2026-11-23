// The CI gate for this repo, in one file: does every tracked source file at
// least parse, and does every uck still look like a uck?
//
// The product here is code that only runs when a human types `f <name>`, so
// the cheapest gate that matters is the one that catches a file the loader can
// never read. Run it by hand with:
//
//     node scripts/check.mjs
//
// Deliberately offline and dependency-free. A CI step that downloads a linter
// is a step that goes red when the network hiccups, and the runner ships git,
// bash and a Node that satisfies package engines (>=22.14). Nothing here
// installs, publishes, or touches the network.
//
// It fails on defects only — things that break `f`:
//   * a tracked .js/.cjs/.mjs/.json/.sh that does not parse,
//   * a uck dir (top-level dir with an index.js) whose index.js exports no
//     register(): `f` imports it and rejects it,
//   * a uck dir with no package.json, or without "type": "module", which makes
//     the ESM the ucks are written in unimportable,
//   * a uck dir whose package.json has no "name" at all.
// Everything else this layout expects but does not strictly require is a
// warning, never a failure: a missing SKILL.md costs discoverability, not
// loading, and a package.json named something other than fcli-ucks-<dir>
// still resolves. Style is not a defect and is not checked. Exec-bit and
// shebang oddities are warnings for the same reason: no file in this repo is
// executed directly (f imports the modules), so making that fatal would be
// permanent noise.
//
// Layout note, specific to this repo: the ucks are the top-level dirs
// (config, creds, providers, search, skills, uck, v). lib/ is shared code
// those ucks import and has no register() of its own, so it is not a uck;
// scripts/ is tooling like this file and assemble.mjs. Nested helpers under an
// existing uck (creds/test/, search/test/) are part of that uck, so they are
// parsed but do not each need their own register(). Unlike the Forgejo fork,
// packages here are named fcli-ucks-<dir> and the root package
// (@fcli.dev/ucks) only assembles them into dist/ for npm.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// dist/ and node_modules/ are build output or vendored code (this repo also
// has committed vitest caches under node_modules), .git is not a tree:
// nothing there is ours to check.
const IGNORED = new Set(["dist", "node_modules", ".git"]);
// Not ucks even though they can hold a top-level index.js: scripts/ is tooling
// (this file), lib/ is shared code with no entry point of its own.
const NOT_A_UCK = new Set(["scripts", "lib"]);

const git = (args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });

const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
const onDisk = tracked.filter((f) => !f.split("/").some((seg) => IGNORED.has(seg)));
const shipped = onDisk.filter(
  (f) => !f.split("/").some((seg) => NOT_A_UCK.has(seg)),
);

// mode 100755 => git has the exec bit on it.
const modes = new Map();
for (const rec of git(["ls-files", "-s", "-z"]).split("\0").filter(Boolean)) {
  const [meta, file] = rec.split("\t");
  modes.set(file, meta.split(" ")[0]);
}

const fails = [];
const warns = [];
const n = { js: 0, json: 0, sh: 0, skipped: 0 };

const run = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: "" };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

// The first line of a tool's complaint is the only part worth printing; the
// rest is the same stack trace every time.
const firstLine = (text) =>
  (text.split("\n").find((l) => /error|Error/.test(l)) ??
    text.split("\n").find((l) => l.trim()) ??
    "failed").trim();

function checkJs(file, abs) {
  n.js++;
  const direct = run("node", ["--check", abs]);
  if (direct.ok) return;
  // `node --check` picks the module type from the nearest package.json, which
  // not every Node version honours for a bare .js. Retry the same bytes as
  // .mjs so an ESM file cannot fail for a reason that is not its own.
  const tmp = path.join(tmpdir(), `fcli-ucks-check-${process.pid}.mjs`);
  copyFileSync(abs, tmp);
  if (run("node", ["--check", tmp]).ok) return rmSync(tmp, { force: true });
  rmSync(tmp, { force: true });
  fails.push(`${file}: ${firstLine(direct.out)}`);
}

for (const file of onDisk) {
  const abs = path.join(root, file);
  if (!existsSync(abs)) {
    fails.push(`${file}: tracked in git but missing from the working tree`);
    continue;
  }
  const ext = path.extname(file);
  if ([".js", ".cjs", ".mjs"].includes(ext)) checkJs(file, abs);
  else if (ext === ".json") {
    n.json++;
    try {
      JSON.parse(readFileSync(abs, "utf8"));
    } catch (err) {
      fails.push(`${file}: ${firstLine(String(err.message))}`);
    }
  } else if (ext === ".sh") {
    n.sh++;
    const r = run("bash", ["-n", abs]);
    if (!r.ok) fails.push(`${file}: ${firstLine(r.out)}`);
  } else n.skipped++;

  const exec = modes.get(file) === "100755";
  const head = readFileSync(abs, "utf8").split("\n")[0] ?? "";
  if (exec && !head.startsWith("#!"))
    warns.push(`${file}: exec bit set, no shebang`);
  if (ext === ".sh" && !exec) warns.push(`${file}: shell script is not executable`);
}

// --- structure: every uck must stay loadable -------------------------------

const uckDirs = [...new Set(shipped.filter((f) => path.basename(f) === "index.js").map((f) => path.dirname(f)))]
  .filter((d) => d !== "." && !d.includes("/"))
  .sort();
const registerExport =
  /export\s+(async\s+)?function\s+register\b|export\s+(const|let|var)\s+register\b|export\s*\{[^}]*\bregister\b/;

for (const dir of uckDirs) {
  const idx = path.join(root, dir, "index.js");
  if (!registerExport.test(readFileSync(idx, "utf8")))
    fails.push(`${dir}/index.js: exports no register() — the loader rejects it`);
  const pkgPath = path.join(root, dir, "package.json");
  if (!existsSync(pkgPath)) {
    fails.push(`${dir}: index.js with no package.json`);
    continue;
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (err) {
    fails.push(`${dir}/package.json: ${firstLine(String(err.message))}`);
    continue;
  }
  if (pkg.type !== "module")
    fails.push(`${dir}/package.json: "type" must be "module" for an ESM uck`);
  if (!pkg.name) fails.push(`${dir}/package.json: no "name"`);
  // Convention across every package in this repo, including lib/: the name is
  // fcli-ucks-<dir>. A drift is confusing, not fatal, so it warns.
  if (pkg.name && pkg.name !== `fcli-ucks-${dir}`)
    warns.push(
      `${dir}/package.json: name "${pkg.name}" does not follow fcli-ucks-${dir}`,
    );
  if (!existsSync(path.join(root, dir, "SKILL.md")))
    warns.push(`${dir}: no SKILL.md — nothing tells anyone what \`f ${dir}\` does`);
}

// --- report ----------------------------------------------------------------

const summary = [
  `checked: ${n.js} js, ${n.json} json, ${n.sh} sh (${n.skipped} other files skipped)`,
  `ucks: ${uckDirs.join(", ") || "(none)"}`,
];
for (const line of summary) console.log(line);
for (const w of warns) console.log(`warn: ${w}`);
for (const f of fails) console.error(`FAIL ${f}`);

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) {
  appendFileSync(
    summaryFile,
    `${summary.join("\n")}\n${warns.map((w) => `- warn: ${w}`).join("\n")}\n`,
  );
}

if (fails.length) {
  console.error(`FAIL ${fails.length} defect(s)`);
  process.exit(1);
}
console.log("OK everything parses");
