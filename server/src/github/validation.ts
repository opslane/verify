/**
 * Validates GitHub owner and repo names to prevent SSRF via path traversal.
 * GitHub names must start and end with alphanumeric characters.
 */
const GITHUB_NAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$|^[a-zA-Z0-9]$/;

export function validateOwnerRepo(owner: string, repo: string): void {
  if (!GITHUB_NAME_RE.test(owner)) {
    throw new Error(`Invalid GitHub owner: ${owner}`);
  }
  if (!GITHUB_NAME_RE.test(repo)) {
    throw new Error(`Invalid GitHub repo: ${repo}`);
  }
}

export function validatePrNumber(prNumber: number): void {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }
}
