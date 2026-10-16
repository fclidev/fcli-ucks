#!/usr/bin/env node
// f creds daemon — holds the derived key in memory, serves ops over a unix socket,
// auto-exits after TTL. Zero deps (node:crypto, node:net, node:fs).

import crypto from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const args = {};
const FLAG_KEYS = ["socket", "lockfile", "ttl", "creds", "salt", "expires-at"];
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, "");
  if (FLAG_KEYS.includes(k) && i + 1 < argv.length) {
    args[k] = argv[i + 1];
    i++;
  }
}

const SOCKET = args.socket;
const LOCKFILE = args.lockfile;
const CREDS = args.creds;
const TTL_SEC = Number(args.ttl) || 600;

// Read passkey from stdin (never argv — argv is visible in ps).
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

// Derive a 32-byte key from passkey + salt via scrypt (slow KDF).
function deriveKey(passkey, salt) {
  return crypto.scryptSync(passkey, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 1 << 29 });
}

// Creds file format: { salt: base64, entries: { name: { nonce, tag, data } } }
// We store the salt in a plaintext header (it's not secret) + the entries encrypted.
function loadCredsBox() {
  if (!fs.existsSync(CREDS)) return { salt: crypto.randomBytes(16).toString("base64"), entries: {} };
  const raw = JSON.parse(fs.readFileSync(CREDS, "utf8"));
  return { salt: raw.salt, entries: raw.entries ?? {}, verifier: raw.verifier };
}
function saveCredsBox(box) {
  // Re-encrypt is per-entry at set time; here we just persist the box as-is.
  // Build the object explicitly rather than serialising `box`, because this
  // function used to emit ONLY {salt, entries}: the verifier blob was assigned
  // to box.verifier, appeared present in memory, and never reached disk — so
  // every unlock took the "first time" branch and a wrong passkey still served
  // the store. Any future plaintext header must be added here to be persisted.
  fs.writeFileSync(
    CREDS,
    JSON.stringify({ salt: box.salt, entries: box.entries, ...(box.verifier ? { verifier: box.verifier } : {}) }, null, 2),
    { mode: 0o600 }
  );
}

// Per-value encryption: AES-256-GCM over BYTES (so binary round-trips). Values
// arrive as either a utf8 string (`set`) or { b64 } raw bytes (`setb` / pack).
// decValue always returns a Buffer; callers decode.
function encBytes(key, buf) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const data = Buffer.concat([cipher.update(buf), cipher.final()]);
  return { nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}
function encValue(key, value) {
  if (value && typeof value === "object" && typeof value.b64 === "string") {
    return encBytes(key, Buffer.from(value.b64, "base64"));
  }
  return encBytes(key, Buffer.from(String(value), "utf8"));
}
function decValue(key, entry) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(entry.nonce, "base64")
  );
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(entry.data, "base64")), decipher.final()]);
}

// base64 is a single JSON token, so a raw value can't word-wrap in terminal
// scrollback into something un-decodable.
function b64(buf) {
  return buf.toString("base64");
}

/* ------------------------------------------------------------- key health */
/*
 * `unlock` used to accept ANY passkey, report `unlocked`, and then behave
 * erratically: reads of entries written under the real key failed with a raw
 * OpenSSL message, while `set` happily encrypted new entries with the wrong key
 * into the SAME file. One typo'd passkey therefore silently corrupted the store,
 * and the damage was indistinguishable from a crypto bug. Two guards:
 *
 *   1. a verifier blob, written when the daemon first holds a key that can
 *      decrypt every entry that existed at that moment, checked on every unlock;
 *   2. refusing to write when no existing entry decrypts (see canDecryptAny).
 *
 * There is deliberately no master password to re-derive and no re-encrypt path:
 * a wrong passkey is a wrong passkey, and the honest response is to stop.
 */

/** Derive the verifier key from the same (passkey, salt) pair. */
function verifierKey(passkey, salt) {
  return crypto.hkdfSync("sha256", deriveKey(passkey, salt), Buffer.from("f-creds-verifier-v1"), Buffer.alloc(0), 32);
}

/**
 * Can `key` decrypt `entries`? Reports the first entry that fails, or null if
 * every entry decrypts. Entries that fail are NOT junk in general — they are
 * exactly the entries written under a different key, which is the state we are
 * trying to make impossible.
 */
function firstUndecryptable(key, entries) {
  for (const [name, e] of Object.entries(entries ?? {})) {
    if (!e || !e.nonce || !e.tag || !e.data) continue; // not a ciphertext entry
    try {
      decValue(key, e);
    } catch {
      return name;
    }
  }
  return null;
}

