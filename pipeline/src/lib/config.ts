import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { VerifyConfig } from "./types.js";

const DEFAULTS: VerifyConfig = {
  baseUrl: "http://localhost:3000",
};

export function loadConfig(verifyDir: string): VerifyConfig {
  let fileConfig: Partial<VerifyConfig> = {};

  const configPath = join(verifyDir, "config.json");
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      console.warn(`[verify] Warning: failed to parse ${configPath}, using defaults`);
    }
  }

  const envOverrides: Partial<VerifyConfig> = {};
  if (process.env.VERIFY_BASE_URL) envOverrides.baseUrl = process.env.VERIFY_BASE_URL;
  if (process.env.VERIFY_SPEC_PATH) envOverrides.specPath = process.env.VERIFY_SPEC_PATH;

  return { ...DEFAULTS, ...fileConfig, ...envOverrides };
}
