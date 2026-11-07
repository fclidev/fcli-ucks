// f providers — list the credential providers registered with `f creds`.
//
// A **credential provider** is any uck that exports a `credentialProvider`
// object alongside `register()`. The creds uck consults providers on a local
// **miss** — the encrypted box always wins — and mirrors hits back into it.
//
// Provider interface (see creds/providers.js for the full contract):
//
//   credentialProvider: {
//     name: "vaultwarden",
//     mirrorTtlSec?: 3600,          // floor on mirror freshness (0 = always revalidate)
//     resolve(name): string|Promise<string|null>,   // null/"" = not mine; throw = unavailable
//     has?(name): boolean|Promise<boolean>,         // cheap pre-filter
//     status?(): { ready, note?, hint? },
//   }
//
// The uck's index.js must also self-dispatch when Node runs it directly, so the
// probe protocol works without importing the provider into the creds hot path:
//
//   uckMain(import.meta.url, main);   // defined in this file, exported below
//   // main() handles: --dump | resolve <name> | has <name> | status
//
// `f providers --dump` is the machine-readable contract `f creds` reads. Every
// uck is imported once to collect exports; nothing is executed.

import fs, { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const F = path.join(process.env.HOME ?? "", ".f");

/* ---------------------------------------------------------------------------
 * uckMain / isMain — the entry-point guard a provider's index.js needs so it
 * can double as a CLI entry point when Node runs it directly, without firing
 * when the `f` harness imports it. `f creds` probes providers by running
 * `node <uck>/index.js resolve <name>` in a child process, so importing a
 * provider must stay side-effect-free while direct execution must do work.
 *
 * These twelve lines are INLINED here on purpose, and exported so other
 * provider ucks can import them from this uck. CONTRACT.md N4 forbids `../`
 * (reaching outside your own uck dir: it breaks under bucket flattening and
 * under a local-source copy that omits lib/), and §5 P7 makes it concrete for
 * providers — the probe spawns `node <uck>/index.js` with node_modules
 * resolved from the uck directory, so a bucket-level lib/ is unreachable
 * there. N4's two legal homes for shared code are "copy it into the uck
 * directory" (the default for small helpers) and "an npm package, when the
 * code is large enough that duplication is worse than a dep". Twelve lines is
 * the floor of small, and the npm option cannot work on the npm install path
 * at all: f's installNpmSource only ever runs `npm pack`, never `npm install`,
 * so a published helper package would never land in <uck>/node_modules.
 * Zero deps.
 * ------------------------------------------------------------------------ */

/** True when `metaUrl` is the module Node entered this process through. */
export function isMain(metaUrl, argv = process.argv) {
  const self = argv[1];
  if (!self) return false;
  try {
    return pathToFileURL(realpathSync(self)).href === metaUrl;
  } catch {
    return false;
  }
}

/**
 * If this file is the process entry point, call `fn(process.argv.slice(2))`.
 * Errors go to stderr as one line and exit 1; `fn`'s own exit codes are
 * respected (return a number to set one).
 */
export function uckMain(metaUrl, fn, argv = process.argv) {
  if (!isMain(metaUrl, argv)) return;
  Promise.resolve()
    .then(() => fn(argv.slice(2)))
    .then((code) => {
      if (typeof code === "number" && code !== 0) process.exitCode = code;
    })
    .catch((e) => {
      process.stderr.write(`f: ${e?.message ?? e}\n`);
      process.exitCode = 1;
    });
}

/** Probe subcommands a provider entry must answer. */
export const PROBE_CMDS = ["resolve", "has", "status"];

function buckets() {
  try {
    return fs.readdirSync(path.join(F, "ucks"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(F, "ucks", d.name));
  } catch {
    return [];
  }
}

/** All uck dirs across buckets: { name, dir }. Duplicates resolve first-bucket-wins. */
export function uckDirs() {
  const out = [];
  const seen = new Set();
  for (const bucket of buckets()) {
    let entries;
    try {
      entries = fs.readdirSync(bucket, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!ent.isDirectory() || seen.has(ent.name)) continue;
      const entry = path.join(bucket, ent.name, "index.js");
      if (!fs.existsSync(entry)) continue;
      seen.add(ent.name);
      out.push({ name: ent.name, dir: path.join(bucket, ent.name), entry });
    }
  }
  return out;
}

/**
 * Import every uck and collect its `credentialProvider` export.
 * Import failures are skipped with a note — a broken uck must not blind creds.
 */
export async function collect({ verbose } = {}) {
  const found = [];
  const skipped = [];
  for (const u of uckDirs()) {
    let mod;
    try {
      mod = await import(pathToFileURL(u.entry).href);
    } catch (e) {
      skipped.push({ ...u, reason: `import failed: ${e?.message ?? e}` });
      continue;
    }
    const p = mod?.credentialProvider ?? mod?.default?.credentialProvider;
    if (!p) continue;
    const problems = [];
    if (typeof p.name !== "string" || !p.name) problems.push("missing name");
    if (typeof p.resolve !== "function") problems.push("missing resolve()");
    if (problems.length) {
      skipped.push({ ...u, reason: `invalid credentialProvider (${problems.join(", ")})` });
      continue;
    }
    found.push({
      name: p.name,
      uck: u.name,
      entry: u.entry,
      // Advertised by the provider's credentialProvider; gates `creds set` dual-write.
      // Must be copied here — dropping it makes every provider look read-only to `set`.
      canWrite: p.canWrite === true,
      mirrorTtlSec: typeof p.mirrorTtlSec === "number" ? p.mirrorTtlSec : undefined,
    });
  }
  if (verbose) for (const s of skipped) process.stderr.write(`f providers: skip ${s.name}: ${s.reason}\n`);
  return { found, skipped };
}

/**
 * Probe self-test (G6-adjacent): a provider whose `index.js` is not a working
 * CLI entry fails silently on first `f creds get` miss. Run `status` as a
 * child (exactly what the readiness section does) and report the wiring
 * problem at list time instead.
 *
 * Returns found[] with an extra `probe: "ok" | <problem string>` field.
 */
/**
 * Every child that runs a provider probe must carry the recursion marker.
 *
 * `creds/providers.js` honours `F_CREDS_NO_PROVIDER` and cuts discovery, and a
 * provider honours it to answer "configured" without touching the store. This
 * uck spawns the same probes and did not set it, so a provider's `status` read a
 * live store here while the marker said it should not — which is how
 * `f providers` came to print `vaultwarden: not ready — creds locked` next to a
 * `f creds status` saying `unlocked`. The marker is the single fact every probe
 * caller needs, so it is set here once rather than left to each call site (and
 * to `f providers` is not the only one: see the readiness section below).
 */
const probeEnv = () => ({ ...process.env, F_CREDS_NO_PROVIDER: "1" });

export async function checkProbes(found) {
  const { execFileSync } = await import("node:child_process");
  for (const p of found) {
    try {
      const out = execFileSync(process.execPath, [p.entry, "status"], {
        encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"],
        env: probeEnv(),
      });
      JSON.parse(out); // must be machine-readable
      p.probe = "ok";
    } catch (e) {
      const m = String(e?.stderr || e?.message || e).split("\n")[0].slice(0, 120);
      p.probe = m ? `probe failed: ${m}` : "probe failed";
    }
  }
  return found;
}

export function register(_ctx) {
  return {
    name: "providers",
    desc: "list credential providers registered with f creds",
    run: (_argv, args) => {
      const a = args._ ?? [];
      const dump = a.includes("--dump") || a.includes("--json");
      (async () => {
        const { found, skipped } = await collect({ verbose: !dump });
        await checkProbes(found);
        if (dump) {
          process.stdout.write(JSON.stringify(found) + "\n");
          return;
        }
        if (!found.length) {
          process.stdout.write("(no credential providers — a uck exports 'credentialProvider')\n");
        } else {
          for (const p of found) {
            const ttl = p.mirrorTtlSec === undefined ? "-" : `${p.mirrorTtlSec}s`;
            const probe = p.probe && p.probe !== "ok" ? `\n  ⚠ ${p.probe}` : "";
            process.stdout.write(`${p.name}\tuck:${p.uck}\tmirrorTtl:${ttl}${probe}\n`);
          }
          process.stdout.write(`ok\t${found.length} provider(s)\n`);
        }
        // Show provider readiness too — that's the thing that actually bites.
        for (const p of found) {
          try {
            const { execFileSync } = await import("node:child_process");
            const st = JSON.parse(execFileSync(process.execPath, [p.entry, "status"], {
              encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"],
              env: probeEnv(),
            }));
            process.stdout.write(`  ${p.name}: ${st.ready ? "ready" : "not ready"}${st.note ? ` — ${st.note}` : ""}${st.hint ? `\n    ${st.hint}` : ""}\n`);
          } catch (e) {
            process.stdout.write(`  ${p.name}: status probe failed (${e?.message ?? e})\n`);
          }
        }
        if (skipped.length) process.stdout.write(`skipped\t${skipped.length} (see stderr with -v)\n`);
      })().catch((e) => {
        process.stderr.write(`f: ${e?.message ?? e}\n`);
        process.exit(1);
      });
    },
  };
}

export default { register };
