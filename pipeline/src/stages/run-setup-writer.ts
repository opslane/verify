// pipeline/src/stages/run-setup-writer.ts — shared setup-writer runner (graph-informed + fallback)
import { graphInformedSetup } from "./graph-setup.js";
import { buildSetupWriterPrompt, parseSetupWriterOutput } from "./setup-writer.js";
import type { SetupCommands, AppIndex, RunClaudeOptions, RunClaudeFn } from "../lib/types.js";
import type { SetupRetryContext } from "./setup-writer.js";

/**
 * Run setup-writer: try graph-informed first, fall back to monolithic.
 * Used by both orchestrator and CLI run-stage (review fix #7: deduplication).
 */
export async function runSetupWriter(opts: {
  groupId: string;
  condition: string;
  appIndex: AppIndex | null;
  projectEnv: Record<string, string>;
  projectRoot: string;
  authEmail?: string;
  retryContext: SetupRetryContext | null;
  runDir: string;
  stageName: string;
  runClaudeFn: RunClaudeFn;
  permissions: Pick<RunClaudeOptions, "dangerouslySkipPermissions" | "allowedTools">;
  timeoutMs: number;
}): Promise<SetupCommands | null> {
  // Try graph-informed first (review decision C4: returns null if entity_graphs missing)
  let commands: SetupCommands | null = null;
  if (opts.appIndex) {
    commands = await graphInformedSetup(
      opts.groupId, opts.condition, opts.appIndex, opts.projectEnv, opts.authEmail,
      opts.runDir, opts.stageName, opts.runClaudeFn,
    );
  }

  // Fallback to old monolithic setup-writer
  if (!commands) {
    const prompt = opts.retryContext
      ? (await import("./setup-writer.js")).buildSetupWriterRetryPrompt(opts.groupId, opts.condition, opts.projectRoot, opts.retryContext, opts.authEmail)
      : buildSetupWriterPrompt(opts.groupId, opts.condition, opts.projectRoot, opts.authEmail);
    const result = await opts.runClaudeFn({
      prompt, model: "sonnet", timeoutMs: opts.timeoutMs,
      stage: opts.stageName, runDir: opts.runDir, ...opts.permissions,
    });
    commands = parseSetupWriterOutput(result.stdout);
  }

  return commands;
}
