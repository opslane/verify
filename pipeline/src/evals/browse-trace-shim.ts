import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function main(): number {
  const realBrowseBin = process.env.BROWSE_TRACE_REAL_BIN;
  const tracePath = process.env.BROWSE_EVAL_TRACE;

  if (!realBrowseBin) {
    process.stderr.write("BROWSE_TRACE_REAL_BIN is required\n");
    return 2;
  }

  if (!tracePath) {
    process.stderr.write("BROWSE_EVAL_TRACE is required\n");
    return 2;
  }

  const args = process.argv.slice(2);
  const command = args.join(" ").trim();
  const result = spawnSync(realBrowseBin, args, {
    encoding: "utf-8",
    env: process.env,
    stdio: "pipe",
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.status ?? 1;

  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
  }

  mkdirSync(dirname(tracePath), { recursive: true });
  appendFileSync(tracePath, `${JSON.stringify({
    ts: new Date().toISOString(),
    command,
    exitCode,
    stdout,
    stderr: result.error ? `${stderr}${stderr ? "\n" : ""}${result.error.message}` : stderr,
  })}\n`);

  return exitCode;
}

process.exit(main());
