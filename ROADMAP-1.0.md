# f ↔ uck interface: pre-1.0 change list

Not the contract. This is the work list: the items from CONTRACT.md §9 still
open (A2 `contractVersion`, A4 cloneable `ctx`), the harness/doc items that
never had a GAP number (C1–C6, D), and the decisions taken at this cut
(A1 reversed, B1–B5) with where they landed.

**Rule assumed throughout: pre-1.0 breaking changes need no migration
handling.** Several items were simplified by it — no deprecation cycles, no
dual-name periods, no fallback shims. Anything that only affects the **core**
is marked **needs core**, because it cannot ship from a bucket.

Verified against: core `@fcli.dev/f@0.3.0` (`dist/index.js`, 847 lines),
`fcli-ucks` @ `ded6cf4`, `kensand-fcli-ucks` @ `2e21609`.

Line refs are to the **bundled** `dist/index.js` in the published tarball
(no `src/` shipped), which is where they're actually readable.

## Where each item landed

| item | outcome | landed in |
|---|---|---|
| A1 `uck()` vs `registry` | **reversed:** `registry` is the sole accessor; `ctx.uck` deleted outright | CONTRACT N20/N20a + G4 row; here §A1 |
| A2 `contractVersion` | open — needs core | here §A2 |
| A3 error vocabulary | `CredsKind` union normative; five vocabularies retired; cross-uck `instanceof` = undefined behaviour | CONTRACT §7.2, §7.3, C2 |
| A4 cloneable `ctx` | declared | CONTRACT N20b |
| B1 bucket-level `lib/` | cross-bucket import forbidden three ways; two legal homes for shared code; probe-transport consequence stated | CONTRACT N4, §5 P7 |
| B2 `self` = registered name | CONTRACT was already right; the wrong doc is **core README:217** ("source label") | here §D |
| B3 `ctx.dir` | withdrawn; replaced by the `here` idiom as a rule | CONTRACT S2; here §Decided |
| B4 `status --json` | declined; the probe protocol was made normative instead | CONTRACT §5 P4 |
| **A1/A2 core** | `ctx.uck` deleted, `ctx.contractVersion` added, register/run one ctx shape | core `36bc090`, covered by `test/ctx-contract.test.ts` |
| B5 `hasExternalApi` | removed — presence of `credentialProvider.name` **is** discovery | CONTRACT P8; flagged by `f uck check` |
| C3 enforcement | **`f uck check` shipped** (no core release needed) | `uck/index.js` |
| **C2 store lock** | symlink lock around store mutation; dead-holder reclaim by pid+boot-id | measured: no lock ⇒ bucket with no `.git` |
| **C5 exit handling** | `exitCode` instead of `exit(1)`; measured 7.4 MB of 52.5 MB lost in 0.3.0 | `test/stdout-drain.test.ts` |
| **C5 stdout** | done; `f version` table + trust model still open | see C5 below |
| C4, C6, C7, D, D2 | open | here |
| C1(b), C7, C8 | closed 0.3.1 | done — C1(b) needed no core change; C8 is new, from building the fix |
| **install bugs found en route** | `#ref` made every ref'd source uninstallable; `firstLine` hid git's reason; local paths percent-encoded; `file://` misrouted to npm | all in 0.3.1 |

---

## A. Closes at 1.0

### A2 — `contractVersion` (single negotiation dial) — **needs core**

Today there are three ad-hoc version dials and no way to answer "does this
bucket speak this core's language":

| dial | direction | where |
|---|---|---|
| `minF` | uck → f | checked in loader, warn only |
| `credsApi.version: 1` | peer → peer | `creds/index.js` |
| `providerVersion` | provider → creds | proposed, §5 P6 |

**Change:** `ctx.contractVersion: 1` at **register** time (so a uck can
branch before it returns anything), plus `uckApiVersion?: number` on the uck
object for peers. Core bumps `contractVersion` only on changes that alter
behaviour of existing fields. Loader records the contract each uck was
written against in `f doctor` output.

Scaffold (`f uck new`) emits `contractVersion`-aware code and never a raw
`ctx` destructure.

### A4 — `ctx` is plain-JSON-clonable — **needs core + contract text**

Declared in CONTRACT.md **N20b**: `ctx` and everything reachable from it must
be structured-cloneable. No live handles (sockets, child processes, open fds,
class instances with private fields) hung off `ctx`.

