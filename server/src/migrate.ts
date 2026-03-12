import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');

export async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl);
  try {
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const content = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await sql.unsafe(content);
      console.log(`Migration applied: ${file}`);
    }
  } finally {
    await sql.end();
  }
}
