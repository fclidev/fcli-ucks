# The f ↔ uck contract

**Status: v2 — v1 was implemented in f 0.3.x (core) and the uck buckets (Oct
2026); v2 is G11 (core 0.4.0): register-time ctx no longer carries `ucks`/
`registry`.**
All GAPs G1–G11 are resolved as described below; the GAP register (§9) is kept
as the change history. `credsApi.version: 1` is live (CredsError with `.kind`);
peers in the personal bucket classify structurally with a message fallback for
older creds builds. This document is the diff-able baseline for 1.0.

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
- **N4.** A uck may import **sibling files in its own directory**
  (`./helper.js`) — that is the sanctioned sharing mechanism, and each
  bucket's `lib/` exists for exactly that. Three things are **forbidden**:
  - `../..` — reaching outside your own uck directory. Breaks under bucket
    flattening, and under a local-source copy that omits `lib/` (observed:
    a local copy of this bucket loaded 8/10 ucks and printed
    `Cannot find module '…/lib/uckmain.js'` on **every** command).
  - reaching a **sibling bucket** by store path (`../../<other-bucket>/lib/…`)
    — bucket dir names are derived from source URLs (§1, `sourceBucket`), so
    that is a dependency on a naming scheme, not an API;
  - reaching a sibling bucket via `ctx.registry["other-uck"]` **and then
    importing from its directory**. The registry carries behaviour, never
    paths, and must never become an import-resolution mechanism.

  **Shared code across buckets has exactly two legal homes:**
  1. **copy it into each bucket's `lib/`** — the default for small helpers.
     `lib/uckmain.js` is byte-identical in both installed buckets today; that
     is intentional duplication, not drift; or
  2. **an npm package** declared in each bucket's own uck `package.json`, when
     the code is large enough that duplication is worse than a dep.

  Copying has one consequence a provider author must know: the probe protocol
  runs `node <uck>/index.js …` with `node_modules` resolved **from the uck
  directory**, so a bucket-level `lib/` is unreachable there and an npm import
  only works if installed *under that uck*. A shared helper consumed by a uck
  whose `index.js` doubles as a CLI entry (all providers) must be **copied into
  the uck directory itself**, or the uck must carry its own installed deps —
  see §5 P7.

  *Fixed here:* `providers/index.js` documented the path as
  `lib/uckmain/index.js`; the file is `lib/uckmain.js`. Both now say
  `../lib/uckmain.js`, which is also what `vaultwarden` and `providers`
  actually import.*
- **N5.** `f` installs a uck's declared dependencies (from its
  `package.json`) into the uck's own `node_modules`, and runs the uck **in
  place** — bare specifiers resolve from the uck's directory. A uck is
  therefore portable: same code, same `node_modules`, no global installs.
