import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

export const sql = postgres(DATABASE_URL);

export interface Org {
  id: string;
  github_org_login: string;
  name: string;
  created_at: Date;
}

export interface User {
  id: string;
  org_id: string;
  github_id: string;
  github_login: string;
  email: string | null;
  name: string | null;
  created_at: Date;
}

export async function upsertOrg(login: string, name: string): Promise<Org> {
  const [org] = await sql<Org[]>`
    INSERT INTO orgs (github_org_login, name)
    VALUES (${login}, ${name})
    ON CONFLICT (github_org_login)
    DO UPDATE SET name = EXCLUDED.name
    RETURNING *
  `;
  return org;
}

export async function upsertUser(params: {
  orgId: string;
  githubId: string;
  githubLogin: string;
  email: string | null;
  name: string | null;
}): Promise<User> {
  const [user] = await sql<User[]>`
    INSERT INTO users (org_id, github_id, github_login, email, name)
    VALUES (${params.orgId}, ${params.githubId}, ${params.githubLogin}, ${params.email}, ${params.name})
    ON CONFLICT (github_id)
    DO UPDATE SET
      github_login = EXCLUDED.github_login,
      email = EXCLUDED.email,
      name = EXCLUDED.name
    RETURNING *
  `;
  return user;
}

export async function upsertInstallation(params: {
  orgId: string | null;
  installationId: number;
  githubAccountLogin: string;
}): Promise<void> {
  await sql`
    INSERT INTO github_installations (org_id, installation_id, github_account_login)
    VALUES (${params.orgId}, ${params.installationId}, ${params.githubAccountLogin})
    ON CONFLICT (installation_id)
    DO UPDATE SET
      org_id = COALESCE(EXCLUDED.org_id, github_installations.org_id),
      github_account_login = EXCLUDED.github_account_login
  `;
}

export async function findUserByLogin(githubLogin: string): Promise<User | null> {
  const [user] = await sql<User[]>`
    SELECT * FROM users WHERE github_login = ${githubLogin}
  `;
  return user ?? null;
}
