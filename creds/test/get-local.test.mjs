// fclidev/fcli-ucks#1 — `f creds get <name> --local` must NOT consult providers.
//
//   node --test creds/test/get-local.test.mjs
//
// `--local` is parsed (~line 1753, "never consult providers") and `lookupCred`
// honours it, but `case "get"` hand-rolls the same resolution order and called
// `resolveViaProvider` unconditionally on a local miss. So the one flag an
// operator uses to ask "is this in MY box?" answered with the provider's value
// and exit 0 — a confident wrong answer.
//
// Why cli.test.mjs could not see this: every `get … --local` assertion there
// (lines ~120, 162, 184, 306, 309, 394) is about a cred that IS in the local
// store, so the provider ladder is never reached. A provider holding a name the
// box does NOT have is the only fixture that distinguishes the two paths.
//
// The three claims, in order of how much they pin:
//   (1) `get <name> --local`  -> non-zero, and the provider's value is NOT printed;
//   (2) `get <name>`          -> exit 0 and the provider's value IS printed
//                                (so the fix cannot be "disable the ladder");
//   (3) `lookup <name> --local` -> non-zero miss (the already-correct path, pinned).
// Plus the message shapes the fix must not silently change:
//   (4) `get <name>` on a full miss with NO provider -> the classic
//       `f: no such cred: <name>`;
//   (5) `get <name>` on a full miss WITH a provider -> the
//       `(no provider has it either)` wording;
//   (6) `get <name> --local --source` still prints a source line;
//   (7) `get <local-cred> --local` still prints the value (the happy path).
//
// Provider injection: the CLI child runs with F_CREDS_FAKE_PROVIDER pointing at
// a module exporting a `credentialProvider`. That is a TEST-ONLY seam in
// providers.js — it short-circuits discovery, which in a test HOME would
// otherwise shell out to `f providers --dump` and (per the header of
// run-command.mjs) execute a stale copy of this tree.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const here = path.dirname(path.resolve(import.meta.filename));
const CREDS = path.dirname(here);
const REAL_HOME = os.homedir();

let pass = 0, fail = 0;
const t = async (label, fn) => {
  try { await fn(); pass++; console.log(`ok   ${label}`); }
  catch (e) { fail++; console.log(`FAIL ${label}\n     ${String(e?.message ?? e).split("\n").join("\n     ")}`); }
};

/* ------------------------------------------------ isolated HOME + real daemon */

// NOT under /tmp and not under `here` — same isolation lesson as cli.test.mjs:
// `f` clones a uck store into any HOME lacking one and walks UP from cwd to find
// a package root, so a temp dir inside the uck makes the child run this tree's
// package.json as its own project config.
const TMP = fs.mkdtempSync(path.join(REAL_HOME, ".f-creds-getlocal-"));
const SAFE_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "f-creds-getlocal-run-"));
fs.mkdirSync(path.join(TMP, ".f"), { recursive: true });

// The fake provider lives OUTSIDE the creds uck dir.
const PROV_DIR = path.join(TMP, "prov");
fs.mkdirSync(PROV_DIR, { recursive: true });
const PROVIDER = path.join(PROV_DIR, "fake.js");
const PROVIDER_NAME = "fakeprov";
const PROV_VALUE = "PROVIDER-ONLY-VALUE";
// The name the provider holds and the local box does NOT.
const FAR_NAME = "far-only-cred";

fs.writeFileSync(PROVIDER, `export const credentialProvider = {
  name: ${JSON.stringify(PROVIDER_NAME)},
  resolve: async (name) => (name === ${JSON.stringify(FAR_NAME)} ? ${JSON.stringify(PROV_VALUE)} : null),
  status: async () => ({ ready: true, note: "test provider" }),
};
`);

// `providerConfig()` reads ~/.f/f.config.json and returns `{}` when the file is
// absent — so `askProviders`' `if (!providerConfig(p.name).enabled) continue;`
// skips EVERY provider in a bare throwaway HOME. Without this file the ladder is
// dead for both the `--local` run and the non-`--local` run, test (1) passes for
// the wrong reason, and test (2) fails. Measured: with the file, `get far --local`
// prints the provider value (the bug); without it, both runs print `no such cred`.
fs.writeFileSync(path.join(TMP, ".f", "f.config.json"),
  JSON.stringify({ providers: { [PROVIDER_NAME]: { enabled: true } } }) + "\n");

const ENV = { ...process.env, HOME: TMP, F_CREDS_FAKE_PROVIDER: PROVIDER };

const run = (args, { allowFail = false } = {}) => {
  const r = spawnSync(process.execPath, [path.join(here, "run-command.mjs"), ...args], {
    encoding: "utf8", env: ENV, cwd: SAFE_CWD, timeout: 30000, input: "",
  });
  const code = r.status ?? 1;
  if (code !== 0 && !allowFail) {
    throw new Error(`creds ${args.join(" ")} -> exit ${code}\n${(r.stderr ?? "").trim()}`);
  }
  return { code, out: r.stdout ?? "", err: r.stderr ?? "" };
};

/* ------------------------------------------------------ harness self-checks */
// Both of these must hold or every negative assertion below is vacuous: the
// provider seam must be live, and the daemon must be up.