- **N6.** The uck directory name and the registered uck `name` are *not
  required to match* (the loader keys on the registered name). They should
  match; `f doctor` reports a mismatch (ROADMAP C3 — the loader keys on the
  registered name, so a mismatch is silent today). *(GAP G10, §9.)*

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
  desc: "one line, ≤ 120 ch", // REQUIRED in practice (f help + skill search).
  run: (argv, args, ctx) => …,// REQUIRED. May be sync or async.
  argv?: (rest) => argsObj,   // OPTIONAL. Overrides arg parsing (see §2.3).
  about?: "longer usage",     // OPTIONAL. Multi-line usage for LLMs (see N10, N16).
  skills?: [{ name, path }],  // OPTIONAL. Self-registered skills (see §6.3).
  credentialProvider?: { … }, // OPTIONAL. Credential provider (see §5).
  <any other key>,            // ALLOWED. Peer API surface (see §5/§6).
}
```

- **N9.** `name` must be a non-empty string, unique across the installed
  set. **Duplicates: last-loaded wins, silently.** Load order is
  store-buckets (alphabetical, first-bucket-wins for dir collisions) then
  npm sources in config order, overwriting the map. *(GAP G9: warn on stderr
  when a name is overwritten and by which bucket — the current message,
  `f: uck '<name>' shadowed (store) by a later source`, cannot name the
  winner; see ROADMAP C5.) *
- **N10.** `desc` is consumed by `f help`, `ctx.ucks`, and skill search.
  One line, no newlines. **The cap is 120 characters** — that is what the
  loader clamps with `…`, and what `f uck new` scaffolds. (100 was an earlier
  draft value; `about` carries the multi-line, LLM-audience text that
  `f <uck> --help` prints.)
- **N11.** Unknown keys on the uck object are allowed and are the intended
  mechanism for peer APIs (§5, §6). f itself ignores them.
- **N12.** `minF?: string` — minimum f semver the uck requires. f warns
  (stderr, once) when `fVersion < minF` and still loads the
  uck. This is the last cheap window to add version negotiation.

### 2.2 `run(argv, args, ctx)`

- **N13.** Signature: `run(argv, args, ctx)`.
  - `argv`: the remaining CLI tokens after the uck name, **unmodified**
    (`string[]`).
  - `args`: parsed form, `{ _: string[], …flags }` when no `argv` hook is
    defined (§2.3).
  - `ctx`: the same object as at register time (§3).
- **N14.** `run` may be sync or async. f `await`s the return value.
- **N15. Exit semantics.**
  - `run` returns normally with `undefined` → exit 0.
  - `run` throws → f prints `f: <message>` on stderr, exit 1.
  - A numeric return value is interpreted as `process.exitCode` when
    non-zero; `undefined` means 0. Any other return type is a bug in the uck.
  - **A uck may set `process.exitCode` directly and that is respected.**
    **Prefer `return n` / `process.exitCode = n` over `process.exit(n)`:** the
    harness terminates the unknown-uck and post-throw paths with
    `process.exit(1)`, which discards buffered stdout — so a uck that printed
    a large report and then threw loses the report, and "how much of a secret
    reached stdout" becomes undefined. The *forbidden* pattern stays
    `process.exit(0)` on a failure path — the harness cannot see it. This bug
    has shipped twice in `creds`.
    The rule, once: **failure = throw, or non-zero exit via return. Never a
    quiet return.**
- **N16. Help.** `f <uck> --help` / `-h` / `help` are **not** intercepted by
  the harness; the tokens pass through to `run` and the uck implements its own
  usage text. Every uck that accepts subcommands must treat a bare call (no
  args) and `--help`/`-h`/`help` as usage, printing to **stdout**. **The
  harness intercepts help only when the uck is called with no args, or with
  exactly one of `--help` / `-h` / `help`, and the uck exported `help` or
  `about`** — then it prints `desc` + `help ?? about` to stdout and `run`
  never executes. Every other token passes through untouched, so exporting
  `about` is what makes `f <uck> --help` work without a parser branch.
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

- **N18.** At **register time**: `ctx = { fVersion, contractVersion, self }`.
  - `fVersion`: `string`, the installed f semver.
  - `contractVersion`: `number` — **A2, implemented; G11 bumps it to 2.** The f↔uck
    contract version this core implements (core exports `CONTRACT_VERSION`).
    A uck written against a given ctx must be able to tell a core from a future
    one that drops a key this ctx still carries; `fVersion` cannot answer that,
    being a core release number and not an interface one. It is now the **only**
    pre-run signal, because it is the only pre-run question left: register()
    cannot ask who its peers are.
  - `self`: `string`, the uck's **registered name** (i.e. what `f <self>`
    invokes). For a directory registering multiple ucks this is *wrong* for
    all but the first — *(GAP G10: guarantee one uck per directory, or
    pass the directory path as `self` and add `selfName` for the registered
    name.)*
  - **`ucks` and `registry` are ABSENT at register time (G11, reversed from the
    original G4).** See §3.1 for why absent rather than empty, and §3.2 for the
    migration grep.
- **N19.** At **run time**: `ctx = { fVersion, contractVersion, self, ucks,
  registry }` — a strict **superset** of the register-time ctx. Direction
  matters: register ctx ⊂ run ctx, so anything written against register ctx
  remains valid in `run`, and not vice versa.
  - `ucks`: `[{ name, desc }]` for every registered uck — **the full set**.
    Intended for LLM-facing discovery, cheap to include.
  - `registry`: **plain object** (not a `Map`) of every registered uck object,
    keyed by name. This is the **only** sanctioned way to reach another uck's
    peer API.
  - `ctx` is rebuilt per invocation, so nothing captured from an earlier run
    can go stale.

### 3.1 Why register-time `registry` is absent, not empty (G11)

v1 handed `register()` a *partial* view — "whatever has loaded so far" — with
N20a as the rulebook ("feature detection only"). That rule existed to protect
uck authors from a property of the loader that the rule could not actually fix.

The partial view is not keyed on a stable order. In `loadStoreUcks` the pass
accumulates, but npm sources are merged by the **caller afterwards**:

```js
// store buckets: accumulating — visibility depends on bucket name order
const loaded = await loadUckModule(indexPath, name, fVersion, origin, snapshot(results));
results.push(...loaded);

