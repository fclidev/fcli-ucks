// f uck — push ucks in the store to a git repo, and manage push targets.
//
// The store is nested: ~/.f/ucks/<bucket>/<name>/index.js. A "push target" is a
// { name, url, ref }. The bucket name IS the link: `f uck push -r mine` mirrors
// every uck under ~/.f/ucks/mine/ into the target's repo.
//
// Push model: a persistent local clone per target at ~/.f/uck-work/<name>/.
//   - rebase (default): fetch, apply store changes as a commit, `git rebase
//     origin/<ref>`, push. Your local history and the remote's genuinely merge.
//     A rebase conflict pauses the push and points you at the work clone to
//     resolve (or abort) — it never auto-continues.
//   - --no-rebase: the simpler FF-only path (fresh clone → overwrite → commit →
//     push). Store wins per uck; a diverged remote gets the store's copy.
//
// Pull is NOT re-implemented here: to pull, add the repo as a source in
// f.config.json (optionally with a matching `name`) and run `f up`.
//
// Zero deps (node:fs, node:path, node:child_process).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const F = path.join(process.env.HOME ?? "", ".f");
const REPO_FILE = path.join(F, "f.repo.json");

function loadTargets() {
  try {
    const raw = JSON.parse(fs.readFileSync(REPO_FILE, "utf8"));
    if (Array.isArray(raw.targets)) return raw.targets;
  } catch {}
  return [];
}
function saveTargets(targets) {
  fs.mkdirSync(F, { recursive: true });
  fs.writeFileSync(REPO_FILE, JSON.stringify({ targets }, null, 2) + "\n");
}
function findTarget(name) {
  return loadTargets().find((t) => t.name === name) ?? null;
}

function storeBucketDir(bucket) {
  return path.join(F, "ucks", bucket);
}

/** List uck names present in a store bucket. */
function bucketUcks(bucket) {
  const dir = storeBucketDir(bucket);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => {
      try {
        return (
          fs.statSync(path.join(dir, n)).isDirectory() &&
          fs.existsSync(path.join(dir, n, "index.js"))
        );
      } catch {
        return false;
      }
    })
    .sort();
}

function git(cmd, cwd) {
  return execSync(`git ${cmd}`, { cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 }).toString().trim();
}

/** git that returns { ok, stdout, stderr } instead of throwing, for commands we handle. */
function gitTry(cmd, cwd) {
  try {
    const out = execSync(`git ${cmd}`, { cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 }).toString();
    return { ok: true, stdout: out.trim(), stderr: "" };
  } catch (e) {
    const msg = e.message ?? String(e);
    return { ok: false, stdout: "", stderr: msg };
  }
}

function workDir(name) {
  return path.join(F, "uck-work", name);
}

/** Ensure a persistent work clone for the target exists and is up to date. Returns {ref, head}. */
function ensureWorkClone(target) {
  const wd = workDir(target.name);
  const ref = target.ref ?? "HEAD";
  if (!fs.existsSync(path.join(wd, ".git"))) {
    fs.mkdirSync(path.dirname(wd), { recursive: true });
    const r = gitTry(`clone ${target.url} ${wd}`);
    if (!r.ok) throw new Error(`clone failed for ${target.name}: ${firstLine(r.stderr)}`);
    if (target.ref) {
      const co = gitTry(`checkout ${target.ref}`, wd);
      if (!co.ok) throw new Error(`checkout ${target.ref} failed: ${firstLine(co.stderr)}`);
    }
  } else {
    const fr = gitTry(`fetch origin`, wd);
    if (!fr.ok) throw new Error(`fetch failed for ${target.name}: ${firstLine(fr.stderr)}`);
  }
  // Make the work clone non-interactive by default, so any git command an
  // operator (or LLM) runs in it — including 'git rebase' during conflict
  // resolution — never hangs waiting for an editor.
  gitTry(`config core.editor true`, wd);
  gitTry(`config rebase.autoStash false`, wd);
  return wd;
}

