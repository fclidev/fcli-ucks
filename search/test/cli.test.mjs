// Unit tests for `f search`, driven through register()/run() rather than by
// importing helpers — a uck exports one thing, so the only honest way to test
// ranking is to call it the way f does.
//
//   node --test search/test/
//
// The ctx shape mirrors what core builds (src/cli.ts): `ucks` complete at run
// time and `self` set to the running uck's name. If either drifts, these fail,
// which is the point — self-exclusion depends on ctx.self being populated.

import assert from "node:assert/strict";
import { register } from "../index.js";

const STORE = [
  {
    name: "creds",
    desc: "store credentials (scrypt+AES-GCM, daemon+socket, ttl); falls back to credential providers on a miss",
  },
  {
    name: "providers",
    desc: "list credential providers registered with f creds",
  },
  {
    name: "vaultwarden",
    desc: "read secrets from a Vaultwarden vault; credential provider for f creds",
  },
  { name: "ls", desc: "list files (terse, one per line)" },
  {
    name: "ha",
    desc: "Home Assistant: states, service calls, scenes, automations",
  },
  { name: "ha-ws", desc: "Home Assistant WebSocket API: live state stream" },
  {
    name: "config",
    desc: "edit f.config.json via JSONPath (get/set/add/remove/list)",
  },
  { name: "pi-models", desc: "save or restore pi model config" },
  {
    name: "search",
    desc: "rank ucks against a query (name, then description)",
  },
];

function run(query, { self = "search", ucks = STORE } = {}) {
  const uck = register({ fVersion: "0.0.0", self, ucks, registry: {} });
  const out = [];
  const err = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s) => {
    out.push(String(s));
    return true;
  };
  process.stderr.write = (s) => {
    err.push(String(s));
    return true;
  };
  let code;
  try {
    const argv = query === "" ? [] : String(query).split(" ");
    code = uck.run(
      argv,
      { _: argv },
      { fVersion: "0.0.0", self, ucks, registry: {} },
    );
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { out: out.join(""), err: err.join(""), code };
}

const names = (out) =>
  out
    .split("\n")
    .filter((l) => l && !l.startsWith("maybe:"))
    .map((l) => l.split(/\s+/)[0]);

