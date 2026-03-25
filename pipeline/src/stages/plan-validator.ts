import type { PlannerOutput, PlanValidationResult, PlanValidationError, AppIndex } from "../lib/types.js";

const TEMPLATE_VAR_RE = /\{[a-zA-Z]+\}|__[A-Z_]+__/;
const ABSOLUTE_URL_RE = /^https?:\/\//;
const MIN_TIMEOUT = 60;
const MAX_TIMEOUT = 300;

/** Convert a parameterized route like /t/:teamUrl/settings to a regex */
function routeToRegex(route: string): RegExp {
  const pattern = route
    .split(/:[a-zA-Z]+/)
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]+");
  return new RegExp(`^${pattern}$`);
}

/**
 * Extract param segments from a route pattern and a concrete URL.
 * E.g., route="/o/:orgUrl/settings", url="/o/test-org/settings"
 * → { orgUrl: "test-org" }
 */
export function extractParamValues(route: string, url: string): Record<string, string> {
  const routeParts = route.split("/");
  const urlParts = url.split("/");
  const params: Record<string, string> = {};
  for (let i = 0; i < routeParts.length; i++) {
    if (routeParts[i].startsWith(":") && urlParts[i]) {
      params[routeParts[i].slice(1)] = urlParts[i];
    }
  }
  return params;
}

/**
 * Check if a URL's parameter values match the example_urls entry for its route.
 * Returns null if valid, or an error message if invented params are detected.
 */
export function validateParamValues(
  url: string,
  matchedRoute: string,
  exampleUrls: Record<string, string>,
): string | null {
  // Only validate parameterized routes that have example URLs
  if (!matchedRoute.includes(":")) return null;
  const exampleUrl = exampleUrls[matchedRoute];
  if (!exampleUrl) return null;

  const actualParams = extractParamValues(matchedRoute, url);
  const expectedParams = extractParamValues(matchedRoute, exampleUrl);

  const mismatches: string[] = [];
  for (const [param, actual] of Object.entries(actualParams)) {
    const expected = expectedParams[param];
    if (expected && actual !== expected) {
      mismatches.push(`'${param}' is '${actual}' but should be '${expected}'`);
    }
  }

  if (mismatches.length === 0) return null;
  return `URL "${url}" uses invented parameter values (${mismatches.join(", ")}). Use the example URL: ${exampleUrl}`;
}

export function validatePlan(
  plan: PlannerOutput,
  appIndex: AppIndex | null
): PlanValidationResult {
  const errors: PlanValidationError[] = [];
  const knownRoutes = appIndex ? Object.keys(appIndex.routes) : [];
  const routePatterns = knownRoutes.map(r => ({ route: r, re: routeToRegex(r) }));

  for (const ac of plan.criteria) {
    if (TEMPLATE_VAR_RE.test(ac.url)) {
      errors.push({
        acId: ac.id, field: "url",
        message: `URL "${ac.url}" contains a template variable — use real IDs from app.json example_urls`,
      });
    }

    if (ABSOLUTE_URL_RE.test(ac.url)) {
      errors.push({
        acId: ac.id, field: "url",
        message: `URL "${ac.url}" is absolute — use a relative path (baseUrl is prepended automatically)`,
      });
    }

    if (appIndex && !TEMPLATE_VAR_RE.test(ac.url) && !ABSOLUTE_URL_RE.test(ac.url)) {
      const urlBase = ac.url.split("?")[0];
      const matchedPattern = routePatterns.find(({ re }) => re.test(urlBase));
      if (!matchedPattern) {
        errors.push({
          acId: ac.id, field: "url",
          message: `URL "${ac.url}" not found in app index routes — verify it exists`,
        });
      } else {
        // Validate parameter values against example_urls
        const paramError = validateParamValues(urlBase, matchedPattern.route, appIndex.example_urls);
        if (paramError) {
          errors.push({ acId: ac.id, field: "url", message: paramError });
        }
      }
    }

    if (!ac.steps || ac.steps.length === 0) {
      errors.push({
        acId: ac.id, field: "steps",
        message: "Steps array is empty — every AC must have at least one step",
      });
    }

    if (ac.timeout_seconds < MIN_TIMEOUT || ac.timeout_seconds > MAX_TIMEOUT) {
      errors.push({
        acId: ac.id, field: "timeout_seconds",
        message: `Timeout ${ac.timeout_seconds}s is outside bounds [${MIN_TIMEOUT}, ${MAX_TIMEOUT}]`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
