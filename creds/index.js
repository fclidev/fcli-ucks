// f creds — store credentials in ~/.f/f.creds.enc, protected by a passkey-derived
// key. Unlock spawns a daemon that holds the key in memory and serves ops over a
// unix socket until TTL expires. Zero deps.

// Provider table (see ./providers.js): every uck that exports a
// `credentialProvider` is consulted when a name is missing from the box, and the
// answer is mirrored back in as `mirror:<name>` with a ttl. Local always wins.
import { registerProvider, resolveViaProvider, listProviders, providerDiscoveryError, MIRROR_PREFIX, mirrorName, isMirrorKey, clearMisses, missBackoffLeft, mirrorSource, clearMirrorSource } from "./providers.js";

import net from "node:net";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import readline from "node:readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const F = path.join(process.env.HOME ?? "", ".f");
const CREDS = path.join(F, "f.creds.enc");
const SOCKET = path.join(F, ".creds.sock");
const LOCKFILE = path.join(F, ".creds-daemon");
const DAEMON = path.join(__dirname, "daemon.js");
const DEFAULT_TTL = 600; // 10 min

/* ------------------------------------------------ permanent file-based unlock */
/*
 * `f creds unlock --permanent` keeps the store open indefinitely and supplies
 * the passkey from a 0600 file instead of a prompt, so nothing has to type a
 * passphrase after a reboot. Two files, both under ~/.f:
 *
 *   UNLOCKKEY  the passkey itself (a 32-byte random hex string by default)
 *   UNLOCKMARK intent marker: exists => auto-start a permanent daemon on demand
 *
 * The threat model is exactly "a secret in a 0600 file", the same one as an SSH
 * private key: any process running as this uid, and root, can read it. Nothing
 * here is magic — the store's encryption is unchanged, only the way the key
 * reaches the daemon differs. `f creds lock` removes BOTH, so locking is a
 * deliberate act twice over and a stray `f creds get` cannot resurrect the box.
 */
const UNLOCKKEY = path.join(F, ".creds-unlock.key");
const UNLOCKMARK = path.join(F, ".creds-unlock");

/** "permanent" in human terms. A permanent unlock has no deadline, so quoting
 *  the uptime back as a countdown would be a lie about the thing we changed. */
function describeUnlock(state) {
  if (!state) return "locked";
  if (state.permanent) {
    const key = readPermanentKey();
    return `unlocked (permanent, since ${fmt(state.remainingMs)}${key ? `, key file: ${key}` : ""})`;
  }
  return `unlocked (${fmt(state.remainingMs)} left)`;
}

/** Marker + key file path, when a permanent unlock is configured. Returns the
 *  path or null; does not say whether the key file is readable. */
function readPermanentKey() {
  try {
    if (!fs.existsSync(UNLOCKMARK)) return null;
    const j = JSON.parse(fs.readFileSync(UNLOCKMARK, "utf8"));
    if (!j || typeof j !== "object") return null;
    return typeof j.keyFile === "string" && j.keyFile ? j.keyFile : UNLOCKKEY;
  } catch {
    return null;
  }
}

/** Read the unlock key. Strict on permissions: a group/world-readable or
 *  non-regular key file means someone else can have it, and unlocking with it
 *  would silently launder that exposure as "authenticated". */
function readUnlockKeyFile(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { error: `${file} does not exist` };
  }
  if (!st.isFile()) return { error: `${file} is not a regular file` };
  const mode = st.mode & 0o777;
  if (mode & 0o077) {
    return {
      error:
        `${file} is mode ${mode.toString(8)} — refusing to use a group/world-readable unlock key. ` +
        `Fix with: chmod 600 ${file}`,
    };
  }
  const key = fs.readFileSync(file, "utf8").trim();
  if (!key) return { error: `${file} is empty` };
  return { key, file };
}

/** Remove the permanent-unlock intent + key file. Used by `lock`, and by a
 *  failed auto-unlock so a broken key file cannot spew a warning on every
 *  subsequent creds command. */
function clearPermanentUnlock({ removeKey = false } = {}) {
  const errs = [];
  const configured = readPermanentKey();
  try {
    fs.unlinkSync(UNLOCKMARK);
  } catch (e) {
    if (e.code !== "ENOENT") errs.push(`${UNLOCKMARK}: ${e.message}`);
  }
  if (removeKey && configured) {
    try {
      fs.unlinkSync(configured);
    } catch (e) {
      if (e.code !== "ENOENT") errs.push(`${configured}: ${e.message}`);
    }
  }
  return errs;
}

/** Mirror entries are vault-sourced and expire; stamp the expiry on store. */
async function setMirror(name, value, ttlMs, state) {
  const st = state ?? (await requireUnlocked());
  const r = await daemonCall(
    { op: "set", name, value: { b64: Buffer.from(String(value), "utf8").toString("base64") }, expiresAt: Date.now() + ttlMs },
    st.socket,
  );
  if (!r.ok) throw new Error(r.error);
}

/** Read all of piped stdin. Used by `set` so a secret need not sit in argv. */
function readAllStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

/**
 * Delete a mirror entry AND the provenance record describing it.
 *
 * The two live in different places — the value in the encrypted box, the
 * `src:<key>` provenance in the plaintext cache file — so a deletion that skips
 * the second leaves a record naming a provider for a mirror that no longer
 * exists. `clearMirrorSource` was exported for exactly this and never called.
 * One helper so the pair cannot drift apart at a future call site.
 *
 * Uses daemonCall, not op(): op() process.exit(1)s on a missing entry and that
 * is uncatchable, so a mirror expiring mid-sweep would abort the whole sweep.
 */
async function dropMirror(key, state) {
  const st = state ?? (await requireUnlocked());
  const r = await daemonCall({ op: "rm", name: key }, st.socket).catch(() => ({ ok: false }));
  // Clear provenance even when the entry was already gone: an expired mirror
  // leaving its record behind is precisely the leak being fixed.
  clearMirrorSource(key);
  return !!r?.ok;
}

/**
 * Is mirror:<name> still within its freshness window?
 *
 * `ttlSec` is a SECONDS upper bound, never a grant of freshness. The provider's
 * mirrorTtl is clamped to the daemon's own remaining lifetime, so a mirror is
 * servable only while the store is unlocked and within the provider's window.
 * A locked store therefore always counts as stale and forces a provider
 * round-trip on the next unlock — mirrors never outlive the session that
 * fetched them. The stored `expiresAt` is rebased to the daemon lifetime on
 * every unlock (see daemon.js), so this needs no per-read bookkeeping.
 */
async function isMirrorFresh(name, ttlSec) {
  const state = unlockedState();
  if (!state) return false;
  const daemonSecsLeft = Math.max(0, Math.floor(state.remainingMs / 1000));
  const capSec = Math.min(ttlSec, daemonSecsLeft);
  if (capSec <= 0) return false;
  const r = await daemonCall({ op: "meta", name: MIRROR_PREFIX + name }, state.socket);
  if (!r.ok || !Number.isFinite(r.expiresAt)) return false;
  return Date.now() < r.expiresAt;
}

/** Read a raw cred without touching providers (used by the resolver itself). */
async function rawGet(name, state) {
  const st = state ?? unlockedState();
  if (!st) return null;
  const r = await daemonCall({ op: "get", name }, SOCKET);
  return r.ok ? r.value : null;
}

/**
 * Resolve one cred name for a *program* — a uck, not a human.
 *
 * Why this exists as its own entry point: reading the box over the raw socket
 * (the cheap way) only sees names that were actually `set` locally. A cred that
 * lives in a provider — Vaultwarden and friends — exists locally ONLY as the
 * `mirror:<name>` entry, under a different key and a TTL, so a socket `get` of
 * the plain name misses and the uck concludes the credential does not exist.
 * `f ha` and `f gh` were silently broken exactly that way while `f fj` worked,
 * purely because its token happened to be stored locally.
 *
 * Order: local name -> provider ladder (which serves a fresh mirror without any
 * network round trip) -> the raw `mirror:<name>` entry as a last resort. That
 * last step is what makes a vault-backed cred resolvable while the provider is
 * down, which the ladder refuses to do on its own (it reports the mirror stale).
 *
 * Returns { value, source } | { error } | { missing } | { locked }.
 * Never prints anything: the value only ever goes to the caller in memory.
 */
export async function lookupCred(name, opts = {}) {
  const state = unlockedState();
  if (!state) return { locked: true };

  if (!opts.forceProvider) {
    const local = await daemonCall({ op: "get", name }, state.socket);
    if (local.ok && local.value != null && local.value !== "") {
      // Never report a mirror entry as a local cred, even when asked for by its
      // prefixed key: the value is the provider's, its expiry is the provider's,
      // and `local:` tells the operator the box is authoritative when it is not.
      // No staleness judgement here on purpose. Freshness is a function of the
      // provider's TTL and the daemon's own remaining life, and `isMirrorFresh`
      // is the single place that computes it — called below, via the ladder. A
      // guess here would be a second, weaker copy of that rule.
      const mirrored = isMirrorKey(name);
      return { value: local.value, source: mirrored ? `mirror (${name.slice(MIRROR_PREFIX.length)})` : `local:${name}` };
    }
  }

  if (!opts.localOnly) {
    const res = await resolveViaProvider(name, {
      getCred: (k) => rawGet(k, state),
      setMirror: (k, v, t) => setMirror(k, v, t, state),
      isFresh: (n, t) => (opts.forceProvider ? async () => false : isMirrorFresh),
    });
    if (res.value != null) {
      // A stale mirror is still the answer, but say so — callers print `source`.
      return { value: res.value, source: res.mirror ? `mirror (${res.mirror})` : `${res.provider}:${name}`, warning: res.warning };
    }
    if (res.error) return { error: `provider '${res.provider}' failed: ${res.error}` };
    if (res.none) return { missing: true, note: res.note };

    // Nothing live, nothing fresh: fall back to the raw mirror entry rather than
    // reporting a credential we demonstrably still hold.
    if (!opts.forceProvider) {
      const mirrored = await daemonCall({ op: "get", name: MIRROR_PREFIX + name }, state.socket);
      if (mirrored.ok && mirrored.value) return { value: mirrored.value, source: `mirror (unverified)`, stale: true };
    }
  }
  return { missing: true };
}

/** Resolve several names, first hit wins, one process' worth of work each.
 *  Returns { value, source, name } | { error } | { locked } | { missing }. */
export async function lookupFirst(names, opts = {}) {
  let firstError = null;
  for (const name of names) {
    const r = await lookupCred(name, opts);
    if (r.value != null) return { ...r, name };
    if (r.locked) return { locked: true };
    if (r.error && !firstError) firstError = { error: r.error, name };
  }
  return firstError ?? { missing: true };
}

