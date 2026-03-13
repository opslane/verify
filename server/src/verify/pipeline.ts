import Anthropic from '@anthropic-ai/sdk';
import { GitHubAppService } from '../github/app-service.js';
import { fetchPullRequest, fetchPrChangedFiles, postOrUpdateComment } from '../github/pr.js';
import { findRepoConfig } from '../db.js';
import { E2BSandboxProvider } from '../sandbox/e2b-provider.js';
import { requireEnv } from '../env.js';
import { decrypt } from '../crypto.js';
import { discoverSpec } from './spec-discovery.js';
import { setupSandbox } from './sandbox-setup.js';
import { runBrowserAgent } from './browser-agent.js';
import { VERIFY_MARKER, formatVerifyComment, formatStartupFailureComment, formatNoSpecComment } from './comment.js';
import type { AcResult } from './comment.js';

const VERIFY_TEMPLATE = process.env.E2B_VERIFY_TEMPLATE ?? 'opslane-verify-v2';
const VERIFY_TIMEOUT_MS = 600_000; // 10 minutes total sandbox lifetime
const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\-/]+$/;

export interface VerifyPipelineInput {
  owner: string;
  repo: string;
  prNumber: number;
}

interface VerifyCallbacks {
  log: (step: string, message: string, data?: unknown) => void;
}

export type VerifyResult =
  | { mode: 'no-config' }
  | { mode: 'no-spec'; comment?: string }
  | { mode: 'startup-failed'; comment?: string }
  | { mode: 'verified'; comment?: string; passed: number; total: number; results: AcResult[] };

