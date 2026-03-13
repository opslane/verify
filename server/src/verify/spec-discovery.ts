export interface ChangedFile {
  filename: string;
  status: string; // 'added' | 'modified' | 'removed' | etc.
}

export interface SpecDiscoveryInput {
  changedFiles: ChangedFile[];
  prBody: string;
}

export type SpecResult =
  | { type: 'plan-file'; specPath: string }
  | { type: 'pr-body'; specContent: string }
  | { type: 'no-spec' };

// Matches docs/plans/*.md but rejects path traversal (no ..)
const PLAN_FILE_PATTERN = /^docs\/plans\/(?!.*\.\.)[\w.-]+\.md$/;

/** Heuristic: does the PR body contain anything that looks like acceptance criteria? */
function hasAcceptanceCriteria(body: string): boolean {
  if (!body || body.trim().length < 20) return false;
  const lower = body.toLowerCase();
  return (
    /- \[[ x]\]/.test(body) ||
    lower.includes('acceptance criteria') ||
    lower.includes('requirements') ||
    (lower.includes('should') && /^[-*]\s/m.test(body))
  );
}

export function discoverSpec(input: SpecDiscoveryInput): SpecResult {
  // Step 1: Look for plan files in changed files
  const planFiles = input.changedFiles.filter((f) => PLAN_FILE_PATTERN.test(f.filename));

  if (planFiles.length > 0) {
    // Prefer added files over modified
    const added = planFiles.filter((f) => f.status === 'added');
    const chosen = added.length > 0 ? added[added.length - 1] : planFiles[planFiles.length - 1];
    return { type: 'plan-file', specPath: chosen.filename };
  }

  // Step 2: Check PR body for acceptance criteria
  if (hasAcceptanceCriteria(input.prBody)) {
    return { type: 'pr-body', specContent: input.prBody };
  }

  // Step 3: No spec found
  return { type: 'no-spec' };
}
