#!/usr/bin/env node
/**
 * Batch-captures every page listed in a manifest (produced by export-pages.mjs)
 * into a Figma file. Handles retry, timeout, and resume via an adjacent
 * status file.
 *
 * Usage:
 *   node bin/batch.mjs --manifest pages.json
 *   node bin/batch.mjs --manifest pages.json --only business        # single module
 *   node bin/batch.mjs --manifest pages.json --retries 3 --retry-delay 4000
 *   node bin/batch.mjs --manifest pages.json --dry-run
 */
import { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ensureChromeCdp, ensurePlaywright } from '../src/browser.mjs';
import { getCaptureTarget, pollCaptureResult } from '../src/mcp.mjs';
import { runCapture } from '../src/capture.mjs';
import { placeCapturedFrame, resolveAndCreateFreshPages } from '../src/figma-arrange.mjs';

const program = new Command();
program
  .name('figma-capture-batch')
  .description('Batch capture all pages from a pages.json manifest into Figma')
  .requiredOption('-m, --manifest <file>', 'pages.json manifest path')
  .option('--only <module>', 'Capture only pages whose module matches (e.g. business)')
  .option('--limit <n>', 'Stop after N pages (for smoke tests)', '0')
  .option('--status <file>', 'Status file for resume (defaults next to manifest)')
  .option('--retries <n>', 'Retries per page on failure', '2')
  .option('--retry-delay <ms>', 'Base delay between retries (exponential)', '3000')
  .option('--page-timeout <ms>', 'Hard timeout for a single page capture+arrange', '180000')
  .option('--poll-timeout <ms>', 'Total time to wait for Figma conversion per page', '120000')
  .option('--cdp', 'Use an already-running Chrome via CDP instead of a Playwright-managed Chromium', false)
  .option('-p, --port <port>', 'Chrome CDP port (only with --cdp)', '9225')
  .option('--alias <name>', 'Shell alias that starts Chrome with CDP (only with --cdp)', 'chrome-cdp')
  .option('--selector <sel>', 'CSS selector to capture', 'body')
  .option('--delay <ms>', 'Delay before triggering capture (ms)', '1500')
  .option('--no-fixed-size', 'Do not pin the selector to viewport dimensions')
  .option('--no-arrange', 'Skip renaming/moving the captured frame via use_figma')
  .option('--page-suffix <text>', 'Suffix appended to every figmaPage (e.g. "v2" or "@now" for timestamp)')
  .option('--append-existing', 'Append captures to existing Figma pages instead of creating new ones', false)
  .option('--skip-completed', 'Skip pages marked completed in status file', true)
  .option('--force', 'Ignore status file, re-capture everything', false)
  .option('--dry-run', 'List what would run without executing', false)
  .parse(process.argv);

const opts = program.opts();

const log = (...args) => console.log('[batch]', ...args);

function withTimeout(promise, ms, label) {
  let to;
  const timeoutPromise = new Promise((_, rej) => {
    to = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(to));
}

async function loadJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return null; }
}

function substituteDynamic(route, params) {
  return route.replace(/\[(\.\.\.)?([^\]]+)\]/g, (_, spread, key) => {
    const v = params?.[key];
    if (!v) throw new Error(`Missing dynamicParams.${key} for route ${route}`);
    return v;
  });
}

async function processPage(page, ctx) {
  const resolvedRoute = page.dynamic
    ? substituteDynamic(page.route, page.dynamicParams)
    : page.route;
  const url = `${ctx.baseUrl}${resolvedRoute}`;

  const desired = ctx.pageSuffix ? `${page.figmaPage} — ${ctx.pageSuffix}` : page.figmaPage;
  const resolvedPageName = ctx.pageNameMap?.[desired] ?? desired;
  const resolvedPageId = ctx.pageIdMap?.[desired];

  log(`  capture → ${url}`);
  // Pass the target page's nodeId so generate_figma_design creates the frame
  // directly on the right Figma page — never touches hand-crafted pages.
  const { captureId, endpoint } = await getCaptureTarget({
    fileKey: ctx.fileKey,
    nodeId: resolvedPageId,
  });

  await runCapture({
    cdpUrl: ctx.cdpUrl,
    url,
    captureId,
    endpoint,
    selector: ctx.selector,
    delayMs: ctx.delay,
    viewport: page.viewport ?? 'desktop',
    fixedSize: ctx.fixedSize,
  });

  const pollResult = await withTimeout(
    pollCaptureResult({ captureId, maxAttempts: Math.ceil(ctx.pollTimeout / 5000), intervalMs: 5000 }),
    ctx.pollTimeout,
    'Figma conversion poll'
  );

  let arranged = null;
  if (ctx.arrange && pollResult.nodeId) {
    try {
      arranged = await placeCapturedFrame({
        fileKey: ctx.fileKey,
        nodeId: pollResult.nodeId,
        newName: page.name,
        targetPageName: resolvedPageName,
        targetPageId: resolvedPageId,
      });
      log(`    placed → ${arranged.pageName} (${arranged.x}, ${arranged.y})`);
    } catch (e) {
      log(`    arrange failed: ${e.message}`);
    }
  }

  return {
    route: page.route,
    resolvedRoute,
    captureId,
    nodeId: pollResult.nodeId,
    figmaUrl: pollResult.figmaUrl,
    arranged,
    timestamp: Date.now(),
  };
}

