# Changelog

All notable changes to the default uck bundle.

## [0.4.1]

### Added
- **`creds`: `credsApi` is now the single interface into the store**
  (`credsApi.version` → 3). `resolveCred({names|host, flagToken, envVars, waitMs,
  raw})` answers the whole question in one call and returns a §7.2 `reason`
  (`locked` / `missing` / `provider` / `no-store` / `timeout`) instead of
  throwing; `credHint()` returns the matching remediation text (or, for a hit,
  the provenance line) so no uck writes its own creds advice; `rawCredRead()` is
  the sanctioned read for a process with no `credsApi`; `getRaw`/`setRaw` are
  byte-exact; `rm`/`has` exist so a peer need not shell out per name. CONTRACT.md
  §6.1 states the rule (C0) and §6.1 C4 makes the lockfile internal.

### Fixed
- **`creds`: `set` reported success when the daemon refused the write.** It
  returned `undefined` whatever the reply said.
- **`gh`, `grocy`, `ha`, `ha-ws`, `ssh`, `fj`: every one of them reported
  `creds are locked` on a permanently unlocked box** — the split-brain where
  `f creds status` next to it says `unlocked (permanent)`. Each had copied
  creds' lockfile check, and every copy tested `!lf.ttl` or computed
  `start + ttl*1000`; a permanent unlock stores `ttl: null`, so all six called it
  "expired at t=0" and never asked the uck that owns the answer. Worse, a file
  read cannot restart a permanent daemon, so the reboot/OOM case was
  unrecoverable from a consumer no matter how the arithmetic was written. All six
  now call `resolveCred`; the copies are deleted, along with
  `lib/credsresolve.js` (which carried the same bug into `f ha`).
- **`ssh`: `credsApi.getRaw` never existed**, so the intended path always threw
  and its socket fallback answered instead — which cannot see a provider-backed
  (mirror) key, i.e. a vault-stored key looked like "no key stored". v3 adds
  `getRaw`; `f ssh` uses `resolveCred({raw: true})` and keeps the trailing
  newline `ssh-add -` requires.
- **`vaultwarden`: `credsRm` swallowed every failure into `return false`** and
  shelled out one `f` per name; it now awaits `credsApi.rm`. Its `credsStatus`
  regexed the first line of `f creds status` output for "unlocked"; it asks
  `describeStatus()`.
- **`fj`: `urls` passed `credsApi = null`** "because it never waits", so the
  diagnostic printed `(none: locked)` for a permanently unlocked box while
  `f fj whoami` worked two commands later.
- **`creds`: `resolveCred({waitMs})` returned `missing` in 0ms** on an open box
  instead of blocking, because the wait branch only ran while locked. `--wait`
  therefore behaved as "wait" on a locked store and "fail fast" on an open one.
  It also burned the 30s read timeout as the total wait, turning `--wait 4` into
  a 30s hang.

### Notes
- Nothing in the consumer path may read `~/.f/.creds-daemon` or connect
  `~/.f/.creds.sock`. Grep for both before adding a uck that needs a credential.

## [0.4.0]

### Added
- **`creds`: permanent file-based unlock.** `f creds unlock --permanent`
  keeps the store open with no expiry and reads the passkey from a 0600 key
  file (`~/.f/.creds-unlock.key`, `--key-file` to relocate) instead of a
  prompt. A marker (`~/.f/.creds-unlock`) lets any creds command restart the
  daemon itself after a reboot or crash, so no resident process, systemd unit
  or cron entry is needed. `f creds lock` removes the marker so `lock` means
  what it says; `--purge` deletes the key file too. `credsApi.version` → 2
  (`unlock` takes an options object, `lock` takes `{purge}`, and
  `get`/`set`/`ls`/`resolve` may start a permanent daemon themselves).
  Generation only applies to a brand-new store: `--permanent` refuses to
  fabricate a key for an existing one. Threat model is "secret in a 0600
  file", the same as an SSH private key — documented in the uck README.

### Fixed
- `creds`: the unlock probe issued `ls`, which decrypted every entry; on a
  large box it blew the 1.5s probe budget, so `unlock` unlinked a healthy
  socket and started a **second daemon** against the same box — two writers
  racing `writeFileSync` and losing entries. The daemon now answers a `ping`
  op that decrypts nothing.
