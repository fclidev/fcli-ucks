// classifyCredsError — shared helper for ucks that read creds through the
// creds uck's `credsApi` peer surface.
//
// Contract (CONTRACT.md §7): peers branch on STRUCTURE, never on another
// uck's error-message wording. The creds uck (credsApi.version >= 1) throws
// CredsError with a .kind field; this helper normalizes any thrown value
// into one of the three states every consumer needs.
//
//   import { classifyCredsError } from "../../fcli-ucks/lib/creds-error.js";
//   try {
//     const v = await credsApi.get(name);
//   } catch (e) {
//     switch (classifyCredsError(name, e)) {
//       case "locked":  …user must `f creds unlock`…; break;
//       case "missing": …not in the box, no provider has it…; break;
//       case "error":   …availability failure, surface e.message…; break;
//     }
//   }
//
// Returns "locked" | "missing" | "error". For version < 1 (pre-CredsError
// creds builds) it falls back to message matching — the same match the old
// inline code did — so migration is safe either way.
//
// Zero deps.

const LOCKED = /locked/i;
const MISSING = /no such cred/i;

export function classifyCredsError(_name, e) {
  const kind = e && e.kind;
  if (kind === "locked" || kind === "missing" || kind === "provider" || kind === "other") {
    if (kind === "locked") return "locked";
    if (kind === "missing") return "missing";
    return "error";
  }
  const m = (e && e.message) || String(e);
  if (LOCKED.test(m)) return "locked";
  if (MISSING.test(m)) return "missing";
  return "error";
}

export default { classifyCredsError };
