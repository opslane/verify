import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { runMigrations } from './migrate.js';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

const port = Number(process.env.PORT ?? 3000);

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL) {
  await runMigrations(DATABASE_URL);
}

serve({ fetch: app.fetch, port }, () => {
  console.log(`Server running on port ${port}`);
});

export { app };
