// The app profile: a fixed model of how the target app behaves at runtime,
// written once by /verify-setup and read by /break to pick attacks. Every item
// cites the file it came from; a value the code does not show is "unknown".
// This module only checks shape. Whether an entry is still true is /break's
// job, at attack time, against current code.

export const SERVICE_KINDS = ['api', 'worker', 'web', 'db', 'queue', 'storage', 'other'] as const;
export const ACTOR_KINDS = ['scheduler', 'poller', 'reaper', 'sweeper', 'consumer', 'boot_task', 'migration'] as const;
export const EXTERNAL_KINDS = [
  'llm', 'payments', 'chat', 'vcs', 'auth', 'storage', 'sandbox', 'email', 'observability', 'other',
] as const;
export const STUBBABLE = ['yes', 'no', 'unknown'] as const;
export const EDGE_HOPS = ['cloudflare', 'cdn', 'vercel', 'load_balancer', 'nginx_or_ingress', 'none', 'unknown'] as const;

const KEYS = {
  top: ['version', 'services', 'actors', 'entities', 'external', 'config', 'edge'],
  service: ['name', 'kind', 'run', 'source'],
  actor: ['name', 'kind', 'service', 'interval_s', 'interval_env', 'touches', 'source'],
  entity: ['table', 'status_field', 'statuses', 'transitions', 'source'],
  transition: ['from', 'to', 'by', 'source'],
  external: ['name', 'kind', 'env', 'stubbable', 'stub_how', 'source'],
  config: ['name', 'default', 'effect', 'source'],
  edge: ['hops', 'source'],
};

// `path:line` or `path:line-line`. The edge may instead say a person answered.
const SOURCE = /^(.+):(\d+)(?:-(\d+))?$/;
const ANSWERED = 'answered by the user';