function firstLine(s) {
  return (s ?? "").split("\n").find((l) => l.trim()) ?? "";
}

/** The remote-tracking ref for the target's branch (origin/<ref>, or origin/HEAD if ref unset). */
function upstreamRef(wd, target) {
  if (target.ref) return `origin/${target.ref}`;
  // Default branch: resolve origin/HEAD if set, else the current branch's upstream.
  const head = gitTry("rev-parse --abbrev-ref origin/HEAD", wd);
  if (head.ok && head.stdout) return head.stdout;
  const up = gitTry("rev-parse --abbrev-ref --symbolic-full-name @{u}", wd);
  if (up.ok && up.stdout) return up.stdout;
  // Fallback: whatever branch we're on, assume same name on origin.
  const cur = gitTry("rev-parse --abbrev-ref HEAD", wd);
  return `origin/${cur.stdout || "master"}`;
}

/**
 * Push named ucks (or all ucks in the bucket when names is empty) from the
 * store bucket to the target repo.
 *
 * rebase=true (default): persistent work clone + real rebase. On a rebase
 * conflict, stops and reports how to resolve/abort in the work clone.
 * rebase=false: fresh-clone → overwrite → commit → push (FF-only, store wins).
 */
function push(bucket, target, names, rebase = true) {
  if (!fs.existsSync(storeBucketDir(bucket))) {
    throw new Error(`no such bucket in store: ${bucket} (is it installed?)`);
  }
  const ucks = names.length ? names : bucketUcks(bucket);
  if (!ucks.length) throw new Error(`nothing to push to ${target.name}`);
  const present = bucketUcks(bucket);
  for (const n of ucks) if (!present.includes(n)) throw new Error(`no such uck in store: ${bucket}/${n}`);

  const applyStore = (wd) => {
    for (const n of ucks) {
      const dest = path.join(wd, n);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(path.join(storeBucketDir(bucket), n), dest, {
        recursive: true,
        filter: (src) => !src.includes("node_modules"),
      });
    }
  };

  if (!rebase) {
    // --- FF-only path: fresh shallow clone → overwrite → commit → push. ---
    const tmp = path.join(F, ".push-" + Date.now().toString(36));
    fs.mkdirSync(tmp, { recursive: true });
    const work = path.join(tmp, "work");
    try {
      const cloneArgs = target.ref ? `clone --depth 1 --branch ${target.ref} ${target.url} ${work}` : `clone --depth 1 ${target.url} ${work}`;
      const cr = gitTry(cloneArgs);
      if (!cr.ok) throw new Error(`clone failed: ${firstLine(cr.stderr)}`);
      applyStore(work);
      const status = gitTry("status --porcelain", work);
      if (status.stdout) {
        git("add -A", work);
        git(`commit -m "f uck: update ${ucks.join(", ")}"`, work);
        const pr = gitTry("push", work);
        if (!pr.ok) throw new Error(`push rejected (non-fast-forward). Pull/merge and retry.\n${pr.stderr}`);
      } else {
        process.stderr.write(`f uck: nothing changed for ${target.name}\n`);
      }
      for (const n of ucks) process.stderr.write(`f uck: pushed ${n} → ${target.name}\n`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }

  // --- Rebase path: persistent work clone. ---
  const wd = ensureWorkClone(target);
  const up = upstreamRef(wd, target);

  // 1. Apply store changes as a commit (if anything changed).
  applyStore(wd);
  const status = gitTry("status --porcelain", wd);
  if (status.stdout) {
    git("add -A", wd);
    git(`commit -m "f uck: update ${ucks.join(", ")}"`, wd);
  }

  // 2. Rebase onto the remote's latest. On a conflict: abort and error — no
  //    auto-resolution. The user pulls and pushes manually.
  const upExists = gitTry(`rev-parse --verify ${up}`, wd).ok;
  if (upExists) {
    const rb = gitTry(`rebase ${up}`, wd); // work clone has core.editor=true (non-interactive)
    if (!rb.ok) {
      // Gather what conflicted (if any) before cleaning up.
      const unmerged = gitTry("diff --name-only --diff-filter=U", wd).stdout.split("\n").filter(Boolean);
      const remoteTip = gitTry(`rev-parse --short ${up}`, wd).stdout;
      const localTip = gitTry("rev-parse --short HEAD", wd).stdout;
      const behind = gitTry(`rev-list --count HEAD..${up}`, wd).stdout; // remote commits we don't have
      gitTry(`rebase --abort`, wd); // leave the work clone clean

      const files = unmerged.length
        ? "conflicting files:\n  " + unmerged.join("\n  ")
        : "no unmerged files listed (history-level conflict — the remote branch diverged)";
      throw new Error(
`PUSH CONFLICT for target '${target.name}' (rebase of local onto ${up} failed).

What happened:
  The remote branch ${up} (tip ${remoteTip || "?"}) has commits that the store's changes
  conflict with. f rebases the store's changes onto the remote before pushing;
  that rebase could not be applied cleanly, so f aborted it and pushed nothing.
  (local and remote have diverged; remote is ${behind || "?"} commit(s) ahead of where local branched)

${files}

How to fix (pick one), all in the work clone:
  cd ${wd}

  Option A — reconcile manually (keep both sides' work):
    # (f already aborted the rebase, so the work clone is clean — start fresh)
    git rebase ${up}                        # replay local commits onto the remote
    # a conflict will appear; edit the conflicted files to the content you want
    # (or copy the store's version over a uck the store should win), then:
    git rebase --continue                   # or: git rebase --abort to bail out
    git push
    # after, the work clone is up to date; re-run the push to sync the store:
    f uck push -r ${target.name}

  Option B — store wins (discard remote's conflicting uck changes, keep store):
    git reset --hard ${up}                       # take the remote as the base
    # overwrite the uck(s) with the store's copy, then:
    f uck push -r ${target.name} --no-rebase      # fresh-clone, store overwrites, push

  Option C — inspect first:
    git log --oneline --graph --all             # see the divergence
    git diff ${up} HEAD                          # see what differs

  The store (source of truth for the uck code) is at: ${storeBucketDir(bucket)}
  The work clone is a scratch git repo — it is safe to delete and re-push.`);
    }
  }

  // 3. Push (rebase keeps history linear, so this fast-forwards).
  const pr = gitTry("push", wd);
  if (!pr.ok) {
    throw new Error(`push failed for ${target.name}: ${firstLine(pr.stderr)}\n(work clone: ${wd})`);
  }
  for (const n of ucks) process.stderr.write(`f uck: pushed ${n} → ${target.name}\n`);
}

function usage(msg) {
  const line = msg ? `f uck: ${msg}\n` : "";
  process.stderr.write(
    line +
      "usage: f uck <cmd>\n" +
      "  new <name> [--bucket <b>] [--desc <d>]   scaffold a new uck dir\n" +
      "  repo add <name> <url> [--ref <ref>]   register a push target\n" +
      "  repo ls                               list push targets\n" +
      "  repo rm <name>                        unregister a target\n" +
      "  push [<uck>...] [-r <name>]           push store ucks to a target\n" +
      "      [--no-rebase]                       FF-only push (default: rebase)\n"
  );
  process.exit(1);
}

/**
 * `f uck new <name>` — scaffold a contract-compliant uck in the store.
 * Contract (CONTRACT.md §1): one dir per uck, index.js + package.json
 * ({"name": "<bucket>-<name>", "type": "module"}), side-effect-free module
 * scope, register(ctx) returning { name, desc, run }.
 */
function cmdNew(rest) {
  const name = rest[0];
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return usage("new needs a name (lowercase alnum + dashes)");
  }
  let bucket = null;
  let desc = "";
  for (let i = 1; i < rest.length; i++) {
    if (rest[i] === "--bucket") bucket = rest[++i];
    else if (rest[i] === "--desc") desc = rest[++i];
  }
  if (!bucket) {
    // default to the first bucket that is a git clone (a real repo to commit to)
    for (const b of loadTargets().map((t) => t.name)) {
      if (fs.existsSync(path.join(F, "ucks", b, ".git"))) { bucket = b; break; }
    }
  }
  if (!bucket) return usage("no bucket — pass --bucket <name> (a store dir under ~/.f/ucks)");
  const dir = path.join(F, "ucks", bucket, name);
  if (fs.existsSync(dir)) {
    process.stderr.write(`f uck: ${dir} already exists\n`);
    process.exit(1);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `${bucket}-${name}`, type: "module" }, null, 2) + "\n");
  fs.writeFileSync(
    path.join(dir, "index.js"),
    `export function register(ctx) {
  return {
    name: "${name}",
    desc: ${JSON.stringify(desc || "TODO: one line, ≤ 120 chars")},
    run: (_argv, args) => {
      // args._ is the remaining CLI tokens
      process.stdout.write("${name}: not implemented\\n");
    },
  };
}
export default { register };
`
  );
  process.stderr.write(`f uck: scaffolded ${dir}\n  edit index.js, commit + push in ${bucket}\n`);
}

