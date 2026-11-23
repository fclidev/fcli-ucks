---
name: f-v
description: Print the installed f version with `f v`. Trigger - checking whether a uck contract version or a fix is present on this box.
---

# f v — the one-line version

```
f v
0.4.0
```

Prints `ctx.fVersion` — the version `f` reports for itself. No flags, no
subcommands, no exit-code meaning: it is a read.

**It is not the version of every uck, and not necessarily the version of the
`@fcli.dev/f` package you think is installed.** Measured on one box: `f v` said
`0.4.0` while the installed bundle's own `package.json` said `0.4.1` — so treat this
as "what the CLI calls itself", and read a package's `package.json` (or the registry)
when you need a specific artifact's version.

## Why it is worth a file

`f` exits non-zero whenever **any** bucket is degraded, so an `f` exit code says
nothing about the command you just ran. `f v` is the cheapest way to confirm the CLI
answers at all before trusting anything else from it — and the version decides which
contract applies, since uck behaviour (the `run()` return contract, `args` parsing,
CONTRACT.md rules) is defined against `f`, not against a uck's own version.

Check the **uck** versions separately: this prints `f`, not the ucks installed
alongside it (`@fcli.dev/<uck>` on npm; the bundle is `@fcli.dev/ucks`).
