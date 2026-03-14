import Anthropic from '@anthropic-ai/sdk';
import { GitHubAppService } from '../github/app-service.js';
import { fetchPullRequest, fetchPrChangedFiles, postOrUpdateComment } from '../github/pr.js';
import { findRepoConfig } from '../db.js';
import { E2BSandboxProvider } from '../sandbox/e2b-provider.js';
import { requireEnv } from '../env.js';
import { decrypt } from '../crypto.js';
import { drain } from '../sandbox/stream.js';
import { discoverSpec } from './spec-discovery.js';
import { setupSandbox } from './sandbox-setup.js';
import { runBrowserAgent, ensureBrowserRunning, loginAndInjectAuth } from './browser-agent.js';
import { VERIFY_MARKER, formatVerifyComment, formatStartupFailureComment, formatNoSpecComment } from './comment.js';
import type { AcResult } from './comment.js';

const VERIFY_TEMPLATE = process.env.E2B_VERIFY_TEMPLATE ?? 'opslane-verify-v2';
const VERIFY_TIMEOUT_MS = 900_000; // 15 minutes total sandbox lifetime
const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\-/]+$/;

export interface VerifyPipelineInput {
  owner: string;
  repo: string;
  prNumber: number;
}

interface VerifyCallbacks {
  log: (step: string, message: string, data?: unknown) => void;
  /** If true, skip posting the PR comment — caller will handle it */
  skipComment?: boolean;
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
    template: config.sandbox_template ?? VERIFY_TEMPLATE,
    timeoutMs: VERIFY_TIMEOUT_MS,
    envVars: {
      GIT_TERMINAL_PROMPT: '0',
      PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    },
    metadata: { sessionId: `verify-${owner}-${repo}-${prNumber}`, userId: 'system' },
  });

  try {
    // 7. Clone repo (or update if custom template pre-populated /home/user/repo)
    log('clone', `Cloning ${owner}/${repo}@${prMeta.headBranch}`);
    const authCloneUrl = prMeta.cloneUrl.replace(
      'https://github.com/',
      `https://x-access-token:${token}@github.com/`,
    );
    if (config.sandbox_template) {
      // Custom template: repo is pre-cloned with deps installed — just fetch the PR branch
      await drain(provider.runCommand(
        sandbox.id,
        `cd /home/user/repo && git remote set-url origin '${authCloneUrl}' && git fetch --depth=1 origin '${prMeta.headBranch}' && git checkout FETCH_HEAD`,
        { rawOutput: true },
      ));
    } else {
      await drain(provider.runCommand(
        sandbox.id,
        `git clone --depth=1 --branch '${prMeta.headBranch}' '${authCloneUrl}' /home/user/repo`,
        { rawOutput: true },
      ));
    }

    // 8. If plan-file spec, fetch its content from the cloned repo
    let specContent: string;
    if (spec.type === 'plan-file') {
      // Defense in depth: validate specPath before shell interpolation
      // (spec-discovery.ts already constrains to docs/plans/*.md via PLAN_FILE_PATTERN)
      if (!SAFE_BRANCH_RE.test(spec.specPath)) {
        throw new Error(`Unsafe spec path: ${spec.specPath}`);
      }
      specContent = await provider.readFile(sandbox.id, `/home/user/repo/${spec.specPath}`);
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

    // 11. Launch browser once, then run agent for each AC
    const baseUrl = `http://localhost:${config.port}`;
    const testEmail = config.test_email ? decrypt(config.test_email) : undefined;
    const testPassword = config.test_password ? decrypt(config.test_password) : undefined;
    const results: AcResult[] = [];

    // Ensure playwright npm package is available (custom templates may not have it)
    log('agent', 'Ensuring playwright package is installed');
    await drain(provider.runCommand(sandbox.id, 'node -e "require(\'playwright\')" 2>/dev/null || npm install --prefix /home/user/.local playwright@latest', { rawOutput: true, timeoutMs: 120_000 }));

    log('agent', 'Launching persistent browser');
    await ensureBrowserRunning(provider, sandbox.id, (msg) => log('agent', msg));

    // Pre-authenticate: run customer's login script, capture cookies, inject into browser
    if (config.login_script && testEmail && testPassword) {
      log('agent', 'Running login script to pre-authenticate browser');
      const authOk = await loginAndInjectAuth(
        provider, sandbox.id, baseUrl, config.login_script, testEmail, testPassword,
        (msg) => log('agent', msg),
      );
      log('agent', authOk ? 'Browser pre-authenticated' : 'Login script failed — agent will handle login');
    }

    for (const ac of criteria) {
      if (ac.testable === false) {
        log('agent', `Skipping untestable AC: ${ac.id} — ${ac.description}`);
        results.push({
          id: ac.id,
          description: ac.description,
          result: 'skipped',
          reason: 'Not testable via browser — requires manual or backend verification',
        });
        continue;
      }
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
    if (!callbacks.skipComment) {
      await postOrUpdateComment(owner, repo, prNumber, comment, VERIFY_MARKER, token);
    }
    return { mode: 'verified', comment, passed, total: results.length, results };

  } finally {
    log('cleanup', 'Destroying sandbox');
    await provider.destroy(sandbox.id);
  }
}

interface AcceptanceCriterion {
  id: string;
  description: string;
  testable?: boolean;
}

/**
 * Use Claude to parse a spec document into individual, testable acceptance criteria.
 * Exported for testing.
 */
export async function parseAcceptanceCriteria(specContent: string): Promise<AcceptanceCriterion[]> {
  // Mitigate prompt injection: strip XML-like tags that could break out of our delimiter
  const sanitized = specContent.replace(/<\/?spec>/gi, '[spec-tag-removed]');

  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `You are an autonomous QA engineer. Extract the key acceptance criteria from this spec/PR description for browser-based verification.

IMPORTANT RULES:
1. **Consolidate related checks into a single AC.** For example, "component renders, has a button, button is clickable" should be ONE AC, not three. Group by user flow or component.
2. **Maximum 5 testable ACs.** If the spec implies more, merge related ones. Focus on the most important user-visible behaviors.
3. **Each AC description must include full navigation steps.** A browser agent will execute each AC independently with no prior context. Include EVERY step from the home page: "Navigate to base URL, click 'ComponentName' nav button, then verify X". Never assume the agent is already on the right page.
4. **Be specific about UI interactions.** Use button labels and visible text, not vague descriptions. Example: "Navigate to base URL, click 'WatcherBug' button, then click 'Increment' button 3 times, verify counter stays at 0" — not "verify counter behavior".
5. Mark ACs as "testable": false only if they genuinely cannot be checked in a browser (e.g., database state, external API calls).

For each criterion, return a JSON object with:
- "id": e.g. "AC-1", "AC-2"
- "description": a concrete test scenario (what to do and what to verify)
- "testable": true if verifiable via browser interaction, false otherwise

<spec>
${sanitized}
</spec>

Respond with ONLY the JSON array, no other text.`,
      },
    ],
  });

  const text = response.content.find((c) => c.type === 'text')?.text ?? '[]';
  return parseAcceptanceCriteriaJson(text);
}

/** Parse Claude's response into validated AcceptanceCriterion array. Exported for testing. */
export function parseAcceptanceCriteriaJson(text: string): AcceptanceCriterion[] {
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]) as unknown[];
    return parsed
      .filter((item): item is { id: string; description: string; testable?: boolean } =>
        typeof item === 'object' && item !== null &&
        'id' in item && typeof (item as Record<string, unknown>).id === 'string' &&
        'description' in item && typeof (item as Record<string, unknown>).description === 'string'
      )
      .map((item) => ({
        id: item.id,
        description: item.description,
        testable: typeof item.testable === 'boolean' ? item.testable : true,
      }));
  } catch {
    return [];
  }
}