export function register(ctx) {
  return {
    name: "uck",
    desc: "push store ucks to a git repo (bucket name = target name)",
    skills: [{ name: "f-uck-creation", path: path.join(__dirname, "SKILL.md") }],
    uckApi: { loadTargets, saveTargets, push, bucketUcks },
    run: (argv, args) => {
      const a = [...(args._ ?? [])];
      let rName = null;
      let ref = null;
      let rebase = true;
      const pos = [];
      for (let i = 0; i < a.length; i++) {
        if (a[i] === "-r" || a[i] === "--repo") { rName = a[++i]; }
        else if (a[i] === "--ref") { ref = a[++i]; }
        else if (a[i] === "--no-rebase") { rebase = false; }
        else if (a[i] === "--rebase") { rebase = true; }
        else pos.push(a[i]);
      }
      const [cmd, ...rest] = pos;

      switch (cmd) {
        case "new": {
          cmdNew(rest);
          break;
        }
        case "repo": {
          const sub = rest[0];
          if (sub === "add") {
            const name = rest[1], url = rest[2];
            if (!name || !url) return usage("repo add needs <name> <url>");
            const targets = loadTargets();
            const i = targets.findIndex((t) => t.name === name);
            const t = { name, url, ref: ref ?? null };
            if (i >= 0) targets[i] = t;
            else targets.push(t);
            saveTargets(targets);
            process.stderr.write(`f uck: target ${name} → ${url}${ref ? ` @ ${ref}` : ""}\n`);
          } else if (sub === "rm") {
            const name = rest[1];
            if (!name) return usage("repo rm needs <name>");
            const targets = loadTargets().filter((t) => t.name !== name);
            saveTargets(targets);
            process.stderr.write(`f uck: removed target ${name}\n`);
          } else if (sub === "ls" || !sub) {
            const targets = loadTargets();
            if (!targets.length) return process.stderr.write("f uck: no push targets (use `f uck repo add`)\n");
            for (const t of targets) {
              const ucks = bucketUcks(t.name);
              process.stdout.write(`${t.name}\t${t.url}${t.ref ? ` @ ${t.ref}` : ""}\t[ ${ucks.join(", ") || "no ucks in store"} ]\n`);
            }
          } else return usage(`unknown repo subcommand: ${sub}`);
          break;
        }
        case "push": {
          const names = rest;
          const target = rName ? findTarget(rName) : (loadTargets().length === 1 ? loadTargets()[0] : null);
          if (!target) {
            const t = loadTargets();
            if (rName && !t.some((x) => x.name === rName)) return usage(`no such target: ${rName} (see 'f uck repo ls')`);
            return usage(t.length ? "specify a target with -r <name>" : "no push targets (use `f uck repo add`)");
          }
          try {
            push(target.name, target, names, rebase);
          } catch (e) {
            process.stderr.write(`f uck: ${e.message}\n`);
            process.exit(1);
          }
          break;
        }
        default:
          usage();
      }
    },
  };
}

export default { register };
