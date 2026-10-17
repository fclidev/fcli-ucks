import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname, resolve, isAbsolute, sep } from "node:path";

const require = createRequire(import.meta.url);
const { JSONPath } = require("jsonpath-plus");

/** Resolve the config file for a target: "project" | "global" | explicit path. */
function resolveTarget(target) {
  if (target && target !== "project" && target !== "global") {
    return target; // explicit path
  }
  if (target === "global") {
    return join(process.env.HOME ?? "", ".f", "f.config.json");
  }
  // project: walk up from cwd
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const p = join(dir, "f.config.json");
    if (existsSync(p)) return p;
    dir = join(dir, "..");
  }
  // No project config found — default to creating in cwd.
  return join(process.cwd(), "f.config.json");
}

function readDoc(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeDoc(path, doc) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
}

/** Parse a value: try JSON first, fall back to raw string. */
function parseValue(raw) {
  // NOTE: String(value) in the callers is only correct because every value that
  // reaches it is already a string (an argv token). It is a trap for programmatic
  // callers: configApi.add(t, "ucks", ["a"]) stringifies to "a" and stores the
  // string, not the array. Parse non-strings through unchanged.
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * A uck source that points into the store, or null. Checked at the moment the
 * source is written, not when `f up` later tries to install it.
 *
 * Core refuses to install such a source: installing it copies a tree into
 * itself, and the copy partly lands before the failure — which is how one
 * mistyped path deleted `config/*` and `lib/*` from an author's own bucket and
 * left it claiming to be a clone of another repo. Seeing that here, on
 * `f config add`, beats seeing it during a later `f up`.
 *
 * Git URLs, npm specs and anything else that is not a filesystem path are
 * untouched, and only the realpath is compared — a source that merely shares a
 * label with a store ancestor is a name collision (ROADMAP C5), not a self-copy,
 * so it stays allowed.
 */
function insideStore(specifier) {
  if (typeof specifier !== "string" || !specifier) return null;
  if (/^(git\+|file|https?|ssh|ftps?):\/\//i.test(specifier)) return null;
  if (specifier.startsWith("github:") || specifier.startsWith("git@")) return null;
  const looksLikePath =
    specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("~");
  if (!looksLikePath) return null; // an npm spec
  const expanded =
    specifier.startsWith("~") ? join(process.env.HOME ?? "", specifier.slice(1)) : specifier;
  let abs;
  try {
    abs = realpathSync(isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded));
  } catch {
    return null; // unresolvable here; core reports it at install time
  }
  let store;
  try {
    store = realpathSync(join(process.env.HOME ?? "", ".f", "ucks"));
  } catch {
    return null; // no store yet: nothing can be inside it
  }
  return abs === store || abs.startsWith(store + sep) ? abs : null;
}

/**
 * Refuse to write a config whose uck sources point into the store. Throws
 * instead of writing, so the file is never left describing an uninstallable
 * source. NOTE: this guards the config only. Whether authors may *edit* store
 * buckets is a separate, unresolved question — see ROADMAP-1.0.md C1(b).
 */
function assertSourcesUsable(doc) {
  const list = Array.isArray(doc?.ucks) ? doc.ucks : Array.isArray(doc?.extensions) ? doc.extensions : [];
  const sources = list
    .map((s) => (typeof s === "string" ? s : typeof s?.source === "string" ? s.source : null))
    .filter(Boolean);
  const bad = sources.filter(insideStore);
  if (bad.length === 0) return;
  const store = join(process.env.HOME ?? "", ".f", "ucks");
  throw new Error(
    `uck source(s) point into the store (${store}):\n  ${bad.join("\n  ")}\n` +
      `A store bucket is a cache that f overwrites; a source inside it means copying a tree over itself.\n` +
      `Add an external path instead (a clone you made), or push and add the git URL.`
  );
}

/** Core ops. target: "project" | "global" | explicit path. */
const configApi = {
  /** Read the whole doc (or a path). Returns the natural value (no extra array wrap). */
  get(target, path) {
    const file = resolveTarget(target);
    const doc = readDoc(file);
    if (!path) return doc;
    const res = JSONPath({ path, json: doc, wrap: true });
    if (!Array.isArray(res) || res.length === 0) return null;
    // unwrap single match to its natural value; keep arrays for multi-match
    return res.length === 1 ? res[0] : res;
  },

  /** Set a value at a JSONPath. Creates intermediate objects as needed. */
  set(target, path, value) {
    const file = resolveTarget(target);
    const doc = readDoc(file);
    const val = parseValue(value);
    applySet(doc, path, val);
    assertSourcesUsable(doc);
    writeDoc(file, doc);
    return val;
  },

  /** Append a value into an array at a JSONPath (ucks[$] style). */
  add(target, path, value) {
    const file = resolveTarget(target);
    const doc = readDoc(file);
    const val = parseValue(value);
    applyAdd(doc, path, val);
    assertSourcesUsable(doc);
    writeDoc(file, doc);
    return val;
  },

  /** Remove matches at a JSONPath. */
  remove(target, path) {
    const file = resolveTarget(target);
    const doc = readDoc(file);
    const n = applyRemove(doc, path);
    writeDoc(file, doc);
    return n;
  },

  /** List the whole doc (alias for get with no path). */
  list(target) {
    return this.get(target);
  },
};

/** Set via resultType all (parent + parentProperty). */
function applySet(doc, path, value) {
  // If the path selects nothing, create it by walking segments.
  const existing = JSONPath({ path, json: doc, wrap: true });
  if (Array.isArray(existing) && existing.length > 0) {
    const all = JSONPath({ path, json: doc, resultType: "all" });
    for (const item of all) {
      if (item.parent && item.parentProperty != null) {
        item.parent[item.parentProperty] = value;
      }
    }
    return;
  }
  // Create intermediate structure then assign leaf.
  setPathCreate(doc, path, value);
}

/** Walk a simple dotted/bracketed path, creating objects/arrays, set leaf. */
function setPathCreate(doc, path, value) {
  const segments = parseSegments(path);
  let cur = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (cur[seg] == null) {
      // Infer array vs object from next segment.
      const next = segments[i + 1];
      cur[seg] = /^\d+$/.test(next) || next === "$" ? [] : {};
    }
    cur = cur[seg];
  }
  const leaf = segments[segments.length - 1];
  if (Array.isArray(cur) && (leaf === "$" || /^\d+$/.test(leaf))) {
    if (leaf === "$") cur.push(value);
    else cur[Number(leaf)] = value;
  } else {
    cur[leaf] = value;
  }
}

