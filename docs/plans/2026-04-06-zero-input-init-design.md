# Zero-Input Init

**Goal:** `npx @opslane/verify init` sets up everything a new user needs with no flags, no prompts, no credentials.

## Current state

`init` requires `--email`, `--password`, `--login-steps`, and optionally `--base-url`. The setup skill (`/verify-setup`) is 8 interactive steps. A new user must: provide credentials, discover CSS selectors for login forms, build a login recipe, verify it replays correctly, then index the app with 4 LLM agents + Prisma parsing + seed extraction + entity graphs.

## v1 design

```
npx @opslane/verify init

1. Scaffold         Create .verify/, update .gitignore         (deterministic)
2. Detect base URL  LLM agent reads project files → curl       (1 agent, ~10s)
3. Import cookies   browse cookie-import-browser → localhost    (deterministic)
4. Index app        LLM agents extract routes + selectors       (2 agents, ~30s)
→ ready to run /verify
```

### Step 1: Scaffold

Create `.verify/` directory. Append gitignore patterns if missing:

```
.verify/config.json
.verify/evidence/
.verify/prompts/
.verify/report.json
.verify/browse.json
.verify/report.html
.verify/progress.jsonl
```

No user input. Same as today.

### Step 2: Detect base URL

A single LLM agent (haiku, fast) reads project files to find the dev server port:

- `package.json` scripts (`"dev": "next dev -p 3000"`, `"start": "vite"`)
- Framework configs (`next.config.js`, `vite.config.ts`, `nuxt.config.ts`, `angular.json`)
- `.env` / `.env.local` (`PORT=3001`)
- `docker-compose.yml` port mappings

The agent returns a `{ port, source }` object. CLI then verifies with a curl to `http://localhost:{port}`.

**If server is not running:** print "Detected port {port} from {source} but nothing is running there. Start your dev server and re-run `npx @opslane/verify init`." and exit.

**If no port detected:** fall back to `http://localhost:3000` and attempt curl. If that fails too, ask the user for the URL (single prompt — only escape hatch in the flow).

Write `baseUrl` to `.verify/config.json`.

### Step 3: Import cookies

Use gstack's browse binary (already a dependency):

```
browse cookie-import-browser [browser] --domain localhost
```

Behavior:
- Auto-detect the default Chromium browser (Chrome → Arc → Brave → Edge).
- Import cookies scoped to the `localhost` domain only.
- macOS Keychain will prompt for permission natively — this is the only user interaction, and it's OS-level, not ours.
- Cookies are loaded into the browse daemon's persistent session.

**If no localhost cookies found:** print "No session cookies found for {baseUrl}. Log into your app in Chrome and re-run `npx @opslane/verify init`." and exit.

### Step 4: Index routes + selectors

Two LLM agents run in parallel (same as today's `index-app`, but trimmed):

1. **index-routes** — discovers all routes/pages from the codebase (file-based routing, router configs, etc.)
2. **index-selectors** — discovers key UI selectors per page (forms, buttons, navigation elements)

Output merged into `.verify/app.json` with just:

```json
{
  "indexed_at": "...",
  "routes": { ... },
  "pages": { ... }
}
```

**Removed from v1 index:**
- Schema / data model (Prisma parsing, DB schema dump)
- Fixtures
- Seed IDs
- Entity graphs
- JSONB annotations
- Example URL resolution
- `db_url_env`, `feature_flags`

These can be added back later as opt-in (`npx @opslane/verify index --full`) if needed.

## What changes in the codebase

### Removed
- `--email`, `--password`, `--login-steps` flags from `init` command
- Login recipe discovery + replay verification (`init.ts` login flow)
- `auth` field in `VerifyConfig` (replaced by cookie-based auth)
- `/verify-setup` skill's credential and login steps (steps 5-7)

### Added
- Base URL detection agent (new prompt in `pipeline/src/prompts/`)
- `browse cookie-import-browser` integration in init flow
- Cookie verification step (confirm cookies were imported for the target domain)

### Modified
- `init` command in `cli.ts` — new 4-step flow
- `index-app` command — only run routes + selectors agents
- `VerifyConfig` type — drop `auth`, keep `baseUrl`
- Executor stage — use cookie-based session instead of login replay before each run
- `/verify-setup` skill — simplified to match new init

## How the executor uses cookies

Today the executor runs `loginWithCredentials()` before each verification run, replaying the saved login steps. With cookies:

1. `init` imports cookies into a `browse.json` state file in `.verify/`.
2. On each `verify run`, the executor starts the browse daemon with that state file — session is already authenticated.
3. If cookies expire between runs, the executor detects auth failure (existing `isAuthFailure()` logic) and tells the user to re-run `init`.

## Decisions

1. **Cookie freshness** — No proactive staleness check. Let the executor catch auth failures at runtime via existing `isAuthFailure()` logic and tell the user to re-run `init`.
2. **Non-Chromium browsers** — Chromium-only for v1 (Chrome, Arc, Brave, Edge). Firefox/Safari deferred.
3. **CI environments** — Local-only for v1. CI auth (service accounts, API tokens) is a separate problem.
