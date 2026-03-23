import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("browse dom eval runner", () => {
  it("exposes eval:browse:dom in package.json scripts", () => {
    const packageJsonPath = join(__dirname, "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(typeof packageJson.scripts?.["eval:browse:dom"]).toBe("string");
    expect(packageJson.scripts?.["eval:browse:dom"]).toBeTruthy();
  });
});
