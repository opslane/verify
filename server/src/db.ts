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

export interface RepoConfig {
  id: string;
  installation_id: number | null;
  owner: string;
  repo: string;
  dev_command: string;
  port: number;
  install_command: string | null;
  health_path: string;
  test_email: string | null;
  test_password: string | null;
  env_vars: Record<string, string> | null;
  compose_file: string | null;
  schema_command: string | null;
  seed_command: string | null;
  login_script: string | null;
  sandbox_template: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function upsertRepoConfig(params: {
  installationId: number | null;
  owner: string;
  repo: string;
  devCommand: string;
  port: number;
  installCommand?: string | null;
  healthPath?: string;
  testEmail?: string | null;
  testPassword?: string | null;
  envVars?: Record<string, string> | null;
  composeFile?: string | null;
  schemaCommand?: string | null;
  seedCommand?: string | null;
  loginScript?: string | null;
  sandboxTemplate?: string | null;
}): Promise<RepoConfig> {
  const rows = await sql<RepoConfig[]>`
    INSERT INTO repo_configs (
      installation_id, owner, repo, dev_command, port,
      install_command, health_path,
      test_email, test_password, env_vars,
      compose_file, schema_command, seed_command,
      login_script, sandbox_template
    ) VALUES (
      ${params.installationId}, ${params.owner}, ${params.repo},
      ${params.devCommand}, ${params.port},
      ${params.installCommand ?? null},
      ${params.healthPath ?? '/'},
      ${params.testEmail ?? null}, ${params.testPassword ?? null},
      ${params.envVars ? sql.json(params.envVars) : null},
      ${params.composeFile ?? null}, ${params.schemaCommand ?? null},
      ${params.seedCommand ?? null}, ${params.loginScript ?? null},
      ${params.sandboxTemplate ?? null}
    )
    ON CONFLICT (owner, repo) DO UPDATE SET
      installation_id = EXCLUDED.installation_id,
      dev_command = EXCLUDED.dev_command,
      port = EXCLUDED.port,
      install_command = EXCLUDED.install_command,
      health_path = EXCLUDED.health_path,
      test_email = EXCLUDED.test_email,
      test_password = EXCLUDED.test_password,
      env_vars = EXCLUDED.env_vars,
      compose_file = EXCLUDED.compose_file,
      schema_command = EXCLUDED.schema_command,
      seed_command = EXCLUDED.seed_command,
      login_script = EXCLUDED.login_script,
      sandbox_template = EXCLUDED.sandbox_template,
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

export async function findRepoConfig(owner: string, repo: string): Promise<RepoConfig | null> {
  const rows = await sql<RepoConfig[]>`
    SELECT * FROM repo_configs WHERE owner = ${owner} AND repo = ${repo}
  `;
  return rows[0] ?? null;
}
