---
name: verify-setup
description: One-time auth setup for /verify. Discovers login steps using seed credentials and saves a replayable recipe.
---

# /verify-setup

Run once before using /verify on any app that requires authentication.

## Steps

### 1. Add .verify/ to .gitignore

```bash
for pattern in ".verify/config.json" ".verify/evidence/" ".verify/prompts/" ".verify/report.json" ".verify/plan.json" ".verify/.spec_path" ".verify/browse.json" ".verify/report.html" ".verify/judge-prompt.txt" ".verify/progress.jsonl"; do
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
  "baseUrl": "http://localhost:3000"
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

### 5. Collect seed credentials

Ask the user:
- "What email and password can I use to log in? (These should be from your seed data)"

Save credentials to config:
```bash
jq --arg email "THEIR_EMAIL" --arg password "THEIR_PASSWORD" \
  '.auth = { email: $email, password: $password, loginSteps: [] }' \
  .verify/config.json > .verify/config.tmp && mv .verify/config.tmp .verify/config.json
```

### 6. Discover login steps

Run the login agent to figure out how to log in. This uses an LLM to navigate the login form once and record the steps.

```bash
BASE_URL=$(jq -r '.baseUrl' .verify/config.json)
EMAIL=$(jq -r '.auth.email' .verify/config.json)
PASSWORD=$(jq -r '.auth.password' .verify/config.json)
BROWSE_BIN="${BROWSE_BIN:-$(cat ~/.cache/verify/browse-path 2>/dev/null || echo ~/.cache/verify/browse)}"

cd "$(git rev-parse --show-toplevel)"

npx tsx ~/.claude/tools/verify/pipeline/src/cli.ts run-stage login-agent \
  --verify-dir .verify \
  --run-dir .verify/runs/setup-login \
  --base-url "$BASE_URL" \
  --email "$EMAIL" \
  --password "$PASSWORD" \
  --browse-bin "$BROWSE_BIN"
```

If the login agent succeeds, it outputs login steps. The CLI automatically saves them to config.json.

If it fails, show the error and ask the user to verify their credentials and dev server.

### 7. Verify login recipe by replay

Clear cookies and replay the saved steps mechanically to confirm they work:

```bash
BROWSE_BIN="${BROWSE_BIN:-$(cat ~/.cache/verify/browse-path 2>/dev/null || echo ~/.cache/verify/browse)}"

npx tsx ~/.claude/tools/verify/pipeline/src/cli.ts run-stage verify-login \
  --verify-dir .verify
```

If replay succeeds:
```
✓ Login recipe verified — /verify will authenticate automatically on every run.
```

If replay fails:
```
✗ Login replay failed. Check the credentials and try again, or re-run /verify-setup.
```

### 8. Index the application

After auth is confirmed, build the app index.

```bash
cd "$(git rev-parse --show-toplevel)"
npx tsx ~/.claude/tools/verify/pipeline/src/cli.ts index-app \
  --project-dir . \
  --output .verify/app.json
```

Show the summary:

```bash
echo "App index built:"
echo "  Routes: $(jq '.routes | length' .verify/app.json)"
echo "  Models: $(jq '.data_model | length' .verify/app.json)"
echo "  Seed IDs: $(jq '[.seed_ids[]] | flatten | length' .verify/app.json)"
echo "  DB URL env: $(jq -r '.db_url_env // "not found"' .verify/app.json)"
```

If the model count is 0, warn: "No Prisma schema found. Setup writer will have to discover column names from the codebase — this may cause SQL column name errors."
