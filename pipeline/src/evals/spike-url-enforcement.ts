/**
 * Spike: URL parameter value validation
 *
 * Tests whether adding parameter value validation to the plan validator
 * would have caught the URL invention failures from the March 25 eval run.
 *
 * The problem: the planner invents URLs like /o/test-org/settings/members
 * where "test-org" is a made-up org slug. The current validator only checks
 * that the URL matches a known route PATTERN. It doesn't verify parameter
 * values against example_urls.
 */

import { readFileSync } from "node:fs";

// ── Types ──────────────────────────────────────────────────────────────────

interface EvalResult {
  pr: number;
  title: string;
  verdicts: Array<{
    ac_id: string;
    verdict: string;
    reasoning: string;
  }>;
  introspection: Array<{
    ac_id: string;
    root_cause: string;
    detail: string;
  }>;
}

interface RouteMatch {
  routePattern: string;
  paramNames: string[];
  actualParamValues: string[];
  expectedParamValues: string[];
  exampleUrl: string;
}

interface ValidationResult {
  url: string;
  matchedRoute: string | null;
  hasParams: boolean;
  hasExampleUrl: boolean;
  exactMatch: boolean;
  inventedParams: Array<{ param: string; actual: string; expected: string }>;
  errorMessage: string | null;
  currentValidatorCatches: boolean;
  newValidatorCatches: boolean;
}

// ── Route matching logic (mirrors plan-validator.ts) ────────────────────────

function routeToRegex(route: string): RegExp {
  const pattern = route
    .split(/:[a-zA-Z]+/)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("([^/]+)");
  return new RegExp(`^${pattern}$`);
}

function extractParamNames(route: string): string[] {
  const matches = route.match(/:([a-zA-Z]+)/g);
  return matches ? matches.map((m) => m.slice(1)) : [];
}

function findMatchingRoute(
  url: string,
  routes: Record<string, unknown>,
  exampleUrls: Record<string, string>,
): RouteMatch | null {
  const urlBase = url.split("?")[0];

  for (const routePattern of Object.keys(routes)) {
    const re = routeToRegex(routePattern);
    const match = urlBase.match(re);
    if (!match) continue;

    const paramNames = extractParamNames(routePattern);
    const actualParamValues = match.slice(1); // capture groups

    // Get example URL for this route
    const exampleUrl = exampleUrls[routePattern];
    let expectedParamValues: string[] = [];

    if (exampleUrl) {
      const exampleMatch = exampleUrl.match(re);
      if (exampleMatch) {
        expectedParamValues = exampleMatch.slice(1);
      }
    }

    return {
      routePattern,
      paramNames,
      actualParamValues,
      expectedParamValues,
      exampleUrl: exampleUrl || "",
    };
  }
  return null;
}

// ── New validation logic ────────────────────────────────────────────────────

