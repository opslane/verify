---
name: verify-setup
description: One-time auth setup for /verify. Imports cookies from your real browser via gstack browse.
---

# /verify-setup

Run once before using /verify on any app that requires authentication.

## Steps

### 1. Add .verify/ to .gitignore

```bash
for pattern in ".verify/evidence/" ".verify/prompts/" ".verify/report.json" ".verify/plan.json" ".verify/.spec_path" ".verify/browse.json" ".verify/report.html" ".verify/judge-prompt.txt" ".verify/progress.jsonl"; do
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
  "specPath": null
}
CONFIG
fi
```

Ask the user:
- "What is your dev server URL? (default: http://localhost:3000)"

Update .verify/config.json with their answer:
```bash
jq --arg url "THEIR_URL" '.baseUrl = $url' \
  .verify/config.json > .verify/config.tmp && mv .verify/config.tmp .verify/config.json
```

### 3. Install browse binary

```bash
BROWSE_BIN=$(bash ~/.claude/tools/verify/install-browse.sh | tail -1)
echo "✓ Browse binary: $BROWSE_BIN"
```

### 4. Check dev server is running

```bash
BASE_URL=$(jq -r '.baseUrl' .verify/config.json)
curl -sf "$BASE_URL" > /dev/null 2>&1 || echo "⚠ Dev server not running at $BASE_URL. Start it before continuing."
```

### 5. Import cookies from browser

Ask the user:
- "Which browser are you logged into your app with? (Chrome / Arc / Edge / Brave / Comet)"
- "What domain should I import cookies for? (e.g. localhost)"

Then import:
```bash
$BROWSE_BIN cookie-import-browser BROWSER --domain DOMAIN
```

First time: a macOS Keychain dialog will appear. The user must click "Allow" or "Always Allow".

### 6. Verify auth was captured

```bash
BASE_URL=$(jq -r '.baseUrl' .verify/config.json)
$BROWSE_BIN goto "$BASE_URL"
$BROWSE_BIN snapshot -i
```

Show the snapshot output to the user and ask: "Does this look like your app's authenticated page? (y/n)"

If yes:
```
✓ Setup complete. Run /verify before your next push.
```

If no:
```
Auth may not have imported correctly. Make sure you're logged into DOMAIN in BROWSER, then try again.
```

### 7. Legacy MCP setup (fallback)

If cookie import fails or the user prefers the old approach:

```bash
BASE_URL=$(jq -r '.baseUrl' .verify/config.json)
echo "Falling back to Playwright codegen. A browser will open — log in, then close it."
npx playwright codegen --save-storage=.verify/auth.json "$BASE_URL"
chmod 600 .verify/auth.json
echo "✓ Auth saved. Use VERIFY_ENGINE=mcp when running /verify."
```