export interface ProfileCounts {
  services: number;
  actors: number;
  entities: number;
  transitions: number;
  external: number;
  config: number;
  unknowns: number;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Check a profile against the schema. `lineCount(path)` returns the number of
 * lines in a repo file, or null when it does not exist, so every cited source
 * can be confirmed to point somewhere real. Returns the problems found; an empty
 * list means the profile is well formed.
 */
export function checkProfile(
  profile: unknown,
  lineCount: (path: string) => number | null,
): { errors: string[]; counts: ProfileCounts } {
  const errors: string[] = [];
  const counts: ProfileCounts = {
    services: 0, actors: 0, entities: 0, transitions: 0, external: 0, config: 0, unknowns: 0,
  };

  const exactKeys = (where: string, v: unknown, keys: string[]): v is Obj => {
    if (!isObj(v)) {
      errors.push(`${where}: expected an object`);
      return false;
    }
    const got = Object.keys(v);
    for (const k of keys) if (!got.includes(k)) errors.push(`${where}: missing "${k}"`);
    for (const k of got) if (!keys.includes(k)) errors.push(`${where}: unexpected key "${k}"`);
    return true;
  };

  const oneOf = (where: string, v: unknown, allowed: readonly string[]) => {
    if (typeof v !== 'string' || !allowed.includes(v)) {
      errors.push(`${where}: "${String(v)}" is not one of ${allowed.join(', ')}`);
    }
    if (v === 'unknown') counts.unknowns++;
  };

  const text = (where: string, v: unknown) => {
    if (!isStr(v)) errors.push(`${where}: expected a non-empty string`);
    else if (v === 'unknown') counts.unknowns++;
  };

  const textOrNull = (where: string, v: unknown) => {
    if (v !== null && typeof v !== 'string') errors.push(`${where}: expected a string or null`);
  };

  const source = (where: string, v: unknown, allowAnswered = false) => {
    if (allowAnswered && typeof v === 'string' && v.startsWith(ANSWERED)) return;
    if (typeof v !== 'string') {
      errors.push(`${where}.source: expected "path:line"`);
      return;
    }
    const m = SOURCE.exec(v);
    if (!m) {
      errors.push(`${where}.source: "${v}" is not "path:line"`);
      return;
    }
    const lines = lineCount(m[1]);
    const line = Number(m[3] ?? m[2]);
    if (lines === null) errors.push(`${where}.source: ${m[1]} does not exist`);
    else if (line < 1 || line > lines) errors.push(`${where}.source: ${m[1]} has ${lines} lines, not ${line}`);
  };

  const list = (where: string, v: unknown): unknown[] => {
    if (!Array.isArray(v)) {
      errors.push(`${where}: expected a list`);
      return [];
    }
    return v;
  };

  if (!exactKeys('profile', profile, KEYS.top)) return { errors, counts };
  if (profile.version !== 1) errors.push('profile.version: expected 1');

  list('services', profile.services).forEach((s, i) => {
    const w = `services[${i}]`;
    if (!exactKeys(w, s, KEYS.service)) return;
    counts.services++;
    text(`${w}.name`, s.name);
    oneOf(`${w}.kind`, s.kind, SERVICE_KINDS);
    text(`${w}.run`, s.run);
    source(w, s.source);
  });

  list('actors', profile.actors).forEach((a, i) => {
    const w = `actors[${i}]`;
    if (!exactKeys(w, a, KEYS.actor)) return;
    counts.actors++;
    text(`${w}.name`, a.name);
    oneOf(`${w}.kind`, a.kind, ACTOR_KINDS);
    text(`${w}.service`, a.service);
    if (a.interval_s !== null && (typeof a.interval_s !== 'number' || a.interval_s <= 0)) {
      errors.push(`${w}.interval_s: expected a positive number or null`);
    }
    textOrNull(`${w}.interval_env`, a.interval_env);
    list(`${w}.touches`, a.touches).forEach((t, j) => text(`${w}.touches[${j}]`, t));
    source(w, a.source);
  });

  list('entities', profile.entities).forEach((e, i) => {
    const w = `entities[${i}]`;
    if (!exactKeys(w, e, KEYS.entity)) return;
    counts.entities++;
    text(`${w}.table`, e.table);
    text(`${w}.status_field`, e.status_field);
    list(`${w}.statuses`, e.statuses).forEach((s, j) => text(`${w}.statuses[${j}]`, s));
    list(`${w}.transitions`, e.transitions).forEach((t, j) => {
      const tw = `${w}.transitions[${j}]`;
      if (!exactKeys(tw, t, KEYS.transition)) return;
      counts.transitions++;
      text(`${tw}.from`, t.from);
      text(`${tw}.to`, t.to);
      text(`${tw}.by`, t.by);
      source(tw, t.source);
    });
    source(w, e.source);
  });

  list('external', profile.external).forEach((x, i) => {
    const w = `external[${i}]`;
    if (!exactKeys(w, x, KEYS.external)) return;
    counts.external++;
    text(`${w}.name`, x.name);
    oneOf(`${w}.kind`, x.kind, EXTERNAL_KINDS);
    list(`${w}.env`, x.env).forEach((v, j) => text(`${w}.env[${j}]`, v));
    oneOf(`${w}.stubbable`, x.stubbable, STUBBABLE);
    textOrNull(`${w}.stub_how`, x.stub_how);
    source(w, x.source);
  });

  list('config', profile.config).forEach((c, i) => {
    const w = `config[${i}]`;
    if (!exactKeys(w, c, KEYS.config)) return;
    counts.config++;
    text(`${w}.name`, c.name);
    textOrNull(`${w}.default`, c.default);
    text(`${w}.effect`, c.effect);
    source(w, c.source);
  });

  const edge = profile.edge;
  if (exactKeys('edge', edge, KEYS.edge)) {
    const hops = list('edge.hops', edge.hops);
    if (hops.length === 0) errors.push('edge.hops: expected at least one hop ("none" or "unknown" if so)');
    hops.forEach((h, j) => oneOf(`edge.hops[${j}]`, h, EDGE_HOPS));
    if (edge.source !== null) source('edge', edge.source, true);
  }

  return { errors, counts };
}
