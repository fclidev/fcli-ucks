# f creds

Encrypted credential store for `f`, plus the **provider** layer that lets other ucks
answer "do you know cred `<name>`?" from some other store.

Everything lives in one box at `~/.f/.creds.box`, keyed by name: secrets, whole files,
provider mirrors, and the miss-cache. A daemon holds the derived key in memory while
unlocked and answers over a unix socket, so a passphrase prompt happens at most once per
TTL window — not per read.

```bash
f creds unlock                     # once per TTL
f creds get github.com --secrets   # local box first, providers on a miss
```

Zero dependencies. `node:crypto` (scrypt + AES-GCM), a unix socket, no keychain
services, no external binaries.

---

## Commands

| command | what it does |
|---|---|
| `set <name> [<value>\|-]` | store a cred (also clears that name's mirror). No value: reads a pipe, or prompts without echo on a terminal — the secret never lands in `ps` |
| `get <name> [--secrets]` | print a cred — **redacted without `--secrets`** |
| `ls` / `has <name>` / `rm <name>` | list / test existence / delete |
| `meta <name>` | existence + size + bytes without decrypting the value |
| `unlock [--ttl <dur>]` / `lock [--purge]` | open or zeroise the in-memory key |
| `unlock --permanent [--key-file <p>]` | never-expiring unlock driven by a 0600 key file; restarts itself after a reboot |
| `status` | locked/unlocked, time left, providers and their readiness |
| `import <file>` / `export` | move entries between stores |
| `files pack/unpack/list` | whole files in the same box (`file:<abs path>`) |
| `request <name> [--timeout s]` | block until the cred is set elsewhere, then print it |
| `waiters` | list open waiting requests from other terminals |
| `forget [name…]` | drop provider mirror(s) + negative cache (no args = all) |

### Flags on `get`

| flag | meaning |
|---|---|
| `--secrets` | actually print the value (otherwise redacted — safe in logs) |
| `--local` | **never** consult providers |
| `--vault` | skip the mirror; revalidate with the provider now. Refuses to serve a stale mirror |
| `--source` | provenance to stderr: `local:<name>`, `vaultwarden:<name> (mirrored)`, `vault:mirror:<name> (<warning>)` |
| `--no-cache` | ignore **and clear** the negative ("not found") cache for that name first |

There is **no** `--provider`, `--no-provider`, or `--clear-misses`. `--vault` / `--local`
are the provider on/off pair, and `--no-cache` is the miss-cache reset.

---

## Unlock modes

| | how the key arrives | lifetime | after a reboot |
|---|---|---|---|
| **TTL** (default) | prompt, or one argument | `--ttl`, default 10m | prompt again |
| **Permanent** (`--permanent`) | 0600 key file | none | restarts itself on the next creds command |

```bash
# one-time, on a brand-new store
f creds unlock --permanent

# one-time, on an existing passphrase store — --permanent will not guess your key
umask 077 && printf '%s' 'YOUR-PASSKEY' > ~/.f/.creds-unlock.key
f creds unlock --permanent
```

The permanent mode is exactly two files under `~/.f`: `.creds-unlock.key` (the
passkey) and `.creds-unlock` (a marker saying "this store may open itself"). Any
creds command that finds the box closed and the marker present starts a new
permanent daemon, which is what makes it survive restarts with no setup — no
systemd unit, no cron `@reboot`, no resident process to babysit.

What it is not: it is not a passphrase-less *secure* mode. The key file is the
credential, readable by any process running as your uid and by root — the same
threat model as an SSH private key on disk. `f creds lock` removes the marker so
`lock` means what it says, and `--purge` deletes the key file as well. A key file
that is group/world-readable, or that no longer opens the box, degrades to
`locked` and clears the marker; it never falls back to a prompt or to provider
traffic, because a locked store must stay locked.

---

## Providers

`f creds get <name>` checks the local box first. On a **miss** it asks every registered
provider; a hit is mirrored locally as `mirror:<name>` under a TTL, so later reads are
offline, fast, and survive the provider being unreachable.

```bash
f providers                  # providers + readiness
f providers --dump           # the raw discovery payload ucks are given
```

Rules that decide what an operator sees when something breaks:

- **A provider error is an error, not a miss.** An unreachable or misconfigured provider
  must not read as "you have no such credential". The message names the cause and how
  long until the next attempt.
- **A locked box is not "empty".** While locked, every local read returns null, so the
  provider is skipped entirely rather than called and then unable to store its answer.
- **Unknown names are cached briefly** (default 300s) so a typo doesn't hammer the
  server on every invocation. `--no-cache` resets one name; `f creds forget` clears them.
- **Mirrors are copies of secrets.** `f creds rm mirror:<name>` is a real secret
  deletion, and `f creds ls` shows them.
- **A stale mirror is served with a warning, never silently**, and a provider *miss*
  never updates or deletes vault-sourced content — only a live hit refreshes a mirror.
- **Source affinity**: a mirror records which provider produced it, so a multi-provider
  setup can't serve a stale Vaultwarden value where a local one was expected.

Config in `f.config.json`:

```json
{
  "providers": { "vaultwarden": { "mirrorTtlSec": 3600, "enabled": false } },
  "mirrorTtlSec": 3600
}
```

A top-level `mirrorTtlSec` is the default; per-provider entries override it.
`enabled: false` removes a provider from the ladder without uninstalling the uck.

---

## The provider interface

A provider is another uck's registered object carrying a `credentialProvider`. The
creds uck never needs to know it exists — providers self-register at load time and are
resolved lazily on the first local miss.

```ts
{
  name: "vaultwarden",                 // short id; appears in provenance + status
  resolve(name): string|Buffer|null|undefined | Promise<…>,
  has?(name): boolean | Promise<boolean>,          // optional pre-filter
  status?(): { ready, note?, hint? } | Promise<…>, // for `f creds status`
  mirrorTtlSec?: number,               // floor before a mirrored hit is revalidated
                                       //   0 = revalidate every time
}
```

### `resolve(name)` — the only required method

Discovery rejects anything without a `name: string` **and** a `resolve: function`.

Three outcomes, and the distinction is the whole contract:

| outcome | meaning | what the user sees |
|---|---|---|
| `string` / `Buffer` | a hit | value returned, mirrored as `mirror:<name>` |
| `null` / `undefined` / `""` | "this name is **not mine**" | next provider, then a clean `no such cred` |
| **throw** | availability failure (locked, offline, wrong password, misconfigured) | the error, verbatim, exit non-zero |

**Returning `null` for a failure silently becomes "no such credential."** That is the
single most important line in this document: throwing is how a provider says *broken*
rather than *absent*. Any error that is not a confident "I don't have this" must throw,
with an actionable message.

### `has(name)` — optional, and a trap

A pre-filter consulted before `resolve`. If it answers "not mine", `resolve` is
**never called** — and that answer is cached.

> Do not implement `has()` unless you can answer it **without the network**. A provider
> whose `has()` returns false on a timeout will suppress its own `resolve()` and look
> empty rather than broken. Not implementing it at all is always safe: the ladder then
> just calls `resolve()`.

### `status()`

Feeds `f creds status` / `f providers`. Report `{ ready, note, hint }`. Be honest about
"not ready" — a provider that claims ready and then throws on every `resolve` is worse
than one that says what is missing.

### `mirrorTtlSec`

A **floor**, not a grant of freshness. The effective TTL is clamped to the daemon's own
remaining unlocked lifetime, so a mirror can never outlive the session that fetched it.
Set `0` to revalidate on every read.

### `blurb` — documented, **not read by anything**

`providers/index.js` builds its output from `{ name, ready, note }` only, and `blurb`
appears nowhere in the uck tree (`grep -rn blurb ~/.f/ucks` finds nothing outside
comments). Vaultwarden sets one; it is ignored. Set it if you like, but **put anything
the operator must see in `status().note`** — that is the field that actually surfaces.
Do not debug a "missing description" by adding one.

---

## Writing one

```js
// myprov/index.js
export function register(_ctx) {
  return {
    name: "myprov",
    desc: "what it can answer (terse)",
    credentialProvider: {
      name: "myprov",
      blurb: "secrets from the Example provisioning API",
      mirrorTtlSec: 3600,
      async status() {
        return configured()
          ? { ready: true }
          : { ready: false, note: "no token", hint: "f myprov login" };
      },
      async resolve(name) {
        if (!configured()) throw new Error("myprov is not configured — run: f myprov login");
        const v = await lookUp(name);
        if (v === NOT_FOUND) return null;   // confident "not mine"
        return v;                            // anything else is a hit
      },
    },
    run: (_argv, args) => main(args._ ?? []),
  };
}
export default { register };
```

### Rules for provider code

- **Module scope must be side-effect free.** Discovery is `f providers --dump`, which
  runs in `f` processes for unrelated commands. Do no work until `resolve`/`status` is
  called. `uckMain(import.meta.url, main)` exists so `index.js` can be both a CLI entry
  point and an importable provider.
- **Never block on a passphrase.** A provider that needs interactive input during a
  probe will hang the caller. If the store it needs is locked, throw — the caller is
  already gated on `f creds unlock`.
- **Recursion is the sharp edge.** A provider that reads through `f creds` can call
  itself. `f creds` sets `F_CREDS_NO_PROVIDER=1` in the environment of every child it
  spawns for provider work; a provider that shells out must pass that through. Read the
  flag's semantics in `providers.js` before inventing your own marker — a self-suppression
  applied to the wrong subcommand silently costs a full round-trip per lookup.
- **`resolve` is on the hot path** for any name you don't own. Cache aggressively, fail
  fast, keep the negative case cheap.
- **Secrets never go in argv.** Providers are spawned as child processes; anything in
  `argv` is visible in `ps` and in shell history.

---

## Tests

**There are none, and that is worth knowing before you change this code.** `creds/` has
no `test/` directory and `package.json` declares no test script. The provider ladder is
covered only indirectly, by `vaultwarden/test/e2e.test.mjs` driving a real daemon and a
mock provider. Treat edits to `providers.js` as unguarded: exercise them through the
vaultwarden suite, or add the missing coverage first.

Two test-only seams exist for exactly that purpose:

```js
setDiscoveryOverride(list)   // replace discovery entirely (a list, or null to restore)
resetProviders()             // forget process-local registrations + collision history
```

Without them, exercising the ladder offline means shelling out to the real `f` or
mutating the real store — neither belongs in a test. Do not call either from provider
code.

---

## Conventions

- Names are opaque strings; hosts (`github.com`) are just conventional because
  providers harvest them from vault item URIs.
- **Reserved in the box**: `mirror:` and `file:`. `f creds set 'mirror:x' v` is rejected
  (`isMirrorKey` guard) because mirrors are provider-owned. `file:` is namespaced by the
  `files` subcommand.
- **`miss:` and `src:` are NOT box keys** — they live in a separate, plaintext-at-rest
  cache file, `~/.f/.creds-cache.json`, holding the negative backoff and source affinity.
  So `f creds ls` will never show them, and `f creds rm` cannot clear them: use
  `--no-cache` or `f creds forget`. Do not go looking for a `miss:github.com` entry.
- Values are strings or Buffers; the box stores base64 and preserves bytes.

## Anti-patterns

- Reading a provider **error** as a **miss** — the user then sees "no such cred" for a
  network outage.
- Implementing `has()` with a network call.
- Trusting `status()` to mean "this name exists" — it reports readiness, not ownership.
- Echoing a secret in an error message. Errors carry names and causes, never values.
