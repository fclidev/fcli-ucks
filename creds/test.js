#!/usr/bin/env node
// Regression tests for credential unlock failure reporting.
//
//   node creds/test.js
//
// Background: a wrong passkey used to exit 0 with no output, indistinguishable
// from a successful unlock. Two defects caused it:
//   1. daemon.js derived the key but never verified it, so a bad key only surfaced
//      much later as an opaque AES-GCM error on the first `get`.
//   2. index.js spawned the daemon with stderr discarded and returned true
//      unconditionally, so a dead daemon looked identical to a live one.
//
// These drive daemon.js directly rather than through `f`, so they need no network
// and never touch the real ~/.f/f.creds.enc (each case gets a throwaway HOME).

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(HERE, "daemon.js");
const INDEX = path.join(HERE, "index.js");
const GOOD = "correct horse battery staple";

// MUST mirror daemon.js deriveKey: it passes box.salt as the base64 *string*
// read from JSON, not the decoded bytes. Deriving with Buffer.from(salt,"base64")
// produces a different key and makes every case look like a bad passkey.
function deriveKey(passkey, saltB64) {
  return crypto.scryptSync(passkey, saltB64, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 1 << 29 });
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// A sandbox HOME with a store containing one entry, encrypted under `passkey`.
// Pass passkey=null for a fresh (empty) box.
function sandbox(passkey) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "f-creds-test-"));
  const f = path.join(home, ".f");
  fs.mkdirSync(f, { recursive: true });
  const creds = path.join(f, "f.creds.enc");
  if (passkey !== null) {
    const salt = crypto.randomBytes(16).toString("base64");
    const key = deriveKey(passkey, salt);
    const nonce = crypto.randomBytes(12);
    const ci = crypto.createCipheriv("aes-256-gcm", key, nonce);
    const data = Buffer.concat([ci.update("secret-value"), ci.final()]);
    fs.writeFileSync(
      creds,
      JSON.stringify(
        {
          salt,
          entries: {
            probe: {
              nonce: nonce.toString("base64"),
              tag: ci.getAuthTag().toString("base64"),
              data: data.toString("base64"),
            },
          },
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    key.fill(0);
  }
  return { home, f, creds };
}

// Start the daemon, report whether it survived startup and any stderr.
function startDaemon(creds, passkey, f, waitMs = 3000) {
  return new Promise((resolve) => {
    const sock = path.join(f, "t.sock");
    const lock = path.join(f, "t.lock");
    const child = spawn(
      process.execPath,
      [DAEMON, "--socket", sock, "--lockfile", lock, "--ttl", "20", "--creds", creds],
      { detached: true, stdio: ["pipe", "ignore", "pipe"] }
    );
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => (err += c));
    child.stdin.on("error", () => {});
    child.stdin.end(passkey);
    setTimeout(() => {
      const alive = child.exitCode === null;
      if (alive) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
      resolve({ alive, code: child.exitCode, err: err.trim(), sock, lock });
    }, waitMs);
  });
}

function cleanup(s) {
  try {
    fs.rmSync(s.home, { recursive: true, force: true });
  } catch {}
}

console.log("f creds — unlock failure reporting");

// 1. Wrong passkey on a populated store must fail fast with a clear reason.
{
  const s = sandbox(GOOD);
  const r = await startDaemon(s.creds, "totally-wrong-passkey", s.f);
  check("wrong passkey: daemon refuses to start", !r.alive, "stayed alive");
  check("wrong passkey: non-zero exit", r.code === 2, `code=${r.code}`);
  check("wrong passkey: names the cause", /bad passkey/i.test(r.err), JSON.stringify(r.err));
  check("wrong passkey: no socket left behind", !fs.existsSync(r.sock), r.sock);
  cleanup(s);
}

// 2. Correct passkey must still work — the fix must not break the happy path.
{
  const s = sandbox(GOOD);
  const r = await startDaemon(s.creds, GOOD, s.f);
  check("correct passkey: daemon starts", r.alive, `died exit=${r.code} ${JSON.stringify(r.err)}`);
  cleanup(s);
}

// 3. A brand-new store has no entry to verify against and must unlock freely.
{
  const s = sandbox(null);
  const r = await startDaemon(s.creds, "first-time-passkey", s.f);
  check("fresh empty box: unlocks (nothing to verify)", r.alive, `died exit=${r.code} ${JSON.stringify(r.err)}`);
  cleanup(s);
}

// 4. The store must never be rewritten by a failed unlock.
{
  const s = sandbox(GOOD);
  const before = fs.readFileSync(s.creds);
  await startDaemon(s.creds, "wrong-on-purpose", s.f, 2000);
  const after = fs.readFileSync(s.creds);
  check("failed unlock leaves the store byte-identical", before.equals(after));
  cleanup(s);
}

// 5. Static guards against regressing the two original defects.
{
  const src = fs.readFileSync(INDEX, "utf8");
  check(
    "index.js does not discard daemon stderr",
    !/stdio:\s*\[\s*"pipe",\s*"ignore",\s*"ignore"\s*\]/.test(src),
    'found stdio ["pipe","ignore","ignore"]'
  );
  check(
    "index.js does not unconditionally report success",
    !/await waitForSocket\([^)]*\);\s*\n\s*return true;/.test(src),
    "waitForSocket result is ignored"
  );
  const daemon = fs.readFileSync(DAEMON, "utf8");
  check("daemon verifies the key at startup", /verifyKey\s*\(/.test(daemon) && /bad passkey/.test(daemon));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
