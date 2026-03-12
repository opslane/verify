import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sign } from 'hono/jwt';
import { randomBytes } from 'node:crypto';
import { upsertOrg, upsertUser } from '../db.js';

export const authRouter = new Hono();

function env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

authRouter.get('/github', (c) => {
  const state = randomBytes(32).toString('hex');

  setCookie(c, 'oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: 60 * 10, // 10 minutes
    path: '/',
  });

  const params = new URLSearchParams({
    client_id: env('GITHUB_OAUTH_CLIENT_ID'),
    scope: 'read:user user:email',
    state,
  });

  return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

authRouter.get('/callback', async (c) => {
  const code = c.req.query('code');
  const stateParam = c.req.query('state');
  const stateCookie = getCookie(c, 'oauth_state');

  if (!stateParam || !stateCookie || stateParam !== stateCookie) {
    return c.text('Invalid state', 400);
  }

  deleteCookie(c, 'oauth_state', { path: '/' });

  // User denied OAuth or code is missing
  if (!code) {
    return c.redirect('/?error=cancelled');
  }

  // Exchange code for access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env('GITHUB_OAUTH_CLIENT_ID'),
      client_secret: env('GITHUB_OAUTH_CLIENT_SECRET'),
      code,
    }),
  });

  const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
  if (!tokenData.access_token) {
    return c.text('GitHub OAuth failed', 502);
  }

  const accessToken = tokenData.access_token;
  const ghHeaders = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
  };

  // Fetch user info
  const userRes = await fetch('https://api.github.com/user', { headers: ghHeaders });
  const ghUser = await userRes.json() as {
    id: number;
    login: string;
    name: string | null;
    email: string | null;
  };

  // Fetch emails (in case primary email is private)
  let email = ghUser.email;
  if (!email) {
    const emailsRes = await fetch('https://api.github.com/user/emails', { headers: ghHeaders });
    const emails = await emailsRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
    email = emails.find((e) => e.primary && e.verified)?.email ?? null;
  }

  // Upsert org (1:1 with user for v1)
  const org = await upsertOrg(ghUser.login, ghUser.name ?? ghUser.login);

  // Upsert user
  const user = await upsertUser({
    orgId: org.id,
    githubId: String(ghUser.id),
    githubLogin: ghUser.login,
    email,
    name: ghUser.name,
  });

  // Sign JWT (90-day expiry)
  const jwtSecret = env('JWT_SECRET');
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90;
  const token = await sign(
    { sub: user.id, orgId: org.id, login: ghUser.login, exp: expiresAt },
    jwtSecret,
  );

  setCookie(c, 'session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: 60 * 60 * 24 * 90,
    path: '/',
  });

  return c.redirect(env('GITHUB_APP_INSTALL_URL'));
});