/** True when at least one existing entry decrypts — the weak test that makes a
 *  write safe-ish. False only when the key matches NOTHING, i.e. a wrong key. */
function canDecryptAny(key, entries) {
  for (const e of Object.values(entries ?? {})) {
    if (!e || !e.nonce || !e.tag || !e.data) continue;
    try {
      decValue(key, e);
      return true;
    } catch {}
  }
  return Object.keys(entries ?? {}).length === 0;
}

let key = null;
let box = null;
// Set when the key has been shown, by decryption, to match the entries on disk.
// Allows the verifier to be seeded by the first `set` on a box that was empty of
// ciphertext at startup — which is the common case for a brand-new store, where
// there is no blob to check until something has been written.
let keyIsGood = false;
const VERIFIER_PLAINTEXT = "f-creds-verifier-v1";

const server = net.createServer((socket) => {
  let buf = "";
  socket.on("data", (c) => {
    buf += c;
    let req;
    try {
      req = JSON.parse(buf);
    } catch {
      return; // wait for full message
    }
    buf = "";
    let resp;
    try {
      switch (req.op) {
        case "ls":
          resp = { ok: true, names: Object.keys(box.entries) };
          break;
        case "get": {
          const e = box.entries[req.name];
          if (!e) resp = { ok: false, error: `no such cred: ${req.name}` };
          else if (req.b64) resp = { ok: true, b64: b64(decValue(key, e)) };
          else resp = { ok: true, value: decValue(key, e).toString("utf8") };
          break;
        }
        case "set": {
          // --- Guard 2: never encrypt new entries with a key that matches
          // nothing on disk. This is the actual corruption step, so it is the
          // last place to refuse. A store with one unrelated bad entry is still
          // writable (canDecryptAny is deliberately weak) so this cannot
          // brick a box that merely needs one name repaired.
          if (!keyIsGood && !canDecryptAny(key, box.entries)) {
            resp = {
              ok: false,
              error:
                `store holds entries this passkey cannot decrypt — wrong passkey? Refusing to mix keys. ` +
                `Lock, then unlock with the passkey that opened this store (or restore: f creds restore <file>).`,
            };
            break;
          }
          box.entries[req.name] = encValue(key, req.value);
          // Mirror entries carry an explicit expiry so freshness survives a lock
          // cycle (the value stays encrypted at rest; only the stamp is plaintext).
          if (Number.isFinite(req.expiresAt)) box.entries[req.name].expiresAt = req.expiresAt;
          saveCredsBox(box);
          if (!keyIsGood && !box.verifier) {
            // First successful write with a key that decrypted something: the
            // key is now proven against a known plaintext we control.
            try {
              box.verifier = encValue(Buffer.from(verifierKey(passkey, box.salt)), VERIFIER_PLAINTEXT);
              saveCredsBox(box);
              keyIsGood = true;
            } catch {}
          }
          resp = { ok: true };
          break;
        }// Existence + size + (optionally) base64 bytes, without a full get.
        case "has": {
          const e = box.entries[req.name];
          if (!e) resp = { ok: true, exists: false };
          else {
            const plain = decValue(key, e);
            resp = { ok: true, exists: true, bytes: plain.length, expiresAt: e.expiresAt, b64: req.b64 ? b64(plain) : undefined };
          }
          break;
        }
        // Plaintext metadata only — never the decrypted value. Used by `ls` to
        // annotate mirrors and by the freshness check.
        case "meta": {
          const e = box.entries[req.name];
          if (!e) resp = { ok: false, error: `no such cred: ${req.name}` };
          else resp = { ok: true, expiresAt: e.expiresAt };
          break;
        }
        case "clear-expires": {
          let n = 0;
          for (const e of Object.values(box.entries)) if (e && "expiresAt" in e) { delete e.expiresAt; n++; }
          if (n) saveCredsBox(box);
          resp = { ok: true, count: n };
          break;
        }
        // Bulk write. Each item {name, value}(utf8) or {name, b64}(raw). Stages
        // every item before touching the box, so one bad item aborts the whole pack.
        case "import": {
          const items = Array.isArray(req.items) ? req.items : null;
          if (!items?.length) resp = { ok: false, error: "import requires items[]" };
          else {
            const staged = [];
            let err = null;
            for (const it of items) {
              if (!it || typeof it.name !== "string" || !it.name) { err = "item missing name"; break; }
              try {
                staged.push({ name: it.name, entry: encValue(key, it.b64 != null ? { b64: it.b64 } : it.value) });
              } catch (e) {
                err = `${it.name}: ${e.message}`;
                break;
              }
            }
            if (err) resp = { ok: false, error: `import aborted: ${err}` };
            else {
              for (const s of staged) box.entries[s.name] = s.entry;
              saveCredsBox(box);
              resp = { ok: true, count: staged.length };
            }
          }
          break;
        }
        case "rm": {
          if (!(req.name in box.entries)) resp = { ok: false, error: `no such cred: ${req.name}` };
          else {
            delete box.entries[req.name];
            saveCredsBox(box);
            resp = { ok: true };
          }
          break;
        }
        default:
          resp = { ok: false, error: `unknown op: ${req.op}` };
      }
    } catch (e) {
      resp = { ok: false, error: e.message };
    }
    socket.end(JSON.stringify(resp));
  });
  socket.on("error", () => {});
});