- `creds`: `unlock` decided success by watching for the socket *file*, which
  cannot distinguish "wrong passkey" from "still starting", and `unref()`d the
  detached daemon before reading its verdict — so a failed unlock could exit 0
  and `f creds unlock && deploy` would deploy. The daemon now announces
  `{ok, ttl, permanent, error}` on stdout and the CLI waits for it.
- `creds`: a daemon that lost the socket race no longer overwrites the
  lockfile with its own dead pid, which had hidden the live daemon from
  `status`/`unlock` and invited a second daemon.
- `creds`: auto-unlock clears a stale socket before spawning, so recovery
  after `kill -9`/OOM/reboot reports the real cause instead of "socket already
  in use".

### Notes
- `@fcli.dev/ucks@0.4.0` requires nothing new from core: `@fcli.dev/f` 0.4.0
  (contract v2) is still the peer. `credsApi.version` is a creds-level number,
  not the contract version.
- `npm test` is broken independently of this release and is NOT run by CI.
  `config/config.test.js` is a vitest suite but `package.json` runs it under
  `node --test`, which cannot resolve `vitest`. The creds suites are plain
  node and do run: `node creds/test/cli.test.mjs` (35) and
  `node creds/test/permanent.test.mjs` (23). Fixing the test script is open
  work, not a gate for this release.

## [0.3.0]

### Changed
- **Documented contract target is v2.** CONTRACT.md records G11: register-time
  ctx is `{fVersion, contractVersion, self}` only — no `ucks`, no `registry`.
  `run()` is unchanged and is now the only place a uck can see a peer. Requires
  core `@fcli.dev/f` v0.4.0, which ships `CONTRACT_VERSION: 2`.
  This is a documentation-only change in this repo: no shipped uck read a peer
  at register time, so every uck here works unchanged against both cores. The
  bump is major-in-spirit because the *documented* interface lost a field —
  a bundle at 0.2.x read alongside core 0.4.0 would describe a ctx that no
  longer exists.
- `search`: dropped the `.help` export so bare `f search` prints usage from
  `run()` without the G8 interceptor's `search  rank ucks…` header; `--help`
  and `-h` are handled as tokens instead.
- `skills`: bare `f skills` now lists skills, which was the useful default.
  Reading the default skill is explicit: `f skills show default`.
- `uck`: the N6 warning names both sides — registered name and dir — instead of
  only the dir.

### Added
- CHANGELOG.md.

## [0.2.1]

### Changed
- Added the `fcli-uck` keyword to package.json for npm search.
- `assemble` wipes `dist/` before copying, preventing stale files in the published bundle.
- `assemble` lists every uck in the manifest, not just those with dependencies.

### Fixed
- Removed `ls` and `w` ucks (superseded by `f`'s own index and `f v`).
- Moved discovery ranking out of core into the `search` uck.

## [0.2.0]

### Added
- Initial tagged release as `@fcli.dev/ucks` on npm.
- **creds** — encrypted credential store with TTL daemon, provider layer (Vaultwarden, local files), packed files (`f creds files pack/unpack/ls/rm`), cross-terminal cred supply (wait/request), passkey verifier, redaction by default.
- **skills** — markdown instruction files loaded into context on demand; per-uck skill exports merged with config skills.
- **config** — `f config add/remove/get/ls` with JSONPath; refuses uck sources that point into the store.
- **fj** — Forgejo/Gitea: all 491 endpoints.
- **gh** — GitHub via @octokit/rest.
- **ha** — Home Assistant: states, scenes, automations, history, weather, calendars.
- **vaultwarden** — read secrets from a Vaultwarden vault.
- **ssh** — ssh/scp/rsync with a key from the creds store (never touches disk).
- **pi-models** — save/restore `~/.pi/agent/models.json` in the encrypted store.
- **df** — disk usage report.
- **grocy** — stock, shopping list, recipes, chores, tasks.
- **search** — ranks installed ucks against a query (moved out of core in 0.2.1).
- **v** — version info.

### Fixed
- creds: `set` reads value from stdin; mirror deletes carry provenance.
- creds: `ls --json` respected; mirror metadata displayed.
- creds: unknown `--flag` no longer became unlock's passkey.
- creds: successful `set` no longer exited 1.
- creds: 25 tests; suite was silently skipping everything appended after the first.
- creds: stop provider discovery from recursing into itself.
- config: `add` no longer silently discards the value (C7).
- uck: quote-free description no longer broke YAML frontmatter parsing.
