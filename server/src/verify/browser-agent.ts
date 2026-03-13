import Anthropic from '@anthropic-ai/sdk';
import type { SandboxProvider } from '../sandbox/types.js';

interface BrowserAgentInput {
  goal: string;
  baseUrl: string;
  testEmail?: string;
  testPassword?: string;
}

export function buildBrowserAgentPrompt(input: BrowserAgentInput): string {
  let prompt = `You are a browser testing agent. Your goal is to verify the following acceptance criterion:

**Goal:** ${input.goal}

**Base URL:** ${input.baseUrl}

Use the provided tools to interact with the browser. Start by navigating to the base URL, then interact with the page to verify the criterion.

When you have enough evidence to determine if the criterion passes or fails, call the "done" tool with your verdict.
`;

  if (input.testEmail || input.testPassword) {
    prompt += `
**Test Credentials:**
- Email: ${input.testEmail ?? 'N/A'}
- Password: ${input.testPassword ?? 'N/A'}

Use these credentials if the criterion requires authentication.
`;
  }

  return prompt;
}

interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const BROWSER_TOOLS: ToolDef[] = [
  {
    name: 'navigate',
    description: 'Navigate the browser to a URL',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to navigate to' },
      },
      required: ['url'],
    },
  },
  {
    name: 'click',
    description: 'Click an element matching a CSS selector or accessible name',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or accessible name to click' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'fill',
    description: 'Fill an input field with text',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input' },
        value: { type: 'string', description: 'Text to fill' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'snapshot',
    description: 'Get the current page accessibility snapshot (DOM tree)',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of the current page',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'done',
    description: 'Report the final verdict for this acceptance criterion',
    input_schema: {
      type: 'object',
      properties: {
        result: { type: 'string', enum: ['pass', 'fail'], description: 'Whether the criterion passed or failed' },
        expected: { type: 'string', description: 'What was expected (for failures)' },
        observed: { type: 'string', description: 'What was actually observed (for failures)' },
      },
      required: ['result'],
    },
  },
];

export interface AgentVerdict {
  result: 'pass' | 'fail' | 'error';
  expected?: string;
  observed?: string;
  error?: string;
}

const MAX_TURNS = 20;

/**
 * Run a browser agent loop inside an E2B sandbox.
 * Claude calls tools (navigate, click, fill, snapshot, done) and we dispatch them
 * as Playwright commands inside the sandbox via the provider.
 */
export async function runBrowserAgent(
  provider: SandboxProvider,
  sandboxId: string,
  input: BrowserAgentInput,
  log: (msg: string) => void,
): Promise<AgentVerdict> {
  const client = new Anthropic();
  const systemPrompt = buildBrowserAgentPrompt(input);

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: 'Begin testing. Navigate to the base URL and verify the acceptance criterion.' },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    log(`Turn ${turn + 1}/${MAX_TURNS}`);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      tools: BROWSER_TOOLS as Anthropic.Tool[],
      messages,
    });

    // Check for done or no more tool use
    if (response.stop_reason === 'end_turn') {
      const textContent = response.content.find((c) => c.type === 'text');
      return {
        result: 'error',
        error: `Agent ended without calling done tool. Last message: ${textContent?.text ?? 'none'}`,
      };
    }

    // Process tool calls
    const toolUseBlocks = response.content.filter((c) => c.type === 'tool_use');
    if (toolUseBlocks.length === 0) {
      return { result: 'error', error: 'No tool use in response' };
    }

    // Add assistant message
    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      if (toolUse.type !== 'tool_use') continue;
      const toolInput = toolUse.input as Record<string, string>;

      // Handle done tool
      if (toolUse.name === 'done') {
        if (toolInput.result !== 'pass' && toolInput.result !== 'fail') {
          return { result: 'error', error: `Invalid done result: ${toolInput.result}` };
        }
        return {
          result: toolInput.result,
          expected: toolInput.expected,
          observed: toolInput.observed,
        };
      }

      // Dispatch browser tool to sandbox
      const toolResult = await dispatchBrowserTool(
        provider, sandboxId, toolUse.name, toolInput, log,
      );

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: toolResult,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return { result: 'error', error: `Agent exceeded max turns (${MAX_TURNS})` };
}

async function dispatchBrowserTool(
  provider: SandboxProvider,
  sandboxId: string,
  toolName: string,
  input: Record<string, string>,
  log: (msg: string) => void,
): Promise<string> {
  const workDir = '/home/user/repo';

  try {
    switch (toolName) {
      case 'navigate': {
        log(`Navigate: ${input.url}`);
        const output = await collectOutput(provider.runCommand(
          sandboxId,
          `cd ${workDir} && npx playwright evaluate "await page.goto('${shellEscape(input.url)}', { waitUntil: 'networkidle' }); 'navigated'"`,
        ));
        return output || 'Navigated successfully';
      }
      case 'click': {
        log(`Click: ${input.selector}`);
        const output = await collectOutput(provider.runCommand(
          sandboxId,
          `cd ${workDir} && npx playwright evaluate "await page.click('${shellEscape(input.selector)}'); 'clicked'"`,
        ));
        return output || 'Clicked successfully';
      }
      case 'fill': {
        log(`Fill: ${input.selector}`);
        const output = await collectOutput(provider.runCommand(
          sandboxId,
          `cd ${workDir} && npx playwright evaluate "await page.fill('${shellEscape(input.selector)}', '${shellEscape(input.value)}'); 'filled'"`,
        ));
        return output || 'Filled successfully';
      }
      case 'snapshot': {
        log('Snapshot');
        const output = await collectOutput(provider.runCommand(
          sandboxId,
          `cd ${workDir} && npx playwright evaluate "await page.accessibility.snapshot()"`,
        ));
        return output || 'Empty snapshot';
      }
      case 'screenshot': {
        log('Screenshot');
        const output = await collectOutput(provider.runCommand(
          sandboxId,
          `cd ${workDir} && npx playwright evaluate "await page.screenshot({ path: '/tmp/screenshot.png' }); 'screenshot saved'"`,
        ));
        return output || 'Screenshot taken';
      }
      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Tool error (${toolName}): ${msg}`);
    return `Error: ${msg}`;
  }
}

/** Escape a string for use inside single quotes in shell (POSIX idiom: replace ' with '\'') */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

async function collectOutput(stream: AsyncIterable<string>): Promise<string> {
  const lines: string[] = [];
  for await (const line of stream) { lines.push(line); }
  return lines.join('\n');
}
