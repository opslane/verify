# --- Build stage ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src/ ./src/
RUN npm run build

# --- Runtime stage ---
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY server/src/public ./dist/public
COPY server/db/migrations ./db/migrations
USER app
EXPOSE 3000
CMD ["node", "dist/index.js"]