// npm sources: merged on top by the caller
//   → a store uck can NEVER see an npm uck at register time
//   → an npm uck ALWAYS sees the entire store
```

So `"creds" in ctx.registry` did not merely depend on order; it depended on
**which kind of source the peer came from**, in one direction only. Rename a
bucket and alphabetical order flips. There is no correct uck to write against
that, which is the definition of a race condition rather than an interface.

Three candidate fixes, and why only the third holds:

| register-time `registry` | `ctx.registry.x = y` (mutation) | `"creds" in ctx.registry` | state space |
|---|---|---|---|
| partial view (v1) | silently discarded — the snapshot is thrown away and rebuilt per uck | order-dependent, **can be false for a peer that is installed** | 3, indistinguishable |
| `Object.freeze({})` | throws ✓ | present but **always false** ✗ | 2 |
| **absent (v2)** | throws ✓ | **throws** ✓ | 1 |

The freeze row is the trap. It looks like it keeps the documented idiom alive
while removing the race, and it does something worse: it converts a sometimes
answer into a **guaranteed-wrong** answer. Every uck that obeyed N20a and wrote
`"creds" in ctx.registry` would get `false`, fall through to the §6.1 C3 socket
fallback, and report `no-store` — which reads to an operator as *no credential
configured*. That is precisely the failure N20 refuses for `ctx.uck`: *"A
half-migrated uck is worse than an unmigrated one."*

Absent is the same argument N20 already made about `ctx.uck`, applied to its
conclusion: **deleting the key fails loud rather than degrading silently.**
`ctx.registry.creds` → `TypeError: Cannot read properties of undefined`; the
`in` operator throws on a primitive. Both surface at load, in the uck's own
`register()`, next to the line that caused it. It also buys the one distinction
the partial view could never make — *absent* vs *present-but-empty* — by
removing the empty case.

This is a **contract-level** change, not an implementation detail: it changes
the meaning of an existing ctx field for code already written, which is exactly
`CONTRACT_VERSION`'s stated bump rule. Hence **v2**, not a quiet patch.

### 3.2 Migration (one grep per bucket)

```bash
grep -rn "ctx\.registry\|ctx\.ucks" --include=*.js . | grep -v node_modules
# then check: is each hit lexically inside run(...)? If not, it must move.
```

Peer work in `register()` cannot be preserved, and should not be: a provider is
spawned as a child (§5 P4/P5) and must re-derive everything anyway, so
register-time `registry` was never a real peer channel. Measured adoption on
the two installed buckets plus the core example: **zero register-time readers**
— 7 peer sites (`fj`, `grocy`, `ha`, `ha-ws`, `skills`, `search`, `gh`) are all
inside `run`, and the only trace of the partial view in any uck is a *warning
comment about it* (core's own `examples/df-ext/index.js`). A change with this
little traction is cheap now and expensive after 1.0.
- **N20. `ctx.registry` is the one peer accessor. `ctx.uck(name)` is deleted —
  no deprecation cycle.** *(A1, implemented: the key is absent from both ctx
  objects, so a uck still calling it fails loud rather than degrading to a
  socket fallback.)* `uck()` shipped in 0.3.0 as sugar over
  `registry[name]` (a closure over the same map, so both returned
  **identical object identities**). Adoption decided this: of six in-tree peer
  accesses, **five already used `registry`** (`skills`, `fj`, `ha`, `ha-ws`,
  `ssh`) and exactly one used `uck()` (`gh`). The superset won on its own, and
  it strictly dominates:
  - `registry[name]` subsumes `uck(name)`; "filter `uck()` instead" is not
    isolation, since peer objects are unsandboxed and a proxy hides key names,
    not powers;
  - load order is contract-relevant (N9 shadowing/last-wins; §6.3 skill
    merging spans every uck) and only the map answers "what did I shadow?".

  *(N20's third original argument — "`registry` is the only one that can exist
  at register time (N20a)" — was overtaken by G11: `registry` no longer exists
  at register time either. It argued `registry` vs `uck()`, and `registry` still
  wins that contest on the two grounds above; it simply no longer wins it by
  being available earlier.)*

  Pre-1.0 breaking changes need no migration handling, and the failure mode is
  loud anyway: `ctx.uck("creds")` → `f: ctx.uck is not a function`.

  #### Migration (one call site, in-tree)

  ```diff
  - const credsApi = ctx?.uck?.("creds")?.credsApi ?? null;
  + const credsApi = ctx?.registry?.creds?.credsApi ?? null;
  ```

  **`?.` guards the call, not the result.** A uck left reading
  `ctx.uck?.("creds")` does *not* fail loudly: it yields `undefined`, degrades
  to the §6.1 C3 socket fallback, and reports `no-store` — which reads to a
  user as "no credential configured". **A half-migrated uck is worse than an
  unmigrated one.** Audit any bucket before bumping:
  `grep -rn "\.uck(" --include=*.js . | grep -v node_modules`
- **N20a.** `registry` is **read-only by convention** — do not mutate it, add
  keys, or delete a peer; registration happens only via `register()`. Nothing
  enforces this in 0.x; mutation is unsupported.

  `registry` exists at **run time only** (G11). The register-time ctx does not
  carry the key, so there is no partial view, no feature-detection caveat, and
  nothing to get wrong before `run` — N20a's "use it there for feature detection
  only" rule is **retired**: the question it regulated can no longer be asked.
- **N20b.** `ctx` and everything reachable from it must be
  **structured-cloneable** — no sockets, child processes, open fds, or class
  instances with private fields hung off it. Providers are spawned as children
  (§5 P4/P5), so anything a provider needs must survive that boundary. The
  rule applies to `ctx`'s **fields**.
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
- **P6.** The provider interface carries a **version tag**
  (`providerVersion?: 1`) and the caller (creds) **feature-detects** it rather
  than string-matching. Untagged = pre-v1: it may throw untyped errors, so the
  caller keeps its message-matching fallback. See §7.
  *Not yet implemented in either bucket — `providerVersion` appears in zero
  files today, which is why `creds` still carries the `/locked/i` fallback.*
- **P7.** **A provider may not share code with another bucket** (N4), and the
  probe transport makes this concrete: `node <uck>/index.js …` resolves
  `node_modules` **from the uck directory**, so a bucket-level `lib/` import
  works when f imports the module in-process and **breaks when the same module
  is spawned as a probe child**. Providers must copy helpers into their own
  directory, or declare deps in their own `package.json`.
- **P8.** `hasExternalApi` (was: `false` = excluded from discovery) is
  **removed** — pre-1.0 breaking change, no shim. Presence of
  `credentialProvider.name` **is** discovery; there is no opt-out, and if a
  uck should not be probed it should not carry `credentialProvider`. Sites to
  delete: `providers/index.js` (`hasExternalApi: true`),
  `creds/providers.js` (the `!== false` filter), `vaultwarden/index.js`
  (the `--dump` row).

## 6. Peer APIs (informal, registry-based)

Anything beyond §5. A uck may expose any data or functions on its registered
object; peers read them via `ctx.registry` (N20 — the sole accessor).
Two exist today:

### 6.1 `creds` → `credsApi`

```js
creds.credsApi = {
  version?: 1,                  // §7.2: gates whether `kind` is guaranteed
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
  That is string coupling to another uck's wording. Branch on structure
  instead — `err.kind`, vocabulary in §7.2. **`kind` is the contract; the
  `CredsError` class is not** (§7.3): never `instanceof` it from another uck,
  and never import it from a sibling bucket (that would also violate N4).
- **C3.** A peer that can't get `credsApi` (registry absent, or the uck
  not installed) must fall back to reading the creds **socket directly** or
  report locked/missing in its own status output.