/** Append into an array. Path must select an array (e.g. "ucks" or "ucks[$]"). */
function applyAdd(doc, path, value) {
  // Append `value` to the array selected by `path`, creating it when absent.
  //
  // Everything is driven by JSONPath's own resultType "all" records
  // (parent / parentProperty) — the same source of truth applySet uses. Two
  // hand-rolled shortcuts lost data here:
  //   * the fallback was setPathCreate(doc, path, undefined): it assigned
  //     undefined, the key did not survive JSON.stringify, and
  //     `f config add ucks github:user/repo` — the example in this uck's own
  //     usage line — wrote {} and exited 0;
  //   * parseSegments("ucks[0]") returns ["ucks","0"], where "0" is part of the
  //     selector and not a container to walk into; walking it produced
  //     {"ucks":{"0":["b"]}}.
  //
  // An absent path must still work rather than fail: `add` is how a fresh config
  // gets its first source, and it is f's own bootstrap path — ensureGlobalConfig()
  // seeds a source with no ref, so `f config add <x>#main` on a machine that has
  // never run f also lands here.
  const clean = path.replace(/\[\$\]$/, "");
  const segments = parseSegments(clean);
  if (segments.length === 0) throw new Error(`config: '${path}' is not a usable path`);
  const leaf = segments.at(-1);
  const matches = JSONPath({ path: clean, json: doc, resultType: "all" });
  const anchor = matches[0];
  const parent = anchor && "parent" in anchor ? anchor.parent : undefined;
  const prop = anchor && "parentProperty" in anchor ? anchor.parentProperty : undefined;
  const owner =
    clean.replace(/\[[^\]]*\]$/, "") ||
    segments.slice(0, -1).reduce((acc, seg) => (seg.match(/^\d+$/) ? acc : acc + "." + seg), "").replace(/^\./, "") ||
    "the array";

  // A positional path is refused whether or not it currently matches.
  //   `add ucks[5] x` on a 1-element array matched nothing and would have written
  //   a HOLE — a hole serialises as null, and core's source loop does
  //   `typeof s === "string" ? s : s?.source`, so null becomes undefined and
  //   every later f command dies with "Uck source not found: undefined".
  //   `add ucks[0] x` on a 1-element array matched the element "a"; pushing onto
  //   a string is a no-op, so it reported success having changed nothing.
  // Positions have no append semantics at all — `set` is the operation for them.
  if (/^\d+$/.test(leaf)) {
    throw new Error(
      `config: '${clean}' addresses a position — use 'f config set' to replace it, or 'f config add ${owner}' to append`
    );
  }

  if (Array.isArray(parent)) {
    // The selector addressed an element of an array ($, or a name that JSONPath
    // resolved through one). Only [$] means "append here".
    if (leaf === "$") {
      parent.push(value);
      return;
    }
    throw new Error(`config: '${clean}' addresses a position — use 'f config add ${owner}' to append`);
  }

  if (parent !== undefined && prop !== undefined && prop !== null) {
    if (parent[prop] === undefined) {
      parent[prop] = [value];
      return;
    }
    if (!Array.isArray(parent[prop]))
      throw new Error(
        `config: '${clean}' is ${typeof parent[prop]}, not an array — use 'f config set' to give it a value`
      );
    parent[prop].push(value);
    return;
  }

  // Nothing matches: the key is absent. Create it (dotted paths included) and
  // store an array.
  let cursor = doc;
  for (const seg of segments.slice(0, -1)) {
    if (cursor[seg] === undefined) cursor[seg] = {};
    cursor = cursor[seg];
    if (cursor === null || typeof cursor !== "object")
      throw new Error(`config: '${clean}' passes through a non-object`);
  }
  if (cursor[leaf] === undefined) cursor[leaf] = [];
  if (!Array.isArray(cursor[leaf]))
    throw new Error(`config: '${clean}' is not an array — use 'f config set' to give it a value`);
  cursor[leaf].push(value);
}

