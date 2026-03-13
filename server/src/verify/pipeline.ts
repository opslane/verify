import { GitHubAppService } from '../github/app-service.js';
import { fetchPullRequest } from '../github/pr.js';
import { findRepoConfig } from '../db.js';
import { E2BSandboxProvider } from '../sandbox/e2b-provider.js';
import { requireEnv } from '../env.js';
import { discoverSpec } from './spec-discovery.js';
import { setupSandbox } from './sandbox-setup.js';
import { formatStartupFailureComment, formatNoSpecComment } from './comment.js';
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

  // 4. Spec discovery
  // TODO: Task 10 adds fetchPrChangedFiles — for now, spec discovery
  // uses only PR body since we don't have changed files yet
  const spec = discoverSpec({
    changedFiles: [], // Will be populated when fetchPrChangedFiles is added (Task 10)
    prBody: prMeta.body ?? '',
  });

  if (spec.type === 'no-spec') {
    log('spec', 'No spec found — posting no-spec comment');
    return { mode: 'no-spec', comment: formatNoSpecComment() };
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
      ANTHROPIC_API_KEY: requireEnv('ANTHROPIC_API_KEY'),
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
      return { mode: 'startup-failed', comment };
    }

    // 10. Run verify pipeline stages (planner → agents → judge)
    // TODO: Implement in Task 8 — browser agent orchestration
    log('verify', `Running verify against spec (${specContent.length} chars)`);

    // Placeholder — will be implemented in Task 8
    return { mode: 'verified', passed: 0, total: 0, results: [] };

  } finally {
    log('cleanup', 'Destroying sandbox');
    await provider.destroy(sandbox.id);
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
