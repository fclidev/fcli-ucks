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
//   uckMain(import.meta.url, main);   // from ../lib/uckmain.js
//   // main() handles: --dump | resolve <name> | has <name> | status
//
// `f providers --dump` is the machine-readable contract `f creds` reads. Every
// uck is imported once to collect exports; nothing is executed.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const F = path.join(process.env.HOME ?? "", ".f");

/** Shared guard so a provider's index.js can run standalone; lives one level up
 *  because the f loader requires every uck dir to export register(ctx). */
export { uckMain, isMain } from "../lib/uckmain.js";

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
      hasExternalApi: true,
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
export async function checkProbes(found) {
  const { execFileSync } = await import("node:child_process");
  for (const p of found) {
    try {
      const out = execFileSync(process.execPath, [p.entry, "status"], {
        encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"],
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
