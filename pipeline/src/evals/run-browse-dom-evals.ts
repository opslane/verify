import { execFile, type ExecFileException, type ExecFileOptions } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrowseBin, stopDaemon } from "../lib/browse.js";
import { scoreBrowseEvalArtifacts, type BrowseEvalResult, type BrowseEvalArtifactPaths } from "./browse-eval-score.js";
import { startBrowseDomHarnessServer, stopBrowseDomHarnessServer, type BrowseDomHarnessServerHandle } from "./browse-dom-harness-server.js";
import { formatBrowseEvalSummary } from "./run-browse-evals.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_DIR = resolve(__dirname, "..", "..");
const DOM_CASES_DIR = join(PIPELINE_DIR, "evals", "browse-dom-harness", "cases");

export interface StageExecutorInput {
  acId: string;
  env: Record<string, string>;
  pipelineDir: string;
  runDir: string;
  verifyDir: string;
}

export type StageExecutor = (input: StageExecutorInput) => Promise<void> | void;
type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void;

export interface RunBrowseDomEvalCaseOptions {
  baseUrl: string;
  pipelineDir?: string;
  realBrowseBin: string;
  scoreArtifacts?: (paths: BrowseEvalArtifactPaths) => BrowseEvalResult;
  stageExecutor?: StageExecutor;
}

export interface RunBrowseDomEvalsOptions {
  caseFilter?: string;
  pipelineDir?: string;
  resolveBrowseBinHook?: () => string;
  scoreArtifacts?: (paths: BrowseEvalArtifactPaths) => BrowseEvalResult;
  stageExecutor?: StageExecutor;
  startServer?: (options?: { port?: number }) => Promise<BrowseDomHarnessServerHandle>;
  stopDaemonHook?: typeof stopDaemon;
  stopServer?: (server: BrowseDomHarnessServerHandle["server"]) => Promise<void>;
}

export function discoverCaseDirs(root = DOM_CASES_DIR): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort();
}

export function selectCaseDirs(caseDirs: string[], caseFilter?: string): string[] {
  if (!caseFilter) return caseDirs;
  return caseDirs.filter((caseDir) => basename(caseDir) === caseFilter);
}

export function createTraceWrapper(tmpRoot: string, pipelineDir = PIPELINE_DIR): string {
  const wrapperPath = join(tmpRoot, "browse-trace");
  const tsxPath = join(pipelineDir, "node_modules", ".bin", "tsx");
  const shimPath = join(pipelineDir, "src", "evals", "browse-trace-shim.ts");
  writeFileSync(wrapperPath, `#!/bin/sh\nexec "${tsxPath}" "${shimPath}" "$@"\n`);
  chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

export function canonicalizePath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

export function defaultStageExecutor(
  input: StageExecutorInput,
  execFileImpl: ExecFileLike = execFile as ExecFileLike,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFileImpl("npx", [
      "tsx",
      "src/cli.ts",
      "run-stage",
      "browse-agent",
      "--verify-dir",
      input.verifyDir,
      "--run-dir",
      input.runDir,
      "--ac",
      input.acId,
    ], {
      cwd: input.pipelineDir,
      env: input.env,
      encoding: "utf-8",
      timeout: 120_000,
    }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function runBrowseDomEvalCase(caseDir: string, options: RunBrowseDomEvalCaseOptions): Promise<BrowseEvalResult> {
  const caseId = basename(caseDir);
  const pipelineDir = options.pipelineDir ?? PIPELINE_DIR;
  const stageExecutor = options.stageExecutor ?? defaultStageExecutor;
  const scoreArtifacts = options.scoreArtifacts ?? scoreBrowseEvalArtifacts;
  const tmpRoot = canonicalizePath(mkdtempSync(join(tmpdir(), "verify-browse-dom-eval-")));
  const verifyDir = join(tmpRoot, ".verify");
  const runDir = join(tmpRoot, "run");
  const tracePath = join(runDir, "trace.jsonl");
  const wrapperPath = createTraceWrapper(tmpRoot, pipelineDir);

  mkdirSync(verifyDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(verifyDir, "config.json"), JSON.stringify({ baseUrl: options.baseUrl }));
  copyFileSync(join(caseDir, "plan.json"), join(runDir, "plan.json"));

  try {
    try {
      await stageExecutor({
        acId: "ac1",
        env: {
          ...process.env,
          BROWSE_BIN: wrapperPath,
          BROWSE_EVAL_TRACE: tracePath,
          BROWSE_TRACE_REAL_BIN: options.realBrowseBin,
        },
        pipelineDir,
        runDir,
        verifyDir,
      });
    } catch {
      // Keep going — scorer should inspect whatever artifacts were produced.
    }

    return scoreArtifacts({
      caseId,
      expectedPath: join(caseDir, "expected.json"),
      resultPath: join(runDir, "evidence", "ac1", "result.json"),
      tracePath,
      streamPath: join(runDir, "logs", "browse-agent-ac1-stream.jsonl"),
    });
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export async function runBrowseDomEvals(
  caseDirs = discoverCaseDirs(),
  options: RunBrowseDomEvalsOptions = {},
): Promise<BrowseEvalResult[]> {
  const selectedCaseDirs = selectCaseDirs(caseDirs, options.caseFilter);
  if (selectedCaseDirs.length === 0) return [];

  const startServerFn = options.startServer ?? startBrowseDomHarnessServer;
  const stopServerFn = options.stopServer ?? stopBrowseDomHarnessServer;
  const resolveBrowseBinFn = options.resolveBrowseBinHook ?? resolveBrowseBin;
  const stopDaemonFn = options.stopDaemonHook ?? stopDaemon;

  const realBrowseBin = resolveBrowseBinFn();
  const serverHandle = await startServerFn({ port: 0 });
  const baseUrl = `http://127.0.0.1:${serverHandle.port}`;
  const results: BrowseEvalResult[] = [];

  stopDaemonFn();
  try {
    for (const caseDir of selectedCaseDirs) {
      stopDaemonFn();
      try {
        results.push(await runBrowseDomEvalCase(caseDir, {
          baseUrl,
          pipelineDir: options.pipelineDir ?? PIPELINE_DIR,
          realBrowseBin,
          scoreArtifacts: options.scoreArtifacts,
          stageExecutor: options.stageExecutor,
        }));
      } finally {
        stopDaemonFn();
      }
    }
  } finally {
    stopDaemonFn();
    await stopServerFn(serverHandle.server);
  }

  return results;
}

export function parseCaseFilter(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--case") {
      return argv[index + 1];
    }
  }
  return undefined;
}

export function isLiveSmokeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BROWSE_DOM_LIVE_SMOKE === "1";
}

export async function runDomEvalCli(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  runner: typeof runBrowseDomEvals = runBrowseDomEvals,
  logger: Pick<typeof console, "log"> = console,
): Promise<BrowseEvalResult[]> {
  const caseFilter = parseCaseFilter(argv);

  if (caseFilter && !isLiveSmokeEnabled(env)) {
    logger.log(`SKIP set BROWSE_DOM_LIVE_SMOKE=1 to run single-case DOM smoke for ${caseFilter}`);
    return [];
  }

  const results = await runner(discoverCaseDirs(), { caseFilter });

  for (const result of results) {
    if (result.passed) {
      logger.log(`PASS ${result.caseId}  ${result.commandCount} cmds  ${result.durationMs}ms`);
      continue;
    }
    logger.log(`FAIL ${result.caseId}  ${result.failures.join("; ")}`);
  }
  logger.log(formatBrowseEvalSummary(results));
  return results;
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  await runDomEvalCli(argv);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
