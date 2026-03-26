#!/usr/bin/env npx tsx
/**
 * Spike: Route Parameter → DB Column Resolver
 *
 * Given a parameterized route (e.g., /t/:teamUrl/documents/:id/edit),
 * can we statically determine which DB column each param maps to?
 *
 * Two approaches tested:
 * 1. Grep: regex the route handler for Prisma where clauses
 * 2. LLM: give a focused prompt the handler + imports, ask what column
 *
 * Usage: cd pipeline && npx tsx src/evals/spike-param-resolver.ts
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { parseJsonOutput } from "../lib/parse-json.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const PROJECT_DIR = "/Users/abhishekray/Projects/opslane/evals/documenso";

// Known parameterized routes from app.json (route → expected column mapping)
const TEST_CASES: Array<{
  route: string;
  param: string;
  expectedColumn: string;  // what we know the answer should be
}> = [
  { route: "/t/:teamUrl/documents/:id/edit", param: "id", expectedColumn: "secondaryId" },
  { route: "/t/:teamUrl/documents/:id", param: "id", expectedColumn: "secondaryId" },
  { route: "/t/:teamUrl/templates/:id", param: "id", expectedColumn: "secondaryId" },
  { route: "/t/:teamUrl/settings/members", param: "teamUrl", expectedColumn: "url" },
  { route: "/o/:orgUrl/settings/members", param: "orgUrl", expectedColumn: "url" },
];

// ─── Approach 1: Grep-based ─────────────────────────────────────────────────

function findRouteHandlerFile(route: string): string | null {
  // Convert route like /t/:teamUrl/documents/:id/edit to Remix file search patterns
  // Remix convention: /t/$teamUrl/documents.$id.edit → routes/...t.$teamUrl+/documents.$id.edit.tsx

  // Build search terms from the route segments
  const segments = route.split("/").filter(Boolean);
  // Convert :param to $param for Remix
  const remixSegments = segments.map(s => s.startsWith(":") ? `$${s.slice(1)}` : s);
  // The last 2-3 segments usually form the filename
  const lastSegments = remixSegments.slice(-2).join(".");

  // Try Remix: find actual .tsx files (not type defs) matching the route
  try {
    const result = execSync(
      `find "${PROJECT_DIR}/apps" -path "*/routes/*" -name "*.tsx" ` +
      `-not -path "*/.react-router/*" -not -path "*/node_modules/*" ` +
      `| grep -i "${lastSegments.replace(/\$/g, "\\$")}" | head -5`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    if (result) {
      // Prefer _layout or the exact match
      const lines = result.split("\n").filter(Boolean);
      // For routes with :id, prefer _layout (has the loader) over edit/index
      const layout = lines.find(l => l.includes("_layout"));
      return layout ?? lines[0];
    }
  } catch { /* ignore */ }

  // Try Next.js App Router: find page.tsx files with matching folder names
  const paramFolders = segments.filter(s => s.startsWith(":")).map(s => `[${s.slice(1)}]`);
  if (paramFolders.length > 0) {
    try {
      const result = execSync(
        `find "${PROJECT_DIR}/apps" -path "*/app/*" -name "page.tsx" ` +
        `-not -path "*/node_modules/*" ` +
        `| grep "${paramFolders[0]}" | head -5`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      if (result) return result.split("\n")[0];
    } catch { /* ignore */ }
  }

  return null;
}

