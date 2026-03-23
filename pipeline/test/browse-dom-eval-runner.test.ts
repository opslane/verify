import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("browse dom eval runner", () => {
  it("exposes eval:browse:dom in package.json scripts", () => {
    const packageJsonPath = join(process.cwd(), "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["eval:browse:dom"]).toBe("tsx src/evals/run-browse-dom-evals.ts");
  });
});
