// Test driver: invoke the creds uck's register().run() directly, so the suite
// exercises THIS working tree. `f creds …` would not: `f` clones the uck store
// into any HOME that lacks one, and an isolated-HOME run then executes a stale
// COPY of the code under test — green tests proving nothing about the edit.
// (The vaultwarden e2e suite hit this exact trap; see its header comment.)
//
// Usage: node test/run-command.mjs <creds-subcommand> [args…]
//
// run() resolves inside a floating IIFE, and success paths never call
// process.exit(0) — they rely on the event loop draining, which is how `f`
// reaches exit code 0. Errors DO call process.exit(1). So: flush what the
// commands wrote to a pipe, then exit on the exitCode they set. Awaiting
// register()/run() is not enough on its own — the spawned daemon can keep the
// loop alive past completion, which makes the caller wait for the whole TTL.
import { register } from "../index.js";

const uck = register({});
const argv = process.argv.slice(2);
// run() returns the command's promise. It used to fire a floating async IIFE and
// return synchronously, so awaiting run() exited the moment the switch was
// entered — `unlock` reported success with an empty .f/ because nothing had run.
await uck.run(argv, { _: argv });

// stdout to a pipe is asynchronous; drain so assertions see the output.
const finish = () => process.exit(process.exitCode ?? 0);
if (process.stdout.writableNeedDrain) process.stdout.once("drain", finish);
else finish();
