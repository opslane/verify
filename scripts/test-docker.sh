#!/bin/bash
set -euo pipefail

WORKTREE="/Users/abhishekray/Projects/opslane/verify/.worktrees/saas-auth"
IMAGE="verify-server-test"
CONTAINER="verify-server-test-run"

echo "=== Dockerfile test ==="

# Build
echo "→ Building image..."
docker build -t "$IMAGE" "$WORKTREE/server"
echo "✓ Build succeeded"

# Run with health check env vars (no real DB needed for health endpoint)
echo "→ Starting container..."
docker run -d --name "$CONTAINER" \
  -p 3001:3000 \
  -e PORT=3000 \
  -e NODE_ENV=production \
  -e DATABASE_URL=postgres://abhishekray@host.docker.internal:5432/verify_dev \
  -e JWT_SECRET=test-secret-for-docker-smoke-test-only \
  -e GITHUB_OAUTH_CLIENT_ID=test \
  -e GITHUB_OAUTH_CLIENT_SECRET=test \
  -e GITHUB_APP_SLUG=test \
  -e GITHUB_WEBHOOK_SECRET=test \
  "$IMAGE" 2>/dev/null

# Wait for server to be ready
echo "→ Waiting for server..."
for i in $(seq 1 15); do
  if curl -sf http://localhost:3001/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Health check
echo "→ Testing /health..."
RESPONSE=$(curl -sf http://localhost:3001/health)
if echo "$RESPONSE" | grep -q '"ok":true'; then
  echo "✓ /health returned: $RESPONSE"
else
  echo "✗ /health unexpected response: $RESPONSE"
  docker logs "$CONTAINER"
  docker rm -f "$CONTAINER" 2>/dev/null
  exit 1
fi

# Landing page
echo "→ Testing / (landing page)..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/)
if [ "$HTTP_CODE" = "200" ]; then
  echo "✓ / returned HTTP 200"
else
  echo "✗ / returned HTTP $HTTP_CODE (expected 200)"
  docker logs "$CONTAINER"
  docker rm -f "$CONTAINER" 2>/dev/null
  exit 1
fi

# Cleanup
docker rm -f "$CONTAINER" 2>/dev/null
echo ""
echo "=== All Dockerfile tests passed ==="
