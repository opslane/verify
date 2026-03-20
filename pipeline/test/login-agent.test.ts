import { describe, it, expect } from "vitest";
import { buildLoginAgentPrompt, parseLoginAgentOutput } from "../src/stages/login-agent.js";

describe("login-agent", () => {
  describe("buildLoginAgentPrompt", () => {
    it("substitutes all template variables", () => {
      const prompt = buildLoginAgentPrompt({
        baseUrl: "http://localhost:3000",
        email: "test@example.com",
        password: "secret123",
        browseBin: "/usr/local/bin/browse",
      });
      expect(prompt).toContain("test@example.com");
      expect(prompt).toContain("secret123");
      expect(prompt).toContain("http://localhost:3000");
      expect(prompt).toContain("/usr/local/bin/browse");
      // Template vars should be replaced
      expect(prompt).not.toContain("__EMAIL__");
      expect(prompt).not.toContain("__PASSWORD__");
      expect(prompt).not.toContain("__BASE_URL__");
      expect(prompt).not.toContain("__BROWSE_BIN__");
      // But {{email}}/{{password}} output tokens must remain as literals
      expect(prompt).toContain("{{email}}");
      expect(prompt).toContain("{{password}}");
    });
  });

  describe("parseLoginAgentOutput", () => {
    it("parses successful login result", () => {
      const raw = JSON.stringify({
        success: true,
        loginSteps: [
          { action: "goto", url: "/login" },
          { action: "fill", selector: "[name='email']", value: "{{email}}" },
          { action: "fill", selector: "[name='password']", value: "{{password}}" },
          { action: "click", selector: "button:has-text('Log in')" },
        ],
      });
      const result = parseLoginAgentOutput(raw);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      if (result!.success) {
        expect(result!.loginSteps).toHaveLength(4);
      }
    });

    it("parses failure result", () => {
      const raw = JSON.stringify({
        success: false,
        error: "Could not find login form",
        page_snapshot: "@e1 [heading] 404",
      });
      const result = parseLoginAgentOutput(raw);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      if (!result!.success) {
        expect(result!.error).toContain("login form");
      }
    });

    it("returns null for unparseable output", () => {
      expect(parseLoginAgentOutput("not json")).toBeNull();
      expect(parseLoginAgentOutput("{}")).toBeNull();
    });

    it("rejects steps containing @eN refs", () => {
      const raw = JSON.stringify({
        success: true,
        loginSteps: [
          { action: "goto", url: "/login" },
          { action: "click", selector: "@e5" },
        ],
      });
      const result = parseLoginAgentOutput(raw);
      expect(result).toBeNull();
    });

    it("rejects steps with empty selectors", () => {
      const raw = JSON.stringify({
        success: true,
        loginSteps: [
          { action: "fill", selector: "", value: "{{email}}" },
        ],
      });
      const result = parseLoginAgentOutput(raw);
      expect(result).toBeNull();
    });

    it("requires at least one fill and one goto step", () => {
      const raw = JSON.stringify({
        success: true,
        loginSteps: [
          { action: "click", selector: "button" },
        ],
      });
      const result = parseLoginAgentOutput(raw);
      expect(result).toBeNull();
    });

    it("rejects unknown action types", () => {
      const raw = JSON.stringify({
        success: true,
        loginSteps: [
          { action: "goto", url: "/login" },
          { action: "fill", selector: "#email", value: "{{email}}" },
          { action: "hover", selector: "#btn" },
        ],
      });
      const result = parseLoginAgentOutput(raw);
      expect(result).toBeNull();
    });
  });
});