**Why it isn't free to defer:** providers *already* cross a process boundary
(`node <dir>/index.js resolve <name>`). The moment a provider author wants
`ctx`-derived config on that path, an unclonable `ctx` forces a second,
parallel config convention. Cheap to state now; expensive once a bucket
depends on the current shape.

The old "tension with a proxy-returning `uck()`" is gone: `uck()` is deleted
(A1), `registry` is the only accessor, and the rule applies to `ctx`'s plain
fields.

### A1 — status: **resolved — `registry` wins, `ctx.uck` is deleted**

`uck()` is sugar over `registry`, not a capability boundary (verified:
`registry = ucks` is the same object `ctx.uck` closes over). Settled by
**adoption data**, not argument: 0.3.0 shipped both, and of six in-tree peer
accesses **five used `registry`** (`skills`, `fj`, `ha`, `ha-ws`, `ssh`) and
exactly one used `uck()` (`gh/index.js:368`). The superset won on its own — and
it also subsumes the subset, is the only form that can exist at register time,
and the only one that can answer "what did I shadow?" (N9, §6.3). Recorded in
CONTRACT.md N20/N20a.

My objection was never "keep both" — it was that removing *`registry`* would be
a **silent** break, because `lib/credsresolve.js` takes `credsApi` as a
parameter and so cannot reach `ctx.uck()` below `run()`. Reversing the direction
dissolves it: deleting `ctx.uck` is loud (`f: ctx.uck is not a function`) and
run-time `ctx` is rebuilt per invocation, so no stale capture exists.
**One call site migrates:** `gh/index.js:368`.

**Done.** Core commit `36bc090`: `ctx.uck` is absent from both ctx objects,
`ctx.contractVersion` added, and `register()`/`run()` share one shape. The only
accessor is `ctx.registry`; nothing is kept "for a release", because coexisting
accessors are exactly what makes half-migration silent. `gh` is migrated
(including its `catch` handler, which had the same `ctx.uck` fallback — leaving
it would make the migration *worse* than not doing it, since the success path
and the error path would then disagree about which store is authoritative).

---

## C. Harness, before release