function shutdown() {
  try {
    server.close();
    if (key) {
      key.fill(0); // zeroize
      key = null;
    }
    for (const f of [SOCKET, LOCKFILE]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

let passkey = await readStdin().then((s) => s.trim());
if (!passkey) {
  process.stderr.write("daemon: no passkey\n");
  process.exit(1);
}

box = loadCredsBox();
key = deriveKey(passkey, box.salt);

// --- Guard 1: prove this passkey is the one that opened the box before. ---
// Written once, on a box we could fully decrypt; checked every unlock after.
// Skipped only when the box had no entries to corrupt.
{
  const bad = firstUndecryptable(key, box.entries);
  const v = box.verifier;
  if (v && v.data) {
    let expected = null;
    try {
      expected = decValue(Buffer.from(verifierKey(passkey, box.salt)), v).toString("utf8");
    } catch {
      expected = null;
    }
    if (expected !== VERIFIER_PLAINTEXT) {
      // The single most important line in this file. Without it a wrong passkey
      // reported success and then corrupted the store on the first `set`.
      process.stderr.write("daemon: wrong passkey\n");
      process.exit(4);
    }
    if (bad) {
      // Verifier says the key is right, but an entry does not decrypt: the box
      // already has ciphertext from another key in it. Repairs are the operator's
      // call (restore a backup, or drop the bad name) — never silent.
      process.stderr.write(
        `daemon: passkey matches the store but '${bad}' does not decrypt with it — the box mixes keys. ` +
        `Restore a backup or drop that entry; refusing to serve or write.\n`
      );
      process.exit(4);
    }
  } else if (!bad) {
    // The key decrypts every existing entry (or there were none): it is the
    // right key for what is on disk, so adopt it and seed the verifier — the
    // only way the NEXT unlock can tell a right passkey from a wrong one.
    // Seeded on a non-empty box too: a store created before this check existed
    // would otherwise stay unchecked forever, which is the state the real store
    // was in when a mistyped passkey silently made its entries unreadable.
    keyIsGood = true;
    try {
      box.verifier = encValue(Buffer.from(verifierKey(passkey, box.salt)), VERIFIER_PLAINTEXT);
      saveCredsBox(box);
    } catch (e) {
      // Never fail an unlock over the verifier: a daemon that will not start is
      // worse than one that cannot yet detect a wrong passkey. Retried next unlock.
      process.stderr.write(`daemon: could not store passkey verifier: ${e?.message ?? e}\n`);
    }
  }
}

// An unlock refreshes the staleness clock on every mirror: "unlocked for TTL X"
// now means "the vault was live as of this unlock", so mirrors stay servable for
// min(mirrorTtl, daemonTtl) without any per-read bookkeeping.
const EXPIRES_AT = Number(args["expires-at"]);
if (Number.isFinite(EXPIRES_AT)) {
  let n = 0;
  for (const e of Object.values(box.entries)) {
    if (e && "expiresAt" in e) { e.expiresAt = EXPIRES_AT; n++; }
  }
  if (n) saveCredsBox(box);
}

server.listen(SOCKET, () => {
  fs.writeFileSync(
    LOCKFILE,
    JSON.stringify({ pid: process.pid, start: Date.now(), ttl: TTL_SEC, socket: SOCKET }),
    { mode: 0o600 }
  );
});

// Auto-exit after TTL.
const timer = setTimeout(shutdown, TTL_SEC * 1000);
timer.unref();

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    // Another daemon already owns the socket; clean up and exit.
    try {
      fs.unlinkSync(LOCKFILE);
    } catch {}
    process.exit(0);
  }
  throw e;
});