function validateUrlParams(
  url: string,
  routes: Record<string, unknown>,
  exampleUrls: Record<string, string>,
): ValidationResult {
  const routeMatch = findMatchingRoute(url, routes, exampleUrls);

  if (!routeMatch) {
    return {
      url,
      matchedRoute: null,
      hasParams: false,
      hasExampleUrl: false,
      exactMatch: false,
      inventedParams: [],
      errorMessage: null,
      currentValidatorCatches: true, // current validator catches unknown routes
      newValidatorCatches: true,
    };
  }

  const hasParams = routeMatch.paramNames.length > 0;
  const hasExampleUrl = routeMatch.exampleUrl !== "";
  const urlBase = url.split("?")[0];
  const exactMatch = hasExampleUrl && urlBase === routeMatch.exampleUrl;

  const inventedParams: Array<{
    param: string;
    actual: string;
    expected: string;
  }> = [];

  if (hasParams && hasExampleUrl && !exactMatch) {
    for (let i = 0; i < routeMatch.paramNames.length; i++) {
      const actual = routeMatch.actualParamValues[i];
      const expected = routeMatch.expectedParamValues[i];
      if (actual && expected && actual !== expected) {
        inventedParams.push({
          param: routeMatch.paramNames[i],
          actual,
          expected,
        });
      }
    }
  }

  let errorMessage: string | null = null;
  if (inventedParams.length > 0) {
    const paramList = inventedParams
      .map(
        (p) =>
          `parameter '${p.param}' has value '${p.actual}' but should be '${p.expected}'`,
      )
      .join("; ");
    errorMessage =
      `URL "${url}" uses invented parameter values (${paramList}). ` +
      `Use the example URL: ${routeMatch.exampleUrl}`;
  }

  return {
    url,
    matchedRoute: routeMatch.routePattern,
    hasParams,
    hasExampleUrl,
    exactMatch,
    inventedParams,
    errorMessage,
    currentValidatorCatches: false, // current validator passes these (route pattern matches)
    newValidatorCatches: inventedParams.length > 0,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  // Load app.json for routes and example_urls
  const appIndex = JSON.parse(
    readFileSync("/tmp/documenso-verify/app.json", "utf8"),
  );
  const routes: Record<string, unknown> = appIndex.routes;
  const exampleUrls: Record<string, string> = appIndex.example_urls;

  // Load eval results
  const evalLines = readFileSync(
    "/Users/abhishekray/Projects/opslane/evals/documenso-eval-results/2026-03-25-eval-results.jsonl",
    "utf8",
  )
    .trim()
    .split("\n");
  const evalResults: EvalResult[] = evalLines.map((l) => JSON.parse(l));

  console.log("=" .repeat(80));
  console.log("SPIKE: URL Parameter Value Validation");
  console.log("=" .repeat(80));
  console.log();

  // ── Step 1: Extract all URLs from error verdicts ──────────────────────────

  // We reconstruct URLs from the verdict reasoning since the eval results
  // don't store the plan URL directly. We also define the known failing URLs
  // from manual inspection of the eval run.
  const knownFailingUrls: Array<{
    pr: number;
    url: string;
    acCount: number;
    failureType: string;
  }> = [
    {
      pr: 2636,
      url: "/o/test-org/settings/members",
      acCount: 4,
      failureType: "Organisation not found (invented org slug 'test-org')",
    },
    {
      pr: 2626,
      url: "/t/personal_mwiasvikdmkwinfh/documents/1/edit",
      acCount: 4,
      failureType: "Document not found (invented document ID '1')",
    },
    {
      pr: 2617,
      url: "/t/personal_mwiasvikdmkwinfh/documents/1/edit",
      acCount: 3,
      failureType: "Document not found (invented document ID '1')",
    },
    {
      pr: 2633,
      url: "/t/personal_mwiasvikdmkwinfh/documents/1",
      acCount: 2,
      failureType:
        "Document not found (invented document ID '1', from introspection)",
    },
  ];

  // Also test valid URLs that should NOT be rejected (false positive check)
  const knownValidUrls: string[] = [
    "/o/org_hbersosbneorktuw/settings/members",
    "/t/personal_mwiasvikdmkwinfh/documents",
    "/t/personal_mwiasvikdmkwinfh/settings",
    "/t/personal_mwiasvikdmkwinfh/documents/verify-test-group-b-env-001/edit",
    "/o/org_hbersosbneorktuw/settings/groups",
    "/settings/profile",
    "/dashboard",
    // Static routes (no params) should always pass
    "/inbox",
    "/admin",
  ];

  // ── Step 2: Validate failing URLs ─────────────────────────────────────────

  console.log("FAILING URLS (should be caught by new validator)");
  console.log("-".repeat(80));

  let caughtByNew = 0;
  let missedByNew = 0;
  let totalFailingAcs = 0;

  for (const failing of knownFailingUrls) {
    const result = validateUrlParams(failing.url, routes, exampleUrls);
    totalFailingAcs += failing.acCount;

    console.log(`\nPR #${failing.pr}: ${failing.url}`);
    console.log(`  Failure: ${failing.failureType}`);
    console.log(`  ACs affected: ${failing.acCount}`);
    console.log(`  Matched route: ${result.matchedRoute || "NONE"}`);
    console.log(
      `  Current validator catches: ${result.currentValidatorCatches}`,
    );
    console.log(`  New validator catches: ${result.newValidatorCatches}`);

    if (result.errorMessage) {
      console.log(`  Error message: ${result.errorMessage}`);
      caughtByNew += failing.acCount;
    } else {
      console.log(`  WARNING: New validator did NOT catch this!`);
      missedByNew += failing.acCount;
    }
  }

  // ── Step 3: Validate correct URLs (false positive check) ──────────────────

  console.log("\n\nVALID URLS (should NOT be rejected)");
  console.log("-".repeat(80));

  let falsePositives = 0;
  let trueNegatives = 0;

  for (const validUrl of knownValidUrls) {
    const result = validateUrlParams(validUrl, routes, exampleUrls);

    const status = result.newValidatorCatches ? "FALSE POSITIVE" : "OK";
    console.log(`\n  ${validUrl}`);
    console.log(`    Matched route: ${result.matchedRoute || "NONE"}`);
    console.log(`    Result: ${status}`);

    if (result.newValidatorCatches) {
      falsePositives++;
      console.log(`    Error: ${result.errorMessage}`);
    } else {
      trueNegatives++;
    }
  }

  // ── Step 4: Full analysis of all 23 error verdicts ────────────────────────

  console.log("\n\nFULL ERROR VERDICT ANALYSIS");
  console.log("-".repeat(80));

  let totalErrors = 0;
  let inventedParamErrors = 0;
  let otherErrors = 0;

  for (const pr of evalResults) {
    if (!pr.verdicts || pr.verdicts.length === 0) continue;
    for (const v of pr.verdicts) {
      if (v.verdict !== "error") continue;
      totalErrors++;

      // Categorize the error
      const reasoning = v.reasoning || "";
      if (
        reasoning.includes("Organisation not found") ||
        reasoning.includes("test-org")
      ) {
        inventedParamErrors++;
      } else if (
        reasoning.includes("documents/1/edit") ||
        reasoning.includes("document ID 1")
      ) {
        inventedParamErrors++;
      } else {
        otherErrors++;
      }
    }
  }

  // ── Step 5: Summary report ────────────────────────────────────────────────

  console.log("\n\n" + "=".repeat(80));
  console.log("SUMMARY REPORT");
  console.log("=".repeat(80));

  console.log(`\nEval run: 2026-03-25`);
  console.log(`Total verdicts: 58`);
  console.log(`Total error verdicts: ${totalErrors}`);
  console.log(
    `  - Invented parameter errors (org/doc not found): ${inventedParamErrors}`,
  );
  console.log(
    `  - Other errors (upload failures, etc.): ${otherErrors}`,
  );

  console.log(`\nParameter value validation results:`);
  console.log(`  URLs with invented params tested: ${knownFailingUrls.length}`);
  console.log(`  ACs caught by new validator: ${caughtByNew}`);
  console.log(`  ACs missed by new validator: ${missedByNew}`);

  console.log(`\nFalse positive check:`);
  console.log(`  Valid URLs tested: ${knownValidUrls.length}`);
  console.log(`  True negatives (correctly allowed): ${trueNegatives}`);
  console.log(`  False positives (incorrectly rejected): ${falsePositives}`);
  console.log(
    `  False positive rate: ${((falsePositives / knownValidUrls.length) * 100).toFixed(1)}%`,
  );

  const catchRate =
    caughtByNew > 0
      ? ((caughtByNew / totalFailingAcs) * 100).toFixed(1)
      : "0.0";
  console.log(`\nCatch rate: ${catchRate}% of invented-param ACs`);

  console.log(`\nRetry mechanism assessment:`);
  console.log(
    `  When the validator rejects a URL, the error message includes the correct`,
  );
  console.log(
    `  example URL from app.json. The planner retry mechanism would receive:`,
  );
  for (const failing of knownFailingUrls) {
    const result = validateUrlParams(failing.url, routes, exampleUrls);
    if (result.errorMessage) {
      console.log(`\n  PR #${failing.pr}:`);
      console.log(`    Error: ${result.errorMessage}`);
    }
  }

  console.log(`\n  The planner would then substitute the correct parameter values`);
  console.log(`  on retry, exactly like the setup-writer retry pattern.`);

  console.log(`\n${"=".repeat(80)}`);
  console.log(`CONCLUSION`);
  console.log(`${"=".repeat(80)}`);
  console.log(`\n1. URLs with invented params: ${knownFailingUrls.length} unique URLs (${totalFailingAcs} ACs)`);
  console.log(`2. New validator would catch: ${caughtByNew} of ${totalFailingAcs} ACs (${catchRate}%)`);
  console.log(`3. False positive rate: ${((falsePositives / knownValidUrls.length) * 100).toFixed(1)}%`);
  console.log(`4. Of the 23 total error verdicts:`);
  console.log(`   - ${inventedParamErrors} were caused by invented parameter values (catchable)`);
  console.log(`   - ${otherErrors} were other errors (upload failures, etc.)`);
  console.log(`5. The retry mechanism would fix these by providing the correct example URL`);
  console.log(`   in the error message, same pattern as setup-writer retries.`);
}

main();
