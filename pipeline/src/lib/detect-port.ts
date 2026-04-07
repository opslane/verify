// pipeline/src/lib/detect-port.ts — Deterministic dev server port detection
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface PortResult {
  port: number;
  source: string;
}

/**
 * Deterministic port detection from project files.
 * Checks package.json scripts, .env files, and framework configs.
 * Returns null if no port can be determined — caller should fall back to LLM or default.
 */
export function detectPort(projectDir: string): PortResult | null {
  // 1. Check package.json scripts (highest priority — most explicit)
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      for (const key of ["dev", "start", "serve"]) {
        const script = scripts[key];
        if (!script) continue;
        const portMatch = script.match(/(?:-p|--port)[=\s]+(\d+)/);
        if (portMatch) {
          return { port: parseInt(portMatch[1], 10), source: `package.json scripts.${key}` };
        }
      }
    } catch { /* malformed package.json */ }
  }

  // 2. Check .env files for PORT=
  for (const envFile of [".env", ".env.local", ".env.development"]) {
    const envPath = join(projectDir, envFile);
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, "utf-8");
      const portMatch = content.match(/^PORT=(\d+)/m);
      if (portMatch) {
        return { port: parseInt(portMatch[1], 10), source: envFile };
      }
    } catch { /* unreadable */ }
  }

  // 3. Check vite.config for server.port
  for (const configFile of ["vite.config.ts", "vite.config.js", "vite.config.mjs"]) {
    const configPath = join(projectDir, configFile);
    if (!existsSync(configPath)) continue;
    try {
      const content = readFileSync(configPath, "utf-8");
      const portMatch = content.match(/port\s*:\s*(\d+)/);
      if (portMatch) {
        return { port: parseInt(portMatch[1], 10), source: configFile };
      }
    } catch { /* unreadable */ }
  }

  return null;
}
