import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './migrate.js';
import { authRouter } from './routes/auth.js';
import { webhookRoutes } from './routes/webhooks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cache landing page HTML at startup — avoid disk read per request
const landingHtml = await readFile(join(__dirname, 'public', 'index.html'), 'utf8');

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.get('/', (c) => c.html(landingHtml));

app.route('/auth', authRouter);
app.route('/webhooks', webhookRoutes);

const port = Number(process.env.PORT ?? 3000);
if (Number.isNaN(port)) throw new Error(`Invalid PORT: ${process.env.PORT}`);

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL) {
  await runMigrations(DATABASE_URL);
}

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`Server running on port ${port}`);
});

// Graceful shutdown — close server and DB pool on SIGTERM/SIGINT
async function shutdown() {
  server.close();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app };
