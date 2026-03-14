/**
 * Test: Docker + docker-compose inside E2B sandbox (with sudo)
 */
import { E2BSandboxProvider } from '../src/sandbox/e2b-provider.js';
import { collect } from '../src/sandbox/stream.js';

async function run(provider: E2BSandboxProvider, sbId: string, cmd: string, label: string, timeoutMs = 60_000) {
  try {
    const out = await collect(provider.runCommand(sbId, cmd, { rawOutput: true, timeoutMs }));
    const clean = out.filter(l => !l.includes('\x1B') && !l.includes('sudo <command>') && l.trim());
    console.log(`\n[${label}]`);
    console.log(clean.join('\n').slice(0, 2000));
    return clean;
  } catch (err: unknown) {
    const e = err as { ptyOutput?: string };
    const clean = (e.ptyOutput ?? '').split('\n').filter(l => !l.includes('\x1B') && !l.includes('sudo <command>') && l.trim());
    console.log(`\n[${label}] (error)`);
    console.log(clean.join('\n').slice(0, 2000) || '(no output)');
    return clean;
  }
}

async function main() {
  const provider = new E2BSandboxProvider();
  const sandbox = await provider.create({
    template: 'opslane-verify-v2',
    timeoutMs: 600_000,
    envVars: {},
    metadata: { sessionId: 'test-docker-v2', userId: 'system' },
  });
  console.log(`Sandbox: ${sandbox.id}`);

  try {
    // 1. Install Docker + add user to docker group
    console.log('\n--- Installing Docker ---');
    await run(provider, sandbox.id,
      'curl -fsSL https://get.docker.com | sudo sh 2>&1 && sudo usermod -aG docker user',
      'install-docker', 120_000);

    // 2. Start Docker daemon and wait
    await run(provider, sandbox.id,
      'sudo dockerd > /tmp/dockerd.log 2>&1 & sleep 5 && sudo docker version 2>&1',
      'start-docker', 30_000);

    // 3. Test basic Docker
    await run(provider, sandbox.id,
      'sudo docker run --rm hello-world 2>&1',
      'hello-world', 60_000);

    // 4. docker-compose version
    await run(provider, sandbox.id,
      'sudo docker compose version 2>&1',
      'compose-version');

    // 5. Test docker-compose with Postgres + Redis
    const composeYml = `services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: testdb
    ports:
      - "5433:5432"
  redis:
    image: redis:7-alpine
    ports:
      - "6380:6379"
`;
    await provider.uploadFiles(sandbox.id, [{ path: '/tmp/test-compose/docker-compose.yml', content: composeYml }]);

    console.log('\n--- Starting docker-compose (pulling images) ---');
    await run(provider, sandbox.id,
      'cd /tmp/test-compose && sudo docker compose up -d 2>&1',
      'compose-up', 180_000);

    // 6. Wait and check
    await run(provider, sandbox.id,
      'sleep 10 && sudo docker compose -f /tmp/test-compose/docker-compose.yml ps 2>&1',
      'compose-ps');

    // 7. Test connectivity
    await run(provider, sandbox.id,
      'PGPASSWORD=postgres psql -h localhost -p 5433 -U postgres -d testdb -c "SELECT 1 AS docker_postgres_works;" 2>&1',
      'test-postgres');

    await run(provider, sandbox.id,
      'redis-cli -p 6380 ping 2>&1',
      'test-redis');

  } finally {
    await provider.destroy(sandbox.id);
  }
}

main().catch(console.error);
