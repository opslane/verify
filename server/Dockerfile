FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production=false

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node_modules/.bin/tsx", "src/index.ts"]
