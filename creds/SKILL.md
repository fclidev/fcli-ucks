---
name: f-creds
description: Store and use credentials via `f creds` (scrypt+AES-GCM, daemon+socket, ttl) instead of env vars or echoing secrets. Falls through to registered providers (e.g. Vaultwarden) on a local miss.
---

# f creds — credential store

Encrypted credential store (scrypt+AES-GCM). A local daemon holds the key in memory; commands talk to it over a socket. Never write secrets to env vars, files, or command output.

> **Full command table, and the provider interface contract for uck authors:
> [`README.md`](./README.md).** This file is the operational guide.

## Commands

```
f creds unlock [passkey] [--ttl d]      start daemon; --ttl accepts s/m/h/d/w
                                        (900, 45m, 2h, 1d, 1d6h30m; default 10m)
f creds lock                            stop daemon, zeroize key
f creds status                          locked / unlocked + time left
f creds set <name> <value>              store a cred
f creds get <name> [--secrets]          print a cred (redacted without --secrets)
f creds request <name> [--timeout sec]  block until the cred is set elsewhere
f creds waiters                         list open waiting requests (other terminals)
f creds fill [name]                     prompt + set value(s) for open waiters
f creds ls                              list names
f creds rm <name>                       remove a cred
```

## Providers (looking a secret up elsewhere)

`f creds get <name>` checks the local box first. On a miss it asks any registered
**provider** — currently `f vaultwarden`, which reads a Vaultwarden/Bitwarden
server. A successful lookup is mirrored locally as `mirror:<name>` under a TTL, so
repeat reads are fast and survive the provider being unreachable.

```
f providers                             list providers + readiness
f providers --dump                      the raw discovery payload ucks are given
f creds get <name> --provider           force a fresh provider read (ignore the mirror)
f creds get <name> --no-provider        local box only
f creds get <name> --clear-misses       forget the "not found" backoff
```

Rules worth knowing, because they decide what an operator sees when something is
wrong:

- **A provider error is an error, not a miss.** An unreachable or misconfigured
  Vaultwarden must not read as "you have no such credential". The message names
  the cause and how long until the next attempt.
- **A locked box is not "empty".** While locked, `getCred` returns null for every
  key, so the provider is skipped entirely rather than called and then unable to
  save its answer.
- **Unknown names are cached briefly** (default 300s, `missTtlSec`) so a typo does not
  hammer the server on every invocation. `--no-cache` resets one name; `f creds forget`
  clears them.
- **Mirrors are copies of secrets.** `f creds rm mirror:<name>` is a real secret
  deletion, and `f creds ls` shows them.
- **Source affinity**: a mirror records which provider produced it, so a multi-provider
  setup does not serve a stale Vaultwarden value where a local one was expected.
- **A stale mirror is served with a warning, never silently** — and a provider *miss*
  never updates or deletes vault-sourced content. Only a live hit refreshes a mirror, so
  an outage cannot erase what the vault once gave you.

Config lives in `f.config.json` under `providers` (`enabled`, `mirrorTtlSec`,
`missTtlSec`, per-provider overrides). See the `f-vaultwarden` skill for the
provider itself.

### Writing a provider (for uck authors)

Export `credentialProvider` from the uck's registered object:

```js
export function register(_ctx) {
  return {
    name: "myprov",
    credentialProvider: {
      name: "myprov",
      blurb: "what it can answer",
      status: async () => ({ ready: true, note: "…" }),
      resolve: async (name) => {
        // return the secret string, null if this name is genuinely not yours,
        // or THROW with an actionable message for anything else. Throwing is how
        // you distinguish "not mine" from "broken"; returning null for a failure
        // silently becomes "no such credential".
      },
    },
    run: () => {},
  };
}
```

The full interface — all six fields and why each exists — is in
[`README.md`](./README.md). The contract in one table:

| `resolve(name)` returns | means | the user sees |
|---|---|---|
| `string` / `Buffer` | a hit | the value, mirrored as `mirror:<name>` |
| `null` / `undefined` / `""` | "this name is **not mine**" | next provider, then a clean `no such cred` |
| **throws** | broken: locked, offline, wrong password, misconfigured | the error, verbatim, exit non-zero |

Discovery accepts only objects with `name: string` **and** `resolve: function`.
`status()` must report `{ ready, note?, hint? }`; `mirrorTtlSec` is a **floor**, clamped
to the daemon's remaining unlocked lifetime so no mirror outlives the session that
fetched it (`0` = revalidate always).

> `blurb` is read by **nothing** — `f providers` builds output from `{ name, ready,
> note }`. Anything the operator must see goes in `status().note`.

Do **not** implement `has()` unless you can answer it without the network: it is a
pre-filter consulted *before* `resolve`, its answer is cached, and a "not mine" from a
timeout makes the provider look empty rather than broken. Omitting `has` entirely is
always safe — the ladder then just calls `resolve()`.

Discovery is `f providers --dump`, so provider module code runs in every `f` process,
including ones doing unrelated work: keep module scope side-effect free, do nothing until
called, and **never block on a passphrase** (throw instead — the caller is already gated
on `f creds unlock`).

**Recursion is the sharp edge.** A provider that reads through `f creds` can call
itself. `f creds` sets `F_CREDS_NO_PROVIDER=1` in the environment of children it spawns
for provider work; pass it through if you shell out. Read the flag's real semantics in
`providers.js` before inventing your own marker — vaultwarden once self-suppressed on
`list`, which silently cost a full prelogin + sync + PBKDF2 per credential lookup.
Secrets never go in argv: providers are spawned, so argv is visible in `ps`.

## Packed files (`f creds files …`)

The same encrypted box stores whole files — keyed `file:<abs path>`, tracked in a
`files` manifest. Use it to carry machine-local configs (pi `models.json`, dotfiles)
across hosts. `pack` is atomic (all entries or none); `unpack` refuses to clobber an
existing file without `--force` (and writes a `.bak` even then).

```
f creds files ls [--json]               list packed files (terse / raw manifest)
f creds files pack <path>...            store files ('- --as <n>' = stdin; '<dir>/...' = each uck dir)
    --force (binary)  -n (dry-run)
f creds files unpack <path>...          restore to the same abs paths ('--all', '<src> => <dst>',
                                        '<name> -' = raw to stdout, --force, --dir <root> to stage)
f creds files rm <path>                 remove one packed file + its manifest entry
```

Example — pi models.json (replaces the old `f pi-models`):
`f creds files pack ~/.pi/agent/models.json` on one host, `f creds files unpack
~/.pi/agent/models.json` on another (same unlocked store).

## Conventions

- Name a cred after what it authenticates: `forgejo.kensand.net` for a Forgejo token, `github.com` for a GitHub token, `npmjs.com` for an npm token. `f fj` looks up the cred named after the resolved base-URL host.
- Before using a cred programmatically, check `f creds status`; if locked, `f creds unlock` (asks for the passkey) — or `f creds request <name>` to block until a human runs `f creds fill`.
- In long-lived jobs: `f fj --wait` already blocks for the cred.

## Anti-patterns

- `export FORGEJO_TOKEN=...` in a script — the token ends up in shell history and process lists.
- `curl -H "Authorization: Bearer $(cat ~/.token)"` — read the value via `f creds get` only inside the same `f` invocation (e.g. `f fj` does this internally); do not print secrets with `--secrets` unless the user explicitly asks.

