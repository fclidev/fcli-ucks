---
name: f-providers
description: List and health-check the credential providers registered with `f creds` via `f providers`. Trigger - a cred resolves locally but a provider lookup looks wrong, or you need to know which provider will answer a name.
---

# f providers — who answers when `f creds` misses locally

A **credential provider** is any uck that exports a `credentialProvider` object
next to `register()`. `f creds` consults providers on a **local miss only** — the
encrypted local store always wins — and mirrors hits back into it under the
prefixed key `mirror:<name>`.

This uck answers two questions: **which providers are registered**, and **is each
one actually reachable right now**.

## Commands

```
f providers            list providers, then their readiness (human form)
f providers --dump     JSON array: name, uck, entry path, canWrite, mirrorTtlSec, probe
f providers --json     alias of --dump
```

Any other argument is ignored — there is no per-provider subcommand. Probing is the
only side effect: every uck is **imported once to collect exports and nothing is
executed**, so listing providers cannot mutate credential state.

Readiness is printed as a second block because that is what actually bites: a
provider can be registered and still refuse to re-authenticate.

## The probe protocol (why a provider is a CLI, not just an import)

`creds` discovers a provider by **spawning** its entry point
(`node <uck>/index.js resolve <name>`), so a provider must self-dispatch when Node
runs it directly. The probe commands are `resolve` / `has` / `status`, and the
entry guard that makes importing side-effect-free while executing does work is the
canonical ~12-line snippet in **CONTRACT.md §P4** — it is an *implied* contract, so
each provider copies it into its own `index.js` rather than importing shared code.

```
f providers --dump | jq -r '.[] | "\(.name) \(.probe) \(.canWrite)"'
```

## Not this

- To read or write a credential: `f creds` (skill `f-creds`). This uck never
  touches a secret value.
- A provider that **resolves from cache while its issuer is dead** is the failure
  this uck's readiness block exists to expose — `mirrorTtl` is the mirror's freshness,
  not a promise the upstream is alive.
