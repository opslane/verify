import { describe, it, expect } from "vitest";
import { isAuthFailure } from "../src/lib/types.js";

describe("isAuthFailure", () => {
  it("detects 'Auth redirect' in observed text", () => {
    expect(isAuthFailure("Auth redirect — page shows login form")).toBe(true);
  });

  it("detects 'Auth failure' in observed text", () => {
    expect(isAuthFailure("Auth failure: 401 returned")).toBe(true);
  });

  it("detects login URL in observed text", () => {
    expect(isAuthFailure("Page redirected to /login")).toBe(true);
  });

  it("detects signin URL in observed text", () => {
    expect(isAuthFailure("Ended up at /signin page")).toBe(true);
  });

  it("detects 'session expired' in observed text", () => {
    expect(isAuthFailure("Session expired message shown")).toBe(true);
  });

  it("detects 'unauthorized' in observed text", () => {
    expect(isAuthFailure("Page says Unauthorized")).toBe(true);
  });

  it("detects 'please log in' in observed text", () => {
    expect(isAuthFailure("Text on page: Please log in to continue")).toBe(true);
  });

  it("detects 'sign in to continue' in observed text", () => {
    expect(isAuthFailure("Prompt says Sign in to continue")).toBe(true);
  });

  // Context-aware detection: acTargetUrl suppresses false positives
  it("suppresses auth detection when AC targets an auth URL", () => {
    expect(isAuthFailure("Some page loaded", "/auth/callback")).toBe(false);
  });

  it("suppresses auth detection when AC targets /login", () => {
    expect(isAuthFailure("Page loaded OK", "/login?next=/dashboard")).toBe(false);
  });

  it("returns false when AC targets /signin and observed mentions /signin", () => {
    expect(isAuthFailure("Auth redirect: navigated to /signin, was redirected to dashboard", "/signin")).toBe(false);
  });

  it("returns false when AC targets /signup", () => {
    expect(isAuthFailure("Page shows sign up form at /signup", "/signup")).toBe(false);
  });

  it("returns false when AC targets /forgot-password (contains /auth path)", () => {
    expect(isAuthFailure("Navigated to /auth/forgot-password", "/auth/forgot-password")).toBe(false);
  });

  it("returns true when AC targets /documents but observed says Auth redirect", () => {
    expect(isAuthFailure("Auth redirect: redirected to /signin", "/documents")).toBe(true);
  });

  it("returns true when AC targets /documents and observed mentions /signin", () => {
    expect(isAuthFailure("Ended up at /signin page", "/documents")).toBe(true);
  });

  it("does not match /authorize or /author when checking auth page patterns", () => {
    expect(isAuthFailure("Auth redirect: went to /authorize", "/authorize")).toBe(true);
  });

  it("returns false for normal observed text", () => {
    expect(isAuthFailure("Dashboard loaded with 5 items")).toBe(false);
  });

  it("returns false for normal URLs", () => {
    expect(isAuthFailure("Page loaded", "/dashboard/settings")).toBe(false);
  });

  it("is case-insensitive for observed text", () => {
    expect(isAuthFailure("AUTH REDIRECT detected")).toBe(true);
    expect(isAuthFailure("UNAUTHORIZED access")).toBe(true);
  });
});
