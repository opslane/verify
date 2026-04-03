import { describe, it, expect, vi } from "vitest";

// Mock execSync before importing the module
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { extractDiffHints } from "../src/lib/diff-hints.js";
import { execSync } from "node:child_process";

const mockExecSync = vi.mocked(execSync);

describe("extractDiffHints", () => {
  it("returns formatted hints for frontend files", () => {
    // First call: uncommitted changes
    mockExecSync.mockReturnValueOnce("app/(teams)/t/[teamUrl]/settings/page.tsx\nsrc/components/Button.tsx");
    // Second call: staged changes
    mockExecSync.mockReturnValueOnce("");

    const result = extractDiffHints("/project");
    expect(result).toContain("Changed frontend files:");
    expect(result).toContain("settings/page.tsx");
    expect(result).toContain("likely route: /t/{teamUrl}/settings");
  });

  it("filters out non-frontend files", () => {
    mockExecSync.mockReturnValueOnce("package.json\ntsconfig.json\nREADME.md\nsrc/utils/helper.ts");
    mockExecSync.mockReturnValueOnce("");

    const result = extractDiffHints("/project");
    expect(result).toContain("src/utils/helper.ts");
    expect(result).not.toContain("package.json");
    expect(result).not.toContain("README.md");
  });

  it("returns no diff message when git fails", () => {
    mockExecSync.mockImplementation(() => { throw new Error("not a git repo"); });

    const result = extractDiffHints("/project");
    expect(result).toBe("No diff information available.");
  });

  it("returns no diff message when no files changed", () => {
    mockExecSync.mockReturnValueOnce("");
    mockExecSync.mockReturnValueOnce("");
    // Falls back to HEAD~1
    mockExecSync.mockReturnValueOnce("");

    const result = extractDiffHints("/project");
    expect(result).toBe("No diff information available.");
  });

  it("deduplicates files across uncommitted and staged", () => {
    mockExecSync.mockReturnValueOnce("src/components/Modal.tsx");
    mockExecSync.mockReturnValueOnce("src/components/Modal.tsx");

    const result = extractDiffHints("/project");
    const matches = result.match(/Modal\.tsx/g);
    expect(matches).toHaveLength(1);
  });

  it("extracts route from Next.js pages directory", () => {
    mockExecSync.mockReturnValueOnce("pages/api/users.ts\npages/dashboard/index.tsx");
    mockExecSync.mockReturnValueOnce("");

    const result = extractDiffHints("/project");
    expect(result).toContain("likely route: /dashboard");
  });
});