try {
  run(["unlock", "test-pass", "--ttl", "600"]);
  if (!fs.existsSync(path.join(TMP, ".f", ".creds-daemon"))) {
    throw new Error(`daemon state file never appeared in ${TMP}/.f`);
  }
} catch (e) {
  console.log(`FAIL could not start an isolated daemon: ${e.message}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(SAFE_CWD, { recursive: true, force: true });
  process.exit(1);
}

await t("(0a) harness: the fake provider is actually discovered", () => {
  const r = run(["status"]);
  assert.ok(r.out.includes(`providers: ${PROVIDER_NAME}`),
    `the fake provider seam is not live — \`f creds status\` printed:\n${r.out}${r.err}`);
});

await t("(0b) harness: the name under test is NOT in the local store", async () => {
  // Must be checked against the DAEMON, not against `get --local`: pre-fix,
  // `get --local` consults providers, so it exits 0 for exactly the reason the
  // bug exists and cannot double as proof that the name is a local miss.
  const net = await import("node:net");
  const state = JSON.parse(fs.readFileSync(path.join(TMP, ".f", ".creds-daemon"), "utf8"));
  const exists = await new Promise((resolve, reject) => {
    const c = net.default.connect(state.socket, () => c.write(JSON.stringify({ op: "has", name: FAR_NAME })));
    let buf = "";
    c.on("data", (d) => (buf += d));
    c.on("end", () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    c.on("error", reject);
  });
  assert.equal(exists.exists, false, `${FAR_NAME} must not be in the local box`);
});

/* -------------------------------------------------------------------- tests */

await t("(1) get <provider-only> --local does NOT serve the provider value and exits non-zero", () => {
  const r = run(["get", FAR_NAME, "--local", "--secrets"], { allowFail: true });
  assert.notEqual(r.code, 0,
    `\`get ${FAR_NAME} --local\` exited 0 — it consulted a provider despite --local. stdout: ${JSON.stringify(r.out)}`);
  assert.ok(!r.out.includes(PROV_VALUE),
    `\`get --local\` printed the provider's value (${PROV_VALUE}). stdout: ${JSON.stringify(r.out)}`);
  assert.match(r.err, new RegExp(`no such cred: ${FAR_NAME}`),
    `expected a local-miss message, got: ${JSON.stringify(r.err)}`);
});

await t("(2) get <provider-only> WITHOUT --local still serves the provider value", () => {
  const r = run(["get", FAR_NAME, "--secrets"]);
  assert.equal(r.code, 0, `\`get ${FAR_NAME}\` must still resolve via the provider. stderr: ${r.err}`);
  assert.ok(r.out.includes(PROV_VALUE),
    `the provider ladder must still work — stdout: ${JSON.stringify(r.out)}`);
});

await t("(3) lookup <provider-only> --local still reports the miss", () => {
  const r = run(["lookup", FAR_NAME, "--local", "--raw"], { allowFail: true });
  assert.notEqual(r.code, 0, "`lookup --local` must not resolve a provider-only name");
  assert.ok(!r.out.includes(PROV_VALUE), "`lookup --local` must not print the provider value");
  assert.match(r.err, new RegExp(`no such cred: ${FAR_NAME}`), `got: ${JSON.stringify(r.err)}`);
});

await t("(4) full miss with NO provider keeps the classic error wording", () => {
  const env = { ...ENV };
  delete env.F_CREDS_FAKE_PROVIDER;
  const r = (() => {
    const res = spawnSync(process.execPath, [path.join(here, "run-command.mjs"), "get", "nope-anywhere", "--secrets"], {
      encoding: "utf8", env, cwd: SAFE_CWD, timeout: 30000, input: "",
    });
    return { code: res.status ?? 1, out: res.stdout ?? "", err: res.stderr ?? "" };
  })();
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}`);
  assert.equal(r.err.trim(), "f: no such cred: nope-anywhere",
    `the no-provider error string must not drift. got: ${JSON.stringify(r.err)}`);
});

await t("(5) full miss WITH a provider keeps the '(no provider has it either)' wording", () => {
  const r = run(["get", "nope-anywhere", "--secrets"], { allowFail: true });
  assert.equal(r.code, 1);
  assert.match(r.err, /no such cred: nope-anywhere \(no provider has it either\)/,
    `got: ${JSON.stringify(r.err)}`);
});

await t("(7) get <local cred> --local still prints the value", () => {
  run(["set", "src-local", "local-value"]);
  const r = run(["get", "src-local", "--local", "--secrets"]);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), "local-value");
});

await t("(8) get <local cred> --local is redacted without --secrets", () => {
  const r = run(["get", "src-local", "--local"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /redacted/);
  assert.ok(!r.out.includes("local-value"), "the value must not leak without --secrets");
});

await t("(6) get --local --source still prints a provenance line", () => {
  const r = run(["get", "src-local", "--local", "--secrets", "--source"]);
  assert.match(r.err, /f: source: local:src-local/, `got: ${JSON.stringify(r.err)}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
try { run(["lock"], { allowFail: true }); } catch { /* best effort */ }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
try { fs.rmSync(SAFE_CWD, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail ? 1 : 0);
