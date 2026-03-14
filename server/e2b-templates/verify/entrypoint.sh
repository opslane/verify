#!/bin/bash
set -e

# Start Docker daemon
dockerd > /var/log/dockerd.log 2>&1 &

# Wait for Docker to be ready
until docker info > /dev/null 2>&1; do sleep 0.5; done

# Allow non-root user to access Docker
chmod 666 /var/run/docker.sock

# Keep container alive
sleep infinity