- **C4. The creds socket protocol** (`~/.f/.creds.sock`, one JSON object per
  request, one JSON reply). Ops: `get` (value, or base64 with `b64: true`),
  `set` (value, optional `expiresAt` for mirrors), `has`, `ls`, `meta`, `rm`.
  Replies: `{ ok: true, value? }` or `{ ok: false, error }`. The lockfile is
  `~/.f/.creds-daemon` (`{ pid, start, ttl, socket }`); peers read it directly
  for a non-blocking locked/unlocked check. Shared helpers: `fcli-ucks/lib/creds-error.js`
  (`classifyCredsError`) and the personal bucket's `lib/credsresolve.js`
  (`resolveCred`). Both are **duplicated per bucket by design** (N4/P7), and
  both must translate into the §7.2 vocabulary — their private reason codes are
  implementation detail, not interface (see the retired-vocabulary table).

### 6.2 `uck` → `uckApi` (informative — not yet a stable surface)

`{ loadTargets, saveTargets, push, bucketUcks }` — the push-side twin of §1/§4.
Two properties to know before depending on them:

- **Target name = bucket name = store directory.** `push` reads
  `~/.f/ucks/<bucket>/` and the target's `name` selects the work clone at
  `~/.f/uck-work/<name>/`. A mismatch does not error — it pushes the wrong
  directory, or nothing.
