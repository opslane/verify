// pipeline/src/lib/seed-extractor.ts — Extract hardcoded seed IDs from seed files

// CUID pattern: starts with 'cl' or 'cm' followed by 15+ alphanumeric chars
const CUID_RE = /^c[lm][a-z0-9]{15,}$/;
// UUID pattern
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extract hardcoded seed IDs from file content.
 * Looks for CUIDs, UUIDs, and similar patterns inside quotes.
 */
export function extractSeedIds(content: string): string[] {
  const ids = new Set<string>();

  // Find quoted strings that look like IDs
  const quotedStrings = content.matchAll(/["']([^"']{15,})["']/g);
  for (const m of quotedStrings) {
    const val = m[1];
    if (CUID_RE.test(val) || UUID_RE.test(val)) {
      ids.add(val);
    }
  }

  return [...ids];
}

/**
 * Group seed IDs by nearby model/table references.
 * Looks for prisma.modelName or "ModelName" within 5 lines of the ID.
 */
export function groupSeedIdsByContext(content: string): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineIds = extractSeedIds(lines[i]);
    if (lineIds.length === 0) continue;

    // Search surrounding lines (±5) for model references, closest first
    let modelName: string | null = null;

    // First: check the current line for constant-style keys (e.g. USER_ADMIN: "cl...", ORGANIZATION: "cl...")
    const constKeyMatch = lines[i].match(/(\w+?)(?:_\w+)?:\s*["']/);
    if (constKeyMatch) {
      const raw = constKeyMatch[1];
      // Capitalize: "USER" → "User", "ORGANIZATION" → "Organization", "ENV" → "Environment"
      const keyMap: Record<string, string> = {
        USER: "User", ORGANIZATION: "Organization", ORG: "Organization",
        PROJECT: "Project", ENV: "Environment", SURVEY: "Survey",
        TEAM: "Team", MEMBER: "Membership", ACCOUNT: "Account",
      };
      if (keyMap[raw.toUpperCase()]) {
        modelName = keyMap[raw.toUpperCase()];
      }
    }

    // Then: search surrounding lines for prisma.modelName or comment patterns
    if (!modelName) {
      const searchOrder: number[] = [];
      for (let d = 0; d <= 5; d++) {
        if (i - d >= 0) searchOrder.push(i - d);
        if (d > 0 && i + d < lines.length) searchOrder.push(i + d);
      }
      for (const j of searchOrder) {
        // prisma.modelName.create/upsert
        const prismaMatch = lines[j].match(/prisma\.(\w+)\./);
        if (prismaMatch) {
          modelName = prismaMatch[1].charAt(0).toUpperCase() + prismaMatch[1].slice(1);
          break;
        }
        // "ModelName" in a comment
        const commentMatch = lines[j].match(/(?:Seed|Create|Insert)\s+(\w+)/i);
        if (commentMatch) {
          modelName = commentMatch[1];
          break;
        }
      }
    }

    const key = modelName ?? "_unknown";
    if (!groups[key]) groups[key] = [];
    for (const id of lineIds) {
      if (!groups[key].includes(id)) groups[key].push(id);
    }
  }

  return groups;
}
