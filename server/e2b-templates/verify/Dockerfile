FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# --- System packages ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget gnupg2 ca-certificates lsb-release sudo git \
    build-essential python3 unzip \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# --- PostgreSQL client only (for schema commands — no server) ---
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-common && \
    yes | /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh && \
    apt-get install -y --no-install-recommends postgresql-client-16 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# --- Docker CE + Compose plugin ---
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && \
    chmod a+r /etc/apt/keyrings/docker.asc && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
    https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
    docker-ce docker-ce-cli containerd.io docker-compose-plugin && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# --- Node.js 22 ---
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# --- Package managers ---
RUN npm install -g pnpm@9 yarn@1.22 && \
    curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# --- Playwright + Chromium ---
RUN npx playwright@latest install --with-deps chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# --- Working directory ---
RUN mkdir -p /home/user && chmod 777 /home/user
WORKDIR /home/user

# --- Entrypoint ---
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
