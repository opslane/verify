import postgres from 'postgres';
import { decrypt } from '../src/crypto.js';

const sql = postgres(process.env.DATABASE_URL!);
const [config] = await sql`SELECT env_vars FROM repo_configs WHERE owner = 'abhishekray07' AND repo = 'formbricks'`;
const vars = config.env_vars as Record<string, string>;
console.log('Env var keys:', Object.keys(vars));
if (vars.NEXTAUTH_SECRET) {
  console.log('NEXTAUTH_SECRET:', decrypt(vars.NEXTAUTH_SECRET).slice(0, 20) + '...');
}
await sql.end();
