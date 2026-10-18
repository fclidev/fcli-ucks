/**
 * f search <query> — rank installed ucks against what you are trying to do.
 *
 * This is a uck rather than core code on purpose: ranking is the part most
 * likely to need tuning, and a uck can be published without cutting an f
 * release. It also means search dogfoods the thing it searches.
 *
 * Two consequences of that choice, both handled below:
 *
 * 1. ctx.ucks is complete at run time, and it contains this uck. Its own desc
 *    mentions "rank" and "ucks", so an unfiltered search matches itself on
 *    almost every query. Excluded via ctx.self.
 * 2. A uck can only see the registry at run time, so `f search` is absent if
 *    the store is empty. That is inherent — `f help` and `f up` are core
 *    precisely because they must answer before any uck exists.
 */

// Search output caps descriptions far harder than `f help` ever did (core's
// DESC_MAX is 120). Search returns several lines at once and each one pays for
// its own description, so per-line cost is what the model actually feels:
// measured on three matches, 120 chars costs 84 tokens, 40 costs 49, 30 costs
// 34. A hit is a pointer to `f <uck> --help`, not a substitute for it.
const DESC_MAX = 40;

const WORD = /[^a-z0-9]+/;

function tokenize(s) {
  return s
    .toLowerCase()
    .split(WORD)
    .filter((t) => t.length > 1); // drop 1-char noise: "f", "a", path fragments
}

function clampDesc(desc) {
  const one = String(desc ?? "")
    .split("\n")[0]
    .trim();
  if (one.length <= DESC_MAX) return one;
  // Cut at a word boundary: "store credentials (scrypt+AES-GCM,…" reads as a
  // label, whereas a mid-word cut reads as corruption.
  const cut = one.slice(0, DESC_MAX - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > DESC_MAX / 2 ? cut.slice(0, sp) : cut) + "…";
}

/**
 * Substring matching, not fuzzy and not semantic, so the model can predict what
 * will match — a typo does not. Weights, highest first:
 *   exact name 8 | name word 6 | name-word prefix 4 | name substring 3
 *   desc word 2  | desc-word prefix 1.5 | desc substring 1
 * A hyphenated name (`pi-models`) counts as two words, so "models" finds it.
 *
 * A uck matched purely on its description has not been named — it is a guess —
 * so it gets no +100 and sorts after every name hit.
 */
function score(uck, terms) {
  const nameWords = uck.name.toLowerCase().split(WORD).filter(Boolean);
  const descWords = String(uck.desc ?? "")
    .toLowerCase()
    .split(WORD)
    .filter(Boolean);
  const name = uck.name.toLowerCase();
  const desc = String(uck.desc ?? "").toLowerCase();
  let total = 0;
  // Which terms matched this uck's *name*. The byName/byDesc split alone is
  // ambiguous on multi-term queries: `f search credential home` yields a strong
  // name hit (creds) and a description-only hit (ha), and neither the score nor
  // the position says which term earned which row.
  const namedBy = [];
  for (const t of terms) {
    if (name === t) {
      total += 8;
      namedBy.push(t);
    } else if (nameWords.some((w) => w === t)) {
      total += 6;
      namedBy.push(t);
    } else if (nameWords.some((w) => w.startsWith(t))) {
      total += 4;
      namedBy.push(t);
    } else if (name.includes(t)) {
      total += 3;
      namedBy.push(t);
    } else if (descWords.some((w) => w === t)) total += 2;
    else if (descWords.some((w) => w.startsWith(t))) total += 1.5;
    else if (desc.includes(t)) total += 1;
  }
  // +100 keeps any name hit above any description-only hit, whatever the mix.
  return { score: namedBy.length ? total + 100 : total, namedBy };
}

function searchMatches(ucks, terms) {
  const out = [];
  for (const u of ucks) {
    const { score: s, namedBy } = score(u, terms);
    if (s > 0)
      out.push({
        name: u.name,
        desc: clampDesc(u.desc),
        score: s,
        named: namedBy.length > 0,
        namedBy,
      });
  }
  // Best first; ties broken by name so output is stable across runs and stores.
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

const USAGE = `usage: f search <query>

  ranks installed ucks by name, then by description.
  matches on substrings and word prefixes, not meaning.

  e.g. f search credential
       f search "list files"
`;

export function register(_ctx) {
  return {
    name: "search",
    desc: "rank ucks against a query (name, then description)",
    // Declared, not printed from run(). Core intercepts bare `f search`,
    // `--help` and `-h` only when a uck provides .help or .about (src/cli.ts
    // isBareHelp), so declaring it is what makes `f search --help` show usage.
    // Without it, "--help" falls through as a search term and the uck answers
    // "no uck matched: --help" — which reads as a working command that found
    // nothing, when the caller actually asked it how to work.
    help: USAGE,
    run: (argv, args, ctx) => {
      // Reject flags rather than searching for them. Without this, `f search
      // --verbose` scores "verbose" as a query term and answers "no uck
      // matched" — a wrong answer delivered confidently. Unknown flags are
      // refused rather than ignored: `search` takes no flags today, and
      // silently accepting one is how a future `--limit` gets typed, accepted,
      // and does nothing.
      const pos = [];
      for (const a of args._ ?? []) {
        if (a.startsWith("-")) {
          process.stderr.write(`f: search: unknown flag '${a}'\n`);
          process.stderr.write(USAGE);
          return 2;
        }
        pos.push(a);
      }
      const query = pos.join(" ");
      // tokenize() drops 1-char noise, so a query like "a b" leaves nothing to
      // match on. That is a malformed query, not an empty result — report it as
      // usage so it does not read as "no such capability exists".
      const terms = tokenize(query);
      if (!terms.length) {
        process.stdout.write(USAGE);
        return;
      }
      // ctx.self: never let this uck answer its own search.
      const peers = (ctx.ucks ?? []).filter((u) => u.name !== ctx.self);
      const hits = searchMatches(peers, terms);
      if (!hits.length) {
        // A real search result, not an error: it goes to stdout so `f search x
        // || fallback` reads naturally, and exit 1 still signals "nothing here".
        // Saying so at all matters — a silent empty result reads as "no such
        // capability" and sends the model off to invent a workaround.
        process.stdout.write(`no uck matched: ${query}\n`);
        return 1;
      }
      const byName = hits.filter((h) => h.named);
      const byDesc = hits.filter((h) => !h.named);
      // A row's standing must never be guessable from position alone. On
      // `f search config home`, config matches a name while ha/ha-ws reach the
      // results only through their descriptions — without a marker the strong
      // and weak hits are indistinguishable, and a description keyword appears
      // to outrank the command the query actually named.
      //
      // (Contrast `f search credential home`: no uck is named "credential", so
      // every hit is description-only and no marker is correct. Worth naming
      // because "a term that appears in some desc" and "a term that names a
      // uck" are easy to conflate when picking test cases.)
      //
      // Marker on name hits only when some hit did *not* match a name: with
      // every hit in the name tier, position carries no claim worth annotating,
      // and the extra characters are paid for on every query.
      const mixed = byDesc.length > 0 && byName.length > 0;
      const lines = byName.map(
        (h) =>
          `${h.name}  ${h.desc}` +
          // Which term earned this row. Only useful on a multi-term query —
          // otherwise it restates what was typed.
          (mixed && tokenize(query).length > 1
            ? `  [${h.namedBy.join(",")}]`
            : ""),
      );
      if (mixed) lines.push("matched on description:");
      for (const h of byDesc) lines.push(`${h.name}  ${h.desc}`);
      process.stdout.write(lines.join("\n") + "\n");
    },
  };
}

export default { register };
