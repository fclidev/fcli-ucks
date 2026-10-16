# The f ↔ uck contract

**Status: PROPOSED v1 — pinning the current behavior of f 0.2.5.**
Sections marked **PROPOSED** are normative going forward; sections marked
**GAP** describe behavior that exists today but should change, with the change
numbered (G1…G9) and the migration sketch given. This document is the diff-able
baseline: read it top to bottom, resolve every GAP, and the contract is solid.

What is **not** a contract and should stay out of it:

- Output formatting (terse, one fact per line) is a *style* goal, not a contract.
  Ucks may print whatever; nothing downstream parses uck output except the
  explicit peer APIs below.
- No lifecycle hooks, no typed argv schemas, no plugin tiers. The surface is
  intentionally small: one entry function, one dispatch function, two peer
  interfaces.

---

## 1. Packaging

A **bucket** is a git repo (or npm package, or local dir) whose top level is a
bag of **uck directories**. A uck is one subdirectory:

```
bucket/
  myuck/
    index.js          # required — the uck's module
    package.json      # required — {"type":"module"} at minimum
    <anything else>   # helpers, data, SKILL.md, test/ …
    node_modules/     # deps installed by f on install; never committed
```

- **N1.** `index.js` is the only file f looks at. All other files are the
  uck's business and must be imported by `index.js`.
- **N2.** `index.js` is an ES module. The uck's `package.json` must set
  `"type": "module"`. *(GAP G7: today some ucks omit `package.json` entirely or
  set inconsistent `name`/`version` fields; standardize on exactly
  `{"name": "<bucket>-<uck>", "type": "module"}` and scaffold it.)*
- **N3.** Module scope must be **side-effect free**. `index.js` is imported at
  `f` startup for *every* installed uck, for *every* command, including
  commands that never touch that uck. No network, no file writes, no prompts,
  no daemons at import time. All work happens in `register()`-return values
  that are *called* later, or in `run()`.
- **N4.** A uck may import sibling files in its own directory. Cross-bucket
  imports are forbidden (today `vaultwarden` imports
  `../../fcli-ucks/lib/uckmain.js` — *GAP G7: this breaks the moment the two
  buckets land in different store layouts; ship `uckmain` per bucket or in a
  shared npm package*). Note `providers/index.js` documents the path as
  `lib/uckmain/index.js` while the file is `lib/uckmain.js` — docs and code
  already disagree; G7 should fix the path too.
- **N5.** `f` installs a uck's declared dependencies (from its
  `package.json`) into the uck's own `node_modules`, and runs the uck **in
  place** — bare specifiers resolve from the uck's directory. A uck is
  therefore portable: same code, same `node_modules`, no global installs.
- **N6.** The uck directory name and the registered uck `name` are *not
  required to match* (the loader keys on the registered name). They should
  match; `f uck` tooling enforces it. *(GAP G10: see §4 P10.)*

## 2. The uck module — `register(ctx)`

`index.js` must export `register` — either as a named export or as
`default.register`. Anything else in the module is ignored by f except the
peer interfaces in §5–§6.

```js
export function register(ctx) { return oneUck; }          // or
export function register(ctx) { return [uckA, uckB]; }    // or
export default { register };                              // f uses mod.default ?? mod
```

- **N7.** `register` is synchronous and must not throw. If it does, f prints
  one error line and the whole uck is dropped (all its ucks silently absent
  from `f help`).
- **N8.** `register` receives `ctx` (shape in §3) and returns one uck object
  or an array.

### 2.1 The uck object

```js
{
  name: "myuck",              // REQUIRED. string. The dispatch key: `f myuck …`.
  desc: "one line, ≤ 100 ch", // REQUIRED in practice (f help + skill search).
  run: (argv, args, ctx) => …,// REQUIRED. May be sync or async.
  argv?: (rest) => argsObj,   // OPTIONAL. Overrides arg parsing (see §2.3).
  about?: "longer usage",     // GAP G2 (new field).
  skills?: [{ name, path }],  // OPTIONAL. Self-registered skills (see §6.3).
  credentialProvider?: { … }, // OPTIONAL. Credential provider (see §5).
  <any other key>,            // ALLOWED. Peer API surface (see §5/§6).
}
```

- **N9.** `name` must be a non-empty string, unique across the installed
  set. **Duplicates: last-loaded wins, silently.** Load order is
  store-buckets (alphabetical, first-bucket-wins for dir collisions) then
  npm sources in config order, overwriting the map. *(GAP G9: warn on stderr
  when a name is overwritten and by which bucket.)*
- **N10.** `desc` is consumed by `f help`, `ctx.ucks`, and skill search.
  One line, no newlines. *(GAP G2: enforce length cap in the loader —
  truncate with `…` — and add `about` for the multi-line, LLM-audience text
  that `f <uck> --help` should print.)*
