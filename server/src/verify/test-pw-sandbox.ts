/**
 * Test persistent browser via CDP: spawn Chrome directly, then navigate + snapshot as separate tool calls.
 * Verifies state persists across script executions via connectOverCDP.
 * Run: node --env-file=.env --import tsx/esm src/verify/test-pw-sandbox.ts
 */
import { E2BSandboxProvider } from '../sandbox/e2b-provider.js';

const provider = new E2BSandboxProvider();
const NODE_ENV = 'NODE_PATH=/usr/local/lib/node_modules:/usr/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/ms-playwright';
const CDP_PORT = 9222;

const CHROMIUM_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--js-flags=--jitless',
  '--disable-features=V8Sparkplug',
  `--remote-debugging-port=${CDP_PORT}`,
];

async function drain(stream: AsyncIterable<string>) {
  for await (const _ of stream) {}
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of stream) lines.push(line);
  return lines;
}

async function main() {
  console.log('Creating sandbox (opslane-verify-v2)...');
  const sandbox = await provider.create({
    template: 'opslane-verify-v2',
    timeoutMs: 600_000,
    envVars: { PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' },
    metadata: { sessionId: 'pw-cdp-test', userId: 'test' },
  });
  const id = sandbox.id;
  console.log(`Sandbox: ${id}`);

  try {
    // Step 1: Launch Chrome directly with --remote-debugging-port
    console.log('\n--- Step 1: Launch Chrome via CDP ---');
    const launchScript = `const { execSync } = require('child_process');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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

setTimeout(() => {}, 600000);
`;
    await provider.uploadFiles(id, [{ path: '/home/user/verify-browser-launch.cjs', content: launchScript }]);
    try {
      await drain(provider.runCommand(id,
        `nohup env ${NODE_ENV} node /home/user/verify-browser-launch.cjs > /home/user/browser.log 2>&1 & sleep 2`,
        { rawOutput: true, timeoutMs: 15_000 },
      ));
    } catch (err) {
      if (!(err instanceof Error && 'ptyOutput' in err)) throw err;
    }

    // Wait for CDP endpoint
    for (let i = 0; i < 10; i++) {
      try {
        const cdpUrl = await provider.readFile(id, '/home/user/browser-ws.txt');
        if (cdpUrl.startsWith('http://')) {
          console.log(`Browser ready: ${cdpUrl.trim()}`);
          break;
        }
      } catch { /* not ready */ }
      if (i === 9) {
        const log = await collect(provider.runCommand(id, 'cat /home/user/browser.log | tail -10', { rawOutput: true }));
        console.log('Browser log:', log.join('\n'));
        throw new Error('Browser not ready');
      }
      await new Promise(r => setTimeout(r, 1_000));
    }

    // Step 2: Navigate via connectOverCDP (persists state)
    console.log('\n--- Step 2: Navigate via CDP ---');
    const navScript = `const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:${CDP_PORT}');
  const contexts = browser.contexts();
  const context = contexts[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();
  await page.setContent('<h1>Persistent Test</h1><p>Counter: 42</p><button>Increment</button>');
  const text = await page.innerText('body');
  console.log(JSON.stringify({ ok: true, result: 'Page set. Body: ' + text }));
  process.exit(0);
})();
`;
    await provider.uploadFiles(id, [{ path: '/home/user/verify-browser-tool.cjs', content: navScript }]);
    const navOut = await collect(provider.runCommand(id,
      `${NODE_ENV} node /home/user/verify-browser-tool.cjs 2>&1`,
      { rawOutput: true, timeoutMs: 30_000 },
    ));
    for (const line of navOut) {
      try { const p = JSON.parse(line.trim()); console.log(p.ok ? 'OK:' : 'FAIL:', p.result || p.error); } catch {}
    }

    // Step 3: Snapshot (separate script — should see state from step 2)
    console.log('\n--- Step 3: Snapshot (should see persistent state) ---');
    const snapScript = `const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:${CDP_PORT}');
  const contexts = browser.contexts();
  const page = contexts[0]?.pages()[0];
  if (!page) { console.log(JSON.stringify({ ok: false, error: 'No page found' })); return; }
  const title = await page.title();
  const url = page.url();
  const bodyText = await page.innerText('body').catch(() => '(empty)');
  console.log(JSON.stringify({ ok: true, result: { title, url, bodyText } }));
  process.exit(0);
})();
`;
    await provider.uploadFiles(id, [{ path: '/home/user/verify-browser-tool.cjs', content: snapScript }]);
    const snapOut = await collect(provider.runCommand(id,
      `${NODE_ENV} node /home/user/verify-browser-tool.cjs 2>&1`,
      { rawOutput: true, timeoutMs: 30_000 },
    ));
    for (const line of snapOut) {
      try {
        const p = JSON.parse(line.trim());
        if (p.ok) {
          console.log('OK:', JSON.stringify(p.result));
          if (p.result.bodyText?.includes('Counter: 42')) {
            console.log('\n✅ STATE PERSISTED — snapshot sees content from navigate step!');
          } else {
            console.log('\n❌ STATE NOT PERSISTED — got:', p.result.bodyText?.slice(0, 100));
          }
        } else {
          console.log('FAIL:', p.error);
        }
      } catch {}
    }

  } finally {
    await provider.destroy(id);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
