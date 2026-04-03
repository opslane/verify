// pipeline/src/lib/diff-hints.ts — Extract diff context to help executor navigate
import { execSync } from "node:child_process";

/** Frontend file extensions worth reporting as diff hints. */
const FRONTEND_EXTS = /\.(tsx|jsx|ts|js|vue|svelte)$/;

/** Path segments that suggest a frontend file. */
const FRONTEND_PATHS = /(src|app|pages|components|views|routes)\//;

/**
 * Extract a likely route pattern from a file path.
 * e.g. "app/(teams)/t/[teamUrl]/settings/page.tsx" → "/t/{teamUrl}/settings"
 */
function extractRoute(filePath: string): string | null {
  // Look for app-router or pages-router patterns
  const match = filePath.match(/(?:app|pages)(\/.*?)(?:\/page\.\w+|\/index\.\w+|\.\w+)$/);
  if (!match) return null;
  let route = match[1];
  // Strip Next.js route groups: (groupName) → ""
  route = route.replace(/\/\([^)]+\)/g, "");
  // Convert dynamic segments: [param] → {param}
  route = route.replace(/\[([^\]]+)\]/g, "{$1}");
  // Clean up double slashes
  route = route.replace(/\/+/g, "/");
  return route || null;
}

/**
 * Get diff hints for the executor by inspecting git changes.
 * Returns a formatted string describing changed frontend files and their likely routes.
 */
export function extractDiffHints(projectRoot: string): string {
  let files: string[];
  try {
    // Try uncommitted changes first (most common during local dev)
    const uncommitted = execSync("git diff --name-only HEAD 2>/dev/null", {
      cwd: projectRoot, encoding: "utf-8", timeout: 5000,
    }).trim();

    // Also include staged changes
    const staged = execSync("git diff --cached --name-only 2>/dev/null", {
      cwd: projectRoot, encoding: "utf-8", timeout: 5000,
    }).trim();

    const allFiles = `${uncommitted}\n${staged}`.trim();
    if (!allFiles) {
      // Fall back to last commit
      const lastCommit = execSync("git diff --name-only HEAD~1 2>/dev/null", {
        cwd: projectRoot, encoding: "utf-8", timeout: 5000,
      }).trim();
      files = lastCommit ? lastCommit.split("\n") : [];
    } else {
      files = [...new Set(allFiles.split("\n").filter(Boolean))];
    }
  } catch {
    return "No diff information available.";
  }

  if (files.length === 0) return "No diff information available.";

  // Filter to frontend-relevant files
  const frontendFiles = files.filter(
    f => FRONTEND_EXTS.test(f) && FRONTEND_PATHS.test(f)
  );

  if (frontendFiles.length === 0) {
    return `Changed files (${files.length} total, none appear to be frontend routes).`;
  }

  const lines = frontendFiles.map(f => {
    const route = extractRoute(f);
    return route ? `- ${f} (likely route: ${route})` : `- ${f}`;
  });

  return `Changed frontend files:\n${lines.join("\n")}`;
}
