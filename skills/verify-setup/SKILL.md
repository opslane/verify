---
name: verify-setup
description: One-time auth setup for /verify. Captures Playwright session state to .verify/auth.json.
---

# /verify-setup

Run once before using /verify on any app that requires authentication.

## Steps

### 1. Add .verify/ to .gitignore

```bash
for pattern in ".verify/auth.json" ".verify/evidence/" ".verify/prompts/" ".verify/report.json" ".verify/plan.json" ".verify/.spec_path" ".verify/chrome-profile/"; do
  grep -qF "$pattern" .gitignore 2>/dev/null || echo "$pattern" >> .gitignore
done
echo "✓ .gitignore updated"
```

### 2. Create .verify/config.json if missing

```bash
mkdir -p .verify
if [ ! -f .verify/config.json ]; then
  cat > .verify/config.json << 'CONFIG'
{
  "baseUrl": "http://localhost:3000",
  "authCheckUrl": "/api/me",
  "specPath": null
}
CONFIG
fi
```

Ask the user:
- "What is your dev server URL? (default: http://localhost:3000)"
- "What URL returns 200 when authenticated? (default: /api/me)"

Update .verify/config.json with their answers using:
```bash
jq --arg url "THEIR_URL" --arg check "THEIR_CHECK" \
  '.baseUrl = $url | .authCheckUrl = $check' \
  .verify/config.json > .verify/config.tmp && mv .verify/config.tmp .verify/config.json
```

### 3. Check dev server is running

```bash
BASE_URL=$(jq -r '.baseUrl' .verify/config.json)
curl -sf "$BASE_URL" > /dev/null 2>&1 || echo "⚠ Dev server not running at $BASE_URL. Start it before logging in."
```

### 4. Capture auth via Playwright codegen

`playwright codegen` opens a headed browser, lets the user log in, and saves auth state on exit.

```bash
BASE_URL=$(jq -r '.baseUrl' .verify/config.json)
mkdir -p .verify
echo "A browser will open. Log in, then close the browser window."
npx playwright codegen --save-storage=.verify/auth.json "$BASE_URL"
```

### 5. Set permissions

```bash
chmod 600 .verify/auth.json
echo "✓ Auth saved to .verify/auth.json (chmod 600)"
```

### 6. Verify auth was captured

```bash
if [ -f .verify/auth.json ] && [ -s .verify/auth.json ]; then
  COOKIE_COUNT=$(jq '.cookies | length' .verify/auth.json 2>/dev/null || echo 0)
  echo "✓ Auth state captured: $COOKIE_COUNT cookies"
else
  echo "✗ auth.json is empty. Log in when the browser opens, then close it."
  exit 1
fi
```

### 7. Done

Tell the user:
```
✓ Setup complete. Run /verify before your next PR.
```
