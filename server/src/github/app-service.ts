import { importPKCS8, SignJWT } from "jose";
import { createPrivateKey } from "node:crypto";
import { validateOwnerRepo } from "./validation.js";

const GITHUB_API_BASE = "https://api.github.com";

export interface InstallationToken {
  token: string;
  expiresAt: string;
  installationId: number;
}

export class GitHubAppService {
  private appId: string;
  private privateKey: string;
  private appSlug: string;
  private clockOffsetSec = 0;

  constructor(appId: string, privateKeyOrBase64: string, appSlug = "opslane") {
    this.appId = appId;
    this.appSlug = appSlug;
    // Accept raw PEM or base64-encoded PEM (for env vars)
    this.privateKey = this.decodePem(privateKeyOrBase64);
    this.assertPrivateKeyReadable();
  }

  /**
   * Create a short-lived JWT (10 min) for authenticating as the GitHub App.
   * Uses RS256 with the App's private key.
   */
  async createAppJwt(): Promise<string> {
    const key = await this.importKey();
    const now = this.getNowSec();

    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(this.appId)
      .setIssuedAt(now - 60) // 60s clock skew allowance
      .setExpirationTime(now + 540) // 9 minutes (GitHub max is 10)
      .sign(key);
  }

  /**
   * Look up the GitHub App installation for a specific repo.
   * Returns the installation ID or null if the app is not installed.
   * Optionally accepts a pre-created JWT to avoid redundant RSA signing.
   */
  async getInstallationForRepo(owner: string, repo: string, jwt?: string): Promise<number | null> {
    validateOwnerRepo(owner, repo);
    const { response: res, errorBody } = await this.requestWithAppJwt(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/installation`,
      (token) => ({
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }),
      jwt,
    );

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      const body = errorBody ?? await res.text();
      console.error("Failed to look up GitHub App installation", { status: res.status, body, owner, repo });
      throw new Error(`GitHub API error (${res.status}): ${body}`);
    }

    const data = await res.json() as { id: number };
    return data.id;
  }

  /**
   * Get a short-lived installation access token scoped to a specific repo.
   * Combines installation lookup + token generation using a single JWT.
   */
  async getTokenForRepo(owner: string, repo: string): Promise<InstallationToken> {
    validateOwnerRepo(owner, repo);

    // Create JWT once and reuse for both API calls
    const jwt = await this.createAppJwt();

    const installationId = await this.getInstallationForRepo(owner, repo, jwt);

    if (installationId === null) {
      throw new GitHubAppNotInstalledError(owner, repo, this.appSlug);
    }

    const { response: res, errorBody } = await this.requestWithAppJwt(
      `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`,
      (token) => ({
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          repositories: [repo],
        }),
      }),
      jwt,
    );

    if (!res.ok) {
      const body = errorBody ?? await res.text();
      console.error("Failed to create installation access token", { status: res.status, body, installationId, owner, repo });
      throw new Error(`Failed to create installation access token (${res.status}): ${body}`);
    }

    const data = await res.json() as { token: string; expires_at: string };
    return {
      token: data.token,
      expiresAt: data.expires_at,
      installationId,
    };
  }

  private getNowSec(): number {
    return Math.floor(Date.now() / 1000) + this.clockOffsetSec;
  }

  private isClockSkewJwtError(status: number, body: string): boolean {
    if (status !== 401) return false;
    return /exp\).*too far in the future|expiration time.*too far in the future|iat\).*in the future|issued at.*in the future/i.test(body);
  }

  private adjustClockOffset(dateHeader: string | null): boolean {
    if (!dateHeader) return false;
    const serverMs = Date.parse(dateHeader);
    if (Number.isNaN(serverMs)) return false;
    const serverSec = Math.floor(serverMs / 1000);
    const localSec = Math.floor(Date.now() / 1000);
    this.clockOffsetSec = serverSec - localSec;
    console.warn("Adjusted GitHub App JWT clock offset from GitHub server time", { clockOffsetSec: this.clockOffsetSec });
    return true;
  }

  private async requestWithAppJwt(
    url: string,
    initForToken: (token: string) => RequestInit,
    initialToken?: string,
  ): Promise<{ response: Response; errorBody?: string }> {
    let token = initialToken ?? await this.createAppJwt();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(url, initForToken(token));
      if (response.status !== 401) {
        return { response };
      }

      const body = await response.text();
      const canRetry =
        attempt === 0 &&
        this.isClockSkewJwtError(response.status, body) &&
        this.adjustClockOffset(response.headers.get("date"));
      if (canRetry) {
        console.warn("Retrying GitHub App request after JWT clock offset adjustment", { url });
        token = await this.createAppJwt();
        continue;
      }
      return { response, errorBody: body };
    }

    // This line is unreachable — the loop always returns on attempt 1.
    throw new Error("Unreachable: requestWithAppJwt retry loop exhausted");
  }

  /**
   * Import the private key, handling both PKCS#1 (RSA PRIVATE KEY) and PKCS#8 (PRIVATE KEY) formats.
   * GitHub generates PKCS#1 keys by default.
   */
  private async importKey(): Promise<CryptoKey> {
    const pem = this.privateKey;

    if (pem.includes("-----BEGIN RSA PRIVATE KEY-----")) {
      // PKCS#1 format — convert to PKCS#8 via Node's crypto, then import
      const keyObject = createPrivateKey({ key: pem, format: "pem" });
      const pkcs8Pem = keyObject.export({ type: "pkcs8", format: "pem" }) as string;
      return importPKCS8(pkcs8Pem, "RS256");
    }

    // PKCS#8 format — import directly
    return importPKCS8(pem, "RS256");
  }

  /**
   * Decode PEM from raw or base64-encoded format.
   */
  private decodePem(input: string): string {
    const normalized = this.normalizePemString(input);
    if (normalized.includes("-----BEGIN")) {
      return normalized;
    }
    // Base64-encoded PEM
    return this.normalizePemString(Buffer.from(normalized, "base64").toString("utf-8"));
  }

  /**
   * Normalize common env formatting issues:
   * - surrounding quotes
   * - escaped newlines (\\n) from .env providers
   * - escaped carriage returns (\\r)
   */
  private normalizePemString(value: string): string {
    let out = value.trim();
    if (
      (out.startsWith('"') && out.endsWith('"')) ||
      (out.startsWith("'") && out.endsWith("'"))
    ) {
      out = out.slice(1, -1);
    }
    out = out.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    return out.trim();
  }

  private assertPrivateKeyReadable(): void {
    try {
      createPrivateKey({ key: this.privateKey, format: "pem" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid GitHub App private key format: ${reason}`);
    }
  }
}

export class GitHubAppNotInstalledError extends Error {
  public owner: string;
  public repo: string;

  constructor(owner: string, repo: string, appSlug = "opslane") {
    super(
      `GitHub App is not installed on ${owner}/${repo}. ` +
      `Please install the app at https://github.com/apps/${appSlug}/installations/new`,
    );
    this.name = "GitHubAppNotInstalledError";
    this.owner = owner;
    this.repo = repo;
  }
}
