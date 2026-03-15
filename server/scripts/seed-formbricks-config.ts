/**
 * One-off: seed repo config for abhishekray07/formbricks.
 * Run: cd server && node --env-file=.env --import tsx/esm src/verify/seed-formbricks-config.ts
 */
import { randomBytes } from 'node:crypto';
import { upsertRepoConfig, sql } from '../src/db.js';
import { encrypt } from '../src/crypto.js';

const secret = () => randomBytes(32).toString('hex');

async function main() {
  const config = await upsertRepoConfig({
    installationId: null,
    owner: 'abhishekray07',
    repo: 'formbricks',
    devCommand: 'pnpm turbo build --filter=@formbricks/web^... && pnpm --filter @formbricks/web dev',
    port: 3000,
    installCommand: 'pnpm install',
    healthPath: '/auth/login',
    testEmail: encrypt('admin@formbricks.com'),
    testPassword: encrypt('Password#123'),
    envVars: {
      WEBAPP_URL: encrypt('http://localhost:3000'),
      NEXTAUTH_URL: encrypt('http://localhost:3000'),
      DATABASE_URL: encrypt('postgresql://postgres:postgres@localhost:5432/formbricks?schema=public'),
      NEXTAUTH_SECRET: encrypt(secret()),
      ENCRYPTION_KEY: encrypt(secret()),
      CRON_SECRET: encrypt(secret()),
      REDIS_URL: encrypt('redis://localhost:6379'),
      EMAIL_VERIFICATION_DISABLED: encrypt('1'),
      PASSWORD_RESET_DISABLED: encrypt('1'),
      MAIL_FROM: encrypt('noreply@example.com'),
      SMTP_HOST: encrypt('localhost'),
      SMTP_PORT: encrypt('1025'),
      SMTP_SECURE_ENABLED: encrypt('0'),
    },
    composeFile: 'docker-compose.dev.yml',
    schemaCommand: 'npx prisma db push --schema=packages/database/schema.prisma --accept-data-loss',
    seedCommand: 'pnpm --filter @formbricks/logger build && ALLOW_SEED=true pnpm --filter @formbricks/database db:seed',
    loginScript: [
      "await page.getByRole('button', { name: 'Login with Email' }).click();",
      "await page.getByPlaceholder('work@email.com').fill(EMAIL);",
      "await page.getByPlaceholder('*******').fill(PASSWORD);",
      "await page.getByRole('button', { name: 'Login with Email' }).nth(1).click();",
    ].join('\n'),
    sandboxTemplate: null,
  });

  console.log(`Repo config seeded: ${config.owner}/${config.repo} (id: ${config.id})`);
  await sql.end();
}

main().catch(async (err) => {
  console.error('Failed to seed:', err.message);
  await sql.end();
  process.exit(1);
});