- **`f uck new`'s default bucket** is the first `f.repo.json` `targets` entry
  whose store dir is a git clone. With more than one target that is an ordering
  accident; pass `--bucket` whenever it matters.

Push semantics (rebase by default, conflict ⇒ abort and report, `--no-rebase`
for store-wins) stay in the `uck` uck's own README.

### 6.3 Skills — uck-registered

A uck object may carry `skills: [{ name, path }]`. The `skills` uck merges
those with `f.config.json` `skills` entries (config wins on name collision).
`path` must be an absolute path to a local `.md` file, conventionally
`SKILL.md` in the uck's own directory. Skill files use the standard
frontmatter `name:`/`description:`. **S1.** A uck registering a skill should
also document it in its `desc` or `about`, because `f help` is the primary
discovery surface.

**S2. `skills[].path` is the one field on a uck object that must be an
absolute path**, and it is always built from the uck's own location:

```js
const here = path.dirname(fileURLToPath(import.meta.url));
skills: [{ name: "f-myuck", path: path.join(here, "SKILL.md") }]
```

Deliberately **not** `ctx.self` — `self` is the *registered name*, not a
filesystem path, and using it would break the moment dir and registered name
 diverge (N6).

Why it is absolute: this is the same expression the `uckMain` guard uses
(`isMain` compares `pathToFileURL(realpathSync(argv[1])).href` to
`import.meta.url`), so **one `here` constant serves both the skill path and
the probe entry point** — and it stays correct under the two layouts that
break naive paths: the git-bucket layout (`<bucket>/<uck>/`) and the
local-source layout, which flattens to `<bucket>/` (N4, §7.3). A relative
`path` would be resolved against the *reader's* cwd, and the skills uck reads
these from a different process than the one that registered them.

