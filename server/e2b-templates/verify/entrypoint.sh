#!/bin/bash
set -e

# Start Postgres
pg_ctlcluster 16 main start
su - postgres -c "createdb app" 2>/dev/null || true

# Start Redis
redis-server --daemonize yes

# Keep container alive
sleep infinity
