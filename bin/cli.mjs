#!/usr/bin/env node
import { Command } from 'commander';
import { ensureChromeCdp, ensurePlaywright } from '../src/browser.mjs';
import { getCaptureTarget, pollCaptureResult } from '../src/mcp.mjs';
import { runCapture } from '../src/capture.mjs';

const program = new Command();
program
  .name('figma-capture')
  .description('Capture a web page into a Figma file via MCP + Playwright')
  .argument('<url>', 'Target URL to capture')
  .requiredOption('-f, --file <fileKey>', 'Target Figma fileKey')
  .option('-n, --node <nodeId>', 'Optional Figma node ID to add the capture inside')
  .option('-s, --selector <selector>', 'CSS selector to capture', 'body')
  .option('-v, --viewport <preset>', 'Viewport preset: mobile|tablet|desktop', 'desktop')
  .option('--delay <ms>', 'Delay before triggering capture (ms)', '1500')
  .option('--no-fixed-size', 'Do not pin the selector to viewport dimensions (variable-size captures)')
  .option('--cdp', 'Use an already-running Chrome via CDP instead of a Playwright-managed Chromium', false)
  .option('-p, --port <port>', 'Chrome CDP port (only with --cdp)', '9225')
  .option('--alias <name>', 'Shell alias that starts Chrome with CDP (only with --cdp)', 'chrome-cdp')
  .option('--keep-page', 'Leave the captured page open after success')
  .option('--no-poll', 'Skip polling; just trigger capture and exit')
  .parse(process.argv);

const [targetUrl] = program.args;
const opts = program.opts();

const log = (...args) => console.log('[figma-capture]', ...args);

async function main() {
  let cdpUrl = null;
  if (opts.cdp) {
    log(`Ensuring Chrome CDP on :${opts.port}`);
    const chromeStatus = await ensureChromeCdp({
      port: Number(opts.port),
      aliasCommand: opts.alias,
    });
    log(chromeStatus.started ? '  started Chrome via alias' : '  already running');
    cdpUrl = `http://127.0.0.1:${opts.port}`;
  } else {
    log('Ensuring Playwright Chromium');
    await ensurePlaywright({ log: (m) => log(' ', m) });
  }

  log(`Requesting capture target for file=${opts.file}${opts.node ? ` node=${opts.node}` : ''}`);
  const { captureId, endpoint } = await getCaptureTarget({
    fileKey: opts.file,
    nodeId: opts.node,
  });
  log(`  captureId=${captureId}`);

  log(`Capturing ${targetUrl}`);
  await runCapture({
    cdpUrl,
    url: targetUrl,
    captureId,
    endpoint,
    selector: opts.selector,
    delayMs: Number(opts.delay),
    keepPageOpen: !!opts.keepPage,
    viewport: opts.viewport,
    fixedSize: opts.fixedSize !== false,
  });
  log('  capture submitted');

  if (opts.poll === false) {
    log('Skipping poll (--no-poll)');
    console.log(JSON.stringify({ captureId, endpoint }, null, 2));
    return;
  }

  log('Polling Figma for conversion result…');
  const result = await pollCaptureResult({ captureId });
  log('Done');
  if (result.figmaUrl) {
    console.log(result.figmaUrl);
  } else {
    console.log(result.raw);
  }
}

main().catch((err) => {
  console.error('[figma-capture] error:', err?.message ?? err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
