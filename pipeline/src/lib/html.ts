// html.ts — the acceptance report. Dynamic strings are model-controlled and
// must remain escaped; receipt and evidence drawers reveal raw detail without
// letting it become markup.
import type { Criterion, DriveStep } from './criteria.js';
import { EVIDENCE_EXCERPT_LIMIT, type CriterionEvidence, type EvidenceFile } from './evidence.js';
import type { StepReceipt } from './steps.js';
import type {
  ClassifiedCriterionResult,
  Precheck,
  ProofSource,
} from './verdict.js';
import { notProvenReason, sourceLabel, headline, summarise } from './verdict.js';

export interface ReviewOpinion {
  reviewer: string;
  criteria: { id: string; keep: string; why: string; codify: boolean }[];
  missing: string[];
}

export interface HtmlInput {
  runId: string;
  runTag: string;
  criteria: Criterion[];
  results: ClassifiedCriterionResult[];
  filesWithoutCriterion: number;
  precheck?: Precheck;
  review?: ReviewOpinion;
  violation: boolean;
  evidence: Record<string, CriterionEvidence>;
  /** Run-scope garnish: run.gif, run.cast. */
  runAssets?: string[];
  notChecked: { what: string; why: string }[];
  sources?: Record<string, ProofSource>;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function highlighted(text: string, runTag: string): string {
  if (!runTag || !text.includes(runTag)) return esc(text);
  return text.split(runTag).map(esc).join(`<mark>${esc(runTag)}</mark>`);
}

const STATUS_LABEL = {
  proven: '✔ pass',
  failed: '✘ fail',
  'not-proven': '⚠ not proven',
  blocked: '⚠ blocked',
} as const;

const GUARD_LABEL: Record<string, string> = {
  changes: 'proves the new behavior',
  preserves: 'guards existing behavior',
};

function seconds(receipt: StepReceipt): string {
  const duration = Date.parse(receipt.endedAt) - Date.parse(receipt.startedAt);
  if (!Number.isFinite(duration) || duration < 0) return '';
  const value = (duration / 1000).toFixed(duration < 10_000 ? 1 : 0);
  return ` (${value}s)`;
}

function planLabel(step: DriveStep): string {
  return `${step.verb} ${step.args.join(' ')}`;
}

function receiptResult(receipt: StepReceipt | undefined, fallbackState: string, index: number): string {
  if (!receipt) return `${fallbackState} — no receipt for step ${index}`;
  const code = receipt.status !== undefined ? ` — HTTP ${receipt.status}`
    : receipt.exit !== undefined ? ` — exit ${receipt.exit}` : '';
  return `${receipt.state}${code}${seconds(receipt)}`;
}

function invocation(receipt: StepReceipt): string {
  if (receipt.request) {
    return [
      `${receipt.request.method} ${receipt.request.url}`,
      ...(receipt.request.headers ? [`headers: ${JSON.stringify(receipt.request.headers, null, 2)}`] : []),
      ...(receipt.request.body === undefined ? [] : [`body:\n${receipt.request.body}`]),
    ].join('\n');
  }
  if (receipt.command) {
    // Unambiguous quoting: 'a b' as one argument must not render like two.
    const argv = receipt.command.argv
      .map((arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`))
      .join(' ');
    return `${argv}\ncwd: ${receipt.command.cwd}`;
  }
  return receipt.display;
}

function transcript(receipt: StepReceipt, runTag: string): string {
  const outputNotice = receipt.outputTruncated
    ? `<span class="notice">truncated at capture limit</span>` : '';
  const diagnosticsNotice = receipt.diagnosticsTruncated
    ? `<span class="notice">truncated at capture limit</span>` : '';
  return [
    `<div class="terminal">`,
    `<h4>recorded invocation</h4>`,
    `<pre>${highlighted(invocation(receipt), runTag)}</pre>`,
    `<p class="timestamps">started ${esc(receipt.startedAt)} · ended ${esc(receipt.endedAt)}</p>`,
    `<h4>captured output ${outputNotice}</h4>`,
    `<pre>${highlighted(receipt.output || '(no output)', runTag)}</pre>`,
    ...(receipt.diagnostics ? [
      `<h5>diagnostics ${diagnosticsNotice}</h5>`,
      `<pre>${highlighted(receipt.diagnostics, runTag)}</pre>`,
    ] : []),
    `</div>`,
  ].join('\n');
}

function renderAttempt(criterion: Criterion, evidence: CriterionEvidence, runTag: string): string[] {
  const attempt = evidence.attempt;
  if (!attempt) return ['<p class="warning">No finalized receipt trail was found.</p>'];
  const manifestByIndex = new Map(attempt.manifest.steps.map((step) => [step.index, step]));
  const lines: string[] = ['<ol class="steps">'];
  for (const [offset, planStep] of (criterion.drive ?? []).entries()) {
    const index = offset + 1;
    const receipt = attempt.receipts[index];
    const state = manifestByIndex.get(index)?.state ?? 'not-attempted';
    const result = receiptResult(receipt, state, index);
    lines.push(`<li><details><summary>${esc(planLabel(planStep))} <span class="step-state">→ ${esc(result)}</span></summary>`);
    if (receipt) lines.push(transcript(receipt, runTag));
    lines.push('</details></li>');
  }
  const extras = Object.keys(attempt.receipts).map(Number)
    .filter((index) => index < 1 || index > (criterion.drive?.length ?? 0)).sort((a, b) => a - b);
  for (const index of extras) {
    const receipt = attempt.receipts[index];
    lines.push(`<li><details><summary>unlabeled extra step ${index} <span class="step-state">→ ${esc(receiptResult(receipt, receipt.state, index))}</span></summary>`);
    lines.push(transcript(receipt, runTag), '</details></li>');
  }
  lines.push('</ol>');
  return lines;
}

function renderFile(file: EvidenceFile): string[] {
  const cited = file.alsoCitedBy.length > 0
    ? `<span class="notice">also cited by ${esc(file.alsoCitedBy.join(', '))}</span>` : '';
  const lines = [
    `<details class="evidence-file"><summary>${esc(file.name)} <span class="bytes">${file.bytes} bytes</span> ${cited}</summary>`,
  ];
  if (file.kind === 'image') lines.push(`<img alt="evidence ${esc(file.name)}" src="${esc(file.href)}">`);
  else if (file.kind === 'video') lines.push(`<video controls src="${esc(file.href)}"></video>`);
  else {
    if (file.bytes > EVIDENCE_EXCERPT_LIMIT) {
      lines.push(`<p class="notice">excerpt limited to ${EVIDENCE_EXCERPT_LIMIT} bytes</p>`);
    }
    lines.push(`<pre>${esc(file.excerpt ?? '')}</pre>`);
  }
  // download: a served .html/.svg evidence file must save, not execute in the
  // report's origin.
  lines.push(`<p><a href="${esc(file.href)}" download>full file</a></p>`, '</details>');
  return lines;
}

export function renderHtml(input: HtmlInput): string {
  const summary = summarise(input.results, { filesWithoutCriterion: input.filesWithoutCriterion });
  const line = headline(summary, { violation: input.violation });
  const byId = new Map(input.results.map((result) => [result.id, result]));
  const down = Object.entries(input.precheck?.parts ?? {}).filter(([, state]) => state === 'down').map(([part]) => part);
  const parts: string[] = [];
  parts.push(`<!doctype html><meta charset="utf-8"><title>Verify — run ${esc(input.runId)}</title>
<style>
body{font:15px/1.5 system-ui;margin:2rem auto;max-width:960px;padding:0 1rem;color:#1a1a1a;background:#fafafa}
h1{font-size:1.3rem}.banner{background:#c62828;color:#fff;padding:.75rem 1rem;border-radius:8px;margin-bottom:1rem}
.card{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0;background:#fff}.claim{font-size:1.12rem;margin:.15rem 0 .7rem}
.proven{border-left:6px solid #2e7d32}.failed{border-left:6px solid #c62828}.blocked,.not-proven{border-left:6px solid #f9a825}
.tag{display:inline-block;font-size:.8rem;color:#555;background:#f2f2f2;border-radius:4px;padding:2px 8px;margin:0 6px 4px 0}
.why,.bytes,.timestamps{color:#777;font-size:.85rem}.warning{color:#8a5a00}.notice{color:#8a5a00;font-size:.8rem;margin-left:.4rem}
h2{font-size:1.05rem;margin-top:2rem}h4,h5{margin:.65rem 0 .2rem}.steps{padding-left:1.6rem}.steps li{margin:.45rem 0}.step-state{color:#555}
details{margin:.55rem 0}summary{cursor:pointer}.terminal{background:#151515;color:#eee;border-radius:7px;padding:.6rem .9rem;margin:.5rem 0}
.terminal pre{background:#090909;color:#e8e8e8}.terminal .timestamps{color:#aaa}mark{background:#ffe082;color:#111}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f5;padding:.75rem;border-radius:6px;max-height:32rem;overflow:auto}
img,video{max-width:100%;border:1px solid #eee;border-radius:6px;margin-top:.5rem}
</style>`);

  if (input.violation) parts.push('<div class="banner">This run modified your working tree (a verify bug) — verdicts may not describe your code. Compare pre-run.diff with post-run.diff.</div>');
  parts.push(`<h1>${esc(line)}</h1>`, `<p class="why">Run tag: <mark>${esc(input.runTag)}</mark></p>`);
  if (down.length > 0) {
    parts.push(`<p class="why">Pipeline check found these parts down before judging: ${esc(down.join(', '))}. Criteria depending on them were blocked.</p>`);
  }

  for (const criterion of input.criteria) {
    const result = byId.get(criterion.id);
    if (!result) {
      // Checks never disappear: even a caller that skipped reconcile gets a
      // visible card for a criterion with no recorded result.
      parts.push(`<section class="card not-proven">`);
      parts.push(`<strong>${esc(criterion.id)}</strong>`, `<p class="claim">${esc(criterion.plain ?? criterion.title)}</p>`);
      parts.push(`<span class="tag">${esc(STATUS_LABEL['not-proven'])}</span>`);
      parts.push('<p class="warning">no result was recorded for this criterion</p>', '</section>');
      continue;
    }
    const evidence = input.evidence[criterion.id] ?? { files: [], markers: [], substantiated: false };
    parts.push(`<section class="card ${esc(result.displayVerdict)}">`);
    parts.push(`<strong>${esc(criterion.id)}</strong>`, `<p class="claim">${esc(criterion.plain ?? criterion.title)}</p>`);
    parts.push(`<span class="tag">${esc(STATUS_LABEL[result.displayVerdict])}</span>`);
    parts.push(`<span class="tag">${esc(GUARD_LABEL[criterion.intent] ?? criterion.intent)}</span>`);
    const source = input.sources?.[criterion.id];
    if (source) parts.push(`<span class="tag">${sourceLabel(source)}</span>`);
    if (result.displayVerdict === 'failed' && result.proofSeen === true) {
      parts.push(`<span class="tag">check ran: ${sourceLabel(source ?? 'judged')}</span>`);
    }
    if (result.displayVerdict === 'not-proven') parts.push(`<p class="warning">${esc(notProvenReason(result))}</p>`);
    if (result.displayVerdict === 'blocked') parts.push(`<p class="warning">${esc(result.observed)}</p>`);
    else parts.push(`<details><summary>Reported observation</summary><pre>${esc(result.observed)}</pre></details>`);

    if (criterion.drive) parts.push(...renderAttempt(criterion, evidence, input.runTag));
    const heading = criterion.drive ? 'Additional evidence' : 'Evidence';
    if (evidence.files.length > 0 || evidence.markers.length > 0) parts.push(`<h3>${heading}</h3>`);
    for (const file of evidence.files) parts.push(...renderFile(file));
    for (const marker of evidence.markers) parts.push(`<p class="warning">${esc(marker.message)}</p>`);
    parts.push('</section>');
  }

  for (const asset of input.runAssets ?? []) {
    if (/\.gif$/i.test(asset)) parts.push(`<h2>Optional run recording</h2><img alt="terminal recording" src="${esc(asset)}">`);
    else parts.push(`<p class="why">Terminal cast: <a href="${esc(asset)}">${esc(asset)}</a></p>`);
  }

  parts.push('<h2>Not checked</h2>');
  if (input.notChecked.length === 0 && (input.precheck?.unchecked ?? []).length === 0) parts.push('<p class="why">Nothing.</p>');
  else {
    for (const part of input.precheck?.unchecked ?? []) parts.push(`<p class="why">${esc(part)}: no probe available — a fail relying on it may be environmental.</p>`);
    for (const entry of input.notChecked) parts.push(`<p class="why">${esc(entry.what)} — ${esc(entry.why)}</p>`);
  }
  if (input.review) {
    parts.push(`<h2>Second opinion (${esc(input.review.reviewer)})</h2>`);
    if (input.review.reviewer === 'unavailable') parts.push('<div class="banner">No second opinion was available — these criteria were reviewed only by the model that wrote them.</div>');
    for (const item of input.review.criteria) parts.push(`<p class="why">${esc(item.id)}: ${esc(item.keep)} — ${esc(item.why)}</p>`);
    for (const missing of input.review.missing) parts.push(`<p class="why">missing check: ${esc(missing)}</p>`);
  }
  parts.push('<!-- codify-block-begin -->', '<p class="why">Codify suggestions appear here after the run\'s closing turn.</p>', '<!-- codify-block-end -->');
  return parts.join('\n') + '\n';
}
