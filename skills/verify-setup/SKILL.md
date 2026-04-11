---
name: verify-setup
description: One-time setup for /verify. Auto-detects dev server, imports browser cookies, and indexes the app.
---

# /verify-setup

Run once before using /verify on a new project.

## Prerequisites

- Dev server running locally (any framework)
- Logged into the app in Chrome/Arc/Brave (your real browser)
- Node.js 22+

## Steps

### 1. Run init

```bash
npx @opslane/verify init
```

This automatically:
1. Creates `.verify/` directory and updates `.gitignore`
2. Detects your dev server port from `package.json` and framework configs
3. Downloads the browse binary (first run only)
4. Opens a cookie picker — select cookies from your Chromium browser to import
5. Validates cookies authenticate you, exports to `.verify/auth.json`
6. Indexes your app's routes and selectors

### 2. Configure Playwright MCP

If not already installed:

```bash
claude mcp add playwright -- npx @playwright/mcp@latest --storage-state .verify/auth.json --isolated
```

Restart Claude Code after adding the MCP server.

**Note:** The `--storage-state` flag loads cookies exported by `init`. The `--isolated` flag ensures Playwright uses those cookies instead of its own profile.

### 3. Verify setup worked

```bash
cat .verify/config.json
cat .verify/app.json | head -20
```

You should see your `baseUrl` in config and routes in `app.json`.

### 4. Troubleshooting

**"Dev server not running"** — Start your dev server and re-run `npx @opslane/verify init`.

**"Cookie import failed"** — Open your app in Chrome, log in, then re-run init.

**Wrong port detected** — Override with: `npx @opslane/verify init --base-url http://localhost:YOUR_PORT`

**Playwright MCP not found** — Run `claude mcp add playwright -- npx @playwright/mcp@latest --storage-state .verify/auth.json --isolated` and restart Claude Code.

**Auth expired during /verify** — Re-run `npx @opslane/verify init` to re-import cookies from Chrome, then restart Claude Code.
