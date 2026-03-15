import { describe, it, expect } from 'vitest';
import { parseJudgeResponse } from './judge.js';

describe('parseJudgeResponse', () => {
  it('parses valid judge JSON', () => {
    const input = JSON.stringify({
      criteria: [
        { ac_id: 'AC-1', status: 'pass', reasoning: 'Heading matches', evidence: 'screenshot shows correct heading' },
        { ac_id: 'AC-2', status: 'fail', reasoning: 'Button label wrong', evidence: 'screenshot shows old label' },
      ],
    });
    const result = parseJudgeResponse(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ ac_id: 'AC-1', status: 'pass', reasoning: 'Heading matches', evidence: 'screenshot shows correct heading' });
    expect(result[1].status).toBe('fail');
  });

  it('handles code-fenced JSON', () => {
    const input = '```json\n{"criteria":[{"ac_id":"AC-1","status":"pass","reasoning":"ok","evidence":"ok"}]}\n```';
    const result = parseJudgeResponse(input);
    expect(result).toHaveLength(1);
  });

  it('returns empty array for malformed JSON', () => {
    expect(parseJudgeResponse('not json')).toEqual([]);
  });

  it('filters out entries with missing fields', () => {
    const input = JSON.stringify({
      criteria: [
        { ac_id: 'AC-1', status: 'pass', reasoning: 'ok' },
        { status: 'fail' },
      ],
    });
    const result = parseJudgeResponse(input);
    expect(result).toHaveLength(1);
  });

  it('normalizes invalid status to error', () => {
    const input = JSON.stringify({
      criteria: [{ ac_id: 'AC-1', status: 'maybe', reasoning: 'unsure' }],
    });
    const result = parseJudgeResponse(input);
    expect(result[0].status).toBe('error');
  });
});
