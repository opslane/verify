import Anthropic from '@anthropic-ai/sdk';
import type { SandboxProvider } from '../sandbox/types.js';
import { drain, collectOutput } from '../sandbox/stream.js';

const MAX_TURNS = 12;

interface BrowserAgentInput {
  goal: string;
  baseUrl: string;
  testEmail?: string;
  testPassword?: string;
}

export function buildBrowserAgentPrompt(input: BrowserAgentInput): string {
  let prompt = `You are a fast, efficient browser testing agent. Verify this acceptance criterion in as few steps as possible.

**Goal:** ${input.goal}
**Base URL:** ${input.baseUrl}

RULES:
- You have a maximum of ${MAX_TURNS} tool calls. Be efficient — plan your steps before starting.
- Start with "navigate" to the base URL, then "snapshot" to see the page.
- Use "snapshot" (not "screenshot") to see page content — it returns text you can analyze.
- When you have enough evidence, call "done" immediately. Don't keep testing.
- If a click/action fails twice, try a different selector or call "done" with "fail".

SELECTORS — CRITICAL:
- For clicking by text: use \`text=Button Text\` (Playwright text selector)
- For clicking buttons: use \`button:has-text("Label")\` (Playwright pseudo-class, NOT CSS :contains)
- For links: use \`a:has-text("Link Text")\`
- For data attributes: use \`[data-testid="foo"]\`
- NEVER use \`:contains()\` — it is NOT valid CSS and will error.

NAVIGATION PATTERN:
- Many apps have a nav menu on the home page. If the goal mentions a specific component/page, look at the snapshot text for nav items and click the matching one FIRST, then verify.
- Example: if snapshot shows "HomeUserCardWatcherBug" and goal mentions WatcherBug, click \`button:has-text("WatcherBug")\` first.
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
    name: 'console',
    description: 'Get browser console messages (errors, warnings, logs) from the current page',
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

const CDP_PORT = 9222;
const SANDBOX_ENV = 'NODE_PATH=/usr/local/lib/node_modules:/usr/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/ms-playwright';

/** Chromium launch args optimized for E2B containers (matches opslane-v2) */
const CHROMIUM_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--js-flags=--jitless',
  '--disable-features=V8Sparkplug',
  `--remote-debugging-port=${CDP_PORT}`,
];

/**
 * Launch a persistent Chromium browser in the sandbox.
 * Returns once the CDP endpoint is ready on the specified port.
 */
async function launchPersistentBrowser(
  provider: SandboxProvider,
  sandboxId: string,
  log: (msg: string) => void,
): Promise<void> {
  // Launch script: starts Chromium in the background, waits for CDP port
  // Launch Chrome directly with --remote-debugging-port so all connections
  // share the same browser state via CDP (unlike launchServer which isolates per-connection)
  const launchScript = `const { execSync } = require('child_process');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Find the headless shell binary
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.HOME, '.cache', 'ms-playwright');
let chromePath;
try {
  chromePath = execSync(\`find \${browsersPath} -name "chrome-headless-shell" -type f 2>/dev/null | head -1\`, { encoding: 'utf-8' }).trim();
} catch {}
if (!chromePath) {
  try {
    chromePath = execSync(\`find \${browsersPath} -name "chrome" -type f 2>/dev/null | head -1\`, { encoding: 'utf-8' }).trim();
  } catch {}
}
if (!chromePath) {
  console.log(JSON.stringify({ ok: false, error: 'Chrome binary not found in ' + browsersPath }));
  process.exit(1);
}

const args = ${JSON.stringify(CHROMIUM_LAUNCH_ARGS)}.concat([
  '--headless',
  '--hide-scrollbars',
  '--mute-audio',
  'about:blank',
]);

console.error('Launching:', chromePath);
const proc = spawn(chromePath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

proc.stderr.on('data', (data) => {
  const line = data.toString();
  // Chrome prints the DevTools URL to stderr
  const match = line.match(/DevTools listening on (ws:\\/\\/[^\\s]+)/);
  if (match) {
    fs.writeFileSync('/home/user/browser-ws.txt', 'http://127.0.0.1:${CDP_PORT}');
    console.log(JSON.stringify({ ok: true, cdp: 'http://127.0.0.1:${CDP_PORT}' }));
  }
});

proc.on('exit', (code) => {
  console.log(JSON.stringify({ ok: false, error: 'Chrome exited with code ' + code }));
  process.exit(1);
});

// Keep alive
setTimeout(() => {}, 600000);
`;

  await provider.uploadFiles(sandboxId, [{ path: '/home/user/verify-browser-launch.cjs', content: launchScript }]);

  // Fire-and-forget: launch browser in background
  log('Launching persistent browser...');
  try {
    await drain(provider.runCommand(
      sandboxId,
      `nohup env ${SANDBOX_ENV} node /home/user/verify-browser-launch.cjs > /home/user/browser.log 2>&1 & sleep 2`,
      { rawOutput: true, timeoutMs: 15_000 },
    ));
  } catch (err) {
    // PTY exit is expected for background commands
    if (!(err instanceof Error && 'ptyOutput' in err)) throw err;
  }

  // Wait for WebSocket endpoint file to appear
  for (let i = 0; i < 10; i++) {
    try {
      const cdpUrl = await provider.readFile(sandboxId, '/home/user/browser-ws.txt');
      if (cdpUrl && cdpUrl.startsWith('http://')) {
        log(`Browser ready (CDP): ${cdpUrl.trim()}`);
        return;
      }
    } catch {
      // File not created yet
    }
    await new Promise(r => setTimeout(r, 1_000));
  }

  // Check browser log for errors
  const browserLog = await collectOutput(provider.runCommand(
    sandboxId, 'cat /home/user/browser.log 2>/dev/null | tail -5', { rawOutput: true, timeoutMs: 5_000 },
  )).catch(() => 'No log');
  throw new Error(`Browser not ready after 10s. Log: ${browserLog}`);
}

/**
 * Build a tool script that connects to the persistent browser via CDP.
 * Reuses the first page — state persists across tool calls.
 *
 * SAFETY: `code` is interpolated into a JS template string. All user-controlled
 * values (URLs, selectors, fill text from LLM) MUST be escaped via JSON.stringify()
 * before inclusion in the `code` parameter. See dispatchBrowserTool for examples.
 */
function buildToolScript(code: string): string {
  return `const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:${CDP_PORT}');
  const contexts = browser.contexts();
  let page;
  if (contexts.length > 0 && contexts[0].pages().length > 0) {
    page = contexts[0].pages()[0];
  } else {
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    page = await context.newPage();
  }
  try {
    const result = await (async () => { ${code} })();
    console.log(JSON.stringify({ ok: true, result: result ?? null }));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }));
  } finally {
    // Just exit — browser process stays alive, CDP connection drops naturally
    process.exit(0);
  }
})();
`;
}

/**
 * Run a browser agent loop inside an E2B sandbox.
 * Launches a persistent Chromium browser, then Claude calls tools
 * (navigate, click, fill, snapshot, done) that connect via CDP.
 */
/**
 * Ensure the persistent browser is running. Call once before the AC loop.
 * Safe to call multiple times — checks if browser is already up.
 */
export async function ensureBrowserRunning(
  provider: SandboxProvider,
  sandboxId: string,
  log: (msg: string) => void,
): Promise<void> {
  // Check if browser is already running via CDP health probe
  try {
    const cdpUrl = await provider.readFile(sandboxId, '/home/user/browser-ws.txt');
    if (cdpUrl && cdpUrl.startsWith('http://')) {
      // Verify the process is actually alive by probing the CDP endpoint
      const probeOutput = await collectOutput(provider.runCommand(
        sandboxId,
        `curl -sf http://127.0.0.1:${CDP_PORT}/json/version 2>/dev/null && echo CDP_OK || echo CDP_DEAD`,
        { rawOutput: true, timeoutMs: 5_000 },
      ));
      if (probeOutput.includes('CDP_OK')) {
        log('Browser already running');
        return;
      }
      log('Browser sentinel exists but CDP is dead — relaunching');
    }
  } catch {
    // File doesn't exist — launch browser
  }
  await launchPersistentBrowser(provider, sandboxId, log);
}

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

    // Log agent's reasoning text
    const textBlocks = response.content.filter((c) => c.type === 'text');
    for (const tb of textBlocks) {
      if (tb.type === 'text') log(`Agent: ${tb.text.slice(0, 200)}`);
    }

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
        log(`Done: ${toolInput.result} | expected=${toolInput.expected ?? '-'} | observed=${toolInput.observed ?? '-'}`);
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

      // Log tool result (truncated)
      log(`Result(${toolUse.name}): ${toolResult.slice(0, 300)}`);

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
  try {
    let jsCode: string;

    switch (toolName) {
      case 'navigate': {
        log(`Navigate: ${input.url}`);
        // Inject console capture before navigation, then navigate
        jsCode = `
          await page.addInitScript(() => {
            if (window.__verifyConsoleInstalled) return;
            window.__verifyConsoleInstalled = true;
            window.__verifyConsole = [];
            const orig = { error: console.error, warn: console.warn };
            console.error = (...args) => { window.__verifyConsole.push({ type: 'error', text: args.map(String).join(' ') }); orig.error.apply(console, args); };
            console.warn = (...args) => { window.__verifyConsole.push({ type: 'warn', text: args.map(String).join(' ') }); orig.warn.apply(console, args); };
            window.addEventListener('error', (e) => { window.__verifyConsole.push({ type: 'error', text: e.message }); });
            window.addEventListener('unhandledrejection', (e) => { window.__verifyConsole.push({ type: 'error', text: String(e.reason) }); });
          });
          await page.goto(${JSON.stringify(input.url)}, { waitUntil: 'networkidle', timeout: 15000 });
          return 'Navigated to ' + page.url();`;
        break;
      }
      case 'click': {
        log(`Click: ${input.selector}`);
        jsCode = `await page.click(${JSON.stringify(input.selector)}, { timeout: 5000 }); return 'Clicked ' + ${JSON.stringify(input.selector)};`;
        break;
      }
      case 'fill': {
        log(`Fill: ${input.selector}`);
        jsCode = `await page.fill(${JSON.stringify(input.selector)}, ${JSON.stringify(input.value)}); return 'Filled ' + ${JSON.stringify(input.selector)};`;
        break;
      }
      case 'snapshot': {
        log('Snapshot');
        jsCode = `const title = await page.title(); return { title, url: page.url(), bodyText: (await page.innerText('body').catch(() => '(empty)')).slice(0, 2000) };`;
        break;
      }
      case 'screenshot': {
        log('Screenshot');
        jsCode = `await page.screenshot({ path: '/home/user/screenshot.png', fullPage: true }); return 'Screenshot saved';`;
        break;
      }
      case 'console': {
        log('Console');
        jsCode = `const msgs = await page.evaluate(() => window.__verifyConsole || []);
          if (msgs.length === 0) return 'No console errors or warnings captured.';
          return msgs.map(m => m.type.toUpperCase() + ': ' + m.text).join('\\n');`;
        break;
      }
      default:
        return `Unknown tool: ${toolName}`;
    }

    // Upload tool script and execute — connects to persistent browser via CDP
    const scriptPath = '/home/user/verify-browser-tool.cjs';
    const scriptContent = buildToolScript(jsCode);
    await provider.uploadFiles(sandboxId, [{ path: scriptPath, content: scriptContent }]);
    const output = await collectOutput(provider.runCommand(
      sandboxId,
      `${SANDBOX_ENV} node ${scriptPath}`,
      { rawOutput: true, timeoutMs: 60_000 },
    ));

    // Parse JSON result from output
    const lines = output.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.ok) {
          return typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);
        } else {
          return `Error: ${parsed.error}`;
        }
      } catch {
        // Not JSON, skip
      }
    }

    return output || 'No output from browser tool';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Tool error (${toolName}): ${msg}`);
    return `Error: ${msg}`;
  }
}