/** Remove a socket/lockfile pair whose daemon is gone. A killed daemon leaves
 *  the socket FILE behind, and a new daemon cannot bind to it — so an
 *  auto-unlock that skips this fails with "socket already in use" and looks
 *  exactly like a broken key file. `unlock` has always done this; the auto path
 *  needs the same cleanup or it can never recover from a crash or reboot. */
function clearStaleSocket() {
  for (const f of [SOCKET, LOCKFILE]) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
}

/**
 * Auto-start a permanent daemon if one is configured and the box is closed.
 *
 * This is what makes a permanent unlock survive a reboot without anyone typing
 * a passphrase: the marker says "this store is allowed to open itself", the key
 * file says with what. It is best-effort and deliberately loud on failure — a
 * broken key file must never masquerade as "locked, just unlock it", and must
 * not warn on every command forever, so a hard failure clears the marker.
 *
 * Returns an unlocked state or null. Never prompts, never touches providers.
 */
async function autoUnlockPermanent() {
  const keyFile = readPermanentKey();
  if (!keyFile) return null;
  const read = readUnlockKeyFile(keyFile);
  if (read.error) {
    const errs = clearPermanentUnlock();
    process.stderr.write(
      `f: permanent unlock is unusable (${read.error}); removed the permanent-unlock marker.` +
      `${errs.length ? ` Could not remove it: ${errs.join("; ")}` : ""}\n`
    );
    return null;
  }
  // No live daemon answered (that is why we are here), so anything on the socket
  // path is a corpse from the previous daemon.
  clearStaleSocket();
  const result = await startDaemon(read.key, 0);
  if (result.announcement?.ok) {
    // A permanent daemon keeps this process' event loop alive: the pipes to it
    // are open handles with no deadline, so a uck that merely read a cred would
    // never exit. The daemon is detached and self-sustaining, so drop our end of
    // the pipes; it keeps running and its own end stays writable.
    for (const s of [result.child?.stdout, result.child?.stderr, result.child?.stdin]) {
      try { s?.unref?.(); } catch {}
    }
    process.stderr.write("f: unlocked permanently (key file)\n");
    return unlockedState();
  }
  // The key file no longer matches the box (restored backup? new store?). A
  // permanent unlock that cannot open the store is not a permanent unlock.
  const why = (result.stderr || "").trim().split("\n")[0] || result.announcement?.error || "daemon did not start";
  const errs = clearPermanentUnlock();
  process.stderr.write(
    `f: permanent unlock failed (${why}); removed the permanent-unlock marker ` +
    `so the store stays locked until you unlock it by hand.` +
    `${errs.length ? ` Could not remove it: ${errs.join("; ")}` : ""}\n`
  );
  return null;
}

/** Ask for the permanent key file to be (re)created. Set when no key file
 *  existed; refused by `f creds unlock <passkey>`, which is an explicit one-shot
 *  unlock and must not silently install a permanent key. */
function ensureFDir() {
  fs.mkdirSync(F, { recursive: true });
}

function readLockfile() {
  try {
    return JSON.parse(fs.readFileSync(LOCKFILE, "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function unlockedState() {
  const lf = readLockfile();
  if (!lf || !lf.pid || !pidAlive(lf.pid)) return null;
  const now = Date.now();
  // A permanent daemon stores ttl: null and has no deadline at all; `lf.start`
  // doubles as "when did this session begin" purely so `status` can show an age.
  if (lf.permanent) return { remainingMs: now - (lf.start ?? now), socket: lf.socket, pid: lf.pid, permanent: true };
  if (!Number.isFinite(lf.ttl)) {
    // A lockfile with no usable ttl is not a countdown we can honour. Treating
    // it as expired is the safe reading: it refuses service rather than serving
    // forever, and the next `unlock` rewrites it correctly.
    return null;
  }
  const expires = lf.start + lf.ttl * 1000;
  if (now >= expires) return null; // expired (daemon will clean itself up)
  return { remainingMs: expires - now, socket: lf.socket, pid: lf.pid, permanent: false };
}

/** Talk to the daemon over the socket. Returns the JSON response. */
function daemonCall(req, socketPath = SOCKET) {
  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath, () => {
      client.write(JSON.stringify(req));
    });
    let buf = "";
    client.on("data", (c) => (buf += c));
    client.on("end", () => {
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(e);
      }
    });
    client.on("error", reject);
  });
}

async function promptPasskey() {
  // Read the passkey from the TTY in raw mode without echoing it.
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    const line = await new Promise((r) => rl.question("f: passkey: ", (a) => { rl.close(); r(a); }));
    return line;
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    process.stderr.write("f: passkey: ");
    let buf = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    };
    const onData = (ch) => {
      const s = ch.toString();
      for (const c of s) {
        if (c === "\n" || c === "\r") {
          cleanup();
          process.stderr.write("\n");
          resolve(buf);
          return;
        }
        if (c === "\x7f" || c === "\x08") {
          if (buf.length) buf = buf.slice(0, -1);
        } else if (c === "\x03") {
          cleanup();
          process.stderr.write("\n");
          process.exit(1);
        } else {
          buf += c;
        }
      }
    };
    stdin.on("data", onData);
  });
}

/** Prompt for a value from the TTY (no echo). Reuses the passkey raw-mode
 *  pattern; returns the typed string, or null on Ctrl-C. */
