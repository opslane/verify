import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.get('/', async (c) => {
  const html = await readFile(join(__dirname, 'public', 'index.html'), 'utf8');
  return c.html(html);
});

const port = Number(process.env.PORT ?? 3000);

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL) {
  await runMigrations(DATABASE_URL);
}

serve({ fetch: app.fetch, port }, () => {
  console.log(`Server running on port ${port}`);
});

export { app };
