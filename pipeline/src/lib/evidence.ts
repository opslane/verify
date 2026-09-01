import { openSync, readSync, closeSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Criterion } from './criteria.js';
import type { FinalizedAttempt } from './drive.js';
import type { CriterionResult } from './verdict.js';

export const EVIDENCE_EXCERPT_LIMIT = 64 * 1024;

const SELF_OUTPUTS = new Set([
  'report.html',
  'report.md',
  'results.json',
  'criteria.json',
  'coverage.json',
  'claims.json',
  'review.json',
]);

export type EvidenceKind = 'image' | 'video' | 'excerpt';

export interface EvidenceFile {
  /** The submitted path, or the engine-selected precheck path. */
  name: string;
  /** Canonical run-relative path used for links. */
  relativePath: string;
  href: string;
  bytes: number;
  kind: EvidenceKind;
  excerpt?: string;
  source: 'named' | 'precheck';
  /** Other criteria naming this same canonical file. */
  alsoCitedBy: string[];
}

export interface EvidenceMarker {
  name: string;
  message: string;
}

export interface CriterionEvidence {
  files: EvidenceFile[];
  markers: EvidenceMarker[];
  attempt?: FinalizedAttempt;
  substantiated: boolean;
}

function below(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== '' && !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`);
}

function hrefFor(relativePath: string): string {
  return relativePath.split('/').map(encodeURIComponent).join('/');
}

function kindFor(name: string): EvidenceKind {
  if (/\.(png|jpe?g|gif|webp)$/i.test(name)) return 'image';
  if (/\.(webm|mp4)$/i.test(name)) return 'video';
  return 'excerpt';
}

function displayName(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  // Filenames land verbatim in report.md and terminal output; control
  // characters (ANSI, newlines) could forge lines there.
  return text.replace(/[\u0000-\u001f\u007f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Read at most the excerpt limit without loading the whole file. */
function readCapped(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(EVIDENCE_EXCERPT_LIMIT);
    const bytes = readSync(fd, buffer, 0, EVIDENCE_EXCERPT_LIMIT, 0);
    return buffer.subarray(0, bytes).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

interface Candidate {
  file?: EvidenceFile;
  marker?: EvidenceMarker;
  canonical?: string;
}

function resolveFile(
  root: string,
  raw: unknown,
  source: EvidenceFile['source'],
): Candidate {
  const name = displayName(raw);
  const reject = (why: string): Candidate => ({
    marker: { name, message: `missing/rejected: ${name} (${why})` },
  });
  if (typeof raw !== 'string' || raw.trim() === '') return reject('path must be a non-empty string');
  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) return reject('absolute paths are not allowed');

  const candidate = resolve(root, raw);
  const lexicalRelative = relative(root, candidate).split(sep).join('/');
  if (lexicalRelative === '..' || lexicalRelative.startsWith('../') || isAbsolute(lexicalRelative)) {
    return reject('path is outside the run folder');
  }
  if (SELF_OUTPUTS.has(lexicalRelative.toLowerCase())) return reject('run output cannot be its own evidence');
  if (/^evidence\/[^/]+\/(?:drive-[^/]+|drafts)(?:\/|$)/.test(lexicalRelative)) {
    return reject('drive receipt folders are engine-reserved');
  }
  if (!existsSync(candidate)) return reject('file does not exist');
  try {
    let walked = root;
    for (const segment of lexicalRelative.split('/')) {
      walked = resolve(walked, segment);
      if (lstatSync(walked).isSymbolicLink()) return reject('symlinks are not allowed');
    }
    const canonical = realpathSync(candidate);
    if (!below(root, canonical)) return reject('path is outside the run folder');
    const runRelative = relative(root, canonical).split(sep).join('/');
    if (SELF_OUTPUTS.has(runRelative.toLowerCase())) return reject('run output cannot be its own evidence');
    if (/^evidence\/[^/]+\/(?:drive-[^/]+|drafts)(?:\/|$)/.test(runRelative)) return reject('drive receipt folders are engine-reserved');
    const stat = statSync(canonical);
    if (!stat.isFile()) return reject('not a regular file');
    if (stat.size === 0) return reject('file is empty');
    const kind = kindFor(runRelative);
    const excerpt = kind === 'excerpt' ? readCapped(canonical) : undefined;
    return {
      canonical,
      file: {
        name,
        relativePath: runRelative,
        href: hrefFor(runRelative),
        bytes: stat.size,
        kind,
        ...(excerpt === undefined ? {} : { excerpt }),
        source,
        alsoCitedBy: [],
      },
    };
  } catch (error) {
    return reject(error instanceof Error ? error.message : 'file could not be opened');
  }
}

/**
 * Resolve every submitted path against the canonical run root. The returned
 * facts are renderer input: callers never trust an author-supplied
 * `substantiated` value.
 */
export function resolveEvidence(
  runDir: string,
  criteria: Pick<Criterion, 'id' | 'drive'>[],
  results: CriterionResult[],
  attempts: Record<string, FinalizedAttempt | undefined>,
  taintedBy: Record<string, string | undefined> = {},
): Record<string, CriterionEvidence> {
  const root = realpathSync(runDir);
  const resultById = new Map(results.map((result) => [result.id, result]));
  const resolved: Record<string, CriterionEvidence> = {};
  const citations = new Map<string, { criterionId: string; file: EvidenceFile }[]>();

  for (const criterion of criteria) {
    const result = resultById.get(criterion.id);
    const submitted = Array.isArray(result?.evidence) ? result.evidence : [];
    const files: EvidenceFile[] = [];
    const markers: EvidenceMarker[] = [];
    let namedValid = 0;
    if (result?.evidence !== undefined && !Array.isArray(result.evidence)) {
      markers.push({ name: 'evidence', message: 'missing/rejected: evidence (must be a string array)' });
    }
    for (const raw of submitted as unknown[]) {
      const candidate = resolveFile(root, raw, 'named');
      if (candidate.file && candidate.canonical) {
        files.push(candidate.file);
        namedValid += 1;
        const uses = citations.get(candidate.canonical) ?? [];
        uses.push({ criterionId: criterion.id, file: candidate.file });
        citations.set(candidate.canonical, uses);
      } else if (candidate.marker) {
        markers.push(candidate.marker);
      }
    }

    const part = taintedBy[criterion.id];
    if (part) {
      const log = resolveFile(root, `prechecks/${part}.log`, 'precheck');
      // Taint logs auto-attach only when they exist and pass the same floor.
      if (log.file) files.push(log.file);
    }

    const attempt = attempts[criterion.id];
    resolved[criterion.id] = {
      files,
      markers,
      ...(attempt ? { attempt } : {}),
      substantiated: criterion.drive !== undefined ? attempt?.qualifies === true : namedValid > 0,
    };
  }

  for (const uses of citations.values()) {
    if (uses.length < 2) continue;
    for (const use of uses) {
      use.file.alsoCitedBy = [...new Set(
        uses.map((other) => other.criterionId).filter((id) => id !== use.criterionId),
      )].sort();
    }
  }

  return resolved;
}

/** Legacy mode lists submitted names without claiming they were opened. */
export function legacyEvidence(result: CriterionResult): CriterionEvidence {
  const names: unknown[] = Array.isArray(result.evidence) ? result.evidence : [];
  return {
    files: names.map((raw) => {
      const name = displayName(raw);
      return {
        name,
        relativePath: name,
        href: hrefFor(name),
        bytes: 0,
        kind: kindFor(name),
        source: 'named',
        alsoCitedBy: [],
      };
    }),
    markers: result.evidence !== undefined && !Array.isArray(result.evidence)
      ? [{ name: 'evidence', message: 'missing/rejected: evidence (must be a string array)' }]
      : [],
    // Preserve the pre-v2 verdict behavior when no run directory was supplied.
    substantiated: true,
  };
}
