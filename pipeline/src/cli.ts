// cli.ts — engine for the /verify skill.
//
// Three verbs, each a thin wrapper over a pure module. The skill is the
// control loop; this only does plumbing it would be silly to do in markdown.
import { parseArgs } from "node:util";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { sep, isAbsolute, join, resolve } from "node:path";
import type { Criterion } from './lib/criteria.js';

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
    "repo-root": { type: "string" },
    "dry-run": { type: "boolean" },
    draft: { type: "boolean" },
    step: { type: "string" },
  },
});

const [command, ac] = positionals;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function pathFromRepo(repoRoot: string, value: string): string {
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (command === "drive") {
  try {
    const { execFileSync } = await import('node:child_process');
    const { validateCriteria } = await import('./lib/criteria.js');
    const { driveCriterion } = await import('./lib/drive.js');
    if (!ac || !values['run-dir']) fail('drive requires <ac> --run-dir <dir>');
    const repoRoot = realpathSync(values['repo-root'] ?? process.cwd());
    const currentRunPath = join(repoRoot, '.verify', 'current-run');
    if (!existsSync(currentRunPath)) fail(`drive: no active run — ${currentRunPath} is missing`);
    const currentRun = readFileSync(currentRunPath, 'utf8').trim();
    if (!currentRun) fail(`drive: active run file is empty: ${currentRunPath}`);
    if (!/^[A-Za-z0-9._-]+$/.test(currentRun) || currentRun.includes('..')) {
      fail(`drive: current-run holds an invalid run id: ${JSON.stringify(currentRun)}`);
    }
    const requestedPath = pathFromRepo(repoRoot, values['run-dir']);
    const requestedRun = realpathSync(requestedPath);
    const expectedPath = join(repoRoot, '.verify', 'runs', currentRun);
    const expectedRun = existsSync(expectedPath) ? realpathSync(expectedPath) : resolve(expectedPath);
    if (requestedRun !== expectedRun) {
      fail(`drive: --run-dir ${requestedRun} does not match current run ${expectedRun}`);
    }

    if (values.step !== undefined && !values.draft) fail('drive: --step requires --draft');
    const onlyStep = values.step === undefined ? undefined : Number(values.step);
    if (onlyStep !== undefined && (!Number.isInteger(onlyStep) || onlyStep < 1)) {
      fail(`drive: --step must be a positive integer, got ${JSON.stringify(values.step)}`);
    }
    const draftSourceAllowed = values.draft === true || values['dry-run'] === true;
    if (values.criteria && !draftSourceAllowed) {
      fail('drive: --criteria is allowed only with --draft or --dry-run');
    }
    const criteriaPath = values.criteria
      ? pathFromRepo(repoRoot, values.criteria)
      : join(requestedRun, 'criteria.json');
    const criteriaInput = readJson(criteriaPath) as { criteria?: unknown };
    const problems = validateCriteria(criteriaInput.criteria);
    if (problems.length > 0) fail(`criteria.json is not valid:\n  ${problems.join('\n  ')}`);
    const criteria = criteriaInput.criteria as Criterion[];
    const criterion = criteria.find((item) => item.id === ac);
    if (!criterion) fail(`drive: ${ac} has no entry in ${criteriaPath}`);
    if (!criterion.drive) fail('drive: no plan — drive it by hand');

    if (!draftSourceAllowed) {
      const precheckPath = join(requestedRun, 'precheck.json');
      const precheck = readJson(precheckPath) as {
        parts?: Record<string, string>;
        tainted?: Record<string, string>;
      };
      // Same derivation as reconciliation-side taint: the tainted map is a
      // convenience, the parts map is the authority.
      const downDep = (criterion.dependsOn ?? []).find(
        (part) => precheck.parts?.[part] === 'down',
      );
      const taintedBy = downDep ?? precheck.tainted?.[ac];
      if (taintedBy) {
        fail(`drive: ${ac} is tainted by ${taintedBy}; driving a broken pipe is pointless`);
      }
      const manifestPath = join(requestedRun, 'manifest.json');
      if (!existsSync(manifestPath)) {
        let commit = 'unknown';
        try {
          commit = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
          }).trim() || 'unknown';
        } catch {
          // A non-git fixture still gets an interpretable manifest.
        }
        writeFileSync(manifestPath, `${JSON.stringify({
          commit,
          contract: '.verify/setup.json',
          createdAt: new Date().toISOString(),
        }, null, 2)}\n`);
      }
    }

    const setup = readJson(join(repoRoot, '.verify', 'setup.json')) as {
      base_url?: unknown;
      auth?: { header?: unknown; value_env?: unknown };
      observe?: { db_ro_env?: unknown; db_url_env?: unknown };
    };
    if (typeof setup.base_url !== 'string') fail('drive: setup.json base_url must be a string');
    const authHeader = setup.auth?.header ?? '';
    const authValueEnv = setup.auth?.value_env ?? '';
    if (typeof authHeader !== 'string' || typeof authValueEnv !== 'string' || Boolean(authHeader) !== Boolean(authValueEnv)) {
      fail('drive: setup auth.header and auth.value_env must both be empty or both be non-empty strings');
    }
    const dbUrlEnv = setup.observe?.db_ro_env || setup.observe?.db_url_env;
    if (dbUrlEnv !== undefined && typeof dbUrlEnv !== 'string') {
      fail('drive: setup observe db environment variable name must be a string');
    }
    if (typeof dbUrlEnv === 'string' && /^(PATH|IFS|ENV|BASH_ENV|SHELL|CDPATH|LD_.*|DYLD_.*|PS4|PROMPT_COMMAND|TMPDIR)$/.test(dbUrlEnv)) {
      fail(`drive: setup names denylisted DSN environment variable ${dbUrlEnv}`);
    }
    const runEnv = readJson(join(repoRoot, '.verify', 'run-env.json')) as { marker?: unknown };
    if (typeof runEnv.marker !== 'string') fail('drive: run-env.json has no marker');
    const result = await driveCriterion(criterion, {
      runDir: requestedRun,
      marker: runEnv.marker,
      ctx: {
        baseUrl: setup.base_url,
        ...(authHeader ? { authHeader, authValueEnv } : {}),
        ...(typeof dbUrlEnv === 'string' && dbUrlEnv ? { dbUrlEnv } : {}),
        repoRoot,
      },
      draft: values.draft,
      onlyStep,
      dryRun: values['dry-run'],
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    fail(`drive: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

} else if (command === "criteria") {
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
  const {
    renderReport, applyReceiptedProofs, applyTaint, reconcile, classify, taintPartFor, validateResults,
  } = await import("./lib/verdict.js");
  const { legacyEvidence } = await import('./lib/evidence.js');
  const { validateCriteria } = await import('./lib/criteria.js');
  const { existsSync } = await import("node:fs");
  if (!values.results || (!values.criteria && !values['run-dir'])) {
    console.error("report requires --results <json> and either --criteria <json> or --run-dir <dir>");
    process.exit(1);
  }

  if (!existsSync(values.results)) fail(`report: --results file does not exist: ${values.results}`);
  const input = JSON.parse(readFileSync(values.results, "utf8"));
  const resultProblems = validateResults(input);
  if (resultProblems.length > 0) fail(`results.json is not valid:\n  ${resultProblems.join('\n  ')}`);
  const repoRoot = realpathSync(values['repo-root'] ?? process.cwd());
  if (values['run-dir'] && !existsSync(pathFromRepo(repoRoot, values['run-dir']))) {
    fail(`report: --run-dir does not exist: ${values['run-dir']}`);
  }
  const runDir = values['run-dir'] ? realpathSync(pathFromRepo(repoRoot, values['run-dir'])) : undefined;
  if (runDir) {
    // Run-dir mode reasons about ONE run: results and precheck must be that
    // run's own files, or yesterday's results silently pair with today's
    // receipts.
    for (const [flag, given] of [['--results', values.results], ['--precheck', values.precheck]] as const) {
      if (given && !realpathSync(pathFromRepo(repoRoot, given)).startsWith(`${runDir}/`)) {
        fail(`report: ${flag} must live inside --run-dir (${runDir}) in run-dir mode`);
      }
    }
  }
  const violation = runDir ? existsSync(join(runDir, 'clean-repo-violation')) : false;
  const approvedCriteriaPath = runDir ? join(runDir, 'criteria.json') : undefined;
  if (runDir && values.criteria && realpathSync(pathFromRepo(repoRoot, values.criteria)) !== realpathSync(approvedCriteriaPath!)) {
    fail(`report: --criteria ${values.criteria} does not match approved snapshot ${approvedCriteriaPath}`);
  }
  const criteriaPath = approvedCriteriaPath ?? pathFromRepo(repoRoot, values.criteria!);
  if (!existsSync(criteriaPath)) fail(`report: criteria file does not exist: ${criteriaPath}`);
  const criteriaInput = JSON.parse(readFileSync(criteriaPath, "utf8"));
  const criteria = criteriaInput.criteria ?? [];
  if (runDir) {
    const criteriaProblems = validateCriteria(criteria);
    if (criteriaProblems.length > 0) fail(`criteria.json is not valid:\n  ${criteriaProblems.join('\n  ')}`);
  }

  // Fail closed: criteria with dependencies demand a pipeline check. A green
  // report that skipped its prechecks is exactly the lie this tool exists to
  // prevent.
  const hasDeps = criteria.some((c: { dependsOn?: string[] }) => (c.dependsOn ?? []).length > 0);
  let precheck;
  const precheckPath = values.precheck
    ? pathFromRepo(repoRoot, values.precheck)
    : runDir ? join(runDir, 'precheck.json') : undefined;
  if (precheckPath && existsSync(precheckPath)) {
    precheck = JSON.parse(readFileSync(precheckPath, "utf8"));
  } else if (hasDeps) {
    console.error("report: criteria declare dependencies but no --precheck file exists — run the pipeline check first");
    process.exit(1);
  }

  let classified: import('./lib/verdict.js').ClassifiedCriterionResult[];
  let evidence: Record<string, import('./lib/evidence.js').CriterionEvidence>;
  let sources: Record<string, import('./lib/verdict.js').ProofSource> = {};
  if (runDir) {
    const { classifyRun } = await import('./lib/classify-run.js');
    ({ classified, evidence, sources } = classifyRun(runDir, criteria, input.results, precheck));
  } else {
    let results = reconcile(criteria, input.results, precheck);
    results = applyReceiptedProofs(results, {}).results;
    evidence = Object.fromEntries(results.map((result) => [result.id, legacyEvidence(result)]));
    const taintedBy: Record<string, string | undefined> = {};
    if (precheck) {
      for (const criterion of criteria) taintedBy[criterion.id] = taintPartFor(criterion.id, precheck, criteria);
    }
    if (precheck) results = applyTaint(results, precheck, criteria);
    classified = classify(results, Object.fromEntries(results.map((result) => [result.id, {
      substantiated: evidence[result.id]?.substantiated === true,
      tainted: taintedBy[result.id] !== undefined,
    }])));
  }
  // Legacy invocations (no --run-dir) keep their pre-drive line shape: no
  // plain-claim prefix, no evidence labels — just the banner.
  console.log(renderReport(classified, input.coverage, input.notChecked ?? [], {
    ...(runDir ? { criteria, evidence, sources, violation } : { legacyEvidence: true }),
  }));

} else if (command === "html") {
  const { renderHtml } = await import("./lib/html.js");
  const {
    applyReceiptedProofs, applyTaint, classify, taintPartFor, reconcile, validateResults,
  } = await import("./lib/verdict.js");
  const { validateCriteria } = await import("./lib/criteria.js");
  const { existsSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  if (!values.results || !values["run-dir"]) {
    console.error("html requires --results <json> --run-dir <dir>");
    process.exit(1);
  }
  const repoRoot = realpathSync(values['repo-root'] ?? process.cwd());
  if (!existsSync(pathFromRepo(repoRoot, values['run-dir']))) {
    fail(`html: --run-dir does not exist: ${values['run-dir']}`);
  }
  const runDir = realpathSync(pathFromRepo(repoRoot, values["run-dir"]));
  const approvedCriteriaPath = join(runDir, 'criteria.json');
  if (values.criteria && realpathSync(pathFromRepo(repoRoot, values.criteria)) !== realpathSync(approvedCriteriaPath)) {
    fail(`html: --criteria ${values.criteria} does not match approved snapshot ${approvedCriteriaPath}`);
  }
  const criteriaInput = JSON.parse(readFileSync(approvedCriteriaPath, "utf8"));
  const problems = validateCriteria(criteriaInput.criteria);
  if (problems.length > 0) {
    console.error("criteria.json is not valid:");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  const resultsInput = JSON.parse(readFileSync(values.results, "utf8"));
  const resultShapeProblems = validateResults(resultsInput);
  if (resultShapeProblems.length > 0) fail(`results.json is not valid:\n  ${resultShapeProblems.join('\n  ')}`);
  const hasDeps = criteriaInput.criteria.some(
    (c: { dependsOn?: string[] }) => (c.dependsOn ?? []).length > 0,
  );
  let precheck;
  const precheckPath = values.precheck ? pathFromRepo(repoRoot, values.precheck) : join(runDir, 'precheck.json');
  if (existsSync(precheckPath)) {
    precheck = JSON.parse(readFileSync(precheckPath, "utf8"));
  } else if (hasDeps) {
    console.error("html: criteria declare dependencies but no --precheck file exists — run the pipeline check first");
    process.exit(1);
  }
  const { classifyRun } = await import('./lib/classify-run.js');
  const { classified, evidence, sources, attempts } = classifyRun(
    runDir, criteriaInput.criteria, resultsInput.results, precheck);
  let review;
  if (values.review && existsSync(values.review)) {
    review = JSON.parse(readFileSync(values.review, "utf8"));
  }

  // Run-scope evidence: the terminal recording lives at the run root.
  const runAssets: string[] = [];
  for (const name of ["run.gif", "run.cast"]) {
    if (existsSync(join(runDir, name))) runAssets.push(name);
  }

  // Empty runTag disables highlighting: a path or run id is not a marker,
  // and <mark>-ing it in receipt output reads as false proof.
  let runTag = '';
  const runEnvPath = join(repoRoot, '.verify', 'run-env.json');
  if (existsSync(runEnvPath)) {
    try {
      const runEnv = JSON.parse(readFileSync(runEnvPath, 'utf8')) as { marker?: unknown };
      // run-env.json is repo-global; its marker belongs to the CURRENT run.
      // Highlighting an older run with a newer marker would tag the wrong text.
      const currentRunPath = join(repoRoot, '.verify', 'current-run');
      const currentRun = existsSync(currentRunPath) ? readFileSync(currentRunPath, 'utf8').trim() : '';
      const renderedRun = runDir.split(sep).at(-1) ?? '';
      if (typeof runEnv.marker === 'string' && runEnv.marker && currentRun === renderedRun) runTag = runEnv.marker;
    } catch {
      // A missing display tag never changes the report verdict.
    }
  }
  const html = renderHtml({
    runId: values["run-id"] ?? runDir,
    runTag,
    criteria: criteriaInput.criteria,
    results: classified,
    filesWithoutCriterion: resultsInput.coverage?.filesWithoutCriterion ?? 0,
    precheck,
    review,
    violation: existsSync(join(runDir, "clean-repo-violation")),
    evidence,
    runAssets,
    notChecked: resultsInput.notChecked ?? [],
    sources,
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
  console.error("  npx tsx src/cli.ts drive <ac>    --repo-root <dir> --run-dir <dir> [--dry-run] [--draft] [--step N] [--criteria <json>]");
  console.error("  npx tsx src/cli.ts criteria      --criteria <json>");
  console.error("  npx tsx src/cli.ts report        --results <json> [--criteria <json>] [--run-dir <dir>] [--repo-root <dir>] [--precheck <json>]");
  console.error("  npx tsx src/cli.ts html          --results <json> --run-dir <dir> [--criteria <json>] [--repo-root <dir>] [--precheck <json>] [--review <json>] [--run-id <id>]");
  console.error("  npx tsx src/cli.ts changed-files --repo <dir> --base <rev> [--claims <json>]");
  process.exit(1);
}
