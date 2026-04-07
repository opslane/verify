import { describe, it, expect } from "vitest";
import { detectPort } from "../src/lib/detect-port.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTempProject(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "detect-port-"));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

describe("detectPort", () => {
  it("extracts port from next dev -p flag", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ scripts: { dev: "next dev -p 3001" } }),
    });
    expect(detectPort(dir)).toEqual({ port: 3001, source: "package.json scripts.dev" });
  });

  it("extracts port from --port flag", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ scripts: { dev: "vite --port 5173" } }),
    });
    expect(detectPort(dir)).toEqual({ port: 5173, source: "package.json scripts.dev" });
  });

  it("extracts port from --port= flag", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ scripts: { dev: "vite --port=4200" } }),
    });
    expect(detectPort(dir)).toEqual({ port: 4200, source: "package.json scripts.dev" });
  });

  it("reads PORT from .env", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ scripts: { dev: "node server.js" } }),
      ".env": "PORT=4000\nDATABASE_URL=postgres://...",
    });
    expect(detectPort(dir)).toEqual({ port: 4000, source: ".env" });
  });

  it("reads PORT from .env.local over .env", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ scripts: { dev: "node server.js" } }),
      ".env.local": "PORT=4001",
    });
    expect(detectPort(dir)).toEqual({ port: 4001, source: ".env.local" });
  });

  it("reads port from vite.config.ts", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
      "vite.config.ts": `export default { server: { port: 5174 } }`,
    });
    expect(detectPort(dir)).toEqual({ port: 5174, source: "vite.config.ts" });
  });

  it("returns null when no port found", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ scripts: { dev: "node server.js" } }),
    });
    expect(detectPort(dir)).toBeNull();
  });

  it("prefers dev script over start script", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({
        scripts: { dev: "next dev -p 3001", start: "next start -p 3000" },
      }),
    });
    expect(detectPort(dir)).toEqual({ port: 3001, source: "package.json scripts.dev" });
  });

  it("falls back to start script if dev has no port", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({
        scripts: { dev: "node server.js", start: "next start -p 3000" },
      }),
    });
    expect(detectPort(dir)).toEqual({ port: 3000, source: "package.json scripts.start" });
  });

  it("prefers package.json over .env", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({ scripts: { dev: "next dev -p 3001" } }),
      ".env": "PORT=4000",
    });
    expect(detectPort(dir)).toEqual({ port: 3001, source: "package.json scripts.dev" });
  });
});
