import Anthropic from '@anthropic-ai/sdk';

export interface JudgeVerdict {
  ac_id: string;
  status: 'pass' | 'fail' | 'error';
  reasoning: string;
  evidence?: string;
}

export interface AcEvidence {
  id: string;
  description: string;
  agentVerdict: string;
  agentReasoning: string;
  screenshotBase64?: string;
}

const JUDGE_PROMPT = `You are a quality judge reviewing frontend verification results.
For each acceptance criterion, review the screenshot and agent log, then return a verdict.

Rules:
1. Use the SCREENSHOT as primary evidence. Agent verdict is context, not truth.
2. pass = criterion clearly met in the screenshot
3. fail = criterion clearly not met
4. error = agent crashed or hit login redirect — cannot judge
5. Be strict: if you cannot clearly confirm the criterion, mark as fail.
6. If a screenshot shows a login page, mark as error: "Auth redirect"

Return ONLY valid JSON:
{
  "criteria": [
    { "ac_id": "AC-1", "status": "pass|fail|error", "reasoning": "one sentence", "evidence": "what you see in screenshot" }
  ]
}`;

/**
 * Run the judge: send screenshots + agent verdicts to Opus for independent verification.
 */
export async function runJudge(
  evidence: AcEvidence[],
  log: (msg: string) => void,
): Promise<JudgeVerdict[]> {
  if (evidence.length === 0) return [];

  const client = new Anthropic();
  const contentBlocks: Anthropic.ContentBlockParam[] = [
    { type: 'text', text: JUDGE_PROMPT },
  ];

  for (const ac of evidence) {
    contentBlocks.push({
      type: 'text',
      text: `\n--- ${ac.id}: ${ac.description} ---\nAgent verdict: ${ac.agentVerdict}\nAgent reasoning: ${ac.agentReasoning}`,
    });

    if (ac.screenshotBase64) {
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: ac.screenshotBase64 },
      });
    } else {
      contentBlocks.push({
        type: 'text',
        text: '(No screenshot available for this AC)',
      });
    }
  }

  log(`Calling Opus judge with ${evidence.length} ACs, ${evidence.filter(e => e.screenshotBase64).length} screenshots`);

  const response = await client.messages.create({
    model: 'claude-opus-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: contentBlocks }],
  });

  const text = response.content.find((c) => c.type === 'text')?.text ?? '{}';
  log(`Judge response: ${text.slice(0, 300)}`);
  return parseJudgeResponse(text);
}

/** Parse the judge's JSON response into validated verdicts. Exported for testing. */
export function parseJudgeResponse(text: string): JudgeVerdict[] {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();

  try {
    const parsed = JSON.parse(cleaned) as { criteria?: unknown[] };
    if (!Array.isArray(parsed.criteria)) return [];

    return parsed.criteria
      .filter((item): item is { ac_id: string; status: string; reasoning: string; evidence?: string } =>
        typeof item === 'object' && item !== null &&
        'ac_id' in item && typeof (item as Record<string, unknown>).ac_id === 'string' &&
        'status' in item && typeof (item as Record<string, unknown>).status === 'string' &&
        'reasoning' in item && typeof (item as Record<string, unknown>).reasoning === 'string'
      )
      .map((item) => ({
        ac_id: item.ac_id,
        status: (['pass', 'fail', 'error'].includes(item.status) ? item.status : 'error') as 'pass' | 'fail' | 'error',
        reasoning: item.reasoning,
        evidence: typeof item.evidence === 'string' ? item.evidence : undefined,
      }));
  } catch {
    return [];
  }
}
