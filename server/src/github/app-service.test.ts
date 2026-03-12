import { describe, it, expect } from "vitest";
import { GitHubAppService, GitHubAppNotInstalledError } from "./app-service.js";

describe("GitHubAppService", () => {
  it("throws on invalid private key", () => {
    expect(
      () => new GitHubAppService("123", "not-a-valid-key")
    ).toThrow("Invalid GitHub App private key format");
  });

  it("throws GitHubAppNotInstalledError with install URL", () => {
    const err = new GitHubAppNotInstalledError("owner", "repo", "my-app");
    expect(err.message).toContain("https://github.com/apps/my-app/installations/new");
    expect(err.owner).toBe("owner");
    expect(err.repo).toBe("repo");
  });
});
