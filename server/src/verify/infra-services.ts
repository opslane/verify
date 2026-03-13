interface ServiceDef {
  install: string[];  // shell commands to install
  start: string;      // shell command to start (daemonized)
  probe: { command: string; port: number; maxRetries: number; intervalMs: number };
}

const BAKED_IN = new Set(['postgres', 'redis']);

const SERVICE_DEFS: Record<string, ServiceDef> = {
  minio: {
    install: [
      'wget -q https://dl.min.io/server/minio/release/linux-amd64/minio -O /usr/local/bin/minio',
      'chmod +x /usr/local/bin/minio',
    ],
    start: 'MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin nohup minio server /data/minio --console-address :9001 > /tmp/minio.log 2>&1 &',
    probe: {
      command: 'curl -sf http://localhost:9000/minio/health/live',
      port: 9000,
      maxRetries: 15,
      intervalMs: 2000,
    },
  },
  mailhog: {
    install: [
      'wget -q https://github.com/mailhog/MailHog/releases/download/v1.0.1/MailHog_linux_amd64 -O /usr/local/bin/mailhog',
      'chmod +x /usr/local/bin/mailhog',
    ],
    start: 'nohup mailhog > /tmp/mailhog.log 2>&1 &',
    probe: {
      command: 'curl -sf http://localhost:8025',
      port: 8025,
      maxRetries: 10,
      intervalMs: 1000,
    },
  },
};

export function buildInstallCommands(services: string[]): string[] {
  const commands: string[] = [];
  for (const svc of services) {
    if (BAKED_IN.has(svc)) continue;
    const def = SERVICE_DEFS[svc];
    if (!def) continue;
    commands.push(...def.install, def.start);
  }
  return commands;
}

export function buildReadinessProbe(service: string): { command: string; port: number; maxRetries: number; intervalMs: number } {
  const def = SERVICE_DEFS[service];
  if (!def) throw new Error(`Unknown service: ${service}`);
  return def.probe;
}

export function hasServiceDef(service: string): boolean {
  return service in SERVICE_DEFS;
}
