FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# --- System packages ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget gnupg2 ca-certificates lsb-release sudo git \
    build-essential python3 \
    # Postgres 16
    postgresql-common && \
    yes | /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh && \
    apt-get install -y --no-install-recommends postgresql-16 postgresql-client-16 && \
    # Redis
    apt-get install -y --no-install-recommends redis-server && \
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

# --- Postgres config: trust local connections ---
RUN echo "local all all trust" > /etc/postgresql/16/main/pg_hba.conf && \
    echo "host all all 127.0.0.1/32 trust" >> /etc/postgresql/16/main/pg_hba.conf && \
    echo "host all all ::1/128 trust" >> /etc/postgresql/16/main/pg_hba.conf

# --- Working directory ---
RUN mkdir -p /home/user && chmod 777 /home/user
WORKDIR /home/user

# --- Entrypoint ---
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
