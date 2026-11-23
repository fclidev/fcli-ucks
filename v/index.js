import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// CONTRACT §S2: the canonical module-dir expression, correct under both the
// `<bucket>/<uck>/` layout and the flattened local-source layout.
const here = dirname(fileURLToPath(import.meta.url));

export function register(ctx) {
  return {
    name: "v",
    desc: "print f version",
    // Self-register the shipped SKILL.md. The skills uck merges each uck's
    // `skills` array (uckExportedSkills), so a doc that ships in `files` but is
    // not exported here never reaches `f skills ls` — dead weight in the tarball.
    skills: [{ name: "f-v", path: join(here, "SKILL.md") }],
    run: () => console.log(ctx.fVersion),
  };
}
export default { register };
