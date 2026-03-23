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

  it("serves the shared harness assets", async () => {
    const started = await startBrowseDomHarnessServer({ port: 0 });
    server = started.server;

    const cssResponse = await fetch(`http://127.0.0.1:${started.port}/shared.css`);
    const jsResponse = await fetch(`http://127.0.0.1:${started.port}/shared.js`);

    expect(cssResponse.status).toBe(200);
    expect(cssResponse.headers.get("content-type")).toContain("text/css");
    expect(await cssResponse.text()).not.toBe("");

    expect(jsResponse.status).toBe(200);
    expect(jsResponse.headers.get("content-type")).toContain("text/javascript");
    expect(await jsResponse.text()).not.toBe("");
  });

  it("serves the trial tooltip page with only its trigger state initially", async () => {
    const started = await startBrowseDomHarnessServer({ port: 0 });
    server = started.server;

    const response = await fetch(`http://127.0.0.1:${started.port}/trial`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Trial");
    expect(html).toContain("trial-badge");
    expect(html).not.toContain("14 days left in your trial");
  });

  it("serves the event types dialog page with only its trigger state initially", async () => {
    const started = await startBrowseDomHarnessServer({ port: 0 });
    server = started.server;

    const response = await fetch(`http://127.0.0.1:${started.port}/event-types`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("More");
    expect(html).toContain("more-actions-button");
    expect(html).not.toContain("Duplicate event type");
  });

  it("returns 404 for unknown routes", async () => {
    const started = await startBrowseDomHarnessServer({ port: 0 });
    server = started.server;

    const response = await fetch(`http://127.0.0.1:${started.port}/does-not-exist`);

    expect(response.status).toBe(404);
  });
});
