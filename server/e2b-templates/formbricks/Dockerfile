FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# --- System packages ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget gnupg2 ca-certificates lsb-release sudo git \
    build-essential python3 cmake \
    # Postgres 16
    postgresql-common && \
    yes | /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh && \
    apt-get install -y --no-install-recommends postgresql-16 postgresql-client-16 postgresql-16-pgvector && \
    # Redis
    apt-get install -y --no-install-recommends redis-server && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# --- Node.js 22 ---
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# --- pnpm (match formbricks required version) ---
RUN npm install -g pnpm@10.32.1
ENV COREPACK_ENABLE_STRICT=0

# --- Playwright browser env (installed after pnpm install below) ---
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# --- Postgres config: trust local connections ---
RUN echo "local all all trust" > /etc/postgresql/16/main/pg_hba.conf && \
    echo "host all all 127.0.0.1/32 trust" >> /etc/postgresql/16/main/pg_hba.conf && \
    echo "host all all ::1/128 trust" >> /etc/postgresql/16/main/pg_hba.conf

# --- Working directory ---
RUN mkdir -p /home/user && chmod 777 /home/user
WORKDIR /home/user

# --- Clone formbricks and install deps ---
RUN git clone --depth=1 https://github.com/formbricks/formbricks.git /home/user/repo

# --- Default .env (Next.js needs env vars at build time) ---
COPY formbricks.env /home/user/repo/.env
COPY formbricks.env /home/user/repo/apps/web/.env

# --- Install deps + build (following upstream Dockerfile pattern) ---
# Skip TS type-checking during build — we only need a working production bundle
ENV NEXT_PRIVATE_SKIP_TYPECHECK=1
RUN cd /home/user/repo && \
    pnpm install --ignore-scripts && \
    npx prisma generate --schema=packages/database/schema.prisma && \
    pnpm build --filter=@formbricks/web...

# --- Copy static + public into standalone (Next.js standalone doesn't include them) ---
RUN cp -r /home/user/repo/apps/web/.next/static /home/user/repo/apps/web/.next/standalone/apps/web/.next/static && \
    cp -r /home/user/repo/apps/web/public /home/user/repo/apps/web/.next/standalone/apps/web/public && \
    cp /home/user/repo/.env /home/user/repo/apps/web/.next/standalone/apps/web/.env

# --- Playwright + Chromium (must be AFTER pnpm install which clears node_modules) ---
RUN npm install -g playwright@latest && npx playwright install --with-deps chromium

# --- Entrypoint ---
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