- **N11.** Unknown keys on the uck object are allowed and are the intended
  mechanism for peer APIs (§5, §6). f itself ignores them.
- **N12.** *(GAP G1: new field)* `minF?: string` — minimum f semver the uck
  requires. f warns (stderr, once) when `fVersion < minF` and still loads the
  uck. This is the last cheap window to add version negotiation.

### 2.2 `run(argv, args, ctx)`

- **N13.** Signature: `run(argv, args, ctx)`.
  - `argv`: the remaining CLI tokens after the uck name, **unmodified**
    (`string[]`).
  - `args`: parsed form, `{ _: string[], …flags }` when no `argv` hook is
    defined (§2.3).
  - `ctx`: the same object as at register time, plus `registry` (§3).
- **N14.** `run` may be sync or async. f `await`s the return value.
- **N15. Exit semantics.**
  - `run` returns normally with `undefined` → exit 0.
  - `run` throws → f prints `f: <message>` on stderr, exit 1.
  - A numeric return value is **ignored** by the harness. *(GAP G3: make the
    loader reject non-`undefined` returns in a dev build, or interpret
    non-zero numbers as `process.exitCode`. Either way, document one rule.)*
  - **A uck may set `process.exitCode` directly and that is respected.** A uck
    calling `process.exit(n)` also works but bypasses the harness error
    handler. The *forbidden* pattern is `process.exit(0)` on a failure path —
    the harness cannot see it. *(GAP G3: this exact bug has shipped twice in
    `creds`; the rule "failure = throw or non-zero `process.exitCode`, never
    a quiet return" must be in the contract and the scaffolder.)*
- **N16. Help.** `f <uck> --help` / `-h` / `help` are **not** intercepted by
  the harness; the tokens pass through to `run` and the uck implements its own
  usage text. Every uck that accepts subcommands must treat a bare call (no
  args) and `--help`/`-h`/`help` as usage, printing to **stdout**. *(GAP G8:
  consider harness-side interception that prints `desc` + `about` + an
  optional uck-exported `help` string, so ucks stop re-implementing it.)*
- **N17. Stdout is the answer; stderr is diagnostics.** Errors go to stderr
  (the harness's own error lines do too). Secrets must never be printed
  without an explicit flag (the `--secrets` convention in `creds`).

### 2.3 The `argv` hook (optional)

If the uck object defines `argv: (rest) => argsObj`, f calls it with the raw
remaining tokens and uses the returned object as `args` instead of the
default `{ _: rest }`. This is how a uck declares its own flag parsing to
`run`. *(GAP: document this — it exists in the harness
(`uck.argv?.(rest) ?? { _: rest }`) but is used nowhere in the current ucks
and is therefore at risk of drifting.)*

## 3. `ctx`

- **N18.** At **register time**: `ctx = { fVersion, self }`.
  - `fVersion`: `string`, the installed f semver.
  - `self`: `string`, the uck's **registered name** (i.e. what `f <self>`
    invokes). For a directory registering multiple ucks this is *wrong* for
    all but the first — *(GAP G10: guarantee one uck per directory, or
    pass the directory path as `self` and add `selfName` for the registered
    name.)*
- **N19.** At **run time**: `ctx = { fVersion, self, ucks, registry }`.
  - `ucks`: `[{ name, desc }]` for every registered uck — the same data
    `f help` prints. Intended for LLM-facing discovery, cheap to include.
  - `registry`: `Map<string, uckObject>` — every registered uck object,
    keyed by name. This is the **only** sanctioned way to reach another uck's
    peer API.
- **N20. (GAP G4: new)** The two ctx shapes should be **one** shape.
  Register-time will gain `ucks`/`registry` (available, since all ucks are
  registered before any is dispatched), and a helper
  `ctx.uck(name) → uckObject | undefined` replaces direct
  `ctx.registry.creds.credsApi` duck-typing. `registry` remains as a
  read-only property through 0.x, removed at 1.0.
- **N21.** `ctx` is **not** an environment. Ucks that need config read
  `f.config.json` themselves (project, walking up ≤6–8 dirs, then
  `~/.f/f.config.json`) — the convention is a JSON object with a top-level
  key per uck (`"gh": { … }`, `"fj": { … }`). f does not pass config to ucks.
  *(GAP: document the project-walk depth — `config` uses 6, `gh` uses 8;
  unify.)*

## 4. Dispatch (what f does, for completeness)

1. Resolve uck sources from `~/.f/f.config.json` (`"ucks"` array; each entry a
   string — git URL / npm specifier / local path — or
   `{ source, name?, ref? }`). Project `f.config.json` adds sources.
2. Install/update into `~/.f/ucks/<bucket>/` (git clone or npm). A bucket is
   any directory under the store; a uck is any subdirectory with an
   `index.js`.
3. `import()` every uck's `index.js`, call `register(ctx)`, collect ucks into
   a name→object map (last wins, N9).
4. Look up the first CLI token in the map; unknown → stderr + exit 1.
5. Call `run(rest, args, ctx)` (N13–N16).

**GAP G6** — the *published* harness (0.2.5) passes a run-time ctx **without**
`registry`; a locally patched one passes it. Every uck that needs a peer API
therefore writes defensive fallback code (ssh reads the creds socket directly;
gh/ha/fj null-check `ctx.registry`). Until the published f ships `registry`,
the contract is: **peer APIs are best-effort; a uck must degrade gracefully
when its peer is absent** (this is what "silently miss their creds" means in
ssh's comments — it must stay a *graceful* miss, and ideally one surfaced in
`status`-style output rather than silence).

## 5. Peer interface: credential providers

The only *formal* peer contract. Defined here, mirrored in
`creds/README.md` (that file is the operational doc; this section is the
normative one).

A provider is a uck object that additionally carries `credentialProvider`:

```js
{
  name: "vaultwarden",             // REQUIRED. string. Short id; appears in
                                   //   provenance + status output.
  resolve: (name) => value,        // REQUIRED. The only required method.
  has?: (name) => boolean,         // OPTIONAL pre-filter — see the trap below.
  status?: () => readiness,        // OPTIONAL. { ready, note?, hint? }.
  mirrorTtlSec?: number,           // OPTIONAL. Floor on mirror freshness.
  hasExternalApi?: boolean,        // OPTIONAL. false = excluded from discovery.
  blurb?: string,                  // DOCUMENTED-ONLY. Read by nothing.
}
```

- **P1. `resolve(name)` has exactly three outcomes:**
  - returns a value (`string`/`Buffer`) → **hit** (mirrored as
    `mirror:<name>` under the TTL);
  - returns `null`/`undefined`/`""` → **not mine** (next provider);
  - **throws** → **availability failure** (surfaced verbatim, non-zero exit).
  Returning `null` for a failure is the cardinal sin: it reads as "no such
  credential" to the user.
- **P2. `has(name)` is a trap.** If it answers false, `resolve` is never
  called and the answer is cached. Implement it only if it can answer
  **offline**. Not implementing it is always safe.
- **P3. `status()`** reports readiness for `f creds status` / `f providers`.
  Be honest: a provider that claims `ready: true` and throws on every
  `resolve` is worse than one that says what is missing.
- **P4. Discovery** is by importing every installed uck and reading its
  `credentialProvider` export (in-process) — plus, for providers whose
  `index.js` is also a CLI entry, a **child-process probe protocol**:
  `node <dir>/index.js resolve <name> | has <name> | status`, wired via
  `uckMain(import.meta.url, main)`. `f providers --dump` is the
  machine-readable output of discovery; `f creds` consumes it.
  *(GAP G6-adjacent: today a broken probe wiring fails silently on first miss.
  Extend `f providers --dump` to self-test the probe subcommands and report
  providers as `invalid` with the reason.)*
- **P5. Provider environment rules:** module scope side-effect free (N3);
  never prompt (throw instead); pass `F_CREDS_NO_PROVIDER=1` through when
  shelling out to `f` (recursion guard); never put secrets in `argv` (providers
  are spawned as children).
- **P6. (GAP G5: new)** The provider interface needs a **version tag**
  (`providerVersion?: 1`) and the caller (creds) should feature-detect rather
  than string-match. See §7.

## 6. Peer APIs (informal, registry-based)

Anything beyond §5. A uck may expose any data or functions on its registered
object; peers read them via `ctx.registry` (G4: `ctx.uck(name)`). Two exist
today:

### 6.1 `creds` → `credsApi`

```js
creds.credsApi = {
  version?: 1,                  // GAP G5 (new)
  get(name, ttl?),              // → value; throws CredsError (G5) or Error
  set(name, value),
  ls(),                         // → [names]
  wait(name, opts?),            // block up to timeout (default 5 min)
  // … plus request/waiters helpers
}
```

- **C1.** `get` runs the full provider ladder (local box, then providers,
  mirroring). While locked it throws — callers must treat *locked* and
  *missing* as **different** failures.
- **C2. (GAP G5 — the worst coupling in the tree today)** Peers currently
  distinguish locked/missing by **regexing the error message**
  (`/locked/i.test(msg)`, `/no such cred/i.test(msg)`) in ssh, gh, ha, fj.
  That is string coupling to another uck's wording. Replace with a typed
  error: `class CredsError extends Error { kind: "locked"|"missing"|"provider"|"other"; provider?: string }`,
  and let callers branch on `err.kind`. Message text stays free to change.
- **C3.** A peer that can't get `credsApi` (G6: registry absent, or the uck
  not installed) must fall back to reading the creds **socket directly**
  (path: `~/.f/.creds.sock`, JSON-line protocol) or report locked/missing in
  its own status output. The socket protocol is *de facto* part of the
  contract — **GAP G5: document it here** (ops: `get`/`set`/`has`/`ls`/`meta`/
  `rm`, value as base64, `b64: true` flag, `expiresAt` for mirrors).

