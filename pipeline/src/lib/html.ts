// html.ts — the visual report. One self-describing page per run, served
// locally; screenshots and videos are referenced RELATIVE so the run folder
// is the shippable unit. Every dynamic string is escaped: criteria text,
// observations, and reviewer prose are model-controlled, and model-controlled
// text must never become markup.
import type { Criterion } from './criteria.js';
import type { CriterionResult, Precheck } from './verdict.js';
import { summarise, headline } from './verdict.js';

export interface ReviewOpinion {
  reviewer: string;
  criteria: { id: string; keep: string; why: string; codify: boolean }[];
  missing: string[];
}

export interface HtmlInput {
  runId: string;
  criteria: Criterion[];
  results: CriterionResult[];
  filesWithoutCriterion: number;
  precheck?: Precheck;
  review?: ReviewOpinion;
  violation: boolean;
  /** Relative asset paths per criterion id, e.g. evidence/AC1/screenshot-1.png */
  assets: Record<string, { images: string[]; videos: string[] }>;
  /** Run-scope evidence at the run root: run.gif, run.cast. */
  runAssets?: string[];
  notChecked: { what: string; why: string }[];
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STATUS_LABEL: Record<string, string> = {
  pass: '✔ pass',
  fail: '✘ fail',
  'could-not-run': '⚠ could not run',
  'not-proven': '⚠ not proven — the check may not have actually run',
};

const GUARD_LABEL: Record<string, string> = {
  changes: 'proves the new behavior',
  preserves: 'guards existing behavior',
};

/** Rendering status: a pass without its proof is shown as not-proven. */
function displayStatus(result: CriterionResult): string {
  if (result.outcome === 'pass' && result.proofSeen !== true) return 'not-proven';
  return result.outcome;
}

export function renderHtml(input: HtmlInput): string {
  const summary = summarise(input.results, { filesWithoutCriterion: input.filesWithoutCriterion });
  const line = headline(summary, { violation: input.violation });

  const byId = new Map(input.results.map((r) => [r.id, r]));
  const down = Object.entries(input.precheck?.parts ?? {})
    .filter(([, state]) => state === 'down')
    .map(([part]) => part);

  const parts: string[] = [];
  parts.push(`<!doctype html><meta charset="utf-8"><title>Verify — run ${esc(input.runId)}</title>
<style>
body{font:15px/1.5 system-ui;margin:2rem auto;max-width:900px;padding:0 1rem;color:#1a1a1a;background:#fafafa}
h1{font-size:1.25rem} .banner{background:#c62828;color:#fff;padding:.75rem 1rem;border-radius:8px;margin-bottom:1rem}
.card{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0;background:#fff}
.pass{border-left:6px solid #2e7d32}.fail{border-left:6px solid #c62828}
.could-not-run{border-left:6px solid #f9a825}.not-proven{border-left:6px solid #f9a825}
.tag{font-size:.8rem;color:#555;background:#f2f2f2;border-radius:4px;padding:2px 8px;margin-right:6px}
img,video{max-width:100%;border:1px solid #eee;border-radius:6px;margin-top:.5rem}
.why{color:#777;font-size:.85rem} h2{font-size:1.05rem;margin-top:2rem}
</style>`);

  if (input.violation) {
    parts.push(
      `<div class="banner">This run modified your working tree (a verify bug) — verdicts may not describe your code. Compare pre-run.diff with post-run.diff.</div>`,
    );
  }
  parts.push(`<h1>${esc(line)}</h1>`);
  parts.push(`<p class="why">Run ${esc(input.runId)}</p>`);

  if (down.length > 0) {
    parts.push(
      `<p class="why">Pipeline check found these parts down before judging: ${esc(down.join(', '))}. ` +
        `Criteria depending on them were not judged — a broken pipe must never become a false verdict.</p>`,
    );
  }

  for (const criterion of input.criteria) {
    const result = byId.get(criterion.id) ?? {
      id: criterion.id,
      outcome: 'could-not-run' as const,
      proofSeen: false,
      observed: 'no result recorded for this criterion',
    };
    const status = displayStatus(result);
    parts.push(`<div class="card ${esc(status)}">`);
    parts.push(`<strong>${esc(criterion.id)}</strong> — ${esc(criterion.title)}<br>`);
    parts.push(`<span class="tag">${esc(STATUS_LABEL[status] ?? status)}</span>`);
    parts.push(`<span class="tag">${esc(GUARD_LABEL[criterion.intent] ?? criterion.intent)}</span>`);
    parts.push(`<p>Driven: ${esc(criterion.doIt)}<br>Observed: ${esc(result.observed)}</p>`);
    const assets = input.assets[criterion.id];
    for (const image of assets?.images ?? []) {
      parts.push(`<img alt="evidence" src="${esc(image)}">`);
    }
    for (const video of assets?.videos ?? []) {
      parts.push(`<video controls src="${esc(video)}"></video>`);
    }
    parts.push(`</div>`);
  }

  for (const asset of input.runAssets ?? []) {
    if (asset.endsWith('.gif')) {
      parts.push(`<h2>Terminal recording</h2><img alt="terminal recording" src="${esc(asset)}">`);
    } else {
      parts.push(`<p class="why">Terminal cast: <a href="${esc(asset)}">${esc(asset)}</a></p>`);
    }
  }

  parts.push(`<h2>Not checked</h2>`);
  if (input.notChecked.length === 0 && (input.precheck?.unchecked ?? []).length === 0) {
    parts.push(`<p class="why">Nothing.</p>`);
  } else {
    for (const part of input.precheck?.unchecked ?? []) {
      parts.push(
        `<p class="why">${esc(part)}: no probe available — a fail on a criterion relying on it may be environmental.</p>`,
      );
    }
    for (const entry of input.notChecked) {
      parts.push(`<p class="why">${esc(entry.what)} — ${esc(entry.why)}</p>`);
    }
  }

  if (input.review) {
    parts.push(`<h2>Second opinion (${esc(input.review.reviewer)})</h2>`);
    if (input.review.reviewer === 'unavailable') {
      parts.push(
        `<div class="banner">No second opinion was available — these criteria were reviewed only by the model that wrote them.</div>`,
      );
    }
    for (const item of input.review.criteria) {
      parts.push(`<p class="why">${esc(item.id)}: ${esc(item.keep)} — ${esc(item.why)}</p>`);
    }
    for (const missing of input.review.missing) {
      parts.push(`<p class="why">missing check: ${esc(missing)}</p>`);
    }
  }

  parts.push(`<!-- codify-block-begin -->`);
  parts.push(`<p class="why">Codify suggestions appear here after the run's closing turn.</p>`);
  parts.push(`<!-- codify-block-end -->`);

  return parts.join('\n') + '\n';
}