## 7. Error contract

### 7.1 The rules

- Ucks throw to signal failure (N15); the harness prints + exits 1.
- Peer-to-peer: **no string matching on another uck's error messages.**
  Structured results or typed errors only (§6.1 C2, §5 P6).
- Every uck that can fail on an external system (network, daemon, lock)
  should expose a `status`-style subcommand reporting *why*, so the failure is
  diagnosable without re-running the failing call (creds, ha, fj, gh all do;
  a stated convention).

### 7.2 `CredsKind` is the wire vocabulary (normative)

```ts
type CredsKind =
  | "locked"    // store locked → `f creds unlock`. NOT the same as missing.
  | "missing"   // unlocked; no local value and no provider hit
  | "provider"  // a provider was reached and failed (`.provider` names it)
  | "no-store"  // creds uck absent/unreachable; even the socket read failed
  | "timeout";  // a bounded wait elapsed (credsApi.wait)
```

A consumer must handle all five. **`locked` and `missing` are different
failures with different fixes** and must never collapse into one branch (C1).
`version` / `providerVersion` gate the *guarantee*: below v1 kinds are
best-effort (caller keeps message matching), at/above v1 they are thrown and
total.

**Retired vocabulary.** Three incompatible mappings were built over the same
underlying states; they are **not** interface. A helper may use one internally
and must translate at its boundary; callers must not spread the alias:

| retired | where it came from | now |
|---|---|---|
| `unset` | `credsresolve.js` reason | `missing` |
| `wait-timeout` | `credsresolve.js` reason | `timeout` |
| `no-names` | `credsresolve.js` reason | caller bug — built no names, make no call |
| `error` | `classifyCredsError` bucket | `provider` / `no-store` / `other` |
| `""` (empty reason) | `credsresolve.js` | success, or `missing` |

`"other"` stays legitimate **only** for a uck's own internal catch-all. A
credential failure reported *to a user* must name one of the five kinds with
its fix; "something went wrong: other" is not a diagnosis.

### 7.3 `CredsError` the class is not the contract

The throw site already upholds this and should keep doing so: `lookupCred`
catches and re-throws a plain `{kind, message, provider}` without importing the
class, and `credsApi.get` re-throws the original `kind` rather than
reconstructing. Good shape — because the class has a **module-identity hazard**:

`CredsError` lives in `creds/index.js`, reachable two ways — the harness's
`file://` URL, and a hand-written relative path. **A local source flattens
`<bucket>/<uck>` to `<bucket>`**, turning `../creds/index.js` into `./index.js`.
So the two specifiers disagree whenever a bucket is a copy rather than a clone,
Node loads a second module instance with a second class identity, and
`instanceof` returns false for a genuine `CredsError`.

- **Depend on `err.kind` (a string). Not `instanceof`, not `err.name`, not
  message text.**
- Importing from a sibling bucket is an N4 violation anyway — which is the fix,
  not a workaround.
- The one sanctioned `instanceof CredsError` is **inside the `creds` uck**, on
  its own class in its own module (`toCredsError`), where the specifier cannot
  disagree with itself.

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

