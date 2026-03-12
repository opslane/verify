import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { runMigrations } from './migrate.js';

const TEST_DB = process.env.TEST_DATABASE_URL;

describe('db helpers (integration)', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!TEST_DB) throw new Error('TEST_DATABASE_URL not set');
    await runMigrations(TEST_DB);
    sql = postgres(TEST_DB);
    // Clean slate for this test run
    await sql`DELETE FROM github_installations`;
    await sql`DELETE FROM users`;
    await sql`DELETE FROM orgs`;
  });

  afterAll(async () => {
    await sql.end();
  });

  describe('upsertOrg', () => {
    it('inserts a new org', async () => {
      // Import after migrations have run
      const { upsertOrg } = await import('./db.js');
      const org = await upsertOrg('acme', 'Acme Corp');
      expect(org.id).toBeTruthy();
      expect(org.github_org_login).toBe('acme');
      expect(org.name).toBe('Acme Corp');
    });

    it('upserts — updates name on conflict', async () => {
      const { upsertOrg } = await import('./db.js');
      const org = await upsertOrg('acme', 'Acme Corp Updated');
      expect(org.github_org_login).toBe('acme');
      expect(org.name).toBe('Acme Corp Updated');

      const rows = await sql`SELECT COUNT(*) FROM orgs WHERE github_org_login = 'acme'`;
      expect(Number(rows[0].count)).toBe(1);
    });
  });

  describe('upsertUser', () => {
    it('inserts a new user linked to an org', async () => {
      const { upsertOrg, upsertUser } = await import('./db.js');
      const org = await upsertOrg('usertest-org', 'User Test Org');

      const user = await upsertUser({
        orgId: org.id,
        githubId: '99001',
        githubLogin: 'testuser',
        email: 'test@example.com',
        name: 'Test User',
      });

      expect(user.id).toBeTruthy();
      expect(user.github_id).toBe('99001');
      expect(user.github_login).toBe('testuser');
      expect(user.email).toBe('test@example.com');
      expect(user.org_id).toBe(org.id);
    });

    it('upserts — updates login/email on conflict (same github_id)', async () => {
      const { upsertOrg, upsertUser } = await import('./db.js');
      const org = await upsertOrg('usertest-org', 'User Test Org');

      const user = await upsertUser({
        orgId: org.id,
        githubId: '99001',
        githubLogin: 'testuser-renamed',
        email: 'new@example.com',
        name: 'Test User',
      });

      expect(user.github_login).toBe('testuser-renamed');
      expect(user.email).toBe('new@example.com');

      const rows = await sql`SELECT COUNT(*) FROM users WHERE github_id = '99001'`;
      expect(Number(rows[0].count)).toBe(1);
    });

    it('handles null email and name', async () => {
      const { upsertOrg, upsertUser } = await import('./db.js');
      const org = await upsertOrg('nulltest-org', 'Null Test Org');

      const user = await upsertUser({
        orgId: org.id,
        githubId: '99002',
        githubLogin: 'nulluser',
        email: null,
        name: null,
      });

      expect(user.email).toBeNull();
      expect(user.name).toBeNull();
    });
  });

  describe('upsertInstallation', () => {
    it('inserts installation linked to an org', async () => {
      const { upsertOrg, upsertInstallation } = await import('./db.js');
      const org = await upsertOrg('install-org', 'Install Org');

      await upsertInstallation({
        orgId: org.id,
        installationId: 55001,
        githubAccountLogin: 'install-org',
      });

      const rows = await sql`SELECT * FROM github_installations WHERE installation_id = 55001`;
      expect(rows[0].org_id).toBe(org.id);
      expect(rows[0].github_account_login).toBe('install-org');
    });

    it('inserts installation with null org_id (pre-auth install)', async () => {
      const { upsertInstallation } = await import('./db.js');

      await upsertInstallation({
        orgId: null,
        installationId: 55002,
        githubAccountLogin: 'unknown-org',
      });

      const rows = await sql`SELECT * FROM github_installations WHERE installation_id = 55002`;
      expect(rows[0].org_id).toBeNull();
    });

    it('upserts — updates org_id when same installation_id seen again', async () => {
      const { upsertOrg, upsertInstallation } = await import('./db.js');
      const org = await upsertOrg('late-org', 'Late Org');

      // First: no org
      await upsertInstallation({ orgId: null, installationId: 55003, githubAccountLogin: 'late-org' });
      // Then: org identified
      await upsertInstallation({ orgId: org.id, installationId: 55003, githubAccountLogin: 'late-org' });

      const rows = await sql`SELECT * FROM github_installations WHERE installation_id = 55003`;
      expect(rows[0].org_id).toBe(org.id);
      const count = await sql`SELECT COUNT(*) FROM github_installations WHERE installation_id = 55003`;
      expect(Number(count[0].count)).toBe(1);
    });
  });

  describe('findUserByLogin', () => {
    it('returns user by github_login', async () => {
      const { findUserByLogin } = await import('./db.js');
      const user = await findUserByLogin('testuser-renamed');
      expect(user).not.toBeNull();
      expect(user?.github_id).toBe('99001');
    });

    it('returns null for unknown login', async () => {
      const { findUserByLogin } = await import('./db.js');
      const user = await findUserByLogin('nobody-here');
      expect(user).toBeNull();
    });
  });
});