async function captureWithRetry(page, ctx) {
  let lastError;
  for (let attempt = 0; attempt <= ctx.retries; attempt++) {
    if (attempt > 0) {
      const wait = ctx.retryDelay * Math.pow(2, attempt - 1);
      log(`  retry ${attempt}/${ctx.retries} after ${wait}ms (prev: ${lastError?.message ?? '?'})`);
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      return await withTimeout(
        processPage(page, ctx),
        ctx.pageTimeout,
        `page ${page.route}`
      );
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

async function main() {
  const manifestPath = path.resolve(opts.manifest);

  const manifest = await loadJson(manifestPath);
  if (!manifest) {
    console.error(`[batch] cannot read manifest: ${manifestPath}`);
    process.exit(1);
  }

  // Scope the status file by fileKey so captures for different Figma files
  // don't cross-contaminate (different file = unshared "completed" state).
  const shortKey = (manifest.fileKey || '').slice(0, 12) || 'unknown';
  const statusPath = opts.status
    ? path.resolve(opts.status)
    : manifestPath.replace(/\.json$/, `.${shortKey}.status.json`);

  let status = await loadJson(statusPath);
  if (!status) status = { completed: {}, failed: {} };
  if (opts.force) status = { completed: {}, failed: {} };

  // Defensive: if someone points --status at a shared file, still filter out
  // entries whose stored figmaUrl refers to a different fileKey.
  const currentFileKey = manifest.fileKey;
  const originalCompleted = status.completed;
  status.completed = {};
  let droppedForeign = 0;
  for (const [route, entry] of Object.entries(originalCompleted)) {
    const m = (entry?.figmaUrl || '').match(/figma\.com\/design\/([^?\/]+)/);
    const keyInEntry = m?.[1];
    if (!keyInEntry || keyInEntry === currentFileKey) {
      status.completed[route] = entry;
    } else {
      droppedForeign++;
    }
  }
  if (droppedForeign) {
    log(`ignored ${droppedForeign} completed entries that belong to a different fileKey`);
  }

  let todo = manifest.pages;
  if (opts.only) todo = todo.filter((p) => p.module === opts.only);
  if (opts.skipCompleted && !opts.force) {
    todo = todo.filter((p) => !status.completed[p.route]);
  }
  const limit = Number(opts.limit);
  if (limit > 0) todo = todo.slice(0, limit);

  log(`manifest: ${todo.length} pages to capture (${manifest.pages.length} total)`);
  if (opts.dryRun) {
    for (const p of todo) {
      console.log(`  ${p.route.padEnd(40)} → ${p.figmaPage} / "${p.name}"${p.dynamic ? ' [dynamic]' : ''}`);
    }
    return;
  }

  let cdpUrl = null;
  if (opts.cdp) {
    log(`ensuring Chrome CDP on :${opts.port}`);
    await ensureChromeCdp({ port: Number(opts.port), aliasCommand: opts.alias });
    cdpUrl = `http://127.0.0.1:${opts.port}`;
  } else {
    log('ensuring Playwright Chromium');
    await ensurePlaywright({ log: (m) => log(' ', m) });
  }

  // '@now' expands to an ISO-ish timestamp once per batch — so every page in
  // this run lands on the same generated Figma page per module.
  let pageSuffix = opts.pageSuffix ?? '';
  if (pageSuffix === '@now') {
    const d = new Date();
    pageSuffix = d.toISOString().slice(0, 16).replace('T', ' ');
  }

  const ctx = {
    baseUrl: manifest.baseUrl,
    fileKey: manifest.fileKey,
    cdpUrl,
    fixedSize: opts.fixedSize !== false,
    port: opts.port,
    selector: opts.selector,
    delay: Number(opts.delay),
    retries: Number(opts.retries),
    retryDelay: Number(opts.retryDelay),
    pageTimeout: Number(opts.pageTimeout),
    pollTimeout: Number(opts.pollTimeout),
    arrange: opts.arrange !== false,
    pageSuffix,
    pageNameMap: {}, // desired → actual (resolved at batch start)
    pageIdMap: {},   // desired → Figma page nodeId (used to create frame directly on right page)
    appendExisting: !!opts.appendExisting,
  };
  if (pageSuffix) log(`page suffix: "— ${pageSuffix}" appended to every figmaPage`);

  // Unless --append-existing is set, pre-create FRESH Figma pages for every
  // unique target in this batch. Auto-resolves name collisions with " (2)" /
  // " (3)" suffixes. All frames in this run land on these fresh pages.
  if (ctx.arrange && !ctx.appendExisting) {
    const desired = [
      ...new Set(
        todo.map((p) =>
          ctx.pageSuffix ? `${p.figmaPage} — ${ctx.pageSuffix}` : p.figmaPage
        )
      ),
    ];
    log(`creating ${desired.length} fresh Figma page(s)`);
    const { resolved, pageIds, created } = await resolveAndCreateFreshPages({
      fileKey: ctx.fileKey,
      desiredNames: desired,
    });
    ctx.pageNameMap = resolved ?? {};
    ctx.pageIdMap = pageIds ?? {};
    for (const c of created ?? []) {
      log(`  ${c.desired}${c.desired === c.actual ? '' : ` → ${c.actual}`}`);
    }
  }

  let ok = 0;
  let fail = 0;
  for (const [i, page] of todo.entries()) {
    log(`[${i + 1}/${todo.length}] ${page.route} → ${page.figmaPage} / "${page.name}"`);
    try {
      const result = await captureWithRetry(page, ctx);
      status.completed[page.route] = result;
      delete status.failed[page.route];
      ok++;
    } catch (e) {
      status.failed[page.route] = {
        attempts: ctx.retries + 1,
        lastError: String(e?.message ?? e),
        timestamp: Date.now(),
      };
      fail++;
      log(`  ✗ failed: ${e?.message ?? e}`);
    }
    // Persist after every page so a crash mid-batch doesn't lose progress.
    await writeFile(statusPath, JSON.stringify(status, null, 2) + '\n', 'utf8');
  }

  log(`done — ${ok} ok, ${fail} failed, status: ${statusPath}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[batch] fatal:', e?.message ?? e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
