# fcli-ucks

[![npm version](https://img.shields.io/npm/v/@fcli.dev/ucks)](https://www.npmjs.com/package/@fcli.dev/ucks)
[![unpacked size](https://img.shields.io/npm/unpacked-size/@fcli.dev/ucks)](https://www.npmjs.com/package/@fcli.dev/ucks)
[![build](https://img.shields.io/github/actions/workflow/status/fclidev/fcli-ucks/publish.yml)](https://github.com/fclidev/fcli-ucks/actions/workflows/publish.yml)
[![license](https://img.shields.io/github/license/fclidev/fcli-ucks)](LICENSE)

Default ucks for [f](https://fcli.dev). This repo is a **bag of ucks** — every
subdirectory is one uck, entered through its `index.js`.

## Layout

```
fcli-ucks/
  v/index.js
  w/index.js
  ls/index.js
  config/index.js
  creds/index.js
  uck/index.js
  skills/index.js
  search/index.js
```

`f` downloads this repo on first install (it's seeded into
`~/.f/f.config.json`) and installs each subdirectory into the store:

```
~/.f/ucks/v/index.js
~/.f/ucks/w/index.js
~/.f/ucks/ls/index.js
~/.f/ucks/config/index.js
~/.f/ucks/creds/index.js
~/.f/ucks/uck/index.js
~/.f/ucks/skills/index.js
~/.f/ucks/search/index.js
```

## Discovery: `f search`

`f` itself prints uck **names** only — a name+description listing grows linearly
with the store, so it cannot be the default surface. `search` is the other half:
it ranks ucks against a query and returns short descriptions for the matches.

It lives here rather than in f core so ranking can be tuned without cutting an f
release. Two properties follow from being a uck, and `search/index.js` handles
both:

- **It must not find itself.** `ctx.ucks` is complete at run time and includes
  this uck, whose description mentions "rank", "ucks", "query", "name" and
  "description" — so unfiltered it surfaces on most queries. Filtered via
  `ctx.self`.
- **`--help` needs a declared `.help`.** Core only intercepts bare `f search`,
  `--help` and `-h` when the uck provides `.help`/`.about`. Without declaring it,
  `f search --help` reaches `run()` as a query and answers "no uck matched:
  --help" — which reads as a working command that found nothing, when the caller
  asked how to use it.

Unknown flags are refused (exit 2) rather than scored as search text.

## Format

Each `index.js` exports `register(ctx)` returning one uck or an array:

```js
export function register(ctx) {
  // ctx: { fVersion, ucks: [{name, desc}], self }
  return {
    name: "myuck",
    desc: "what it does (terse)",
    run: (argv, args) => {
      // args._ is the remaining CLI args
    },
  };
}
export default { register };
```

Supporting files (helpers, data) can live in the same directory and be imported
from `index.js`.

## Adding a uck

1. Create `myuck/index.js` (plus any supporting files).
2. Commit and push.

Existing installs pick it up on `f up`.

## Current ucks

- `v` — print f version
- `w <bin>` — locate binary
- `ls [path]` — list files (terse)

## License

AGPL-3.0. See [LICENSE](./LICENSE).