export async function runVerifyPipeline(
  input: VerifyPipelineInput,
  callbacks: VerifyCallbacks,
): Promise<VerifyResult> {
  const { owner, repo, prNumber } = input;
  const log = callbacks.log;

  // 1. Check repo config exists
  const config = await findRepoConfig(owner, repo);
  if (!config) {
    log('config', 'No repo config found — skipping verify');
    return { mode: 'no-config' };
  }

  // 2. Get GitHub token
  const appService = new GitHubAppService(
    requireEnv('GITHUB_APP_ID'),
    requireEnv('GITHUB_APP_PRIVATE_KEY'),
  );
  const { token } = await appService.getTokenForRepo(owner, repo);

  // 3. Fetch PR metadata
  const prMeta = await fetchPullRequest(owner, repo, prNumber, token);

  // 4. Fetch changed files + spec discovery
  const changedFiles = await fetchPrChangedFiles(owner, repo, prNumber, token);
  const spec = discoverSpec({
    changedFiles,
    prBody: prMeta.body ?? '',
  });

  if (spec.type === 'no-spec') {
    log('spec', 'No spec found — posting no-spec comment');
    const comment = formatNoSpecComment();
    await postOrUpdateComment(owner, repo, prNumber, comment, VERIFY_MARKER, token);
    return { mode: 'no-spec', comment };
  }

  // 5. Validate branch name
  if (!SAFE_BRANCH_RE.test(prMeta.headBranch)) {
    throw new Error(`Unsafe branch name: ${prMeta.headBranch}`);
  }

  // 6. Spin up sandbox
  log('sandbox', 'Creating E2B sandbox');
  const provider = new E2BSandboxProvider();
  const sandbox = await provider.create({
    template: VERIFY_TEMPLATE,
    timeoutMs: VERIFY_TIMEOUT_MS,
    envVars: {
      GIT_TERMINAL_PROMPT: '0',
      PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    },
    metadata: { sessionId: `verify-${owner}-${repo}-${prNumber}`, userId: 'system' },
  });

  try {
    // 7. Clone repo
    log('clone', `Cloning ${owner}/${repo}@${prMeta.headBranch}`);
    const authCloneUrl = prMeta.cloneUrl.replace(
      'https://github.com/',
      `https://x-access-token:${token}@github.com/`,
    );
    await drain(provider.runCommand(
      sandbox.id,
      `git clone --depth=1 --branch '${prMeta.headBranch}' '${authCloneUrl}' /home/user/repo`,
    ));

    // 8. If plan-file spec, fetch its content from the cloned repo
    let specContent: string;
    if (spec.type === 'plan-file') {
      // Defense in depth: validate specPath before shell interpolation
      // (spec-discovery.ts already constrains to docs/plans/*.md via PLAN_FILE_PATTERN)
      if (!SAFE_BRANCH_RE.test(spec.specPath)) {
        throw new Error(`Unsafe spec path: ${spec.specPath}`);
      }
      const lines = await collect(provider.runCommand(sandbox.id, `cat '/home/user/repo/${spec.specPath}'`));
      specContent = lines.join('\n');
    } else {
      specContent = spec.specContent;
    }

    // 9. Setup sandbox (env, infra, deps, start app)
    log('setup', 'Setting up sandbox');
    const setupResult = await setupSandbox(provider, sandbox.id, config, log);

    if (!setupResult.success) {
      log('setup', `Setup failed: ${setupResult.error}`);
      const comment = formatStartupFailureComment({
        port: config.port,
        error: setupResult.error ?? 'Unknown error',
        serverLog: setupResult.serverLog ?? 'No log available',
      });
      await postOrUpdateComment(owner, repo, prNumber, comment, VERIFY_MARKER, token);
      return { mode: 'startup-failed', comment };
    }

    // 10. Parse spec into acceptance criteria (planner step)
    log('verify', `Parsing spec into acceptance criteria (${specContent.length} chars)`);
    const criteria = await parseAcceptanceCriteria(specContent);
    log('verify', `Found ${criteria.length} acceptance criteria`);

    // 11. Run browser agent for each AC
    const baseUrl = `http://localhost:${config.port}`;
    const testEmail = config.test_email ? decrypt(config.test_email) : undefined;
    const testPassword = config.test_password ? decrypt(config.test_password) : undefined;
    const results: AcResult[] = [];

    for (const ac of criteria) {
      log('agent', `Testing AC: ${ac.id} — ${ac.description}`);
      const verdict = await runBrowserAgent(
        provider, sandbox.id,
        { goal: ac.description, baseUrl, testEmail, testPassword },
        (msg) => log('agent', msg),
      );
      results.push({
        id: ac.id,
        description: ac.description,
        result: verdict.result === 'error' ? 'skipped' : verdict.result,
        expected: verdict.expected,
        observed: verdict.observed,
        reason: verdict.result === 'error' ? verdict.error : undefined,
      });
    }

    const passed = results.filter((r) => r.result === 'pass').length;
    const specPath = spec.type === 'plan-file' ? spec.specPath : '(PR body)';
    const comment = formatVerifyComment({ specPath, port: config.port, results });
    await postOrUpdateComment(owner, repo, prNumber, comment, VERIFY_MARKER, token);
    return { mode: 'verified', comment, passed, total: results.length, results };

  } finally {
    log('cleanup', 'Destroying sandbox');
    await provider.destroy(sandbox.id);
  }
}

interface AcceptanceCriterion {
  id: string;
  description: string;
}

/**
 * Use Claude to parse a spec document into individual, testable acceptance criteria.
 */
async function parseAcceptanceCriteria(specContent: string): Promise<AcceptanceCriterion[]> {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `Extract all testable acceptance criteria from the following spec. Return a JSON array where each item has "id" (e.g. "AC-1") and "description" (a single sentence describing what to verify in the browser).

Only include criteria that can be verified by interacting with a web UI. Skip non-functional requirements, deployment steps, or backend-only criteria.

<spec>
${specContent}
</spec>

Respond with ONLY the JSON array, no other text.`,
      },
    ],
  });

  const text = response.content.find((c) => c.type === 'text')?.text ?? '[]';
  // Extract JSON array from response (handle markdown code fences)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]) as unknown[];
    return parsed
      .filter((item): item is { id: string; description: string } =>
        typeof item === 'object' && item !== null &&
        'id' in item && typeof (item as Record<string, unknown>).id === 'string' &&
        'description' in item && typeof (item as Record<string, unknown>).description === 'string'
      )
      .map((item) => ({ id: item.id, description: item.description }));
  } catch {
    return [];
  }
}

async function drain(stream: AsyncIterable<string>): Promise<void> {
  for await (const _ of stream) { /* consume */ }
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of stream) { lines.push(line); }
  return lines;
}
