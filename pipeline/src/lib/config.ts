import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { VerifyConfig } from "./types.js";

const DEFAULTS: VerifyConfig = {
  baseUrl: "http://localhost:3000",
  maxParallelGroups: 5,
};

export function loadConfig(verifyDir: string): VerifyConfig {
  let fileConfig: Partial<VerifyConfig> = {};

  const configPath = join(verifyDir, "config.json");
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      // Malformed config — use defaults
    }
  }

  const envOverrides: Partial<VerifyConfig> = {};
  if (process.env.VERIFY_BASE_URL) envOverrides.baseUrl = process.env.VERIFY_BASE_URL;
  if (process.env.VERIFY_AUTH_CHECK_URL) envOverrides.authCheckUrl = process.env.VERIFY_AUTH_CHECK_URL;
  if (process.env.VERIFY_SPEC_PATH) envOverrides.specPath = process.env.VERIFY_SPEC_PATH;
  if (process.env.VERIFY_DIFF_BASE) envOverrides.diffBase = process.env.VERIFY_DIFF_BASE;

  return { ...DEFAULTS, ...fileConfig, ...envOverrides };
}
