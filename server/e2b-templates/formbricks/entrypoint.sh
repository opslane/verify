#!/bin/bash
set -e

# Start Postgres and wait for readiness
pg_ctlcluster 16 main start
until pg_isready -q; do sleep 0.2; done

# Create the formbricks database
su - postgres -c "createdb formbricks" 2>/dev/null || true

# Start Redis
redis-server --daemonize yes

# Push schema and seed test data
cd /home/user/repo
npx prisma db push --schema=packages/database/schema.prisma --accept-data-loss 2>&1 || true
ALLOW_SEED=true pnpm --filter @formbricks/database db:seed 2>&1 || true

# Keep container alive
sleep infinity
