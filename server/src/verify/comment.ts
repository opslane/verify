export const VERIFY_MARKER = '<!-- opslane-verify -->';

export interface AcResult {
  id: string;
  description: string;
  result: 'pass' | 'fail' | 'skipped';
  expected?: string;
  observed?: string;
  reason?: string;
}

interface VerifyCommentInput {
  specPath: string;
  port: number;
  results: AcResult[];
}

const ICON = { pass: '\u2705', fail: '\u274C', skipped: '\u2298' };
const LABEL = { pass: 'Pass', fail: 'Fail', skipped: 'Skipped' };

export function formatVerifyComment(input: VerifyCommentInput): string {
  const passed = input.results.filter((r) => r.result === 'pass').length;
  const total = input.results.length;

  const rows = input.results
    .map((r) => {
      const suffix = r.result === 'skipped' && r.reason ? ` (${r.reason})` : '';
      return `| ${ICON[r.result]} | ${r.id}: ${r.description} | ${LABEL[r.result]}${suffix} |`;
    })
    .join('\n');

  const details = input.results
    .filter((r) => r.result === 'fail')
    .map((r) => {
      let detail = `**${r.id} — Fail**\n`;
      if (r.expected) detail += `> Expected: ${r.expected}\n`;
      if (r.observed) detail += `> Observed: ${r.observed}\n`;
      return detail;
    })
    .join('\n');

  return `${VERIFY_MARKER}
## Verify Report

**Spec:** \`${input.specPath}\`
**App:** Started on port ${input.port}

### Acceptance Criteria

| | AC | Result |
|---|---|---|
${rows}

${details ? `### Details\n\n${details}` : ''}
---

*${passed} of ${total} criteria passed \u00b7 Powered by Opslane Verify*
`;
}

export function formatStartupFailureComment(input: {
  port: number;
  error: string;
  serverLog: string;
}): string {
  return `${VERIFY_MARKER}
## Verify Report

**Status:** App failed to start on port ${input.port}

${input.error}

**Server log (last 30 lines):**
\`\`\`
${input.serverLog}
\`\`\`

**Common fixes:**
- Check your startup command in the Opslane dashboard
- Ensure required env vars are configured
- Verify your pre-start script (migrations, etc.) succeeds
`;
}

export function formatNoSpecComment(): string {
  return `${VERIFY_MARKER}
## Verify Report

No spec found for this PR. To enable acceptance testing, add a plan file to \`docs/plans/\` in your PR.

*Powered by Opslane Verify*
`;
}
