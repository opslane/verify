#!/bin/bash
set -e

# Start Docker daemon
dockerd > /var/log/dockerd.log 2>&1 &

# Wait for Docker to be ready (max 30s)
for i in $(seq 1 60); do
  docker info > /dev/null 2>&1 && break
  if [ "$i" -eq 60 ]; then
    echo "ERROR: Docker daemon failed to start within 30s" >&2
    cat /var/log/dockerd.log >&2
    exit 1
  fi
  sleep 0.5
done

# Allow non-root user to access Docker
chmod 666 /var/run/docker.sock

# Keep container alive
sleep infinity