async function promptVisible(label) {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    const line = await new Promise((r) => rl.question(label, (a) => { rl.close(); r(a); }));
    return line;
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    process.stderr.write(label);
    let buf = "";
    const cleanup = (done) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      if (done) process.stderr.write("\n");
    };
    const onData = (ch) => {
      const s = ch.toString();
      for (const c of s) {
        if (c === "\n" || c === "\r") { cleanup(true); resolve(buf); return; }
        if (c === "\x7f" || c === "\x08") { if (buf.length) buf = buf.slice(0, -1); }
        else if (c === "\x03") { cleanup(true); resolve(null); }
        else { buf += c; }
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * A prompt function for `fill`. In a TTY, prompts interactively (no echo).
 * In non-TTY (piped), reads one line per call from a SINGLE shared readline so
 * a piped multi-line input fills multiple waiters in sequence. */
function makeFillPrompt() {
  if (process.stdin.isTTY) {
    // Interactive: prompt one at a time, no echo.
    return (label) => promptVisible(label);
  }
  // Non-TTY (piped): read all of stdin up front, serve one line per prompt.
  // This makes `printf 'V1\nV2\n' | f creds fill` fill multiple waiters.
  const lines = [];
  let buf = "";
  const done = new Promise((res) => {
    if (!process.stdin.readable) return res();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    process.stdin.on("end", () => { if (buf) lines.push(buf); res(); });
  });
  let idx = 0;
  return async (label) => {
    process.stderr.write(label);
    await done;
    const v = idx < lines.length ? lines[idx++] : "";
    return v;
  };
}

/**
 * Start the daemon. `ttl` of 0 means permanent (see daemon.js).
 *
 * The daemon, not the filesystem, is the authority on whether it came up: it
 * announces {ok, ttl, permanent, error} on stdout before it can be detached.
 * Watching for the socket file used to be the only signal, which could not tell
 * "daemon refused the passkey" from "daemon is still starting", and could not
 * see a ttl the daemon had rewritten (the `--permanent` request goes in as one
 * flag and comes back as ttl=0).
 */
async function startDaemon(passkey, ttl) {
  let daemonErr = "";
  const expiresAt = ttl ? Date.now() + ttl * 1000 : 0;
  const child = spawn(process.execPath, [DAEMON, "--socket", SOCKET, "--lockfile", LOCKFILE, "--ttl", String(ttl), "--creds", CREDS, "--expires-at", String(expiresAt)], {
    detached: true,
    // Daemon stderr was `ignore`d, so the one message that matters — `wrong
    // passkey` — was thrown away, and the CLI fell through to `unlocked`.
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr?.on("data", (c) => (daemonErr += c));

  const announcement = await new Promise((resolve) => {
    let line = "";
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c) => {
      line += c;
      const nl = line.indexOf("\n");
      if (nl < 0) return;
      try {
        finish(JSON.parse(line.slice(0, nl)));
      } catch {
        finish(null);
      }
    });
    child.on("error", (e) => {
      daemonErr += `\n${e.message}`;
      finish(null);
    });
    child.on("exit", () => finish(null));
    child.stdin.on("error", () => {}); // EPIPE when the daemon exits before reading the passkey
    child.stdin.write(passkey);
    child.stdin.end();
    // Cap the wait so a wedged daemon cannot hang the CLI forever.
    setTimeout(() => finish(null), 15000).unref();
  });

  if (announcement?.ok) {
    // Only detach once the daemon has proved it is serving. If we unref'd a
    // daemon that then died, the parent would have nothing keeping its event
    // loop alive and would exit before reading the failure.
    child.unref();
  } else {
    try { child.kill("SIGKILL"); } catch {}
  }
  return { announcement, stderr: daemonErr, child };
}

/** Explain a failed start in the operator's terms. */
function reportUnlockFailure({ announcement, stderr }) {
  const why = (stderr || "").trim().split("\n")[0] || announcement?.error || "daemon did not start";
  if (/wrong passkey/i.test(stderr || "")) {
    process.stderr.write(
      "f: wrong passkey — nothing was unlocked and nothing was written.\n" +
      "   The store is unchanged. If the passkey is genuinely lost, the entries\n" +
      "   are unrecoverable; restore a backup with: f creds restore <file>\n"
    );
  } else {
    process.stderr.write(`f: could not unlock: ${why}\n`);
  }
}

async function unlock(passkeyArg, ttl, opts = {}) {
  ensureFDir();
  // The file existing says nothing about the key it holds — a daemon started with
  // a wrong passkey serves `ls` fine and fails later on every `get`. Probe it.
  const live = await probeSocket(SOCKET);
  if (live) {
    process.stderr.write(`f: already unlocked (${fmt(live.remainingMs)}${live.permanent ? ", permanent" : ""} left)\n`);
    return true;
  }
  // A socket file whose daemon is gone (or whose key is bad) must be cleared,
  // or the next unlock would report instant false success.
  if (fs.existsSync(SOCKET)) clearStaleSocket();

  // A requested ttl overrides an existing key file; supplying a passkey by hand
  // is an explicit, one-shot unlock and must not quietly become permanent.
  let permanent = !!opts.permanent;
  let keyFile = opts.keyFile ?? null;
  if (!permanent && !passkeyArg && !opts.keyFile && ttl === undefined) {
    const configured = readPermanentKey();
    if (configured) {
      permanent = true;
      keyFile = configured;
    }
  }

  let keyFromFile = null;
  if (permanent && !passkeyArg) {
    const target = keyFile ?? UNLOCKKEY;
    if (!fs.existsSync(target)) {
      if (!opts.createKey) {
        process.stderr.write(
          `f: no unlock key at ${target}. Create one with:\n` +
          `   f creds unlock --permanent   (writes the key, then unlocks)\n`
        );
        return false;
      }
      // Generate, then read back through the same permission-checked path so the
      // file we unlock with is the file we just verified is 0600 and non-empty.
      const created = createUnlockKey(target, opts.keyLabel ?? "f creds permanent unlock key");
      if (created.error) {
        process.stderr.write(`f: ${created.error}\n`);
        return false;
      }
      process.stderr.write(`f: wrote unlock key ${target} (0600)\n`);
    }
    const read = readUnlockKeyFile(target);
    if (read.error) {
      process.stderr.write(`f: ${read.error}\n`);
      return false;
    }
    keyFromFile = read;
  }

  const passkey = passkeyArg ?? keyFromFile?.key ?? (await promptPasskey());
  if (!passkey) {
    process.stderr.write("f: no passkey\n");
    return false;
  }
  const effectiveTtl = permanent ? 0 : (ttl ?? DEFAULT_TTL);
  const result = await startDaemon(passkey, effectiveTtl);
  if (!result.announcement?.ok) {
    reportUnlockFailure(result);
    return false;
  }

  // Trust the daemon's own ttl: `--permanent` is a request, ttl 0 is the fact.
  permanent = !!result.announcement.permanent;
  if (permanent) {
    writePermanentMarker(keyFromFile?.file ?? UNLOCKKEY, {
      source: passkeyArg ? "argument" : "key-file",
    });
    process.stderr.write("f: unlocked permanently (no expiry). Revert with: f creds lock\n");
  }
  return true;
}

/** Create the unlock key file with a tight mode. The value is random, so
 *  writing it through a descriptor is fine — it is never a user passphrase. */
function createUnlockKey(file, label) {
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(fd, crypto.randomBytes(32).toString("hex") + "\n");
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(file, 0o600);
    return { file };
  } catch (e) {
    if (e.code === "EEXIST") {
      return { error: `${file} already exists — refusing to overwrite an existing unlock key` };
    }
    return { error: `could not create ${file}: ${e.message}` };
  }
}

function writePermanentMarker(keyFile, extra = {}) {
  try {
    fs.writeFileSync(UNLOCKMARK, JSON.stringify({ keyFile, since: Date.now(), ...extra }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(UNLOCKMARK, 0o600); } catch {}
    return true;
  } catch (e) {
    // The daemon is unlocked either way; a missing marker only costs auto-restart
    // after a crash, so say so rather than failing an unlock that worked.
    process.stderr.write(`f: unlocked, but could not write ${UNLOCKMARK}: ${e.message}\n`);
    return false;
  }
}

/**
 * Stop the daemon and zeroize the key. For a permanently-unlocked store this
 * also clears the auto-unlock marker: otherwise the very next `f creds get`
 * would start a new daemon from the key file and the operator's `lock` would
 * appear to have done nothing. The key file itself survives (it is a secret you
 * may want to keep) unless --purge asks for its deletion.
 */
function lock(opts = {}) {
  const lf = readLockfile();
  const hadMarker = !!readPermanentKey();
  const keyPath = readPermanentKey() ?? UNLOCKKEY;
  const errs = clearPermanentUnlock({ removeKey: !!opts.purge });
  // Read the paths BEFORE clearing them: a message that reports what it deleted
  // must not print `undefined` for the file it just removed.
  const describe = (verb) =>
    verb +
    (hadMarker ? " and removed the permanent-unlock marker" : "") +
    (opts.purge ? ` and deleted ${keyPath}` : "") +
    (errs.length ? ` (${errs.join("; ")})` : "") +
    "\n";
  if (!lf || !pidAlive(lf.pid)) {
    if (hadMarker) {
      // The marker is the only thing that makes this store auto-openable, so
      // removing it is the meaningful outcome even with no daemon to signal.
      process.stderr.write(describe("f: no daemon was running; removed the permanent-unlock marker"));
    } else {
      process.stderr.write("f: not unlocked\n");
      for (const f of [SOCKET, LOCKFILE]) try { fs.unlinkSync(f); } catch {}
    }
    return;
  }
  process.kill(lf.pid, "SIGTERM");
  process.stderr.write(describe("f: locked"));
}

/**
 * State for the programmatic API. A configured permanent unlock may open itself
 * here; an unconfigured one must NEVER prompt, because a uck in a pipeline is
 * not a human at a terminal. Still returns null when locked — `CredsError.locked`
 * is how sibling ucks decide to ask for `f creds fill`.
 */
async function apiState() {
  const state = unlockedState();
  if (state) return state;
  return autoUnlockPermanent();
}

async function requireUnlocked() {
  let state = unlockedState();
  if (!state) state = await autoUnlockPermanent();
  if (!state) {
    process.stderr.write("f: creds locked. Run `f creds unlock`\n");
    process.exit(1);
  }
  return state;
}

async function op(name, value) {
  const state = await requireUnlocked();
  const resp = await daemonCall({ op: name, name: value?.name, value: value?.value }, state.socket);
  if (!resp.ok) {
    process.stderr.write(`f: ${resp.error}\n`);
    process.exit(1);
  }
  return resp;
}

/** Read all of stdin as a Buffer (for `pack -`). */
function readStdinBuf() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(Buffer.from(c)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", reject);
  });
}

/** Raw (binary-safe) get: returns a Buffer via the daemon's base64 op. */
async function getBuf(name, state) {
  const r = await daemonCall({ op: "get", name, b64: true }, state.socket);
  if (!r.ok) throw new Error(r.error);
  return Buffer.from(r.b64 ?? "", "base64");
}

/** Store raw bytes for a name (one daemon round-trip, no argv/shell/size limits). */
async function setBuf(name, buf, state) {
  const r = await daemonCall({ op: "set", name, value: { b64: buf.toString("base64") } }, state.socket);
  if (!r.ok) throw new Error(r.error);
}

/** Bulk-write entries in ONE daemon round-trip (daemon stages -> all-or-nothing). */
async function daemonImport(items, state) {
  const r = await daemonCall({ op: "import", items }, state.socket);
  if (!r.ok) throw new Error(r.error);
  return r.count;
}

/** Manifest of packed files: { "file:<abs>": meta }. Kept as a normal cred entry. */
const FILES_KEY = "files";

async function loadIndex(state) {
  try {
    const r = await daemonCall({ op: "get", name: FILES_KEY }, state.socket);
    if (!r.ok || r.value == null || r.value === "") return {};
    const j = JSON.parse(r.value);
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch (e) {
    throw new Error(`manifest '${FILES_KEY}' is unreadable (${e.message}) — refusing to touch it; inspect with: f creds get ${FILES_KEY}`);
  }
}
async function saveIndex(idx, state) {
  await setBuf(FILES_KEY, Buffer.from(JSON.stringify(idx, null, 2), "utf8"), state);
}

function expandTilde(p) {
  return p.startsWith("~") ? path.join(process.env.HOME ?? "", p.slice(1)) : p;
}
function looksLikePath(a) {
  return a.startsWith("/") || a.startsWith("~/") || a.startsWith("./") || a.startsWith("../");
}

/** Recurse a dir into { file } targets, skipping node_modules/.git. */
function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.isFile()) out.push({ file: p });
  }
  return out;
}

/** Expand pack targets: files, '-' = stdin, or '<dir>/...' = every uck dir in <dir>. */
function expandTargets(rest) {
  const targets = [];
  for (const spec of rest) {
    if (spec === "-") { targets.push({ stdin: true }); continue; }
    const m = /^(.*?)\/\.\.\.$/.exec(spec);
    if (m) {
      const dir = path.resolve(m[1]);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);
      const ucks = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "index.js")))
        .map((d) => d.name).sort();
      if (!ucks.length) throw new Error(`no ucks (dirs with index.js) under ${dir}`);
      for (const u of ucks) targets.push(...walk(path.join(dir, u)));
      continue;
    }
    const p = path.resolve(spec);
    if (!fs.existsSync(p)) throw new Error(`no such file: ${spec}`);
    if (fs.statSync(p).isDirectory()) throw new Error(`${spec} is a directory — use '${spec}/...' for ucks, or name files`);
    targets.push({ file: p });
  }
  return targets;
}

async function pack(targets, { as, force, dryRun } = {}) {
  const state = await requireUnlocked();
  const idx = await loadIndex(state);
  const items = [];
  const rows = [];
  let mode = null;

  const stdinOnly = targets.length === 1 && targets[0].stdin;
  if (stdinOnly) {
    const name = as;
    if (!name) throw new Error("pack - needs --as <name> (stdin has no path)");
    const buf = await readStdinBuf();
    items.push({ name, b64: buf.toString("base64") });
    rows.push({ name, bytes: buf.length });
  } else {
    for (const t of targets) {
      const buf = fs.readFileSync(t.file);
      if (buf.includes(0) && !force) {
        throw new Error(`${t.file}: contains NUL (binary) — pass --force to pack it anyway`);
      }
      const key = "file:" + t.file;
      const m = fs.statSync(t.file).mode & 0o777;
      if (mode === null) mode = m; else if (m !== mode) mode = false;
      items.push({ name: key, b64: buf.toString("base64") });
      rows.push({ name: key, bytes: buf.length, replace: key in idx });
      idx[key] = { bytes: buf.length, mode: m, packed: new Date().toISOString() };
    }
  }

  if (dryRun) {
    for (const r of rows) process.stdout.write(`would pack\t${r.name}\t${r.bytes}${r.replace ? "\t(replaces existing)" : ""}\n`);
    return;
  }

  await daemonImport(items, state);            // atomic: all items or none
  if (!stdinOnly) await saveIndex(idx, state); // manifest after the data
  for (const r of rows) process.stdout.write(`packed\t${r.name}\t${r.bytes}\n`);
  if (mode) process.stdout.write(`packed\tmode\t${mode.toString(8)}\n`);
  process.stdout.write(`ok\t${items.length} item(s)\n`);
}

/** Build restore specs from argv. Handles `--all`, `<abs>`, `bare`, and
 *  `<src> => <dst>` (the arrow arrives as its OWN argv token because f's harness
 *  passes positionals only). Returns { all, specs }. */
