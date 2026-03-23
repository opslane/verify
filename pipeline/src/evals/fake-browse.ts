#!/usr/bin/env node
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowseScript, BrowseScriptStep } from "./browse-eval-types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function countTraceEntries(tracePath: string): number {
  if (!existsSync(tracePath)) return 0;
  return readFileSync(tracePath, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .length;
}

function matches(step: BrowseScriptStep, command: string): boolean {
  const normalized = step.match.trimEnd();
  return command === normalized || command.startsWith(`${normalized} `);
}

async function main(): Promise<number> {
  const command = process.argv.slice(2).join(" ").trim();
  const scriptPath = process.env.BROWSE_EVAL_SCRIPT;
  const tracePath = process.env.BROWSE_EVAL_TRACE;

  if (!scriptPath) {
    process.stderr.write("BROWSE_EVAL_SCRIPT is required\n");
    return 2;
  }

  const script = readJsonFile<BrowseScript>(scriptPath);
  const nextIndex = tracePath ? countTraceEntries(tracePath) : 0;
  const step = script.steps[nextIndex];

  if (!step) {
    const stderr = `UNSCRIPTED COMMAND at step ${nextIndex}`;
    process.stderr.write(`${stderr}\n`);
    return 99;
  }

  if (!matches(step, command)) {
    const stderr = `SCRIPT MISMATCH at step ${nextIndex}: expected "${step.match}" but got "${command}"`;
    process.stderr.write(`${stderr}\n`);
    return 98;
  }

  const stdout = step.stdout ?? "";
  const stderr = step.stderr ?? "";

  if (tracePath) {
    mkdirSync(dirname(tracePath), { recursive: true });
    appendFileSync(tracePath, `${JSON.stringify({
      ts: new Date().toISOString(),
      command,
      exitCode: step.exitCode,
      stdout,
      stderr,
    })}\n`);
  }

  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (step.sleepMs && step.sleepMs > 0) await sleep(step.sleepMs);
  return step.exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