function grepForColumnMapping(handlerFile: string, param: string): string | null {
  const content = readFileSync(handlerFile, "utf-8");

  // Pattern 1: Direct Prisma query — findFirst/findUnique({ where: { COLUMN: params.param } })
  const directPattern = new RegExp(
    `where:\\s*\\{[^}]*?(\\w+):\\s*(?:params\\.${param}|${param}|id)`,
    "m",
  );
  const directMatch = content.match(directPattern);
  if (directMatch) return directMatch[1];

  // Pattern 2: Function call with param — getXById({ id: params.param }) or similar
  // Then grep the imported function for the actual column
  const funcCallPattern = new RegExp(
    `(\\w+)\\(\\{[^}]*?(?:${param}|id):\\s*params\\.${param}`,
    "m",
  );
  const funcMatch = content.match(funcCallPattern);
  if (funcMatch) {
    // Try to find the imported function and grep it
    const funcName = funcMatch[1];
    try {
      const grepResult = execSync(
        `grep -r "function ${funcName}\\|export.*${funcName}" "${PROJECT_DIR}/packages" --include="*.ts" -l 2>/dev/null | head -3`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      if (grepResult) {
        const implFile = grepResult.split("\n")[0];
        const implContent = readFileSync(implFile, "utf-8");
        const implMatch = implContent.match(directPattern);
        if (implMatch) return implMatch[1];
      }
    } catch { /* ignore */ }
  }

  // Pattern 3: trpc query — trpc.entity.method.useQuery({ paramName: params.param })
  const trpcPattern = new RegExp(
    `trpc\\.(\\w+)\\.(\\w+)\\.(\\w+)\\.useQuery\\(\\{[^}]*?(\\w+):\\s*params\\.${param}`,
    "m",
  );
  const trpcMatch = content.match(trpcPattern);
  if (trpcMatch) {
    // The field name in the trpc call tells us the param name used server-side
    return `trpc:${trpcMatch[1]}.${trpcMatch[2]}.${trpcMatch[3]}(${trpcMatch[4]})`;
  }

  return null;
}

// ─── Approach 2: LLM-based ──────────────────────────────────────────────────

function readFileWithImports(handlerFile: string, maxDepth = 2): string {
  const content = readFileSync(handlerFile, "utf-8");
  const lines: string[] = [`// === ${handlerFile} ===`, content];

  if (maxDepth <= 0) return lines.join("\n");

  // Find imports and read them too (only project-local imports)
  const importPattern = /from\s+['"]([^'"]+)['"]/g;
  let match;
  const importedFiles = new Set<string>();

  while ((match = importPattern.exec(content)) !== null) {
    const importPath = match[1];
    if (importPath.startsWith(".") || importPath.startsWith("@documenso")) {
      // Resolve relative imports
      let resolved: string;
      if (importPath.startsWith("@documenso")) {
        // Package import — try common locations
        const pkgPath = importPath.replace("@documenso/", "");
        const candidates = [
          join(PROJECT_DIR, "packages", pkgPath + ".ts"),
          join(PROJECT_DIR, "packages", pkgPath, "index.ts"),
          join(PROJECT_DIR, "packages/lib", pkgPath + ".ts"),
          join(PROJECT_DIR, "packages/lib", pkgPath.replace("lib/", "") + ".ts"),
        ];
        resolved = candidates.find(c => existsSync(c)) ?? "";
      } else {
        resolved = resolve(dirname(handlerFile), importPath);
        if (!resolved.endsWith(".ts") && !resolved.endsWith(".tsx")) {
          if (existsSync(resolved + ".ts")) resolved += ".ts";
          else if (existsSync(resolved + ".tsx")) resolved += ".tsx";
          else if (existsSync(join(resolved, "index.ts"))) resolved = join(resolved, "index.ts");
        }
      }

      if (resolved && existsSync(resolved) && !importedFiles.has(resolved)) {
        importedFiles.add(resolved);
        const importContent = readFileSync(resolved, "utf-8");
        // Only include if it contains Prisma/DB references
        if (importContent.includes("prisma") || importContent.includes("findFirst") ||
            importContent.includes("findUnique") || importContent.includes("where")) {
          lines.push(`\n// === ${resolved} ===`);
          lines.push(importContent.slice(0, 3000)); // Cap at 3000 chars per import
        }
      }
    }
  }

  return lines.join("\n").slice(0, 8000); // Cap total at 8000 chars
}

function llmResolveParam(handlerCode: string, param: string, route: string): string | null {
  const prompt = `You are analyzing a route handler to determine which database column a URL parameter maps to.

ROUTE: ${route}
PARAMETER: ${param}

The code below shows the route handler and its imports. Trace how params.${param} reaches a database query (Prisma findFirst/findUnique/findMany). What column name does it ultimately query?

CODE:
${handlerCode}

Answer with ONLY the column name (e.g., "secondaryId", "slug", "id", "uid"). If the parameter goes through a transformation function, trace into it. If you can't determine it, say "UNKNOWN".`;

  try {
    const result = execSync(
      `claude -p --output-format text --model haiku`,
      {
        input: prompt,
        encoding: "utf-8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 5 * 1024 * 1024,
      },
    );
    return result.trim().replace(/["`']/g, "").split("\n")[0].trim() || null;
  } catch {
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log("=".repeat(70));
console.log("Spike: Route Parameter → DB Column Resolver");
console.log("=".repeat(70));
console.log(`Project: ${PROJECT_DIR}`);
console.log(`Test cases: ${TEST_CASES.length}`);
console.log("");

const results: Array<{
  route: string;
  param: string;
  expected: string;
  handlerFile: string | null;
  grepResult: string | null;
  llmResult: string | null;
  grepCorrect: boolean;
  llmCorrect: boolean;
}> = [];

for (const tc of TEST_CASES) {
  console.log(`\n--- ${tc.route} (param: ${tc.param}) ---`);

  // Step 1: Find handler file
  const handlerFile = findRouteHandlerFile(tc.route);
  console.log(`  Handler: ${handlerFile ?? "NOT FOUND"}`);

  if (!handlerFile) {
    results.push({
      route: tc.route, param: tc.param, expected: tc.expectedColumn,
      handlerFile: null, grepResult: null, llmResult: null,
      grepCorrect: false, llmCorrect: false,
    });
    continue;
  }

  // Step 2: Try grep approach
  const grepResult = grepForColumnMapping(handlerFile, tc.param);
  const grepCorrect = grepResult === tc.expectedColumn;
  console.log(`  Grep: ${grepResult ?? "MISS"} ${grepCorrect ? "✓" : "✗"} (expected: ${tc.expectedColumn})`);

  // Step 3: Try LLM approach
  const handlerCode = readFileWithImports(handlerFile);
  console.log(`  LLM input: ${handlerCode.length} chars (handler + ${handlerCode.split("// ===").length - 1} files)`);
  const llmResult = llmResolveParam(handlerCode, tc.param, tc.route);
  const llmCorrect = llmResult === tc.expectedColumn;
  console.log(`  LLM:  ${llmResult ?? "MISS"} ${llmCorrect ? "✓" : "✗"} (expected: ${tc.expectedColumn})`);

  results.push({
    route: tc.route, param: tc.param, expected: tc.expectedColumn,
    handlerFile, grepResult, llmResult,
    grepCorrect, llmCorrect,
  });
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(70));
console.log("RESULTS");
console.log("=".repeat(70));

const grepHits = results.filter(r => r.grepCorrect).length;
const llmHits = results.filter(r => r.llmCorrect).length;
const total = results.length;

console.log(`\nGrep accuracy: ${grepHits}/${total} (${Math.round(100 * grepHits / total)}%)`);
console.log(`LLM accuracy:  ${llmHits}/${total} (${Math.round(100 * llmHits / total)}%)`);

console.log("\nPer-route breakdown:");
for (const r of results) {
  const status = r.grepCorrect && r.llmCorrect ? "BOTH ✓"
    : r.grepCorrect ? "GREP only"
    : r.llmCorrect ? "LLM only"
    : "NEITHER";
  console.log(`  ${r.route}`);
  console.log(`    param=${r.param}  expected=${r.expected}  grep=${r.grepResult ?? "MISS"}  llm=${r.llmResult ?? "MISS"}  → ${status}`);
}

if (grepHits === total) {
  console.log("\nVERDICT: Grep catches everything — LLM unnecessary for this app.");
} else if (llmHits > grepHits) {
  console.log(`\nVERDICT: LLM adds ${llmHits - grepHits} correct answers grep missed. Use grep-first, LLM-fallback.`);
} else {
  console.log("\nVERDICT: Neither approach is reliable enough. Need a different strategy.");
}
