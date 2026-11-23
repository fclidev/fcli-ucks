---
name: f-config
description: Edit f's own config (f.config.json / ~/.f/f.config.json) by JSONPath with `f config` instead of hand-editing JSON. Trigger - adding a uck bucket, registering a push target, or reading back a config key.
---

# f config — JSONPath editor for f's config

Edits the config document **through paths, not by hand**, so an array append or a
filter-match selector is one command instead of a risky manual JSON edit. Output is
raw for strings, pretty JSON for objects/arrays.

Two targets: **project** `./f.config.json` (default) and **global**
`~/.f/f.config.json` (pass `-g`). `-g` is a flag, not a positional, and may appear
anywhere in the argv.

## Commands

```
f config [-g] list                     the whole target document (`{}` when unset)
f config [-g] get <path>               read one value — `get` with no path is an
                                       error, there is no whole-doc shortcut
f config [-g] set <path> <value>       replace a value
f config [-g] add <path> <value>       append to an array ($ push)
f config [-g] remove <path>            delete a key / array element
```

Paths are JSONPath: `ucks`, `ucks[0]`, `ucks[?(@.source=="./old")]`, and `$` for
the whole document or an array append.

Run `list` first to see what is actually in the file you are pointed at — `f config`
resolves the **project** target from the current working directory, so the same
command edits a different document depending on where you stand:

```
f config add ucks github:user/repo             # register a bucket
f config set ucks[0] ./my-uck                  # replace one entry
f config remove 'ucks[?(@.source=="./old")]'   # match by content, not index
f config -g get ucks                           # the global bucket list
```

## What it is for

`ucks` is where `f` finds buckets (`f uck repo ls` reads the same document), so
`f config add ucks …` is the non-destructive way to install a uck bucket. Quote any
path containing `?(@…)` or `[` — the shell globs brackets before `f` sees them.

Values arrive as **strings**; a numeric-looking value is stored as a string, so this
is not the tool for typed scalars. A failed edit is one `f: <message>` line on stderr
plus exit 1 — it never prints a stack, and it never truncates stdout.

## Not this

- Credential values never belong in config. `f creds` owns secrets
  (skill `f-creds`); `f config` owns *where* providers and buckets live.
- Skill entries live in the same documents but are managed by `f skills`
  (`-g` selects the global file there too).