### 6.2 `uck` → `uckApi`

`{ loadTargets, saveTargets, push, bucketUcks }` — push-store targets.
Internal to the default bucket; document in the uck uck, not here.

### 6.3 Skills — uck-registered

A uck object may carry `skills: [{ name, path }]`. The `skills` uck merges
those with `f.config.json` `skills` entries (config wins on name collision).
`path` must be an absolute path to a local `.md` file, conventionally
`SKILL.md` in the uck's own directory. Skill files use the standard
frontmatter `name:`/`description:`. **S1.** A uck registering a skill should
also document it in its `desc` or `about`, because `f help` is the primary
discovery surface.

## 7. Error contract (GAP G5 summary)

- Ucks throw to signal failure (N15); the harness prints + exits 1.
- Peer-to-peer: **no string matching on another uck's error messages.**
  Structured results or typed errors only (§6.1 C2, §5 P6).
- Every uck that can fail on an external system (network, daemon, lock)
  should expose a `status`-style subcommand reporting *why*, so the failure
  is diagnosable without re-running the failing call (creds, ha, fj, gh all
  do; make it a stated convention).

## 8. Conventions (non-normative, but stated)

- **Creds naming:** hosts are the convention (`github.com`,
  `forgejo.kensand.net`); `mirror:` and `file:` are reserved in the box;
  `ssh.key.<host>` / `<host>-token` patterns are per-uck.