const tests = [
  [
    "desc is capped well below core's 120",
    () => {
      const r = run("credential");
      for (const line of r.out
        .trim()
        .split("\n")
        .filter((l) => l && l !== "maybe:")) {
        const desc = line.slice(line.indexOf("  ") + 2);
        assert.ok(desc.length <= 40, `desc too long (${desc.length}): ${desc}`);
      }
      // The cap must actually bite, or it is decoration.
      assert.ok(r.out.includes("…"), "expected truncation marker");
    },
  ],

  [
    "the search uck never matches itself",
    () => {
      // Its own desc contains "rank", "ucks", "query", "name", "description" —
      // an unfiltered search would surface it on most queries.
      for (const q of [
        "rank",
        "ucks",
        "query",
        "name",
        "description",
        "description of ucks",
      ]) {
        const r = run(q);
        assert.ok(
          !names(r.out).includes("search"),
          `"${q}" matched the search uck itself`,
        );
      }
    },
  ],

  [
    "name hits sort above description-only hits, and say which term matched",
    () => {
      const r = run("home");
      assert.equal(names(r.out)[0], "ha");
      assert.ok(
        !r.out.includes("description"),
        "all hits are desc-only; no tiers to label",
      );

      // "config" is a uck name, so it earns the name tier. "home" reaches ha and
      // ha-ws only through their descriptions. Before this was fixed both rows
      // looked equally confident. (Note: `f search credential home` is *not* such
      // a query — no uck is named "credential", so every hit is desc-only and no
      // marker is correct. Picking a representative query matters more than it
      // looks; an unrepresentative one makes working code look broken.)
      const m = run("config home");
      const lines = m.out.trim().split("\n");
      assert.ok(
        lines[0].startsWith("config"),
        `name hit first, got: ${lines[0]}`,
      );
      assert.ok(
        /\[config\]$/.test(lines[0]),
        `row must name its matching term: ${lines[0]}`,
      );
      assert.match(m.out, /matched on description:/);
      assert.ok(
        m.out.indexOf("matched on description:") < m.out.indexOf("ha  "),
        "name tier first",
      );
      const descTier = m.out
        .split("matched on description:")[1]
        .trim()
        .split("\n")
        .map((l) => l.split(/\s+/)[0]);
      // Assert on membership, not exact order: pi-models' desc also says "config",
      // so it belongs in this tier, and asserting a fixed list would encode this
      // fixture's wording rather than the behaviour.
      assert.ok(
        descTier.includes("ha") && descTier.includes("ha-ws"),
        `desc hits kept: ${descTier}`,
      );
      assert.ok(
        !descTier.includes("config"),
        `name hit leaked into desc tier: ${descTier}`,
      );
      assert.ok(
        descTier.every((n) => n !== "config"),
        "name-tier row must not be duplicated in the desc tier",
      );
    },
  ],

  [
    "a term that matches nothing contributes no marker",
    () => {
      // "ssh" names no uck here, so every hit is desc-only via "home"; position
      // makes no claim and the marker would be noise.
      const r = run("ssh home");
      assert.ok(!r.out.includes("["), `unexpected marker: ${r.out}`);
      assert.ok(
        !r.out.includes("description:"),
        `unexpected tier label: ${r.out}`,
      );
    },
  ],

  [
    "single-term queries get no tier labels or match markers",
    () => {
      // Labels are information only when the tiers split; otherwise they are
      // tokens paid for nothing.
      const r = run("credential");
      assert.ok(
        !r.out.includes("description:"),
        `unexpected tier label: ${r.out}`,
      );
      assert.ok(!r.out.includes("["), `unexpected match marker: ${r.out}`);
    },
  ],

  [
    "hyphenated names match on their words",
    () => {
      assert.equal(names(run("models").out)[0], "pi-models");
      assert.ok(run("pi").out.includes("pi-models"));
    },
  ],

  [
    "matching is literal, so a typo does not match",
    () => {
      const r = run("credentail");
      assert.equal(r.out.trim(), "no uck matched: credentail");
      assert.equal(r.code, 1, "no-match must exit non-zero");
      assert.equal(names(run("cred").out)[0], "creds");
    },
  ],

  [
    "no match says so instead of printing nothing",
    () => {
      const r = run("nothingzzz");
      assert.match(r.out, /no uck matched: nothingzzz/);
      assert.equal(r.code, 1);
    },
  ],

  [
    "empty and noise-only queries print usage, not everything",
    () => {
      // A 1-char token is noise ("f", "a"), so "a b" has no usable term. It must
      // print usage rather than silently returning nothing — same reasoning as
      // the no-match path: silence reads as "no such capability".
      for (const q of ["", "   ", "a b"]) {
        const r = run(q);
        assert.match(
          r.out,
          /usage: f search <query>/,
          `"${q}" should print usage`,
        );
        assert.equal(r.code, undefined, "usage is not an error");
      }
    },
  ],

  [
    "a query with real terms that match nothing is a miss, not usage",
    () => {
      // Distinguishes "you gave me nothing to work with" from "nothing exists".
      const r = run("zzzzqqqq");
      assert.ok(!r.out.includes("usage:"), "a real miss must not print usage");
      assert.equal(r.code, 1);
    },
  ],

  [
    "word-boundary truncation never cuts mid-word",
    () => {
      const long = [
        {
          name: "wide",
          desc: "alpha bravo charlie delta echo foxtrot golf hotel india juliett",
        },
      ];
      const r = run("alpha", { ucks: long });
      const desc = r.out.trim().slice(r.out.indexOf("  ") + 2);
      assert.ok(desc.endsWith("…"), `expected ellipsis, got ${desc}`);
      assert.ok(
        !/[a-z]…$/.test(desc.slice(0, -1)) || /\s[^ ]*…$/.test(desc),
        `mid-word cut: ${desc}`,
      );
    },
  ],

  [
    "usage is DECLARED as .help, not only printed from run()",
    () => {
      // Core intercepts `f search --help` / `-h` / bare `f search` and prints
      // uck.help — but only when the uck declares it (src/cli.ts isBareHelp
      // requires typeof uck.help === "string"). A uck that merely prints usage
      // inside run() silently fails `--help`, because "--help" reaches run() as a
      // query and the uck answers "no uck matched: --help". That looks like a
      // command that works and found nothing, when the caller asked how to use it.
      const uck = register({
        fVersion: "0.0.0",
        self: "search",
        ucks: STORE,
        registry: {},
      });
      assert.equal(
        typeof uck.help,
        "string",
        "must declare .help or core will not intercept --help",
      );
      assert.match(uck.help, /usage: f search <query>/);
    },
  ],

  [
    "a flag is refused, not searched for",
    () => {
      // "--verbose" would otherwise tokenize to "verbose" and be scored as a
      // query, yielding a confident "no uck matched" to someone who asked for
      // options.
      const r = run("--verbose");
      assert.ok(
        !r.out.includes("no uck matched"),
        `flag searched as a term: ${r.out}`,
      );
      assert.match(r.err, /^f: search: unknown flag/);
      assert.equal(r.code, 2, "a bad flag is a usage error, not a miss");
    },
  ],

  [
    "search text is unaffected by the flag guard",
    () => {
      // The guard must not swallow ordinary queries or hyphenated search terms.
      assert.ok(run("credential").out.includes("creds"));
      assert.ok(run("pi-models").out.includes("pi-models"));
    },
  ],

  [
    "results are stable for equal scores",
    () => {
      const a = run("e").out;
      const b = run("e").out;
      assert.equal(a, b);
    },
  ],
];

let pass = 0,
  fail = 0;
for (const [label, fn] of tests) {
  try {
    fn();
    pass++;
    console.log(`ok   ${label}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${label}\n     ${e.message.split("\n")[0]}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
