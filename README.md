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
```

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