- **Config keys:** one top-level key per uck in `f.config.json`.
- **SKILL.md:** one per uck that an LLM will invoke non-trivially; frontmatter
  `name: f-<uck>`, `description` states when to use it.
- **Terse output:** one fact per line; no color, no spinners, no tables that
  wrap. Errors: `f <uck>: <one line>` prefix convention.
- **Secrets:** never in argv (visible in `ps`), never in stdout without an
  explicit `--secrets`-style flag, piped via stdin for writes
  (`echo SECRET | f creds set name`).

## 9. GAP register — the change list, ordered

| # | Change | Where | Effort | Blocks 1.0? |
|---|--------|-------|--------|-------------|
| G1 | `ctx.fVersion` is the negotiation point; add uck `minF`, warn on mismatch | core | S | yes |
| G2 | Enforce `desc` one-line + length cap in loader; add `about` for multi-line usage | core | S | yes |
| G3 | Exit semantics: rule "failure = throw or non-zero `process.exitCode`"; loader rejects non-`undefined` returns (or maps to exitCode); document the `process.exit(0)`-on-failure ban | core | S | yes |
| G4 | One `ctx` shape at register + run; add `ctx.uck(name)`; keep `registry` through 0.x, drop at 1.0 | core + all ucks | M | yes (1.0) |
| G5 | Typed `CredsError` + `credsApi.version` + `providerVersion`; replace the `/locked/i` regex sites in ssh/gh/ha/fj; document the creds socket protocol in this doc | creds + 4 ucks | M | yes |
| G6 | Published f must ship `registry` in run ctx; until then peers degrade gracefully (stated rule, §4) | core | S | yes |
| G7 | Standardize `package.json` (`{"name","type":"module"}`); scaffold via `f uck new`; kill cross-bucket imports (ship `uckmain` per bucket or as npm pkg) | tooling + buckets | S | no |
| G8 | Harness intercepts `--help`/`-h`/`help`: prints `desc` + `about` + uck `help` export if present; ucks may still override | core | S | no |
| G9 | Warn on stderr on `name` collision (which bucket won) | core | XS | no |
| G10 | One uck per directory (loader error on multi-register), or fix `self` semantics (dir path + `selfName`) | core + tooling | S | no |

**Suggested cut:** G1+G2+G3+G6+G9 as one core **minor** (0.3, additive);
G5 as creds **minor** (back-compat: old message matching still works until
peers migrate); G4+G8+G10 as **1.0** (breaking: ctx shape, help
interception, one-uck-per-dir). G7 anytime.

## 10. What stays

- `register`/`run` as the only two required surface points.
- The three-outcome `resolve` (hit / not-mine / throw) — it is the best part
  of the ecosystem and should not be touched.
- Bag-of-dirs buckets, in-place execution, uck-local `node_modules`.
- Terse-output style as convention, not contract.
- `f.config.json` as the only config file; ucks read it themselves.
