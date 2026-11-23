---
name: f-search
description: Rank installed ucks against a plain-text query with `f search` before inventing a command. Trigger - you are about to reach for curl/awk/a new uck and are not sure f already does it.
---

# f search — does a capability already exist?

`f help` prints every uck; `f search` **ranks** them against a query, so the question
"do I already have a way to talk to Home Assistant?" is one command.

```
f search <query>            rank ucks: name matches first, then description
f search "list files"       quoted query
```

Matching is **lexical**: substrings and word prefixes, not meaning. One or two short
words beat a sentence — a long natural-language query dilutes every term.

## Reading the result

A hit is a **pointer**, not an answer. The ranking exists to tell you which uck to
open; the usage line for that uck comes from running it bare (`f <uck>`), because
`f <uck> --help` is routed to the global `f help <uck>` table rather than the uck's
own usage.

No hits does **not** mean the capability is absent — it means no name or description
matched your words. Try a different noun (`credential` → `secret`, `monitor` →
`uptime`) before concluding nothing exists.

## Deliberate limits

- **No flags, and it says so.** `f search --verbose` does not run a verbose search:
  unknown flags are **rejected** with exit 2 rather than scored as query terms, which
  would answer "no uck matched" confidently and wrongly. If you need semantic search
  over ucks, that is a different tool — this one is fast and dumb on purpose.
- It searches the **uck list**, not skill content. For skills: `f skills search <q>`.
