import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import {
  startBrowseDomHarnessServer,
  stopBrowseDomHarnessServer,
} from "../src/evals/browse-dom-harness-server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "evals", "browse-dom-harness", "public");

describe("browse dom harness server", () => {
  let server: Server | undefined;
  let staticFileName: string | undefined;

  beforeEach(() => {
    mkdirSync(publicDir, { recursive: true });
  });

  afterEach(async () => {
    if (server) {
      await stopBrowseDomHarnessServer(server);
    }

    if (staticFileName) {
      rmSync(join(publicDir, staticFileName), { force: true });
      staticFileName = undefined;
    }

    server = undefined;
  });

  it("starts on port 0 and returns the bound port", async () => {
    const started = await startBrowseDomHarnessServer({ port: 0 });
    server = started.server;

    expect(started.port).toBeGreaterThan(0);
  });

  it("serves /healthz", async () => {
    const started = await startBrowseDomHarnessServer({ port: 0 });
    server = started.server;

    const response = await fetch(`http://127.0.0.1:${started.port}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("serves static files from the harness public directory", async () => {
    staticFileName = `test-${Date.now()}.txt`;
    writeFileSync(join(publicDir, staticFileName), "browse harness static file");

    const started = await startBrowseDomHarnessServer({ port: 0 });
    server = started.server;

    const response = await fetch(`http://127.0.0.1:${started.port}/${staticFileName}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("browse harness static file");
  });

  it("returns 404 for unknown routes", async () => {
    const started = await startBrowseDomHarnessServer({ port: 0 });
    server = started.server;

    const response = await fetch(`http://127.0.0.1:${started.port}/does-not-exist`);

    expect(response.status).toBe(404);
  });
});