function buildUnpackSpecs(args_) {
  if (args_.includes("--all")) return { all: true, specs: [] };
  const specs = [];
  for (let i = 0; i < args_.length; i++) {
    const a = args_[i];
    if (a === "=>" || a === "->") {
      const prev = specs[specs.length - 1];
      const dst = args_[++i];
      if (!prev || !dst) throw new Error(`bad '${a}' mapping (want '<src> ${a} <dst>')`);
      prev.key = prev.bare ? prev.orig : "file:" + prev.orig;
      prev.dest = path.resolve(expandTilde(dst));
      continue;
    }
    if (a.includes("=>")) {
      const j = a.indexOf("=>");
      const src = a.slice(0, j).trim(), dst = a.slice(j + 2).trim();
      if (!src || !dst) throw new Error(`bad mapping '${a}' (want '<src> => <dst>')`);
      specs.push({ key: looksLikePath(src) ? "file:" + path.resolve(expandTilde(src)) : src, dest: path.resolve(expandTilde(dst)) });
      continue;
    }
    if (looksLikePath(a)) {
      const p = path.resolve(expandTilde(a));
      specs.push({ key: "file:" + p, dest: p, orig: a });
      continue;
    }
    specs.push({ key: a, dest: path.resolve(a), bare: true, orig: a });
  }
  return { all: false, specs };
}

