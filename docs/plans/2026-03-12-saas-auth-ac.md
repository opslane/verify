# SaaS Auth — Acceptance Criteria

**Base URL:** https://abhishekray07.ngrok.io

## AC1: Landing page has a working "Sign in with GitHub" button

Visit `/`. The page loads with a "Sign in with GitHub" button (or link). Clicking it redirects the browser to `github.com/login/oauth/authorize`.

## AC2: GitHub OAuth flow completes and sets a session cookie

Starting from `/auth/github`, complete the GitHub OAuth flow (authorize the app on GitHub). After being redirected back to the app:
- The browser URL is NOT on an error page
- A `session` cookie is set on the response (httpOnly — verify via response headers or DevTools)
- The browser is redirected to `github.com/apps/opslane-review/installations/new`

## AC3: Invalid or missing state returns an error, not a crash

Visit `/auth/callback?code=fakecode&state=wrongstate` directly (no prior oauth_state cookie). The response is a 400 error with a message like "Invalid OAuth state" — not a 500 or unhandled exception.

## AC4: GitHub App install page loads after sign-in

After completing the OAuth flow (AC2), the browser is redirected to the GitHub App install page at `github.com/apps/opslane-review/installations/new`. The page loads successfully (not a 404 or GitHub error page).
