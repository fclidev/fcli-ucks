---
name: f-skills
description: Manage local skill entries (search/ls/show/add/rm) in f.config.json with `f skills`. Trigger - a skill is missing, the wrong file answers a skill name, or you want to know which SKILL.md is actually loaded.
---

# f skills — which SKILL.md is loaded, and how to change it

A **skill** is a markdown file `f` (and any agent reading the store) can pull up by
name. Skills are resolved from entries in the config document plus skills that ucks
**self-register** from their own directory.

Two targets: **project** `./f.config.json` (default), **global** `~/.f/f.config.json`
with `-g`.

## Commands

```
f skills [-g]                     list skill names (bare = list)
f skills [-g] ls                  list skills with paths
f skills [-g] search <query>      find by name + content
f skills [-g] show <name>         print a skill's markdown
f skills [-g] add <name> <path>   add/update a skill (path to a local .md)
f skills [-g] rm  <name>          remove a skill
```

```
f skills ls                       see name → path, the resolution truth
f skills show f-cli               read the core f doc
f skills search creds             find skills that mention it
```

## Precedence (the thing that surprises people)

A **config entry of the same name wins** over a skill a uck self-registers. That is
intentional and non-destructive: it lets you override a shipped skill with your own
file without editing the uck — but it also means editing a uck's `SKILL.md` has no
effect while a same-named config entry exists. `f skills ls` shows the paths, so run
it before hunting for the wrong file.

A uck exports skills by absolute path from `register()`:

```js
skills: [{ name: "f-myuck", path: path.join(here, "SKILL.md") }]
```

Core/f-wide docs live in the `skills` uck (`f-cli.md`); uck-specific docs live in that
uck's own dir (`creds/SKILL.md`, `uck/SKILL.md`).

## Not this

- To add a *capability*, write a uck (skill `f-uck-creation`). A skill is the manual
  for a command, not the command.
- `f search` ranks **ucks**; `f skills search` searches **skill text**. Different
  corpora, similar names.
