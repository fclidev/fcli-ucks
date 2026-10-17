---
name: f-uck-creation
description: Create and publish new f ucks. Trigger - a command has been used multiple times and has no covering uck.
---

# Creating ucks

An **uck** is a directory with an `index.js` that exports `register(ctx)`. It is only a word when prefixed with `f-`.

## When to make one

A command is needed a second time in a session (or is clearly repeated in scripts/CI) and `f help` has no covering uck. Make the uck, not a copy-paste.

## Where it lives (this machine)

> **The bucket is a live git working tree, and `f up` resets it to origin.**
> Committing is not enough — **push**. An unpushed commit is the one thing that
> gets destroyed here: a dirty working tree makes `f up` *skip* the bucket, but a
> clean tree with commits not on the remote looks up-to-date and gets reset.
> `f uck check` warns about this while you work; run it before `f up`.

- **The store bucket is the working repo.** A git bucket is the clone of its repo:
  `~/.f/ucks/<bucket>/` is a live git working tree that `f` reads ucks straight
  out of at run time. There is no separate checkout — edit the bucket directly.
  (The old `~/git/fcli-ucks` checkout is gone; if you need history/branches,
  clone fresh.)
- Personal bucket: `https://forgejo.kensand.net/kensand.net/kensand-fcli-ucks.git`
  → `~/.f/ucks/kensand-fcli-ucks/` (pushable, the primary place for your ucks).
- Default bucket: `https://github.com/kensand/fcli-ucks.git`
  → `~/.f/ucks/fcli-ucks/` (push auth is manual; commit locally and push by hand).
- Add `<name>/index.js` under the bucket, then publish:

```
f uck push <name>     # or: f uck push   (all dirty ucks in the bucket)
```

`f uck` commits, rebases, and pushes the store bucket to its own origin. No push
target needed for the clone bucket (bucket name = target name).

## Skeleton

```js
// myuck/index.js — zero deps unless you add a package.json
import { execSync } from "node:child_process";

export function register(_ctx) {
  return {
    name: "myuck",
    desc: "what it does (terse)",        // shown in f help
    run: (_argv, args) => {
      const rest = args._ ?? [];          // CLI args after the uck name
      const out = execSync(`some command ${rest.join(" ")}`, { encoding: "utf8" });
      process.stdout.write(out);
    },
    // skills: [{ name: "myuck", path: "./SKILL.md" }]  // optional: export a skill
  };
}
export default { register };
```

## Rules

- `register(ctx)` runs once at load; `run(argv, args, ctx)` runs per invocation. Interop via `ctx.registry` (other ucks' exported objects) at run time only.
- Keep output terse: one fact per line, no banners. Errors: one line + the fix.
- Prefer node builtins (`node:fs`, `node:path`, `node:child_process`) over deps. If a dep is needed, `npm install` inside the uck dir; `node_modules` is never pushed by `f uck push`.
- Name the uck after the thing, not the verb pile: `f deploy`, not `f do-the-deploy-thing`.
- After publishing, `f <name> --help` (or the uck's usage path) must print a usable usage; `f help` should show the new desc.

## Publishing checklist

1. `f uck check` — validates the ucks **and** warns if a bucket holds work that
   `f up` would reset away. (`f uck repo ls` also shows push targets/origins.)
2. Add `myuck/index.js` in the bucket (`~/.f/ucks/kensand-fcli-ucks/myuck/`) or the repo checkout.
3. Publish. Note: for NEW (untracked) uck dirs, `f uck push` only commits dirty TRACKED files, so it can say "nothing to do" — in that case commit directly in the bucket:
   ```
   git -C ~/.f/ucks/kensand-fcli-ucks add myuck && git -C ~/.f/ucks/kensand-fcli-ucks commit -m "add myuck uck" && git -C ~/.f/ucks/kensand-fcli-ucks push
   ```
   (For changes to already-tracked ucks, `f uck push myuck` works as-is.)
4. `f myuck --help` — sanity check.
5. **Ship a skill with any non-trivial uck.** Put a `SKILL.md` in the uck dir
   and export it so it self-registers (no `f skills add` needed):
   ```js
   import path from "node:path";
   import { fileURLToPath } from "node:url";
   const here = path.dirname(fileURLToPath(import.meta.url));
   export function register(_ctx) {
     return { name: "myuck", skills: [{ name: "f-myuck", path: path.join(here, "SKILL.md") }], /* … */ };
   }
   ```
   Commit the `SKILL.md` alongside `index.js`. A config entry of the same name
   still wins (override), so this is non-destructive.
   - Core/f-wide docs (not tied to one uck) live in the **default** bucket's
     `skills/` dir and are exported from the `skills` uck (see `f-cli.md`,
     `f-creds.md`, `f-uck-creation.md` there).
   - Uck-specific docs live in the uck's own dir (e.g. `fj/SKILL.md`, `ha/SKILL.md`).

## Notes

- The `~/.pi/agent/skills/f-*/` copies are the *pi harness's* view; the canonical,
  versioned content is the `.md` in the bucket. Keep them in sync if you edit
  either, or just edit the bucket and let `f skills show` read it.
- `f up` resets each bucket to its remote, so unpublished (unpushed) edits in the
  store are wiped on the next update — publish when a uck change is done.