| # | Status | Original change | Where | Effort | Blocks 1.0? |
|---|--------|-------|--------|-------------|
| G1 | ⌛ done in 0.3.0 | `ctx.fVersion` is the negotiation point; add uck `minF`, warn on mismatch | core | S | yes |
| G2 | ⌛ done in 0.3.0 | Enforce `desc` one-line + length cap in loader; add `about` for multi-line usage | core | S | yes |
| G3 | ⌛ done in 0.3.0 | Exit semantics: rule "failure = throw or non-zero `process.exitCode`"; loader rejects non-`undefined` returns (or maps to exitCode); document the `process.exit(0)`-on-failure ban | core | S | yes |
| G4 | ⌛ done in 0.3.x, **then superseded by G11** | One `ctx` shape everywhere. `registry` is the sole peer accessor; `uck()` deleted outright, no deprecation cycle (5 of 6 in-tree sites already used `registry`). The "same keys at register time" half of this is reversed by G11 — see N18/N20 | core | S | yes (1.0) |
| G11 | ⌛ done — core drops `ucks`/`registry` from register ctx, `CONTRACT_VERSION` → 2 | **Reverse G4's register-time half.** Register ctx = `{fVersion, contractVersion, self}`; run ctx unchanged. The v1 partial view was keyed on load order *and source kind* (npm merges after the store pass), so no uck could depend on it correctly. Empty-object is not a substitute: it makes the documented `"creds" in ctx.registry` idiom guaranteed-false and degrades to a `no-store` that reads as "not configured" — the N20 footgun, promoted from race to law. Absent fails loud instead. Retires N20a. Migration = the §3.2 grep (0 in-tree register-time readers). Bumps the contract version, per its own bump rule | core + buckets | S | yes (1.0) |
| G5 | ⌛ done — CredsError + credsApi.version=1 in creds; peers classify structurally (msg fallback kept) | Typed `CredsError` + `credsApi.version` + `providerVersion`; replace the `/locked/i` regex sites in ssh/gh/ha/fj; document the creds socket protocol in this doc | creds + 4 ucks | M | yes |
| G6 | ⌛ done in 0.3.0 (registry always shipped) | Published f must ship `registry` in run ctx; until then peers degrade gracefully (stated rule, §4) | core | S | yes |
| G7 | ⌛ done — package.json standardized, `f uck new` scaffolds, uckmain copied per bucket, doc path fixed | Standardize `package.json` (`{"name","type":"module"}`); scaffold via `f uck new`; kill cross-bucket imports (ship `uckmain` per bucket or as npm pkg) | tooling + buckets | S | no |
| G8 | ⌛ done in 0.3.0 (bare-help only; fall-through when no help/about export) | Harness intercepts `--help`/`-h`/`help`: prints `desc` + `about` + uck `help` export if present; ucks may still override | core | S | no |
| G9 | ⌛ done in 0.3.0 | Warn on stderr on `name` collision (which bucket won) | core | XS | no |
| G10 | ⌛ done in 0.3.0 | One uck per directory (loader error on multi-register), or fix `self` semantics (dir path + `selfName`) | core + tooling | S | no |

**Implemented cut (Oct 2026):** core 0.3.0 ships G1/G2/G3/G6/G8/G9/G10;
creds ships G5 (CredsError, `credsApi.version: 1`); the uck buckets ship G7.

**Remaining for 1.0:** the ctx work is now closed in both halves. **G4** —
`ctx.uck` deleted, `registry` the sole run-time accessor (done in 0.3.x).
**G11** — register ctx reduced to `{fVersion, contractVersion, self}`, which
reverses G4's "same keys at register time" half and retires N20a. Both landed
without a deprecation cycle, since pre-1.0 breaking changes need no migration
handling; G11 is the reason `CONTRACT_VERSION` is 2 and why a core minor
(0.4.0) is not optional — a uck cannot tell a v1 and a v2 core any other way.
`registry` itself never goes away; only its register-time appearance did.
Un-numbered harness/doc work: `ROADMAP-1.0.md`.

**Original suggested cut:** G1+G2+G3+G6+G9 as one core **minor** (0.3, additive);
G5 as creds **minor** (back-compat: old message matching still works until
peers migrate); G4+G8+G10 as **1.0** (breaking: ctx shape, help
interception, one-uck-per-dir). G7 anytime.

## 10. What stays

- `register`/`run` as the only two required surface points.
- **`run` as the only place a uck can see another uck** (G11). If peer discovery
  ever needs to move earlier, that is a new contract version and a new argument,
  not a reinstated partial view.
- The three-outcome `resolve` (hit / not-mine / throw) — it is the best part
  of the ecosystem and should not be touched.
- Bag-of-dirs buckets, in-place execution, uck-local `node_modules`.
- Terse-output style as convention, not contract.
- `f.config.json` as the only config file; ucks read it themselves.
