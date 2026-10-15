// f creds — store credentials in ~/.f/f.creds.enc, protected by a passkey-derived
// key. Unlock spawns a daemon that holds the key in memory and serves ops over a
// unix socket until TTL expires. Zero deps.

// Provider table (see ./providers.js): every uck that exports a
// `credentialProvider` is consulted when a name is missing from the box, and the
// answer is mirrored back in as `mirror:<name>` with a ttl. Local always wins.
import { registerProvider, resolveViaProvider, listProviders, providerDiscoveryError, MIRROR_PREFIX, mirrorName, isMirrorKey, clearMisses, missBackoffLeft, mirrorSource } from "./providers.js";

import net from "node:net";
import fs from "node:fs";
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

/** Mirror entries are vault-sourced and expire; stamp the expiry on store. */
async function setMirror(name, value, ttlMs, state) {
  const st = state ?? (await requireUnlocked());
  const r = await daemonCall(
    { op: "set", name, value: { b64: Buffer.from(String(value), "utf8").toString("base64") }, expiresAt: Date.now() + ttlMs },
    st.socket,
  );
  if (!r.ok) throw new Error(r.error);
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
  const expires = lf.start + lf.ttl * 1000;
  if (now >= expires) return null; // expired (daemon will clean itself up)
  return { remainingMs: expires - now, socket: lf.socket, pid: lf.pid };
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

async function unlock(passkeyArg, ttl) {
  ensureFDir();
  const existing = unlockedState();
  if (existing) {
    process.stderr.write(`f: already unlocked (${fmt(existing.remainingMs)} left)\n`);
    return true;
  }
  const passkey = passkeyArg ?? (await promptPasskey());
  if (!passkey) {
    process.stderr.write("f: no passkey\n");
    return false;
  }
  // Spawn daemon detached; passkey via stdin (not argv).
  const expiresAt = Date.now() + (ttl ?? DEFAULT_TTL) * 1000;
  const child = spawn(process.execPath, [DAEMON, "--socket", SOCKET, "--lockfile", LOCKFILE, "--ttl", String(ttl ?? DEFAULT_TTL), "--creds", CREDS, "--expires-at", String(expiresAt)], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.write(passkey);
  child.stdin.end();
  child.unref();
  // Wait briefly for the socket to come up.
  await waitForSocket(SOCKET, 2000);
  return true;
}

function lock() {
  const lf = readLockfile();
  if (!lf || !pidAlive(lf.pid)) {
    process.stderr.write("f: not unlocked\n");
    for (const f of [SOCKET, LOCKFILE]) try { fs.unlinkSync(f); } catch {}
    return;
  }
  process.kill(lf.pid, "SIGTERM");
  process.stderr.write("f: locked\n");
}

async function requireUnlocked() {
  const state = unlockedState();
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
  // Helper: does the cred exist right now (daemon must be up)?
  async function tryGet() {
    const state = unlockedState();
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
    // Programmatic entry for other ucks.
    credsApi: {
      async get(name, ttl) {
        const state = unlockedState();
        if (!state) throw new Error("creds locked");
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
        if (res.error) throw new Error(`provider '${res.provider}' failed: ${res.error}`);
        if (res.none) throw new Error(r.error ?? `no such cred: ${name}`);
        throw new Error(r.error ?? `no such cred: ${name} (no provider has it)`);
      },
      async set(name, value) {
        const state = unlockedState();
        if (!state) throw new Error("creds locked");
        await daemonCall({ op: "set", name, value }, state.socket);
      },
      async ls() {
        const state = unlockedState();
        if (!state) throw new Error("creds locked");
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
      unlock,
      lock,
      /** Resolve a name exactly as `f creds get` does, with provenance.
       *  opts: { localOnly, forceProvider, noCache }. Returns
       *  { value, source, warning? } or throws. Use this from a uck that needs
       *  to report where a token came from. */
      async resolve(name, opts = {}) {
        const state = unlockedState();
        if (!state) throw new Error("creds locked");
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
          if (res.error) throw new Error(`provider '${res.provider}' failed: ${res.error}`);
          if (res.none) throw new Error(`no such cred: ${name} (${res.note})`);
        }
        throw new Error(`no such cred: ${name}`);
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
        return s ? { unlocked: true, remainingMs: s.remainingMs } : { unlocked: false };
      },
    },
    run: (argv, args) => {
      const pos = [];
      let ttl = DEFAULT_TTL;
      let timeoutSec = 300; // default wait window for `request`
      let showSecrets = false;
      let force = false;
      let dryRun = false;
      let outDir = null;
      let asStdin = null;
      let jsonOut = false;
      let localOnly = false;      // --local: never consult providers
      let forceProvider = false;  // --vault: bypass local + mirror, ask providers now
      let showSource = false;     // --source: print provenance alongside the value
      let noCache = false;        // --no-cache: ignore + clear the negative cache
      let showAll = false;        // --all (ls): include provider mirrors
      const a = [...(args._ ?? [])];
      for (let i = 0; i < a.length; i++) {
        if (a[i] === "--ttl") {
          ttl = parseDurationSec(a[++i], "--ttl");
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
        } else pos.push(a[i]);
      }
      const redact = (value) =>
        showSecrets ? String(value) : `[redacted — pass --secrets to reveal]`;
      const [cmd, ...rest] = pos;

      // Returned, not fired-and-forgotten. An unawaited floating IIFE means the
      // caller cannot know when a command finished (a test driver had to poll for
      // it), and a rejection after the first tick is an unhandled rejection that
      // Node turns into a nonzero exit with a stack, not a message. Callers that
      // ignore the promise behave exactly as before.
      return (async () => {
        switch (cmd) {
          case "unlock":
            await unlock(rest[0], ttl);
            break;
          case "lock":
            lock();
            break;
          case "status": {
            const s = unlockedState();
            process.stdout.write(s ? `unlocked (${fmt(s.remainingMs)} left)\n` : "locked\n");
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
            const [name, ...valParts] = rest;
            if (!name || valParts.length === 0) return usage("set requires <name> <value>");
            if (isMirrorKey(name)) return usage(`'${MIRROR_PREFIX}\u2026' is reserved for provider mirrors — drop the prefix`);
            await op("set", { name, value: valParts.join(" ") });
            // An explicit local value supersedes any mirror of the same name.
            // NOT via op(): op() calls process.exit(1) on a missing entry, and a
            // process.exit inside `try { await op(...) } catch {}` is uncatchable
            // — the command died with `no such cred: mirror:<name>` AFTER the set
            // had already succeeded, so every plain `f creds set <name>` of a name
            // with no mirror exited 1 while doing exactly what was asked. Ask the
            // daemon directly and treat "no mirror" as the normal case.
            if (!forceProvider) {
              const st = await requireUnlocked();
              await daemonCall({ op: "rm", name: MIRROR_PREFIX + name }, st.socket).catch(() => {});
            }
            clearMisses(name);
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
          case "forget": {
            // Drop the mirror(s) + negative cache for a name so the next get
            // revalidates. Does not touch real local creds.
            const names = rest.length ? rest : null;
            if (noCache || !names) clearMisses();
            const state = await requireUnlocked();
            if (!names) {
              const r = await daemonCall({ op: "ls" }, state.socket);
              // daemonCall, not op(): op() process.exit(1)s on a missing entry and
              // that is uncatchable, so a mirror deleted underneath us by expiry
              // would abort the whole sweep.
              for (const n of (r.names ?? []).filter(isMirrorKey)) {
                await daemonCall({ op: "rm", name: n }, state.socket).catch(() => {});
              }
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
                await daemonCall({ op: "rm", name: key }, state.socket).catch(() => {});
                process.stdout.write(`forgot\t${n}\n`);
              } else {
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
              // daemonCall, not op(): op() process.exit(1)s internally, which no
              // .catch() can intercept, so the follow-up notes below would never
              // print and the command would look like a failed delete.
              if (mirrorR?.exists) {
                await daemonCall({ op: "rm", name: mirrorKey }, st.socket).catch(() => {});
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

function waitForSocket(p, ms) {
  const start = Date.now();
  return new Promise((resolve) => {
    const try_ = () => {
      if (fs.existsSync(p)) return resolve();
      if (Date.now() - start > ms) return resolve();
      setTimeout(try_, 50);
    };
    try_();
  });
}

function usage(msg) {
  const line = msg ? `f: ${msg}\n` : "";
  process.stderr.write(
    line +
      "usage: f creds <cmd>\n" +
      "  unlock [passkey] [--ttl sec]   start daemon; --ttl accepts s/m/h/d/w\n" +
      "                                    (e.g. 900, 45m, 2h, 1d, 1d6h30m; default 10m)\n" +
      "  lock                            stop daemon, zeroize key\n" +
      "  status                          locked / unlocked + time left, + provider readiness\n" +
      "  set <name> <value>              store a cred (also clears that name's mirror)\n" +
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

export default { register };
