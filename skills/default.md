# f — how to use it

`f` is a token-efficient CLI. Short ucks, minimal output, no boilerplate.
This is the default skill — read it to get oriented, then `f help` for the
live list of ucks.

## The basics

- `f <uck> [args]` — run a uck. `f help` lists every available uck.
- `f v` — print f's version.
- Ucks are units of functionality. Core ships a few; the rest come from
  uck sources (repos, local paths, npm packages) installed into your store.

## Skills

A **skill** is a named pointer to a local markdown file — a chunk of
instructions you can pull into context on demand. Skills live in
`f.config.json`'s `skills` array.

- `f skills` — show this default skill.
- `f skills ls` — list your skills (name + path).
- `f skills show <name>` — print a skill's markdown (read it).
- `f skills search <query>` — find skills relevant to a query (searches the
  names and contents of your configured skills).
- `f skills add <name> <path>` — register a skill (path to a local .md).
- `f skills rm <name>` — remove a skill.
- Add `-g` to any of these to target the global `~/.f/f.config.json` instead
  of the project `f.config.json`.

Skills come from two places, merged by name (a config entry **wins** over a
same-named uck skill, so you can override what a uck contributes):
1. **Config** — entries in the `skills` array (the ones `f skills add/rm`
   manage). A `path` points to a local `.md` file.
2. **Uck-exported** — any uck can export `skills: [...]` in its `register()`
   return value. Each entry is `{ name, path? }` or `{ name, content }` (inline
   markdown) or a bare name. These are read off `ctx.registry` at run time and
   show up in `ls`/`show`/`search` automatically — no config entry needed.

## Creating a new uck

A **uck** is a directory with an `index.js` that exports `register(ctx)`. It's
only a word when prefixed with `f-`. Create one anywhere, then point a source
at it (or put it in a personal uck repo).

```
myuck/
  index.js
```

```js
// myuck/index.js
export function register(ctx) {
  // ctx = { fVersion, self } — load time, before any ucks exist.
  return {
    name: "myuck",                 // -> `f myuck`
    desc: "terse description",     // shown in f help
    run: (argv, args, ctx) => {
      // args._ is the remaining CLI args (already stripped of the uck name)
      // ctx = { fVersion, contractVersion, self, ucks, registry }
      console.log("hello", args._.join(" "));
    },
    // argv?: (argv) => args        // optional custom arg parser
    // ...any other field you want. Core ignores unknown fields.
  };
}
export default { register };
```

Two phases (one ctx **shape**, not two — CONTRACT.md G4):
- `register(ctx)` runs **once at load**. `ucks` / `registry` are a **partial
  view**: only the ucks imported so far, which is load-order-dependent — use
  them for *detection* (`"creds" in ctx.registry`), never as an authoritative
  peer list.
- `run(argv, args, ctx)` runs **per invocation**, after every uck is loaded, so
  `ucks` / `registry` are complete here.
- `ctx = { fVersion, contractVersion, self, ucks, registry }` at both times.
  `contractVersion` is the contract this core implements; `self` is this uck's
  **registered name**, *not* a path — derive a path from `import.meta.url`.

**`ctx.registry`** is the **sole** sanctioned peer accessor — `name -> what that
uck returned from register()`. There is no `ctx.uck()` and no `ctx.deps`; if a
uck or doc mentions one, it predates contract v1. A uck can export anything,
and any other uck can read it off `ctx.registry` at run time. That's how ucks
interoperate: e.g. a uck that exports `skills: [...]` contributes skills that
the `skills` uck merges in. Core imposes no restrictions on what a uck
exports.

Return one uck object, or an array to register several from one module. Full
Node runtime — no sandbox: import other ucks, use `child_process`, `fs`,
`http`, hit the network, whatever. A uck that needs a third-party lib puts it
in its own `package.json` (f runs `npm i` in the uck dir on install / `f up`)
— never in f core.

To try a uck locally without a repo: `f config add ucks ./myuck` (or add it to
`f.config.json`), then `f up` — it installs to `~/.f/ucks/<bucket>/myuck/` and
becomes `f myuck`. The bucket dir is named after the **source**, not the uck, so
one source dir can hold many ucks.

Do not point a source at a directory inside `~/.f/ucks` — installing it copies a
tree over itself. Author in a clone you made (or in the bucket directly, then
`f uck push`); `f config add` refuses sources inside the store.

## Personal uck repos

Your own ucks live in a personal uck repo (a git repo of `<name>/index.js`
dirs), wired two ways in `~/.f`:

- **Pull** — a source in `~/.f/f.config.json`:
  `{ "source": "<git-url>", "name": "kensand-fcli-ucks" }`. `f up` downloads
  its ucks into `~/.f/ucks/kensand-fcli-ucks/`. The `name` is the **bucket**
  (provenance); a same-named uck here shadows the defaults (personal wins).
- **Push** — a target in `~/.f/f.repo.json` (managed by the `uck` uck):
  `f uck repo add kensand-fcli-ucks <git-url> --ref main`. The target name
  must match the bucket, so `f uck push -r kensand-fcli-ucks` mirrors your
  local `~/.f/ucks/kensand-fcli-ucks/` ucks back to the repo.

Workflow: write ucks under `~/.f/ucks/kensand-fcli-ucks/<name>/`, then
`f uck push -r kensand-fcli-ucks` to persist them, `f up` to pull on other
machines.

## When to make a uck (for LLMs)

**If you find yourself repeating a sequence of tool calls, stop and make it a
uck.** The first time you do something by hand (a command, a multi-step
pipeline, a fetch-and-format, a project-specific check), wrap it as a uck so
the next time it's one token: `f <name> [args]`.

Rules of thumb:
- **Repeated 2+ times** → uck it. The cost of a uck (a few lines of
  `index.js`) pays back on the second invocation.
- **Project-specific** → put it in the project's `f.config.json` / local
  source. **Reusable across projects** → put it in your personal uck repo.
- **Keep it terse**: short name, minimal output, no boilerplate. The uck is
  for *you* to call next time — design the `args` so the common case is
  `f <name>` with no flags.
- After creating one, `f up` (local) or `f uck push -r <bucket>` (repo) so it
  sticks, and `f help` to confirm it's listed.

Prefer a uck over re-deriving the steps: a uck is cheaper to call, easier to
audit, and survives context resets.

## Finding other skills

`f skills search <query>` ranks your configured skills by how relevant their
name and file content are to the query. It's local and offline — it searches
what you have. To get more skills:

1. A skill is just an `.md` file + a config entry. Drop a markdown file
   somewhere (e.g. `~/.f/skills/foo.md`) and `f skills -g add foo ~/.f/skills/foo.md`.
2. Shared skill sets ship in uck repos. Add a repo as a source (see `f help` /
   the ucks repo) and its skills become searchable the same way.

Keep skills terse and focused — each one is meant to be read into an LLM's
context when needed, not up front.
