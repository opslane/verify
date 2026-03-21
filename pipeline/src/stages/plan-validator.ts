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
      const routeExists = routePatterns.some(
        ({ re }) => re.test(urlBase)
      );
      if (!routeExists) {
        errors.push({
          acId: ac.id, field: "url",
          message: `URL "${ac.url}" not found in app index routes — verify it exists`,
        });
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