async function unpack(args_, { force, dir } = {}) {
  const state = await requireUnlocked();
  if (args_.includes("--all") && dir && force) {
    throw new Error("--all --dir --force is refused: --dir is for safe staging — resolve existing files yourself, or map paths explicitly");
  }
  let mode = null;

  // raw to stdout: `<name> -`
  if (args_.includes("-")) {
    const name = args_.filter((x) => x !== "-")[0];
    if (!name) throw new Error("unpack - needs <name>");
    const key = looksLikePath(name) ? "file:" + path.resolve(expandTilde(name)) : name;
    const buf = await getBuf(key, state);
    process.stdout.write(buf);
    process.stderr.write(`f creds: wrote ${buf.length} bytes of '${key}' to stdout\n`);
    return;
  }

  const built = buildUnpackSpecs(args_);
  let specs = built.specs;
  if (built.all) {
    const idx = await loadIndex(state);
    const keys = Object.keys(idx);
    if (!keys.length) throw new Error(`nothing packed (manifest '${FILES_KEY}' is empty)`);
    specs = keys.map((k) => {
      const p = k.startsWith("file:") ? k.slice(5) : null;
      if (!p || !p.startsWith("/")) throw new Error(`manifest key '${k}' is not a packed absolute path — refusing to guess a destination`);
      return { key: k, dest: p };
    });
    const modes = new Set(keys.map((k) => idx[k]?.mode));
    if (modes.size === 1) mode = [...modes][0];
  }

  if (dir) for (const s of specs) s.dest = path.join(dir, s.dest.replace(/^\//, ""));

  const planned = [];
  for (const s of specs) {
    const r = await daemonCall({ op: "has", name: s.key, b64: true }, state.socket);
    if (!r.ok) throw new Error(r.error);
    if (!r.exists) throw new Error(`no such cred: ${s.key}${s.bare ? " (for a file, pass an absolute path)" : ""}`);
    planned.push({ ...s, b64: r.b64, exists: fs.existsSync(s.dest) });
  }
  for (const p of planned) {
    if (p.exists && !force) throw new Error(`${p.dest} already exists — pass --force to overwrite (a .bak is written either way once you do)`);
  }
  for (const p of planned) {
    const buf = Buffer.from(p.b64 ?? "", "base64");
    fs.mkdirSync(path.dirname(p.dest), { recursive: true });
    if (p.exists) {
      const bak = `${p.dest}.bak`;
      fs.copyFileSync(p.dest, bak);
      process.stdout.write(`backed-up\t${p.dest}\t${bak}\n`);
    }
    fs.writeFileSync(p.dest, buf);
    if (mode != null) fs.chmodSync(p.dest, mode);
    process.stdout.write(`restored\t${p.key}\t${p.dest}\t${buf.length}\n`);
  }
  process.stdout.write(`ok\t${planned.length} file(s)\n`);
}

/** List the manifest: terse rows, or full JSON with --json. */
async function filesLs({ json } = {}) {
  const state = await requireUnlocked();
  const idx = await loadIndex(state);
  const keys = Object.keys(idx);
  if (json) { process.stdout.write(JSON.stringify(idx, null, 2) + "\n"); return; }
  if (!keys.length) { process.stdout.write("(nothing packed — f creds files pack <path>)\n"); return; }
  for (const k of keys) {
    const p = k.startsWith("file:") ? k.slice(5) : k;
    const e = idx[k] ?? {};
    const mode = typeof e.mode === "number" ? e.mode.toString(8) : "?";
    process.stdout.write(`${p}\t${e.bytes ?? "?"}\t${mode}\t${e.packed ?? "?"}\n`);
  }
  process.stdout.write(`ok\t${keys.length} file(s)\n`);
}

/**
 * Parse a duration into whole seconds. Accepts a bare number (seconds),
 * unit suffixes (s/m/h/d/w), or combined parts: "90", "45s", "10m", "1h30m",
 * "2h", "1d", "1d6h30m", "2w". Units: s/m(=min)/h/d/w. No clamp — the caller
 * gets what it asks for (note Node's setTimeout caps out near ~24.8 days).
 */
function parseDurationSec(v, label = "duration") {
  const str = String(v).trim();
  if (str === "") throw new Error(`${label} is empty`);
  if (/^\d+$/.test(str)) return parseInt(str, 10); // bare seconds
  const units = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  let total = 0, matched = 0;
  const re = /(\d+)\s*([smhdw])/g;
  let m;
  while ((m = re.exec(str))) { total += parseInt(m[1], 10) * units[m[2]]; matched += m[0].length; }
  if (matched === 0 || matched !== str.replace(/\s+/g, "").length) {
    throw new Error(`invalid ${label} '${v}' (use e.g. 5m, 2h, 1d, 2w, 1d6h30m, or plain seconds)`);
  }
  return total;
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/** Shared waiter registry (on disk, visible across processes). A uck that
 *  calls wait() records itself here; `f creds waiters`/`fill` in another
 *  terminal read it. Lives at ~/.f/.creds-waiters.json. */
const WAITERS = path.join(process.env.HOME ?? "", ".f", ".creds-waiters.json");

function readWaiters() {
  try { return JSON.parse(fs.readFileSync(WAITERS, "utf8")); } catch { return {}; }
}
function writeWaiters(obj) {
  try {
    fs.mkdirSync(path.dirname(WAITERS), { recursive: true });
    fs.writeFileSync(WAITERS, JSON.stringify(obj, null, 2));
  } catch {}
}
function addWaiter(name, by) {
  const w = readWaiters();
  w[name] = { startedAt: Date.now(), by: by ?? "unknown" };
  writeWaiters(w);
}
function clearWaiter(name) {
  const w = readWaiters();
  if (name in w) { delete w[name]; writeWaiters(w); }
}

/**
 * Wait for a cred to be available, blocking up to `timeout` ms.
 *
 * Polls every `pollMs` (default 500ms). Each tick:
 *   - if the daemon is locked (not running), keep waiting — the user needs to
 *     run `f creds unlock` in another terminal first;
 *   - if unlocked, check whether the cred is set; if so, fetch and return it.
 * Resolves to the cred's value the moment both conditions are met. Rejects with
 * a clear error if `timeout` elapses. This is the mechanism that lets an LLM
 * uck ask for a credential and block while the user supplies it elsewhere.
 * While waiting, the request is recorded in the shared waiter registry so the
 * human can `f creds waiters` / `f creds fill` in another terminal.
 */
async function wait(name, { timeout = 300000, pollMs = 500, onPoll, by } = {}) {
  const deadline = Date.now() + timeout;
  // Helper: does the cred exist right now? A permanent unlock is allowed to
  // start its own daemon here — a waiter that refused to wake a permanently
  // unlocked store would block for its whole timeout on a store that can open
  // itself. Anything else stays locked and keeps waiting for a human.
  async function tryGet() {
    let state = unlockedState();
    if (!state) state = await autoUnlockPermanent();
    if (!state) return null; // locked
    const r = await daemonCall({ op: "get", name }, state.socket);
    if (r && r.ok && r.value != null && r.value !== "") return r.value;
    return null;
  }
  // Immediate check first (no delay if already present).
  let v;
  try { v = await tryGet(); } catch { v = null; }
  if (v != null) return v;

  // Not yet available — register as a waiter so it shows in `f creds waiters`.
  addWaiter(name, by);
  try {
    while (Date.now() < deadline) {
      const remainMs = deadline - Date.now();
      const sleepMs = Math.min(pollMs, remainMs);
      if (onPoll) {
        try { onPoll(remainMs); } catch {}
      }
      await new Promise((r) => setTimeout(r, sleepMs));
      try { v = await tryGet(); } catch { v = null; }
      if (v != null) return v;
    }
    throw new Error(
      `timed out after ${fmt(timeout)} waiting for cred '${name}' — ` +
      `run in another terminal: f creds unlock && f creds set ${name} <value>`
    );
  } finally {
    clearWaiter(name);
  }
}

/**
 * Typed error for the credsApi peer surface. Peers branch on `kind`, never on
 * message text (contract §7). Message wording stays free to change.
 *
 *   kind: "locked"      daemon not running / key not in memory → `f creds unlock`
 *   kind: "missing"     name not in the box and no provider has it
 *   kind: "provider"    a provider's resolve() threw (availability failure)
 *   kind: "other"       everything else
 */
export class CredsError extends Error {
  /** @type {"locked"|"missing"|"provider"|"other"} */
  kind;
  /** provider name, for kind === "provider" */
  provider;
  constructor(kind, message, provider) {
    super(message);
    this.name = "CredsError";
    this.kind = kind;
    this.provider = provider;
  }
  static locked(msg) { return new CredsError("locked", msg ?? "creds locked"); }
  static missing(name) { return new CredsError("missing", `no such cred: ${name}`); }
  static provider(name, provider, msg) {
    return new CredsError("provider", `provider '${provider}' failed: ${msg}`, provider);
  }
}

/** Classify a thrown value from the credsApi ladder into a CredsError. */
function toCredsError(name, e) {
  if (e instanceof CredsError) return e;
  const m = e?.message ?? String(e);
  if (/locked/i.test(m)) return CredsError.locked(m);
  if (/no such cred/i.test(m)) return CredsError.missing(name);
  if (/^provider '/.test(m)) {
    const p = m.match(/^provider '([^']+)' failed: (.*)$/);
    return CredsError.provider(name, p?.[1] ?? "?", p?.[2] ?? m);
  }
  return new CredsError("other", m);
}

export function register(ctx) {
  return {
    name: "creds",
    desc: "store credentials (scrypt+AES-GCM, daemon+socket, ttl); falls back to credential providers on a miss",
    skills: [{ name: "f-creds", path: path.join(__dirname, "SKILL.md") }],
    /** Let another uck plug a remote secret store in behind `f creds get`.
     *  See ./providers.js for the interface. Registration is process-local —
     *  providers are normally discovered from each uck's `credentialProvider`
     *  export via `f providers --dump` instead. */
    registerProvider,
    // Programmatic entry for other ucks. version: peers feature-detect on this
    // (>=1: CredsError with .kind is thrown; message text is NOT an API).
    // v2: `lock` takes { purge }, `unlock` takes a third options argument, and a
    // configured permanent unlock starts its own daemon on get/set/ls/resolve.
    credsApi: {
      version: 2,
      async get(name, ttl) {
        const state = await apiState();
        if (!state) throw CredsError.locked();
        const r = await daemonCall({ op: "get", name }, state.socket);
        if (r.ok && r.value != null && r.value !== "") return r.value;
        // A sibling uck asking for a cred gets the same provider ladder the CLI
        // gives, so `f fj` / `f gh` pick up vault-backed creds for free. A lock
        // is still a lock: never do provider traffic (or prompt) from here.
        const res = await resolveViaProvider(name, {
          getCred: (k) => rawGet(k, state),
          setMirror: (k, v, t) => setMirror(k, v, t, state),
          isFresh: (n, t) => isMirrorFresh(n, t),
        });
        if (res.value != null) return res.value;
        if (res.error) throw CredsError.provider(name, res.provider, res.error);
        if (res.none) throw CredsError.missing(name);
        throw toCredsError(name, new Error(r.error ?? `no such cred: ${name}`));
      },
      async set(name, value) {
        const state = await apiState();
        if (!state) throw CredsError.locked();
        await daemonCall({ op: "set", name, value }, state.socket);
      },
      async ls() {
        const state = await apiState();
        if (!state) throw CredsError.locked();
        const r = await daemonCall({ op: "ls" }, state.socket);
        return r.names ?? [];
      },
      /**
       * Wait for a cred, blocking up to timeout (default 5 min). Resolves to the
       * value the moment it's set (and the daemon is unlocked). Rejects on
       * timeout. opts: { timeout (ms), pollMs, onPoll(remainMs) }.
       * Usage from a uck: const token = await credsApi.wait("forgejo.kensand.net", { timeout: 300000 });
       */
      wait(name, opts) {
        return wait(name, opts);
      },
      /** List open waiting requests (name + startedAt + by). From another
       *  terminal, so the human knows what to fill in. */
      waiters() {
        const w = readWaiters();
        return Object.entries(w).map(([name, m]) => ({
          name,
          waitingMs: Date.now() - (m.startedAt ?? Date.now()),
          by: m.by ?? "unknown",
        }));
      },
      /** Ask for a permanent, file-backed unlock. Options:
       *    { permanent, keyFile, createKey, keyLabel }
       *  `f creds unlock --permanent` = { permanent: true, createKey: true }. */
      unlock,
      lock,
      /** Is a permanent unlock configured? Read-only; starts nothing. */
      permanentUnlock: () => readPermanentKey(),
      /** Programmatic resolution that includes provider-backed creds. See the
       *  lookupCred() doc comment for why `f ha`/`f gh` needed this. */
      lookupCred,
      lookupFirst,
      /** Resolve a name exactly as `f creds get` does, with provenance.
       *  opts: { localOnly, forceProvider, noCache }. Returns
       *  { value, source, warning? } or throws. Use this from a uck that needs
       *  to report where a token came from. */
      async resolve(name, opts = {}) {
        const state = await apiState();
        if (!state) throw CredsError.locked();
        if (opts.noCache) clearMisses(name);
        if (!opts.localOnly && !opts.forceProvider) {
          const r = await daemonCall({ op: "get", name }, state.socket);
          if (r.ok && r.value != null && r.value !== "") return { value: r.value, source: `local:${name}` };
        }
        if (opts.forceProvider || !opts.localOnly) {
          const res = await resolveViaProvider(name, {
            getCred: (k) => rawGet(k, state),
            setMirror: (k, v, t) => setMirror(k, v, t, state),
            isFresh: (n, t) => (opts.forceProvider ? async () => false : (n2, t2) => isMirrorFresh(n2, t2)),
          });
          if (res.value != null) return { value: res.value, source: res.mirror ? `vault (${res.mirror})` : `${res.provider}:${name}`, warning: res.warning };
          if (res.error) throw CredsError.provider(name, res.provider, res.error);
          throw CredsError.missing(name);
        }
        throw CredsError.missing(name);
      },
      /** Providers visible to creds, with { name, ready, note? }. */
      async providers() {
        const out = [];
        for (const p of await listProviders()) {
          let ready = null;
          let note;
          if (typeof p.status === "function") {
            try { const st = await p.status(); ready = !!st?.ready; note = st?.note; } catch (e) { note = e?.message ?? String(e); }
          }
          out.push({ name: p.name, ready, note });
        }
        return out;
      },
      status: () => {
        const s = unlockedState();
        return s
          ? { unlocked: true, remainingMs: s.remainingMs, permanent: !!s.permanent }
          : { unlocked: false };
      },
      /** Human-readable unlock line, so a uck's status output cannot drift from
       *  what `f creds status` says about a permanent session. */
      describeStatus: () => describeUnlock(unlockedState()),
    },
    run: (argv, args) => {
      const pos = [];
      // undefined = "the operator did not ask for a ttl". It used to be
      // initialised to DEFAULT_TTL here, which made every downstream
      // `ttl !== undefined` test permanently true — so "an explicit --ttl was
      // given" and "--permanent conflicts with --ttl" were both always true,
      // and `f creds unlock --permanent` refused to run at all. unlock() still
      // applies DEFAULT_TTL itself.
      let ttl;
      let timeoutSec = 300; // default wait window for `request`
      let showSecrets = false;
      const unknownFlags = [];
      let force = false;
      let dryRun = false;
      let outDir = null;
      let asStdin = null;
      let jsonOut = false;
      let localOnly = false;      // --local: never consult providers
      let forceProvider = false;  // --vault: bypass local + mirror, ask providers now
      let showSource = false;     // --source: print provenance alongside the value
      let lookupRaw = false;      // --raw:   `lookup` prints the bare value
      let lookupEnv = null;       // --env V: `lookup` prints export V='value'
      let lookupShow = false;     // --show-value: `lookup` prints name + value
      let lookupFd = null;        // --fd N[wa]: write the raw value to inherited fd N
      let noCache = false;        // --no-cache: ignore + clear the negative cache
      let showAll = false;        // --all (ls): include provider mirrors
      let permanent = false;      // --permanent: no expiry, key read from a file
      let keyFileOpt = null;      // --key-file <path>: where that key lives
      let purge = false;          // --purge (lock): delete the key file too
      let ttlRequested = null;    // raw --ttl argument, to reject `--ttl 0`
      const a = [...(args._ ?? [])];
      for (let i = 0; i < a.length; i++) {
        if (a[i] === "--ttl") {
          ttlRequested = a[++i];
          ttl = parseDurationSec(ttlRequested, "--ttl");
        } else if (a[i] === "--permanent") {
          permanent = true;
        } else if (a[i] === "--key-file") {
          keyFileOpt = a[++i];
          if (!keyFileOpt) throw new Error("--key-file needs a path");
        } else if (a[i] === "--purge") {
          purge = true;
        } else if (a[i] === "--timeout") {
          timeoutSec = parseDurationSec(a[++i], "--timeout");
        } else if (a[i] === "--secrets") {
          showSecrets = true;
        } else if (a[i] === "--force") {
          force = true;
        } else if (a[i] === "--dry-run" || a[i] === "-n") {
          dryRun = true;
        } else if (a[i] === "--dir") {
          outDir = a[++i];
          i++;
        } else if (a[i] === "--as") {
          asStdin = a[++i];
          i++;
        } else if (a[i] === "--json") {
          jsonOut = true;
        } else if (a[i] === "--local") {
          localOnly = true;
        } else if (a[i] === "--vault") {
          forceProvider = true;
        } else if (a[i] === "--source") {
          showSource = true;
        } else if (a[i] === "--all") {
          showAll = true;
        } else if (a[i] === "--no-cache") {
          noCache = true;
        } else if (a[i] === "--raw") {
          lookupRaw = true;
        } else if (a[i] === "--show-value") {
          lookupShow = true;
        } else if (a[i] === "--env") {
          lookupEnv = a[++i];   // consumed: the VAR name must not reach `pos`
        } else if (a[i] === "--fd") {
          lookupFd = a[++i];    // consumed: likewise
        } else if (a[i].startsWith("--")) {
          // Do NOT fall through to pos. Unrecognised `--flags` used to land in
          // `pos`, and `pos[0]` is the command while `pos[1]` is `unlock`'s
          // passkey — so `f creds unlock --request foo` "succeeded" by deriving
          // the store key from the literal string `--request`, leaving a daemon
          // that reported `unlocked` while every decrypt failed. A typo'd flag
          // must cost one line, not the store.
          unknownFlags.push(a[i]);
        } else pos.push(a[i]);
      }
      const redact = (value) =>
        showSecrets ? String(value) : `[redacted — pass --secrets to reveal]`;
      const [cmd, ...rest] = pos;
      if (unknownFlags.length) {
        // usage() ends in process.exit(1), so anything after it is unreachable —
        // pass the reason IN rather than writing it and expecting to set 2.
        return usage(`unknown flag(s): ${unknownFlags.join(", ")}`);
      }

      // Returned, not fired-and-forgotten. An unawaited floating IIFE means the
      // caller cannot know when a command finished (a test driver had to poll for
      // it), and a rejection after the first tick is an unhandled rejection that
      // Node turns into a nonzero exit with a stack, not a message. Callers that
      // ignore the promise behave exactly as before.
      return (async () => {
        switch (cmd) {
          case "unlock":
            // A passkey that begins with '-' would be indistinguishable from a
            // flag; refuse rather than derive a key from something the operator
            // believes was parsed as an option.
            if (rest.length > 1) {
              return usage(`unlock takes at most one passkey argument, got ${rest.length}: ${rest.join(" ")}`);
            }
            if (ttl !== undefined && permanent) {
              return usage("--ttl and --permanent are mutually exclusive (--permanent means no expiry)");
            }
            if (ttlRequested !== null && /^0+$/.test(String(ttlRequested).trim())) {
              // `--ttl 0` would reach the daemon as "permanent" through the back
              // door: no key file, no marker, no warning. Say what to type.
              return usage("--ttl 0 is not a duration; use --permanent for an unlock that never expires");
            }
            if (rest.length && permanent) {
              return usage(
                "--permanent does not take a passkey argument — the point is that the key comes from " +
                "a file. Store the passkey first, then unlock:\n" +
                `    umask 077 && printf '%s' 'YOUR-PASSKEY' > ${UNLOCKKEY}\n` +
                "    f creds unlock --permanent"
              );
            }
            if (keyFileOpt !== null && !permanent) {
              return usage("--key-file only applies to --permanent");
            }
            if (purge) {
              return usage("--purge only applies to `f creds lock`");
            }
            // Honour the result: unlock() now returns false when the daemon
            // refused the passkey, and a failed unlock must not exit 0 — a
            // script that did `f creds unlock && deploy` would otherwise deploy.
            process.exit((await unlock(rest[0], ttl, {
              permanent,
              keyFile: keyFileOpt,
              // No key file yet means the operator is setting this up, so write
              // one. An explicit passkey is the exception (see above).
              createKey: permanent,
            })) ? 0 : 4);
          case "lock":
            lock({ purge });
            break;
          case "status": {
            const s = unlockedState();
            process.stdout.write(describeUnlock(s) + "\n");
            // Providers are part of the answer now: a missing cred may be living
            // in a vault the local store has never seen.
            try {
              const provs = await listProviders();
              const enabled = provs.filter((p) => p.name);
              if (!enabled.length) {
                process.stdout.write("providers: none\n");
                if (providerDiscoveryError()) process.stdout.write(`providers: discovery failed (${providerDiscoveryError()})\n`);
              } else {
                for (const p of enabled) {
                  let note = "";
                  if (typeof p.status === "function") {
                    try {
                      const st = await p.status();
                      note = ` — ${st?.ready ? "ready" : "not ready"}${st?.note ? `: ${st.note}` : ""}`;
                      if (st?.hint) note += `\n  hint: ${st.hint}`;
                    } catch (e) { note = ` — status failed: ${e?.message ?? e}`; }
                  }
                  process.stdout.write(`providers: ${p.name}${note}\n`);
                }
              }
            } catch (e) {
              process.stdout.write(`providers: probe failed (${e?.message ?? e})\n`);
            }
            break;
          }
          case "set": {
            const setState = await requireUnlocked();
            const [name, ...valParts] = rest;
            if (!name) return usage("set needs <name> <value>");
            if (isMirrorKey(name)) return usage(`'${MIRROR_PREFIX}\u2026' is reserved for provider mirrors — drop the prefix`);
            // The value must not require argv: anything on the machine can read it
            // from `ps` for the command's lifetime. This uck's own provider helper
            // (credsSet in the vaultwarden uck) already refuses argv for exactly
            // that reason; the CLI was contradicting the library beside it.
            //   echo SECRET | f creds set <name>          (piped, no value arg)
            //   f creds set <name> -                      (explicit stdin)
            //   f creds set <name>                        (interactive prompt, no echo)
            //   f creds set <name> <value>                (still works; see warning)
            // Stdin is read only when no value argument was given. Passing BOTH a
            // value argument and a pipe is rejected rather than resolved: picking
            // either side would silently discard a secret the caller supplied, and
            // in a script that is how the wrong credential gets stored.
            const hasValueArg = valParts.length > 0 && !(valParts.length === 1 && valParts[0] === "-");
            const explicitStdin = valParts.length === 1 && valParts[0] === "-";
            let value, viaArgv = false;
            if (hasValueArg && !process.stdin.isTTY) {
              // Only complain if there is actually something in the pipe; a plain
              // `f creds set x y` in a shell usually has /dev/null or a terminal on
              // stdin, and a closed pipe is not an attempt to pipe a secret.
              const piped = await readAllStdin();
              if (piped.trim() !== "") {
                return usage(`refusing to choose: a value was given as an argument AND on stdin — drop one (piped value wins if you use '${name} -')`);
              }
              value = valParts.join(" ");
              viaArgv = true;
            } else if (hasValueArg) {
              value = valParts.join(" ");
              viaArgv = true;
            } else {
              if (process.stdin.isTTY) {
                // A terminal is not "no input", it is input. Refusing here made
                // `f creds set <name>` unusable interactively — the most common
                // way a human stores a rotated credential — and pushed the
                // operator toward argv, where `ps` reads the secret. `unlock`
                // already prompts on a TTY; `set` does the same. With `-` the
                // caller said the value comes from a pipe, so if nothing came we
                // refuse rather than prompt: the caller may be a script with
                // nobody at the keyboard, and a prompt there is a hang. The
                // prompt goes to stderr, where the secret cannot land.
                if (explicitStdin) return usage("set needs a value (stdin was empty)");
                process.stderr.write(`f: ${name} (input is a terminal; an empty line aborts): `);
                value = (await promptVisible("")) ?? "";
              } else {
                value = (await readAllStdin()).replace(/\n$/, "");
              }
            }
            if (value === "") return usage("empty value — nothing stored (a secret of zero length is usually a mistake)");
            await op("set", { name, value });
            if (viaArgv) {
              process.stderr.write(`f: note: the value was passed in argv, so any process could read it from \`ps\`; prefer: echo SECRET | f creds set ${name}\n`);
            }
            // Dual-write: if a provider serves this name (it has a mirror or a live
            // entry), also write it there so the two sources of truth stay in sync.
            // Before this change a local `set` shadowed the vault, so a provider-backed
            // cred would silently diverge from its local copy — the exact class of
            // failure that made `f ha`/`f gh` go blind. The mirror is refreshed from
            // the new value rather than dropped, so the next read sees the write
            // without a provider round-trip.
            let wroteVault = null;
            if (!forceProvider) {
              const hadMirror = !!(await rawGet(MIRROR_PREFIX + name, setState));
              const provs = await listProviders().catch(() => []);
              const owner = provs.find((p) => p.canWrite === true);
              if (owner) {
                try {
                  if (owner.has && !(await owner.has(name))) {
                    // not actually backed by the provider — leave the local entry as-is
                  } else {
                    await owner.write(name, value);
                    // Refresh the mirror so it reflects the new value and re-stamps freshness.
                    const ttlSec = owner.mirrorTtlSec ?? 3600;
                    await setMirror(MIRROR_PREFIX + name, value, ttlSec * 1000, setState);
                    wroteVault = owner.name;
                  }
                } catch (e) {
                  process.stderr.write(
                    `f: wrote locally but the provider '${owner.name}' failed: ${e?.message ?? e}\n` +
                    `   the vault now holds the OLD value; the local entry is ahead of it.\n`
                  );
                }
              } else if (hadMirror) {
                // A mirror existed but no provider advertised canWrite: the vault is
                // configured but not reachable from this process. Drop the stale mirror
                // so it stops being served as if it were current.
                await dropMirror(MIRROR_PREFIX + name);
              }
            }
            clearMisses(name);
            process.stdout.write(
              `set\t${name}${viaArgv ? "" : "\t(stdin)"}${wroteVault ? `\t+vault:${wroteVault}` : ""}\n`
            );
            break;
          }
          case "get": {
            const name = rest[0];
            if (!name) return usage("get requires <name>");
            if (noCache) clearMisses(name);
            const state = await requireUnlocked();
            let value = null;
            let src = `local:${name}`;

            if (forceProvider) {
              // --vault: skip local and mirror entirely, revalidate against the provider.
              const r = await resolveViaProvider(name, { getCred: (k) => rawGet(k, state), setMirror: (k, v, t) => setMirror(k, v, t, state), isFresh: () => false });
              if (r.none) { process.stderr.write(`f: ${r.note}\n`); process.exit(1); }
              if (r.error) { process.stderr.write(`f: provider '${r.provider}' failed: ${r.error}\n`); process.exit(1); }
              if (r.miss) { process.stderr.write(`f: no provider has '${name}'\n`); process.exit(1); }
              value = r.value;
              src = `${r.provider}:${name}${r.mirrored ? " (mirrored)" : ""}`;
            } else {
              const direct = await daemonCall({ op: "get", name }, state.socket);
              if (direct.ok && direct.value != null && direct.value !== "") {
                value = direct.value;
              } else {
                // Local miss -> provider ladder (mirror ttl, negative cache).
                const r = await resolveViaProvider(name, { getCred: (k) => rawGet(k, state), setMirror: (k, v, t) => setMirror(k, v, t, state), isFresh: (n, t) => isMirrorFresh(n, t) });
                if (r.none) {
                  // No providers at all: preserve the classic error exactly.
                  process.stderr.write(`f: ${direct.error ?? `no such cred: ${name}`}\n`);
                  process.exit(1);
                }
                if (r.error) { process.stderr.write(`f: provider '${r.provider}' failed: ${r.error}\n`); process.exit(1); }
                if (r.miss) { process.stderr.write(`f: no such cred: ${name} (no provider has it either)\n`); process.exit(1); }
                value = r.value;
                src = r.mirror ? `vault:${mirrorName(MIRROR_PREFIX + name)} (${r.mirror}${r.warning ? ", " + r.warning : ""})`
                  : `${r.provider}:${name}${r.mirrored ? " (mirrored)" : ""}`;
                if (r.warning) process.stderr.write(`f: ${r.warning}\n`);
              }
            }

            if (value != null) process.stdout.write(redact(value) + "\n");
            if (showSource) process.stderr.write(`f: source: ${src}\n`);
            break;
          }
          case "lookup": {
            // Machine-facing resolution for other ucks, in ONE process: names in
            // argv order, first hit wins. This exists because a raw socket read
            // cannot see a provider-backed cred (locally it is only `mirror:<name>`),
            // and resolving per name in the caller means one nested `f` per name —
            // which is exactly how `f ha` and `f gh` lost their tokens.
            //
            // Output shapes, in order of how much the value is wanted:
            //   (default)      "<name>\t<source>" — the value is NOT printed
            //   --raw          the bare value on stdout
            //   --env VAR      export VAR='<value>'  (single-quote escaped)
            //   --show-value   "<name>\t<source>\n<value>"
            // A value never appears on stdout by default: a caller that logs the
            // resolution must ask for the secret deliberately.
            const names = rest;
            if (!names.length) return usage("lookup needs <name>...");
            const hit = await lookupFirst(names, {
              localOnly: localOnly,
              forceProvider: forceProvider,
            });
            if (hit.locked) {
              process.stderr.write("f: creds locked\n");
              process.exit(3);
            }
            if (hit.value == null) {
              if (hit.error) process.stderr.write(`f: ${hit.error}\n`);
              else process.stderr.write(`f: no such cred: ${names.join(", ")}\n`);
              process.exit(1);
            }
            if (hit.warning) process.stderr.write(`f: ${hit.warning}\n`);
            if (lookupRaw) process.stdout.write(hit.value);
            else if (lookupFd != null) {
              // Byte-exact delivery on a caller-provided fd, with NOTHING on
              // stdout. Two reasons this exists instead of --raw:
              //   * --raw trims a trailing newline, and OpenSSH refuses a PEM
              //     without one;
              //   * a caller that pipes stdout can end up with the secret in a
              //     log, a terminal scrollback, or `$(...)`. Writing to a fd the
              //     caller opened (a pipe to ssh-add, typically) keeps the value
              //     off every channel that a human or a shell can capture.
              // The value's own bytes stay untouched — no newline added, none
              // removed.
              // Accept `3`, `3w`, `3a`, and node's pipe form `pipe:3` (the form a
              // caller uses when it wants the child's write end torn down on
              // close, which is exactly what keeps a caller from blocking forever
              // if we exit without writing). Anything else is a typo about to
              // write a secret somewhere unintended, so it costs one line.
              const m = /^(?:(\d+)|(pipe:(\d+)))([wa]?)$/.exec(lookupFd);
              const fd = m ? Number(m[1] ?? m[3]) : NaN;
              const append = (m?.[4] ?? "") === "a";
              if (!Number.isInteger(fd) || fd < 3) {
                process.stderr.write("f: --fd wants an inherited descriptor >= 3 (e.g. 3, 3w, 3a, pipe:3)\n");
                process.exit(2);
              }
              try {
                const fsMod = await import("node:fs");
                fsMod.writeFileSync(fd, String(hit.value), append ? { flag: "a" } : { mode: 0o600 });
                fsMod.writeSync(fd, "\n"); // marker, so the caller can tell 'empty' from 'absent'
              } catch (e) {
                process.stderr.write(`f: cannot write to fd ${fd}: ${e?.message ?? e}\n`);
                process.exit(2);
              }
            }
            else if (lookupEnv) {
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(lookupEnv)) {
                process.stderr.write(`f: --env needs a shell identifier, got '${lookupEnv}'\n`);
                process.exit(2);
              }
              process.stdout.write(`export ${lookupEnv}='${String(hit.value).replace(/'/g, `'\\''`)}'\n`);
            } else if (lookupShow) {
              process.stdout.write(`${hit.name}\t${hit.source}${hit.stale ? " (stale)" : ""}\n${hit.value}\n`);
            } else {
              process.stdout.write(`${hit.name}\t${hit.source}${hit.stale ? " (stale)" : ""}\n`);
            }
            break;
          }
          case "forget": {
            // Drop the mirror(s) + negative cache for a name so the next get
            // revalidates. Does not touch real local creds.
            const names = rest.length ? rest : null;
            if (noCache || !names) clearMisses();
            const state = await requireUnlocked();
            if (!names) {
              const r = await daemonCall({ op: "ls" }, state.socket);
              // dropMirror also clears the provenance record; op() would exit(1)
              // on an entry that expired mid-sweep.
              for (const n of (r.names ?? []).filter(isMirrorKey)) await dropMirror(n, state);
              break;
            }
            for (const n of names) {
              const key = isMirrorKey(n) ? n : MIRROR_PREFIX + n;
              // Ask before deleting, then report by the NAME the operator used.
              // Deleting blind and catching was doubly wrong: op()'s process.exit
              // is uncatchable, and the failure path printed the internal
              // `mirror:<name>` key, which is not a name anyone typed.
              const exists = (await daemonCall({ op: "has", name: key }, state.socket).catch(() => ({ exists: false })))?.exists;
              if (exists) {
                await dropMirror(key, state);
                process.stdout.write(`forgot\t${n}\n`);
              } else {
                // Still clear provenance: a mirror that expired left its record.
                clearMirrorSource(key);
                process.stdout.write(`no mirror\t${n}\n`);
              }
              clearMisses(n);
            }
            break;
          }
          case "request": {
            const name = rest[0];
            if (!name) return usage("request requires <name>");
            const timeoutMs = timeoutSec * 1000;
            process.stderr.write(`f: waiting for cred '${name}' up to ${fmt(timeoutMs)}… (set it in another terminal: f creds set ${name} <value>)\n`);
            const value = await wait(name, { timeout: timeoutMs, by: "f creds request" });
            if (showSecrets) process.stdout.write(value + "\n");
            else process.stderr.write(`f: cred '${name}' available (pass --secrets to print)\n`);
            break;
          }
          case "waiters": {
            const ws = readWaiters();
            const entries = Object.entries(ws);
            if (entries.length === 0) {
              process.stdout.write("(no open waiting requests)\n");
              break;
            }
            for (const [name, m] of entries) {
              const waited = Date.now() - (m.startedAt ?? Date.now());
              process.stdout.write(`${name}\t[${fmt(waited)}]\tby: ${m.by ?? "unknown"}\n`);
            }
            break;
          }
          case "fill": {
            // Cycle through open waiting requests (or just the named one),
            // prompting for each value and setting it. This is the human's
            // "fill in what the LLM asked for" action in the other terminal.
            const only = rest[0] ?? null;
            const ws = readWaiters();
            const names = only ? [only] : Object.keys(ws);
            if (names.length === 0) {
              process.stdout.write(only ? `f: '${only}' is not waiting (or no waiters)\n` : "(nothing waiting to fill)\n");
              break;
            }
            const ask = makeFillPrompt(); // one prompt fn for the whole session
            for (const name of names) {
              const meta = ws[name];
              process.stderr.write(`\nf: fill '${name}'${meta ? ` (waiting ${fmt(Date.now() - (meta.startedAt ?? Date.now()))}, by ${meta.by ?? "unknown"})` : ""}\n`);
              const value = await ask(`f: ${name}: `);
              if (value == null || value === "") {
                process.stderr.write(`f: (skipped '${name}')\n`);
                continue;
              }
              // Setting requires the daemon unlocked; `set` already errors if locked.
              const state = await requireUnlocked();
              await daemonCall({ op: "set", name, value }, state.socket);
              clearWaiter(name);
              process.stderr.write(`f: set '${name}'\n`);
            }
            break;
          }
          case "ls": {
            const r = await op("ls", {});
            // Providers may add names beyond what the box holds. Default view
            // keeps mirrors out of the noise (they are a cache, not creds);
            // --all shows them with their producing provider and expiry.
            const names = new Set(r.names ?? []);
            const mirrors = [...names].filter(isMirrorKey);
            for (const m of mirrors) names.delete(m);
            const extra = new Set();
            if (!localOnly) {
              try {
                for (const p of await listProviders()) {
                  if (typeof p.list !== "function") continue;
                  for (const n of (await p.list()) ?? []) if (!names.has(n)) extra.add(n);
                }
              } catch { /* provider listing is advisory */ }
            }
            // Provenance is a property of the cache entry, and it is already
            // recorded (src:<key> in the miss cache, written by setMirrorSource
            // when the provider hit). Read it rather than guessing: the box does
            // NOT record how a plain cred got there, so local values are labelled
            // `local` and nothing more — claiming more would be invention.
            const rows = [];
            for (const n of [...names].sort()) rows.push({ name: n, source: "local" });
            for (const n of [...extra].sort()) rows.push({ name: n, source: "provider" });
            let hidden = 0;
            if (jsonOut || showAll) {
              for (const m of mirrors.sort()) {
                let exp = null;
                // `state.socket`, not `state.socket`: `state` exists only inside
                // op()/requireUnlocked(), so this free variable threw
                // ReferenceError on EVERY mirror. The surrounding `catch` swallowed
                // it, so mirror expiry silently never displayed — the feature read
                // as "no expiry" forever and nothing complained. op("ls") above
                // already proved the store is unlocked, so the SOCKET default is
                // exactly what every other call-site resolves to.
                try {
                  const meta = await daemonCall({ op: "meta", name: m });
                  if (meta?.ok && Number.isFinite(meta.expiresAt)) exp = new Date(meta.expiresAt).toISOString();
                } catch { /* metadata is advisory */ }
                let provider = null;
                try { provider = mirrorSource(m); } catch { /* advisory */ }
                rows.push({
                  name: m,
                  source: provider ? `mirror:${provider}` : "mirror",
                  provider,
                  expiresAt: exp,
                });
              }
            } else if (mirrors.length) {
              hidden = mirrors.length;
            }
            if (jsonOut) {
              // Real JSON. The flag previously set jsonOut and never read it, so
              // `ls --json` printed the same line-oriented text as plain `ls` —
              // and a caller piping to a parser got a bare name per line, with no
              // way to tell a mirror from a local cred.
              process.stdout.write(JSON.stringify(rows.map((r2) => {
                const o = { name: r2.name, source: r2.source };
                if (r2.provider) o.provider = r2.provider;
                if (r2.expiresAt) o.expiresAt = r2.expiresAt;
                return o;
              }), null, 2) + "\n");
              break;
            }
            for (const row of rows) {
              if (row.source === "local") { process.stdout.write(row.name + "\n"); continue; }
              const bits = [];
              if (row.source === "provider") { process.stdout.write(`${row.name}\t(provider)\n`); continue; }
              if (row.provider) bits.push(row.provider);
              bits.push(row.expiresAt ? `expires ${row.expiresAt}` : "no expiry");
              process.stdout.write(`${row.name}\t(mirror; ${bits.join("; ")})\n`);
            }
            // The count line is the ALTERNATIVE to listing mirrors, never an
            // addition to it. It used to print here after the rows were already
            // emitted — and because it sat in an `else if` whose branch also
            // `break`s, `--all` printed a count and then nothing at all.
            if (hidden) process.stdout.write(`(${hidden} provider mirror(s) hidden — --all)\n`);
            break;
          }
          case "files": {
            const [sub, ...r2] = rest;
            if (sub === "pack" || !sub) {
              if (!r2.length) return usage("files pack needs <path>... | '-' | '<dir>/...'");
              await pack(expandTargets(r2), { as: asStdin, force, dryRun });
            } else if (sub === "unpack") {
              if (!r2.length) return usage("files unpack needs <path>... | --all | '<name> -'");
              await unpack(r2, { force, dir: outDir ? path.resolve(outDir) : null });
            } else if (sub === "ls") {
              await filesLs({ json: jsonOut });
            } else if (sub === "rm") {
              if (!r2[0]) return usage("files rm needs <path>");
              const key = "file:" + path.resolve(expandTilde(r2[0]));
              await op("rm", { name: key });
              const st = await requireUnlocked();
              const idx = await loadIndex(st);
              if (key in idx) { delete idx[key]; await saveIndex(idx, st); }
              process.stdout.write(`removed\t${key}\n`);
            } else {
              return usage(`unknown files subcommand: ${sub}`);
            }
            break;
          }
          case "pack":
            if (!rest.length) return usage("pack needs <path>... | '-' | '<dir>/...'");
            await pack(expandTargets(rest), { as: asStdin, force, dryRun });
            break;
          case "unpack":
            if (!rest.length) return usage("unpack needs <path>... | --all | '<name> -'");
            await unpack(rest, { force, dir: outDir ? path.resolve(outDir) : null });
            break;
          case "rm": {
            const [nm] = rest;
            if (!nm) return usage("rm needs <name>");
            {
              const st = await requireUnlocked();
              const localKey = isMirrorKey(nm) ? null : nm;
              const mirrorKey = isMirrorKey(nm) ? nm : MIRROR_PREFIX + nm;
              const localR = localKey ? await daemonCall({ op: "has", name: localKey }, SOCKET).catch(() => ({ exists: false })) : { exists: false };
              const mirrorR = await daemonCall({ op: "has", name: mirrorKey }, SOCKET).catch(() => ({ exists: false }));

              if (!localR?.exists && !mirrorR?.exists) {
                // Say what IS true rather than the bare 'no such cred' that made a
                // failed delete indistinguishable from 'never existed'.
                process.stderr.write(`f: no such cred: ${nm}\n  nothing in the box and no mirror under ${mirrorKey}\n  (a provider may still answer for it — check: f creds has ${nm})\n`);
                process.exitCode = 1;
                break;
              }
              let removedLocal = false, removedMirror = false;
              if (localR?.exists) { await op("rm", { name: localKey }); removedLocal = true; }
              // daemonCall via dropMirror, not op(): op() process.exit(1)s internally,
              // which no .catch() can intercept, so the honest notes below would
              // never print and the command would look like a failed delete.
              if (mirrorR?.exists) {
                await dropMirror(mirrorKey, st);
                removedMirror = true;
              }
              if (removedLocal) process.stdout.write(`removed\t${nm}\n`);
              if (removedMirror) {
                const prov = mirrorSource(mirrorKey);
                process.stdout.write(`removed\t${mirrorKey}${prov ? `\t(mirror of ${prov})` : ""}\n`);
                // The thing an operator needs to hear: the provider still serves this.
                process.stdout.write(`note\tthis only dropped the local cache — ${prov ?? "the provider"} still answers for '${nm}'; the next get re-mirrors it\n`);
                process.stdout.write(`note\tto stop it resolving, remove or rename it at the source${prov === "vaultwarden" ? ` (f vaultwarden has no delete yet: do it in the web vault)` : ""}\n`);
              }
            }
            break;
          }
          case "has": {
            // Documented in USAGE since before this case existed: `has` fell
            // through to `default: usage()` and exited 1. The daemon op was there
            // the whole time — only the CLI route was missing, which is why the
            // mirror/cred distinction below was impossible to ask about.
            const nm = rest[0];
            if (!nm) return usage("has needs <name>");
            {
              await requireUnlocked();
              const r = await daemonCall({ op: "has", name: nm }, SOCKET);
              const mirrorKey = isMirrorKey(nm) ? nm : MIRROR_PREFIX + nm;
              const mirrorR = isMirrorKey(nm) ? r : await daemonCall({ op: "has", name: mirrorKey }, SOCKET).catch(() => ({ exists: false }));
              const src = !isMirrorKey(nm) && r?.exists ? "local"
                : (r?.exists || mirrorR?.exists) ? (mirrorSource(mirrorKey) ?? "mirror")
                : null;
              if (r?.exists) {
                process.stdout.write(`exists\t${nm}\tlocal${Number.isFinite(r.expiresAt) ? `\texpires ${new Date(r.expiresAt).toISOString()}` : ""}\n`);
              } else if (mirrorR?.exists) {
                const prov = mirrorSource(mirrorKey);
                process.stdout.write(`exists\t${nm}\tmirror${prov ? `:${prov}` : ""}${Number.isFinite(mirrorR.expiresAt) ? `\texpires ${new Date(mirrorR.expiresAt).toISOString()}` : ""}\n`);
              } else {
                process.stdout.write(`absent\t${nm}\n`);
                process.exitCode = 1;
              }
              // Naming what a bare `rm` would actually touch, so the mirror/cred
              // distinction is answerable before deleting something.
              if (src) {
                // Naming what a bare `rm` would actually touch, so the mirror/cred
                // distinction is answerable BEFORE deleting something. For a local
                // value there is nothing to hedge: rm removes it, full stop.
                const hint = src === "local"
                  ? `f: rm ${nm} removes the local value (no provider mirror involved)`
                  : `f: rm ${nm} removes only the mirror cache${src.startsWith("mirror:") ? ` (from ${src.slice(8)})` : ""} — the provider still answers for it`;
                process.stderr.write(hint + "\n");
              }
            }
            break;
          }
          case "meta": {
            const nm = rest[0];
            if (!nm) return usage("meta needs <name>");
            {
              await requireUnlocked();
              const r = await daemonCall({ op: "meta", name: nm }, SOCKET);
              if (!r?.ok) { process.stderr.write(`f: no such cred: ${nm}\n`); process.exitCode = 1; break; }
              const prov = isMirrorKey(nm) ? mirrorSource(nm) : mirrorSource(MIRROR_PREFIX + nm);
              const kind = isMirrorKey(nm) ? `mirror${prov ? `:${prov}` : ""}` : (prov && prov !== "local" ? `local (mirror of ${prov} also exists)` : "local");
              process.stdout.write(`name\t${nm}\nkind\t${kind}\n`);
              if (Number.isFinite(r.expiresAt)) process.stdout.write(`expiresAt\t${new Date(r.expiresAt).toISOString()}\n`);
              else process.stdout.write("expiresAt\t(never)\n");
            }
            break;
          }
          default:
            usage();
        }
      })().catch((e) => {
        process.stderr.write(`f: ${e.message}\n`);
        process.exit(1);
      });
    },
  };
}

/** True when the socket appeared, false on timeout. Callers MUST branch on it:
 *  a daemon that died on the way up leaves no socket and no error, which is how
 *  a wrong passkey ended up reported as `unlocked`. */
// True only if a live daemon answers on the socket. The lockfile existing says
// nothing about the key it holds: a daemon started with a wrong passkey serves
// `ls` fine and fails later on every `get`, so `unlock` must not treat a stale
// or wrongly-keyed socket as "already unlocked".
async function probeSocket(socketPath) {
  const lf = readLockfile();
  if (!lf?.pid || !pidAlive(lf.pid)) return null;
  try {
    const r = await Promise.race([
      daemonCall({ op: "ping" }, socketPath),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 1500)
      ),
    ]);
    return r?.ok ? unlockedState() : null;
  } catch {
    return null;
  }
}

// Removed: waitForSocket(). It polled for the socket FILE, which cannot
// distinguish "daemon refused the passkey" from "daemon is still starting", and
// it let `unlock` unref a detached child that then died — so the parent had
// nothing keeping its event loop alive and exited 0 on a failed unlock. The
// daemon now announces {ok, ttl, permanent, error} on stdout and startDaemon()
// waits for that instead.

function usage(msg) {
  const line = msg ? `f: ${msg}\n` : "";
  process.stderr.write(
    line +
      "usage: f creds <cmd>\n" +
      "  unlock [passkey] [--ttl sec]   start daemon; --ttl accepts s/m/h/d/w\n" +
      "                                    (e.g. 900, 45m, 2h, 1d, 1d6h30m; default 10m)\n" +
      "  unlock --permanent [--key-file p]\n" +
      "                                permanent file-based unlock: no expiry, passkey\n" +
      "                                    read from a 0600 key file (default\n" +
      "                                    ~/.f/.creds-unlock.key, created if missing)\n" +
      "                                    and the daemon restarts itself on the next\n" +
      "                                    creds command after a reboot or crash\n" +
      "  lock [--purge]                 stop daemon, zeroize key; also removes the\n" +
      "                                    permanent-unlock marker (--purge deletes the\n" +
      "                                    key file too)\n" +
      "  status                          locked / unlocked + time left, + provider readiness\n" +
      "  set <name> [value|-]           store a cred (also clears that name's mirror);\n" +
      "                                    no value (or `-`) reads stdin, and a TTY\n" +
      "                                    prompts without echo, so the secret\n" +
      "                                    never appears in `ps`\n" +
      "  get <name> [--secrets]          print a cred (redacted without --secrets);\n" +
      "                                    on a local miss, consult credential\n" +
      "                                    providers and mirror the hit\n" +
      "    --local                          never consult providers\n" +
      "    --vault                          skip local + mirror, revalidate with the\n" +
      "                                     provider now (refuses to serve a stale mirror)\n" +
      "    --source                         print provenance to stderr\n" +
      "    --no-cache                       ignore/clear the negative cache first\n" +
      "  forget [name...]                drop provider mirror(s) + negative cache\n" +
      "                                    (no args = all mirrors)\n" +
      "  request <name> [--timeout sec]  block until the cred is set elsewhere,\n" +
      "                                    then print it (default 300s; also waits\n" +
      "                                    for unlock if the daemon is locked;\n" +
      "                                    add --secrets to print, else confirm only)\n" +
      "  waiters                         list open waiting requests (from other\n" +
      "                                    terminals' f fj / ucks that are blocked)\n" +
      "  fill [name]                     prompt + set value(s) for the open\n" +
      "                                    waiters (or just <name>); unblocks them\n" +
      "  ls [--all|--json]               list names; mirrors hidden unless --all\n" +
      "                                    mirrors show their provider + expiry;\n" +
      "                                    --json emits [{name, source, …}]\n" +
      "  rm <name>                       remove a cred; if <name> is only a provider\n" +
      "                                    mirror, drops the cache and says the\n" +
      "                                    provider still answers for it\n" +
      "  files <sub>                     packed files (key = file:<abs path> + 'files' manifest)\n" +
      "    ls [--json]                       list packed files (terse, or raw manifest JSON)\n" +
      "    pack <path>... [opts]             store files\n" +
      "        '-'                               value from stdin (needs --as <name>)\n" +
      "        '<dir>/...'                       every file under each uck dir in <dir>\n" +
      "        [--as <name>] [--force] [-n]      stdin name / allow binary / dry-run\n" +
      "    unpack <path>... [opts]           restore to the same abs paths\n" +
      "        --all                             restore the whole manifest\n" +
      "        '<src> => <dst>'                  restore to a different path\n" +
      "        '<name> -'                        raw bytes to stdout\n" +
      "        [--force] [--dir <root>]          overwrite (w/ .bak) / stage under <root>\n" +
      "    rm <path>                         remove one packed file + its manifest entry\n" +
      "  (top-level 'pack'/'unpack' alias 'files pack'/'files unpack')\n"
  );
  process.exit(1);
}

export default { register, CredsError };