> **Decision needed, not a bug.** 0.3.1 shipped C1(a) (a local source inside the
> store is refused) and deliberately did **not** change C1(b). It is not a defect —
> it is a contradiction between two published positions: `update.ts` says a clone is
> "never an editing surface", while the published `f-uck-creation` skill tells
> authors "the store bucket is a live git working tree… edit the bucket directly".
> Both cannot be true, and the current mix is the worst of both: the docs encourage
> the thing the tool is entitled to discard.
>
> **Recommendation (0.3.1): keep `reset --hard`, fix the docs.** Not the `.f-dirty`
> marker sketch, for two reasons:
>
> 1. **The marker is redundant for the case it was sketched for.** `f up` already
>    skips a bucket whose tree is dirty *or* whose history is ahead of upstream,
>    names it, and `--force` asks before discarding. Verified with a throwaway
>    bucket clone holding one unpushed commit: core printed
>    `has local changes (1 unpushed commit(s)) — skipped` and the commit survived.
> 2. **A `.f-dirty` marker is not a commit graph.** It cannot tell an author's edit
>    from a generated file or a stray `node_modules`, and "commit first, then wipe"
>    writes to the author's repo as a side effect of a command whose documented job
>    is to *update*. Core would grow permanent state plus a recovery UI to serve a
>    workflow it also advises against — against "keep core f simple".
>
> **Shipped in this change:**
> - `f uck check` warns per bucket about work `f up` would reset: commits ahead of
>   upstream, commits on no remote at all, and uncommitted files (`node_modules`
>   excluded, matching core's own check so it never cries wolf about deps). Warning
>   only — exit status stays driven by uck validity, since `check` answers "are
>   these files well-formed" and an author mid-rebase is not writing invalid ucks.
>   It fired on my own uncommitted edit the first time I ran it.
> - Skill: that warning is now the first thing under "Where it lives", and
>   checklist step 1 is `f uck check` rather than `f uck repo ls`.
> - `skills/default.md`: the ctx shape was still pre-A1 — no `contractVersion`,
>   `registry` not named as the sole accessor, `self` not called out as a name and
>   not a path. That one could cost an author hours. It also now says a source may
>   not point into the store.
>
> No core change. `f up`'s existing behaviour is correct; the gap was only that an
> author learns about at-risk work while running `f up`, so `f uck check` — the
> command authors run *while editing* — now says it earlier.
>
> **If the owner instead decides buckets are authoritative editing surfaces**, then
> `reset --hard` has to go entirely (fetch + fast-forward only, refuse to diverge).
> That is coherent too, but it is bigger than the marker and leaves `f up` unable
> to recover a bucket the author has rebased. Say which; do not keep both documents.
>
> **Two claims from earlier drafts of this section were wrong.** Recorded as wrong
> rather than quietly deleted, because the failure mode is the same one behind the
> C5 "64 KB" figure — a plausible mechanism reasoned about, not measured:
>
> - *"a `.f-dirty` marker cannot see a committed-but-unpushed edit and `f up`
>   destroys it."* It does not. The "measurement" cloned a bucket, committed in the
>   clone, reset, then read `HEAD` **in that same clone** — which shows the reset by
>   construction and says nothing about whether the commit survives `f up`. The
>   correct repro (throwaway clone, one commit ahead, through `f up`, piped stdin)
>   shows core skipping the bucket and the commit surviving. `dirtyBuckets()` counts
>   `@{u}..HEAD` precisely because the author already thought of this.
> - *"a skip is silent unless verbose."* It is not — the skip is named on stderr
>   with a count and the `--force` escape, unprompted. Coding against that claim
>   would have duplicated logic that already works.

### C1 — `f up` can destroy a bucket, and a local source can corrupt one

**Reproduced 2026-10-16** on this machine. Two distinct defects.

**(a) A local source pointing *into* the store is an in-place `cpSync`.**

```json
{ "ucks": [ "./ucks/fcli-ucks" ] }     // repo-relative → ~/.f/ucks/fcli-ucks
```

`installLocal` (`dist/index.ts:301` → bundle `:458`) computes
`dest = storeDir()/<bucket>/<basename(src)>` = `~/.f/ucks/fcli-ucks/fcli-ucks`
and runs `cpSync(abs, dest, {recursive:true})` with `abs` inside `abs`'s own
tree → `ERR_FS_CP_EINVAL`, uncaught, `f up` dies mid-loop.

The observed damage in the target bucket: `config/index.js`,
`config/package.json`, `config/package-lock.json`, `config/.gitignore`,
`lib/*` deleted (`git status` → 4 tracked deletions + `lib/`), and
`.f-source.json` overwritten with a *git* provenance pointing at
`github.com/kensand/fcli-ucks` — so the bucket then claimed to be a clone of
a repo while its content was a partial local copy.

`dirtyBuckets()` did **not** protect it: it only checks buckets present in
the source list, and the abort happened after the copy had already run.

Recovered with `git checkout -- config lib` (content was tracked and unpushed
work was nil). **An author with uncommitted uck edits in a bucket and a
badly-typed local source loses them.**

Fixes:
- Reject or hard-error any source whose resolved path is inside `storeDir()`
  or inside its own destination. Currently it silently proceeds to `cpSync`.
- Validate `dest` is not a descendant of `abs` before `cpSync`.
- Never write `.f-source.json` git provenance from a *local* install path
  (`installLocal` writes no manifest at all today — the stray
  `fcli-ucks-dev` bucket has none; the corruption came from the *git* path
  re-stamping an existing dir).

**(b) `reset --hard` + `clean -fdx` with no author marker.**

`installGitSource` (`dist/index.ts:136-145` → bundle `:273-283`) on an
existing clone does `git reset --hard <target>` then `git clean -fdx -e
node_modules`. That is correct for a pure cache and catastrophic for the
model the published `f-uck-creation` skill teaches: *"The store bucket is the
working repo… a git bucket is a live git working tree… edit the bucket
directly."*

Also: `f up` reads sources for the update loop, but `dirtyBuckets()` skip-logic
only guards buckets it finds *and* the non-TTY `--force` path discards after a
single confirm.

Fixes:
- Write a mutation marker (`.f-dirty`) on any in-bucket write by `f uck new`,
  and treat a dirty `git status` as the marker; refuse to `reset --hard` a
  marked bucket even under `--force` unless `--discard`. Clear on clean update.
- `git stash create` (dangling commit, no tree change) before `reset --hard`,
  and print its sha so recovery is a one-liner.
- Cover **every** source the loader actually uses. Today `allSources()` merges
  global+project, but local/project sources install at startup and
  `f up`'s loop can skip them — so `up`'s view of "what's installed" and
  "what's updatable" disagree.

**C2 and C5's exit/stdout half shipped in 0.3.1.** C1's local-source half (a)
also shipped: a source resolving inside the store is refused. The author-bucket
half of C1 is a *policy* choice, not a bug — see the note at the end of C1.

### C2 — no concurrency safety — **needs core, invisible to the contract**

`grep -n "pid\|\.lock\|singleton" dist/index.js` → nothing. Two `f` processes
both `git clone` into the same bucket path; `stashExisting` (`:416`) renames
the live dir aside, so a concurrent load can register from a half-swapped
tree, and `restoreStash`/`discardStashes` can fight over the same stash dirs.
Compounded by C1(a), which leaves `.f-source.json` stale-but-present.

One lock around store mutation fixes it. No contract surface. **Shipped in
0.3.1** (`src/lock.ts`), with three corrections to the sketch above:

- **Lock a symlink, not an O_EXCL file.** `symlink()` fails EEXIST when the name
  exists at all (file, dir, or dangling), and the pid rides in the link *target*
  — so there is no zero-length-file race and no second metadata file to read.
- **A timeout is not a staleness test.** The obvious "give up after N seconds"
  design steals the lock from a healthy `f up` (which clones several buckets and
  npm-installs each, so minutes is legitimate) and reintroduces exactly the
  interleaving the lock exists to stop. A waiter waits and, after a few seconds,
  prints which pid holds it. Staleness is decided by pid liveness (+ boot id, so
  pid reuse is not mistaken for a dead holder), never by elapsed time.
- **Dead-holder reclaim is mandatory.** Without it a single SIGKILL leaves a lock
  that bricks every f command until someone deletes a file by hand. Note core's
  own `index` uck says a `SIGKILL` is "the only way to stop" a daemon — so this
  is not a hypothetical path.

The load phase deliberately stayed **outside** the lock: a load takes no lock at
all when there is nothing to install, and holding one across a whole command
turns "two shells open f" into a serialization nobody asked for. Measured
without the lock, two concurrent `f up` runs left a bucket directory with **no
`.git`** and both runs failing; the test records that so the invariant survives
whoever edits the lock next.

### C3 — contract enforcement — **`f uck check` shipped; `f doctor` still open**

**Done as `f uck check`** (in the `uck` uck, so it needs no core release): one
`ok`/`BAD <bucket>/<dir>` line per uck naming the violated rule — N2
`package.json type`, N3 import / N7 `register`, N8+G10 one-uck-per-dir, N6
dir↔registered name, N9 name, N10 `desc` one-line ≤120, N13 `run` function, S2
skills path absolute+existing, P8 `hasExternalApi`. `--all` includes non-git
buckets; **exit 1 when any uck is invalid**, so it works as a bucket repo's CI
gate today.

First run on this machine: 12/15 valid.
- `kensand-fcli-ucks/ha` desc **155** chars and `ha-ws` **135** — both over the
  N10 cap, i.e. silently truncated in `f help` and in every `ctx.ucks`;
- `fcli-ucks/config` reports `N3 import failed: Cannot find module
  'jsonpath-plus'` — but that is only an **uninstalled-deps** condition, so
  `check` should detect a missing `node_modules` for a uck that declares deps
  and print `skip (deps not installed)` instead of `BAD`. Needs a fix;
- correctly did **not** flag the flattened `fcli-ucks-dev` copy (skills paths
  are built from `import.meta.url`, so they resolve truthfully — good
  property), yet that bucket *does* fail at runtime for `../lib/`, which only
  N3's import error catches.

**Still needs core (`f doctor`):** the runtime half no uck can observe — which
ucks the harness loader dropped and why, shadowing **with bucket names** (C5),
`minF` vs `fVersion`, `contractVersion` per uck (A2), `--json`.

The contract has ~25 normative rules (N1–N21, P1–P8, S1–S2); this is the first
machine check of any of them, and the best debug surface for LLMs — this
project's whole audience.

### C4 — test kit — **open, and smaller than it looks**

`f uck check` covers the static half. Left is a behavioural smoke test: `f uck
test <dir>` — import, `register({fVersion, self})`, assert shape, then call
`run([], {_: []}, ctx)` and assert it does not throw (already how every in-tree
uck treats a bare call, per N16). Otherwise each bucket re-implements
`creds/test.js` (173 lines, hand-rolled, covers one uck) and `fclie.dev2/test.sh`
is 67 KB of shell for the whole surface.

**Blocked on a store-path injection point (measured today).** A test cannot run
f against a throwaway store: `HOME` is not a seam. Setting `process.env.HOME`
before importing `src/cli.js` still loads and dispatches the **operator's real
`~/.f/ucks`** — observed directly, a "throwaway HOME" test printed the real
store's 15 ucks while the fixture's 2 were absent. Cause: `src/registry.ts`
evaluates `fHome()` in a module-scope const (`uckMainPath()`), freezing the
store path at import time, before the test can move `HOME`. Core needs either a
`F_HOME`/store-dir override read at *call* time or an injectable store dir.

Workaround used in the meantime (core `test/ctx-contract.test.ts`): spawn the
built `dist/index.js` as a child process with a scrubbed env. It works, but it
costs a build, and any test that needs a fake store pays the same tax.

### C5 — dispatch and path hardening — **needs core**

- **Unknown uck truncates stdout — FIXED in 0.3.1.** `console.error(...);
  process.exit(1)` for an unknown uck and in the catch discarded buffered stdout.
  The claim was right; the *size* in the original note was wrong. Measured: on
  Linux, pipes are synchronous since 2.6.35, so 64 KB / 640 KB / 3 MB all
  survived `exit(1)` intact — three attempts at a regression test measured
  nothing for that reason. It only shows at 52 MB: **0.3.0 delivered 7.4 MB of
  52.5 MB**. So the correct statement is not "large reports get truncated at
  ~64 KB" but "the truncation threshold is platform- and buffer-dependent, which
  is exactly why it must not be the mechanism deciding how much of a printed
  secret survives". Fixed with `process.exitCode` + return; the unknown-uck path
  additionally had the cheaper bug of discarding everything printed earlier in
  the same run.
- **Bucket labels are not unique.** `sourceBucket()` (`:126`) derives the same
  label for a bare local uck and for a bucket, so `name` is not a stable
  provenance key. Namespace the registry key as `<bucket>/<name>` internally,
  keep `name` as the CLI key. Also makes G9's shadow warning precise ("creds
  shadowed by kensand-fcli-ucks, was fcli-ucks") instead of today's
  "shadowed (store) by a later source", which cannot name the bucket.
- **Source trust model is undocumented.** `{source}` accepts any git URL
  and `f` clones + imports it. That is code execution by URL with no pinning
  (no commit hash, no signature, no allowlist). Either add an allowlist /
  `ref`-to-a-sha recommendation, or state in §1 that `f.config.json` content
  is trusted input. Today neither doc says it.
- **`f v` tells you nothing that matters.** Keep `v` terse; make
  `f version` print f version, `contractVersion`, store path, node version,
  and a `bucket → url @ commit` table. That table is also what makes C1
  damage diagnosable.

### C7 — the `config` uck is untested and `add` loses data — **new, found 0.3.1**

`f config add ucks <value>` on a config with no `ucks` array writes `{}`, prints
nothing and **exits 0** — the value is silently discarded. That includes the
example the uck prints in its own usage:

```console
$ f config add ucks github:user/repo     # the documented example
$ cat f.config.json
{}
```

Cause: `applyAdd`'s fallback when the path selects nothing is
`setPathCreate(doc, clean, undefined)` — it walks to `doc.ucks`, assigns
`undefined` (so the key does not persist) and then re-reads an array that was
never created. A command that silently does nothing is the worst possible
failure mode for an LLM caller: no exit code, no stderr, nothing to react to.

Fix: create the array and push (the current behaviour is data loss, so no
migration concern). Add `test/config.test.js` — `config` is the only stateful
uck with no test file, which is why this survived.

### C6 — provider probe protocol self-test — also blocks test isolation

§5 P4 admits "a broken probe wiring fails silently on first miss". Extend
`f providers --dump` to actually execute `resolve`/`has`/`status` against
each discovered provider and report `invalid` with the reason. Pairs with
B4 below (which defines the output format that makes this checkable).

---

## D. Documentation contradicts the shipped binary

Highest value per minute; no code changes.

| doc says | shipped |
|---|---|
| README: `"extensions": [...]` as the config key | `readConfigFile` (`:76`) accepts `extensions` only as a legacy fallback; `ucks` is the key |
| README: git sources need `npm i` first | `installGitSource` clones and runs `npm i` per uck automatically |
| README: `ctx.ucks` = "all **previously** registered ucks" | full set, computed after all loads (`:828`) |
| README: `credsApi` = `get/set/ls/unlock/lock/status` | also `getRaw`, `resolve`, `wait`, `waiters`, `providers`, `lookupCred`, `lookupFirst`, `status().remainingMs` |
| README: no mention of `ctx.uck` | `gh` already uses it as the primary accessor |
| README: "A one-line `curl … \| sh` bootstrap is coming" | pick a release path or delete the line |
| CONTRACT.md §6.2 "`uckApi` … document in the uck uck, not here" | `uckApi` is `{loadTargets,saveTargets,push,bucketUcks}` with push-target naming coupling (`target.name === bucket`) that no doc states; `f uck new`'s default-bucket rule is also undocumented |
| `f help` truncates `desc` to ≤120 chars | `CONTRACT.md` N10 says 100; `f uck new` scaffold says 120 — three numbers |

Also: `f ls` interpolates `args._[0]` into `ls -1 ${target}` and `f w` into
`which ${target}`. Both are the **reference example ucks** in the README and
both are shell-injection demos. Rewrite with `execFileSync` + argv array —
the scaffold should demonstrate the safe form, since LLMs copy these files.

### D2 — the local-source trap is undocumented and unsurfaced

Discovered while testing C1. A local source's content is **copied once** into
a non-git bucket, so editing the source never reaches the registry again
(`installLocal` returns early when `dest` exists and `!force`). Worse,
**load precedence ignores config order**: `loadStoreUcks` loads the whole
store alphabetically by bucket (`fcli-ucks-dev` before `kensand-…`), and npm
sources load last — so a local dev bucket can be silently shadowed by a
personal bucket without any warning.

Verified on this machine: a local copy of `fcli-ucks` registered as
`fcli-ucks-dev` loaded **8 of 10** ucks (no `lib/`, no `skills/` — only
subdirs containing `index.js` are copied, breaking `providers`'
`../lib/uckmain.js`), printed `f: uck 'providers': Cannot find module …` on
**every** invocation, and its 8 ucks were shadowed anyway — the one noisy
error in the tree was also the one that mattered most.

Two fixes:
- `f config add ucks <path>` should **refuse or warn loudly** when the path
  is inside `storeDir()` or is a bucket that already has a git source, and say
  "this content is copied once and never updated; use a git URL or `--name`
  that does not collide".
- C3's `f doctor` must surface "N ucks shadowed by <bucket>" and "N ucks
  failed to load" in the default (non-`--json`) output. A recurring stderr
  line on every command is the one failure mode an LLM cannot see at all —
  it's in a stream that gets discarded.

---

## Decided against (recorded so it doesn't resurface)

- **`ctx.dir` (B3).** Approved, then withdrawn on inspection: `import.meta.url`
  + `path.dirname` yields the same path from **both** the harness and a direct
  `node index.js` probe, where a harness-provided path would disagree; and
  `ctx.self` is already load-bearing as the **registered name** (provider probe
  keys, provenance). So `ctx.dir` would either duplicate a field or rename one,
  for two lines of import boilerplate. Replaced by **CONTRACT.md S2**, which
  states the `here` idiom normatively and explains why skill paths must be
  absolute — they're read from a *different process* than the one that
  registered them.
- **`ctx.uck()` — deleted, not deprecated (A1).** `registry` is the sole
  accessor. Also kills the earlier "keep `registry`, filter `uck()`" proposal:
  pre-1.0 breaking changes need no migration handling, so there is no reason to
  carry two names for one lookup.
- **Cross-bucket shared `lib/`.** Rejected in favour of publish-only buckets;
  CONTRACT.md N4 + §5 P7. Consequence worth stating plainly: `lib/uckmain.js`
  and `lib/creds-error.js` are deliberately **duplicated** per bucket, and
  `resolve()`'s child-process transport means a provider cannot consume a
  bucket-level shared lib at all. Both are contract text now, not accidents.
- **`status --json` (B4).** Not implemented: no consumer exists. The probe
  protocol (§5 P4, now a normative table) already carries what's machine-
  readable, `has`/`status` are best-effort by P2/P3, and "printed nothing" is
  already distinguishable from "printed `ready: false`". Revisit only if C6's
  probe self-test needs to *parse* readiness rather than merely probe it.
- **Output formatting as contract.** Stays style, per §0.

### C8 — `npm test` tests the previous build — **new, found 0.3.1**

`"test": "vitest run"` with no `pretest` build. `dist/` is a committed build
artifact and several tests spawn it (the C4 store-path blocker leaves no
in-process seam), so **a test can pass while the fix it exists to protect is not
in the binary**. Observed directly: the C1(b) dirty-check fix "did not work", the
test stayed red, and only `npm run build` turned it green.

Fix: `"pretest": "npm run build"` — or drop `dist/` from git and always build, so
CI cannot test a stale artifact either. Cheap, and it removes a whole class of
"but my test passed".

