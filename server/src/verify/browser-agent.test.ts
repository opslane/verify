import { describe, it, expect } from 'vitest';
import { buildBrowserAgentPrompt, BROWSER_TOOLS } from './browser-agent.js';

describe('browser-agent', () => {
  it('includes goal in system prompt', () => {
    const prompt = buildBrowserAgentPrompt({
      goal: 'Verify login page loads',
      baseUrl: 'http://localhost:3000',
    });
    expect(prompt).toContain('Verify login page loads');
    expect(prompt).toContain('http://localhost:3000');
  });

  it('includes test credentials when provided', () => {
    const prompt = buildBrowserAgentPrompt({
      goal: 'Verify dashboard',
      baseUrl: 'http://localhost:3000',
      testEmail: 'test@example.com',
      testPassword: 'password123',
    });
    expect(prompt).toContain('test@example.com');
    expect(prompt).toContain('password123');
  });

  it('exports browser tools array', () => {
    expect(BROWSER_TOOLS).toBeDefined();
    expect(BROWSER_TOOLS.length).toBeGreaterThan(0);
    const toolNames = BROWSER_TOOLS.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('snapshot');
    expect(toolNames).toContain('navigate');
    expect(toolNames).toContain('click');
    expect(toolNames).toContain('done');
  });
});
