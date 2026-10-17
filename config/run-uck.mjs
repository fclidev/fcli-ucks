#!/usr/bin/env node
// Test-only driver. Loads ./index.js exactly the way core's registry does
// (register(ctx), then run(argv, args, ctx)) so a test can assert on what the
// user sees — stdout, stderr, exit code — instead of reaching into helpers.
//
// Usage: run-uck.mjs <cwd> <uck args…>
// The uck finds f.config.json by walking up from cwd, so the test controls the
// config simply by running in a directory that has one.
import { register } from "./index.js";

const [cwd, ...argv] = process.argv.slice(2);
if (cwd) {
  try {
    process.chdir(cwd);
  } catch {
    process.stderr.write(`runner: cannot chdir ${cwd}\n`);
    process.exit(2);
  }
}

const ctx = {
  fVersion: "0.3.1",
  contractVersion: 1,
  argv,
  env: process.env,
  cwd: () => cwd ?? process.cwd(),
  registry: {},
};
const uck = register(ctx);
await uck.run(argv, { _: argv }, ctx);
