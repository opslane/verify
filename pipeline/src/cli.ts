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
    precheck: { type: "string" },
    review: { type: "string" },
    "run-dir": { type: "string" },
    "run-id": { type: "string" },
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
  const { renderReport, applyTaint, reconcile } = await import("./lib/verdict.js");
  const { existsSync } = await import("node:fs");
  if (!values.results || !values.criteria) {
    console.error("report requires --results <json> --criteria <json>");
    process.exit(1);
  }

  const input = JSON.parse(readFileSync(values.results, "utf8"));
  const criteriaInput = JSON.parse(readFileSync(values.criteria, "utf8"));
  const criteria = criteriaInput.criteria ?? [];

  // Fail closed: criteria with dependencies demand a pipeline check. A green
  // report that skipped its prechecks is exactly the lie this tool exists to
  // prevent.
  const hasDeps = criteria.some((c: { dependsOn?: string[] }) => (c.dependsOn ?? []).length > 0);
  let precheck;
  if (values.precheck && existsSync(values.precheck)) {
    precheck = JSON.parse(readFileSync(values.precheck, "utf8"));
  } else if (hasDeps) {
    console.error("report: criteria declare dependencies but no --precheck file exists — run the pipeline check first");
    process.exit(1);
  }

  let results = reconcile(criteria, input.results, precheck);
  if (precheck) results = applyTaint(results, precheck, criteria);
  console.log(renderReport(results, input.coverage, input.notChecked ?? []));

} else if (command === "html") {
  const { renderHtml } = await import("./lib/html.js");
  const { applyTaint } = await import("./lib/verdict.js");
  const { validateCriteria } = await import("./lib/criteria.js");
  const { readdirSync, existsSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  if (!values.criteria || !values.results || !values["run-dir"]) {
    console.error("html requires --criteria <json> --results <json> --run-dir <dir>");
    process.exit(1);
  }
  const runDir = values["run-dir"];
  const criteriaInput = JSON.parse(readFileSync(values.criteria, "utf8"));
  const problems = validateCriteria(criteriaInput.criteria);
  if (problems.length > 0) {
    console.error("criteria.json is not valid:");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  const resultsInput = JSON.parse(readFileSync(values.results, "utf8"));
  const { reconcile } = await import("./lib/verdict.js");
  const hasDeps = criteriaInput.criteria.some(
    (c: { dependsOn?: string[] }) => (c.dependsOn ?? []).length > 0,
  );
  let precheck;
  if (values.precheck && existsSync(values.precheck)) {
    precheck = JSON.parse(readFileSync(values.precheck, "utf8"));
  } else if (hasDeps) {
    console.error("html: criteria declare dependencies but no --precheck file exists — run the pipeline check first");
    process.exit(1);
  }
  let results = reconcile(criteriaInput.criteria, resultsInput.results, precheck);
  if (precheck) results = applyTaint(results, precheck, criteriaInput.criteria);
  let review;
  if (values.review && existsSync(values.review)) {
    review = JSON.parse(readFileSync(values.review, "utf8"));
  }

  // Relative evidence assets: whatever sits under <runDir>/evidence/<id>/.
  const assets: Record<string, { images: string[]; videos: string[] }> = {};
  for (const criterion of criteriaInput.criteria) {
    const dir = join(runDir, "evidence", criterion.id);
    const images: string[] = [];
    const videos: string[] = [];
    if (existsSync(dir)) {
      for (const name of readdirSync(dir).sort()) {
        if (/\.(png|jpe?g)$/i.test(name)) images.push(`evidence/${criterion.id}/${name}`);
        if (/\.(webm|mp4)$/i.test(name)) videos.push(`evidence/${criterion.id}/${name}`);
      }
    }
    assets[criterion.id] = { images, videos };
  }
  // Run-scope evidence: the terminal recording lives at the run root.
  const runAssets: string[] = [];
  for (const name of ["run.gif", "run.cast"]) {
    if (existsSync(join(runDir, name))) runAssets.push(name);
  }

  const html = renderHtml({
    runId: values["run-id"] ?? runDir,
    criteria: criteriaInput.criteria,
    results,
    filesWithoutCriterion: resultsInput.coverage?.filesWithoutCriterion ?? 0,
    precheck,
    review,
    violation: existsSync(join(runDir, "clean-repo-violation")),
    assets,
    runAssets,
    notChecked: resultsInput.notChecked ?? [],
  });
  const out = join(runDir, "report.html");
  writeFileSync(out, html);
  console.log(out);

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
  console.error("  npx tsx src/cli.ts report        --results <json> --criteria <json> [--precheck <json>]");
  console.error("  npx tsx src/cli.ts html          --criteria <json> --results <json> --run-dir <dir> [--precheck <json>] [--review <json>] [--run-id <id>]");
  console.error("  npx tsx src/cli.ts changed-files --repo <dir> --base <rev> [--claims <json>]");
  process.exit(1);
}
