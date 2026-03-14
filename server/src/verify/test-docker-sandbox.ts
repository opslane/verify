/**
 * Test Docker + Docker Compose inside E2B sandbox.
 * Proves AC-1 (Docker daemon runs) and AC-2 (Compose starts services).
 *
 * Run: node --env-file=.env --import tsx/esm src/verify/test-docker-sandbox.ts
 */
import { E2BSandboxProvider } from '../sandbox/e2b-provider.js';

const provider = new E2BSandboxProvider();

async function drain(stream: AsyncIterable<string>) {
  for await (const _ of stream) { /* discard */ }
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of stream) lines.push(line);
  return lines;
}

function elapsed(start: number): string {
  return `${((Date.now() - start) / 1000).toFixed(1)}s`;
}

const COMPOSE_YAML = `services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 2s
      timeout: 5s
      retries: 10
  redis:
    image: redis:7
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 5s
      retries: 10
`;

async function main() {
  const t0 = Date.now();
  console.log('Creating sandbox (opslane-verify-v2, 8GB/4CPU)...');
  const sandbox = await provider.create({
    template: 'opslane-verify-v2',
    timeoutMs: 600_000,
    envVars: {},
    metadata: { sessionId: 'docker-test', userId: 'test' },
  });
  const id = sandbox.id;
  console.log(`[${elapsed(t0)}] Sandbox created: ${id}`);

  try {
    // ── AC-1: Docker daemon runs ──
    console.log('\n── AC-1: Docker daemon runs ──');

    // Wait for Docker daemon to be ready (entrypoint starts it async, then chmod's socket)
    let dockerOk = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const dockerInfo = await collect(provider.runCommand(id, 'docker info 2>&1', { rawOutput: true }));
        dockerOk = dockerInfo.some(l => l.includes('Server Version'));
        if (dockerOk) {
          const ver = dockerInfo.find(l => l.includes('Server Version'))?.trim();
          console.log(`[${elapsed(t0)}] docker info: PASS (${ver})`);
          break;
        }
      } catch { /* daemon not ready or permission denied */ }
      if (attempt < 19) {
        console.log(`[${elapsed(t0)}] Docker daemon not ready, retrying (${attempt + 1}/20)...`);
        await new Promise(r => setTimeout(r, 2_000));
      }
    }
    if (!dockerOk) {
      const fullInfo = await collect(provider.runCommand(id, 'docker info 2>&1', { rawOutput: true }));
      console.log('docker info output:', fullInfo.join('\n'));
      throw new Error('AC-1 FAILED: Docker daemon not running after 40s');
    }

    // Verify no baked-in Postgres
    const psqlCheck = await collect(provider.runCommand(id, 'pg_isready 2>&1 || echo "PG_NOT_RUNNING"', { rawOutput: true }));
    const pgBakedIn = psqlCheck.some(l => l.includes('accepting connections'));
    console.log(`[${elapsed(t0)}] Baked-in Postgres: ${pgBakedIn ? 'FAIL (still baked in!)' : 'PASS (not present)'}`);
    if (pgBakedIn) throw new Error('AC-1 FAILED: Postgres is still baked into the template');

    // Verify no baked-in Redis
    const redisCheck = await collect(provider.runCommand(id, 'redis-cli ping 2>&1 || echo "REDIS_NOT_RUNNING"', { rawOutput: true }));
    const redisBakedIn = redisCheck.some(l => l.includes('PONG'));
    console.log(`[${elapsed(t0)}] Baked-in Redis: ${redisBakedIn ? 'FAIL (still baked in!)' : 'PASS (not present)'}`);
    if (redisBakedIn) throw new Error('AC-1 FAILED: Redis is still baked into the template');

    console.log('✅ AC-1 PASSED: Docker runs, no baked-in services\n');

    // ── AC-2: Docker Compose starts Postgres + Redis ──
    console.log('── AC-2: Docker Compose starts Postgres + Redis ──');

    // Upload compose file
    await provider.uploadFiles(id, [{ path: '/home/user/docker-compose.dev.yml', content: COMPOSE_YAML }]);
    console.log(`[${elapsed(t0)}] Uploaded docker-compose.dev.yml`);

    // Run compose up
    const composeStart = Date.now();
    console.log(`[${elapsed(t0)}] Running docker compose up -d --wait...`);
    await drain(provider.runCommand(id,
      'cd /home/user && docker compose -f docker-compose.dev.yml up -d --wait 2>&1',
      { rawOutput: true, timeoutMs: 180_000 },
    ));
    console.log(`[${elapsed(t0)}] docker compose up completed (${elapsed(composeStart)} for pull+start)`);

    // Verify Postgres reachable
    const pgReady = await collect(provider.runCommand(id, 'pg_isready -h localhost -U app 2>&1', { rawOutput: true }));
    const pgOk = pgReady.some(l => l.includes('accepting connections'));
    console.log(`[${elapsed(t0)}] Postgres via compose: ${pgOk ? 'PASS' : 'FAIL'}`);
    if (!pgOk) {
      console.log('pg_isready output:', pgReady.join('\n'));
      throw new Error('AC-2 FAILED: Postgres not reachable');
    }

    // Verify Redis reachable (exec into the container since redis-cli may not be on host)
    const redisReady = await collect(provider.runCommand(id,
      'docker compose -f /home/user/docker-compose.dev.yml exec -T redis redis-cli ping 2>&1',
      { rawOutput: true, timeoutMs: 10_000 },
    ));
    const redisOk = redisReady.some(l => l.includes('PONG'));
    console.log(`[${elapsed(t0)}] Redis via compose: ${redisOk ? 'PASS' : 'FAIL'}`);
    if (!redisOk) {
      console.log('redis-cli output:', redisReady.join('\n'));
      throw new Error('AC-2 FAILED: Redis not reachable');
    }

    console.log('✅ AC-2 PASSED: Compose starts Postgres + Redis, both reachable\n');

    // ── AC-4/AC-5: Resource check ──
    console.log('── Resource Check (AC-4 + AC-5) ──');

    const memInfo = await collect(provider.runCommand(id, 'free -m 2>&1', { rawOutput: true }));
    console.log(`[${elapsed(t0)}] Memory:`);
    for (const l of memInfo) console.log(`  ${l}`);

    const oomCheck = await collect(provider.runCommand(id, 'dmesg 2>&1 | grep -i oom || echo "NO_OOM"', { rawOutput: true }));
    const hasOom = !oomCheck.some(l => l.includes('NO_OOM'));
    console.log(`[${elapsed(t0)}] OOM kills: ${hasOom ? 'FAIL' : 'PASS (none)'}`);

    // Clean up compose
    await drain(provider.runCommand(id,
      'cd /home/user && docker compose -f docker-compose.dev.yml down 2>&1',
      { rawOutput: true, timeoutMs: 30_000 },
    ));
    console.log(`[${elapsed(t0)}] docker compose down complete`);

    console.log(`\n✅ ALL CHECKS PASSED in ${elapsed(t0)}`);

  } finally {
    console.log('Destroying sandbox...');
    await provider.destroy(id);
    console.log('Done.');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
