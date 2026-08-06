// cli.ts — engine for the /verify skill.
//
// Three verbs, each a thin wrapper over a pure module. The skill is the
// control loop; this only does plumbing it would be silly to do in markdown.
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    criteria: { type: "string" },
    results: { type: "string" },
    repo: { type: "string" },
    base: { type: "string" },
    claims: { type: "string" },
  },
});

const [command] = positionals;

if (command === "criteria") {
  const { renderCriteria } = await import("./lib/criteria.js");
  if (!values.criteria) {
    console.error("criteria requires --criteria <path to json>");
    process.exit(1);
  }

  const input = JSON.parse(readFileSync(values.criteria, "utf8"));

  // TypeScript does nothing for JSON read at runtime. Without this, a criterion missing
  // its declarations renders as an empty cell and the grid silently undercounts.
  const { validateCriteria } = await import("./lib/criteria.js");
  const problems = validateCriteria(input.criteria);
  if (problems.length > 0) {
    console.error("criteria.json is not valid:");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }

  console.log(renderCriteria(input.criteria, input.uncoveredFiles ?? []));

} else if (command === "report") {
  const { renderReport } = await import("./lib/verdict.js");
  if (!values.results) {
    console.error("report requires --results <path to json>");
    process.exit(1);
  }

  const input = JSON.parse(readFileSync(values.results, "utf8"));
  console.log(renderReport(input.results, input.coverage, input.notChecked ?? []));

} else if (command === "changed-files") {
  const { execFileSync } = await import("node:child_process");
  const { parseDiffNames, uncoveredFiles } = await import("./lib/changed-files.js");

  const repo = values.repo ?? process.cwd();
  const base = values.base ?? "origin/HEAD";

  // A base beginning with `-` would be parsed by git as an option rather than a
  // revision. execFileSync uses no shell, so this is not injection, but it
  // produces a baffling error instead of an honest one.
  if (base.startsWith("-")) {
    console.error(`changed-files: --base must be a revision, got "${base}"`);
    process.exit(1);
  }

  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  // Resolve the base before diffing. Without this an unknown revision surfaces
  // as an unhandled exception and a Node stack trace, which tells the caller
  // nothing about what to pass instead. Observed for real: `--base origin/main`
  // against a repo whose default branch is `master`.
  try {
    git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  } catch {
    let candidates = "";
    try {
      candidates = git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"])
        .split("\n")
        .filter(Boolean)
        .slice(0, 8)
        .join(", ");
    } catch {
      // A repo with no remotes is a fine reason to have no candidates.
    }
    console.error(`changed-files: unknown revision "${base}" in ${repo}`);
    if (candidates) console.error(`  available: ${candidates}`);
    console.error(`  hint: this branch's upstream is usually the right base`);
    process.exit(1);
  }

  const committed = git(["diff", "--name-only", `${base}...HEAD`]);
  const unstaged = git(["diff", "--name-only"]);
  const staged = git(["diff", "--name-only", "--cached"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  const changed = [
    ...new Set(parseDiffNames([committed, unstaged, staged, untracked].join("\n"))),
  ].sort();

  if (values.claims) {
    const claims = JSON.parse(readFileSync(values.claims, "utf8"));
    const uncovered = uncoveredFiles(changed, claims);
    console.log(
      JSON.stringify(
        { changed, uncovered, filesWithoutCriterion: uncovered.length },
        null,
        2,
      ),
    );
  } else {
    console.log(JSON.stringify({ changed }, null, 2));
  }
} else {
  console.error("Usage:");
  console.error("  npx tsx src/cli.ts criteria      --criteria <json>");
  console.error("  npx tsx src/cli.ts report        --results <json>");
  console.error("  npx tsx src/cli.ts changed-files --repo <dir> --base <rev> [--claims <json>]");
  process.exit(1);
}
