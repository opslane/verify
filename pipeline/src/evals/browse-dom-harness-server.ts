import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(moduleDir, "..", "..", "evals", "browse-dom-harness", "public");
const routeAliases: Record<string, string> = {
  "/event-types": "dialog.html",
  "/keyboard": "keyboard.html",
  "/loading": "loading.html",
  "/login": "login.html",
  "/reports": "loading.html",
  "/settings": "keyboard.html",
  "/trial": "tooltip.html",
};

type StartBrowseDomHarnessServerOptions = {
  port?: number;
};

export type BrowseDomHarnessServerHandle = {
  server: Server;
  port: number;
};

function contentTypeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function send(res: ServerResponse, statusCode: number, body: string, headers?: Record<string, string>): void {
  res.writeHead(statusCode, {
    "Content-Length": Buffer.byteLength(body).toString(),
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

function sendRedirect(res: ServerResponse, location: string, statusCode = 302): void {
  res.writeHead(statusCode, {
    "Content-Length": "0",
    "Location": location,
  });
  res.end();
}

function resolveStaticFile(urlPath: string): string | null {
  const decodedPath = decodeURIComponent(urlPath);
  const aliasedFile = routeAliases[decodedPath];

  if (aliasedFile) {
    const aliasPath = resolve(publicDir, aliasedFile);

    return existsSync(aliasPath) ? aliasPath : null;
  }

  const relativePath = decodedPath === "/" ? "/index.html" : decodedPath.endsWith("/") ? `${decodedPath}index.html` : decodedPath;
  const resolvedPath = resolve(publicDir, `.${relativePath}`);
  const normalizedPublicDir = publicDir.endsWith(sep) ? publicDir : `${publicDir}${sep}`;

  if (resolvedPath !== publicDir && !resolvedPath.startsWith(normalizedPublicDir)) {
    return null;
  }

  return existsSync(resolvedPath) ? resolvedPath : null;
}

function renderLoginHtml(filePath: string, nextTarget: string): string {
  const html = readFileSync(filePath, "utf-8");
  const renderedNextTarget = escapeHtml(nextTarget || "/");
  return html.replaceAll("__NEXT_TARGET__", renderedNextTarget);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method?.toUpperCase() ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const nextTarget = url.searchParams.get("next") ?? "";

  if (method !== "GET" && method !== "HEAD") {
    send(res, 404, "not found");
    return;
  }

  if (url.pathname === "/healthz") {
    send(res, 200, method === "HEAD" ? "" : "ok");
    return;
  }

  if (url.pathname === "/billing") {
    sendRedirect(res, `/login.html?next=${encodeURIComponent("/billing")}`);
    return;
  }

  const filePath = resolveStaticFile(url.pathname);

  if (!filePath) {
    send(res, 404, "not found");
    return;
  }

  const body =
    filePath.endsWith(`${sep}login.html`)
      ? Buffer.from(renderLoginHtml(filePath, nextTarget))
      : readFileSync(filePath);
  res.writeHead(200, {
    "Content-Length": body.length.toString(),
    "Content-Type": contentTypeFor(filePath),
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

export async function startBrowseDomHarnessServer(options: StartBrowseDomHarnessServerOptions = {}): Promise<BrowseDomHarnessServerHandle> {
  const server = createServer(handleRequest);
  const port = options.port ?? 0;

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("browse dom harness server did not bind to a TCP port");
  }

  return { server, port: address.port };
}

export async function stopBrowseDomHarnessServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((err) => {
      if (err) {
        rejectPromise(err);
        return;
      }
      resolvePromise();
    });
  });
}
