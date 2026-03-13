#!/bin/bash
set -e

# Start Postgres and wait for readiness
pg_ctlcluster 16 main start
until pg_isready -q; do sleep 0.2; done
su - postgres -c "createdb app" 2>/dev/null || true

# Start Redis
redis-server --daemonize yes

# Keep container alive
sleep infinity