function applyRemove(doc, path) {
  // Collect parents+indices for array elements, or keys for object props.
  const all = JSONPath({ path, json: doc, resultType: "all" });
  let removed = 0;
  for (const item of all) {
    if (item.parent == null) continue;
    const pp = item.parentProperty;
    if (Array.isArray(item.parent)) {
      const idx = Number(pp);
      if (Number.isInteger(idx) && idx >= 0 && idx < item.parent.length) {
        item.parent.splice(idx, 1);
        removed++;
      }
    } else if (typeof item.parent === "object" && pp in item.parent) {
      delete item.parent[pp];
      removed++;
    }
  }
  return removed;
}

/** Parse a path into segments: "ucks[2].source" -> ["ucks","2","source"]; "ucks" -> ["ucks"]. */
function parseSegments(path) {
  const segs = [];
  const re = /([^.[\]]+)|\[(\d+|\$)\]/g;
  let m;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) segs.push(m[1]);
    else segs.push(m[2]);
  }
  return segs;
}

/** The uck. */
export function register(ctx) {
  return {
    name: "config",
    desc: "edit f.config.json via JSONPath (get/set/add/remove/list)",
    // Programmatic entry: other ucks can do require("@fcli/config").configApi
    configApi,
    run: (argv, args) => {
      const flags = [];
      const pos = [];
      for (const a of args._ ?? []) (a === "-g" ? flags : pos).push(a);
      const target = flags.includes("-g") ? "global" : "project";

      const [op, path, value] = pos;
      if (!op) return usage();

      // A config edit that cannot be done must fail as one line plus the fix
      // (CONTRACT.md R3), not as a Node stack trace: this uck is the thing an LLM
      // reaches for when it is already confused about config, and a 30-frame
      // stack gives it nothing to act on. Previously there was no catch at all,
      // so a throwing add/set printed the stack of an internal helper.
      try {
        switch (op) {
        case "get":
          if (!path) return usage("get requires a path (or omit for whole doc)");
          print(configApi.get(target, path));
          break;
        case "list":
          print(configApi.list(target));
          break;
        case "set":
          if (!path || value == null) return usage("set requires <path> <value>");
          configApi.set(target, path, value);
          break;
        case "add":
          if (!path || value == null) return usage("add requires <path> <value>");
          configApi.add(target, path, value);
          break;
        case "remove":
          if (!path) return usage("remove requires a path");
          configApi.remove(target, path);
          break;
        default:
          usage();
        }
      } catch (e) {
        process.stderr.write(`f: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1; // not exit(1): CONTRACT.md C5 — never truncate stdout
      }
    },
  };
}

function print(v) {
  process.stdout.write(typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n");
}

function usage(msg) {
  const line = msg ? `f: ${msg}\n` : "";
  process.stderr.write(
    line +
      "usage: f config [-g] <op> <path> [value]\n" +
      "  ops: get | set | add | remove | list\n" +
      "  -g  target global ~/.f/f.config.json (default: project f.config.json)\n" +
      "  e.g. f config add ucks github:user/repo\n" +
      "       f config set ucks[0] ./my-uck\n" +
      "       f config remove 'ucks[?(@.source==\"./old\")]'\n"
  );
  // exitCode, not exit(): CONTRACT.md C5. process.exit() throws away whatever is
  // still buffered on stdout when stdout is a pipe — which is exactly how an agent
  // invokes a uck — so the truncation core just fixed would come back through a
  // usage error, quietly.
  process.exitCode = 1;
}

export default { register, configApi };
