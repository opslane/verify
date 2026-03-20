import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/lib/config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `verify-test-${Date.now()}`);
    mkdirSync(join(tempDir, ".verify"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.VERIFY_BASE_URL;
    delete process.env.VERIFY_SPEC_PATH;
    delete process.env.VERIFY_DIFF_BASE;
  });

  it("returns defaults when no config file exists", () => {
    const config = loadConfig(join(tempDir, ".verify"));
    expect(config.baseUrl).toBe("http://localhost:3000");
  });

  it("reads config.json", () => {
    writeFileSync(
      join(tempDir, ".verify", "config.json"),
      JSON.stringify({ baseUrl: "http://localhost:4000" })
    );
    const config = loadConfig(join(tempDir, ".verify"));
    expect(config.baseUrl).toBe("http://localhost:4000");
  });

  it("env vars override config.json", () => {
    writeFileSync(
      join(tempDir, ".verify", "config.json"),
      JSON.stringify({ baseUrl: "http://localhost:4000" })
    );
    process.env.VERIFY_BASE_URL = "http://localhost:5000";
    const config = loadConfig(join(tempDir, ".verify"));
    expect(config.baseUrl).toBe("http://localhost:5000");
  });

  it("maxParallelGroups defaults to 5", () => {
    const config = loadConfig(join(tempDir, ".verify"));
    expect(config.maxParallelGroups).toBe(5);
  });

  it("handles malformed config.json gracefully", () => {
    writeFileSync(join(tempDir, ".verify", "config.json"), "not json{{{");
    const config = loadConfig(join(tempDir, ".verify"));
    expect(config.baseUrl).toBe("http://localhost:3000");
  });

  it("loads config with loginSteps auth", () => {
    writeFileSync(join(tempDir, ".verify", "config.json"), JSON.stringify({
      baseUrl: "http://localhost:3000",
      auth: {
        email: "admin@example.com",
        password: "secret",
        loginSteps: [
          { action: "goto", url: "/auth/login" },
          { action: "fill", selector: "[name='email']", value: "{{email}}" },
          { action: "fill", selector: "[name='password']", value: "{{password}}" },
          { action: "click", selector: "button:has-text('Sign in')" },
        ],
      },
    }));
    const config = loadConfig(join(tempDir, ".verify"));
    expect(config.auth?.loginSteps).toHaveLength(4);
    expect(config.auth?.loginSteps?.[0]).toEqual({ action: "goto", url: "/auth/login" });
    expect(config.auth?.email).toBe("admin@example.com");
  });
});
