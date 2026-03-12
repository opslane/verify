import { Hono, type Context } from 'hono';
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

function isSecure(c: Context): boolean {
  // Trust x-forwarded-proto from proxies (ngrok, load balancers).
  // Assumes this server always runs behind a trusted reverse proxy in production.
  return c.req.header('x-forwarded-proto') === 'https' || process.env.NODE_ENV === 'production';
}

authRouter.get('/github', (c) => {
  const state = randomBytes(32).toString('hex');

  setCookie(c, 'oauth_state', state, {
    httpOnly: true,
    secure: isSecure(c),
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

  // User denied OAuth or code is missing — check before consuming the state cookie
  if (!code) {
    return c.redirect('/?error=cancelled');
  }

  if (!stateParam || !stateCookie || stateParam !== stateCookie) {
    console.error('[auth/callback] CSRF state mismatch', { hasCookie: !!stateCookie, hasParam: !!stateParam });
    return c.text('Invalid OAuth state. Please try again.', 400);
  }

  deleteCookie(c, 'oauth_state', { path: '/' });

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

  if (!tokenRes.ok) {
    return c.text(`GitHub token exchange failed: ${tokenRes.status}`, 502);
  }

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
  if (!userRes.ok) {
    return c.text(`GitHub API error fetching user: ${userRes.status}`, 502);
  }
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
    if (emailsRes.ok) {
      const emails = await emailsRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
      email = emails.find((e) => e.primary && e.verified)?.email ?? null;
    }
    // Email is optional — continue without it if the API call fails
  }

  // Upsert org — v1 uses 1:1 user-to-org mapping (user's github login = org identifier)
  const org = await upsertOrg(ghUser.login, ghUser.name ?? ghUser.login);

  // Upsert user
  const user = await upsertUser({
    orgId: org.id,
    githubId: String(ghUser.id),
    githubLogin: ghUser.login,
    email,
    name: ghUser.name,
  });

  // Sign JWT: 90-day expiry, HS256
  const jwtSecret = env('JWT_SECRET');
  const now = Math.floor(Date.now() / 1000);
  const token = await sign(
    {
      sub: user.id,
      orgId: org.id,
      login: ghUser.login,
      iat: now,
      exp: now + 60 * 60 * 24 * 90,
    },
    jwtSecret,
  );

  setCookie(c, 'session', token, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: 'Lax',
    maxAge: 60 * 60 * 24 * 90,
    path: '/',
  });

  const installUrl = `https://github.com/apps/${env('GITHUB_APP_SLUG')}/installations/new`;
  return c.redirect(installUrl);
});
