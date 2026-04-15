/**
 * Batch capture command. Three input modes:
 *
 *   1. Manifest:  figma-capture batch --manifest pages.json
 *   2. Sitemap:   figma-capture batch --file <key> --sitemap http://localhost:3000/sitemap.xml
 *   3. Routes:    figma-capture batch --file <key> --base-url http://localhost:3000 --routes "/,/dashboard"
 *
 * Handles retry, timeout, resume (status file), and optional concurrency.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ensureChromeCdp, ensurePlaywright } from '../browser.mjs';
import { getCaptureTarget, pollCaptureResult } from '../mcp.mjs';
import { runCapture } from '../capture.mjs';
import { placeCapturedFrame, resolveAndCreateFreshPages } from '../figma-arrange.mjs';
import { manifestFromRoutes, manifestFromSitemap } from '../manifest.mjs';

const log = (...args) => console.log('[batch]', ...args);

export function registerBatch(program) {
  program
    .command('batch')
    .description('Batch capture pages into Figma — from a manifest, sitemap, or inline route list')
    .option('-m, --manifest <file>', 'pages.json manifest path (mode 1)')
    .option('--sitemap <url>', 'sitemap.xml URL to auto-discover routes (mode 2)')
    .option('--routes <list>', 'Comma-separated list of routes/URLs (mode 3)')
    .option('-f, --file <fileKey>', 'Figma fileKey (required for --sitemap / --routes)')
    .option('-b, --base-url <url>', 'Base URL (required for --routes; optional override for --sitemap)')
    .option('--mobile-modules <list>', 'Modules to default to mobile viewport (--sitemap / --routes only)', '')
    .option('--tablet-modules <list>', 'Modules to default to tablet viewport (--sitemap / --routes only)', '')
    .option('--concurrency <n>', 'Number of pages to capture in parallel (1=sequential, max 8)', '1')
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
    .action(runBatch);
}

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

async function loadManifestFromOpts(opts) {
  const modes = [opts.manifest, opts.sitemap, opts.routes].filter(Boolean);
  if (modes.length === 0) {
    throw new Error('Pick one input mode: --manifest <file>, --sitemap <url>, or --routes <list>');
  }
  if (modes.length > 1) {
    throw new Error('Pick only one input mode: --manifest, --sitemap, or --routes (got multiple)');
  }

  if (opts.manifest) {
    const manifestPath = path.resolve(opts.manifest);
    const m = await loadJson(manifestPath);
    if (!m) throw new Error(`cannot read manifest: ${manifestPath}`);
    return { manifest: m, manifestPath };
  }

  if (opts.sitemap) {
    if (!opts.file) throw new Error('--sitemap requires --file <fileKey>');
    log(`fetching sitemap: ${opts.sitemap}`);
    const m = await manifestFromSitemap({
      fileKey: opts.file,
      sitemapUrl: opts.sitemap,
      baseUrl: opts.baseUrl,
      mobileModules: opts.mobileModules,
      tabletModules: opts.tabletModules,
    });
    log(`  discovered ${m.pages.length} routes (origin: ${m.baseUrl})`);
    return { manifest: m, manifestPath: null };
  }

  if (!opts.file) throw new Error('--routes requires --file <fileKey>');
  if (!opts.baseUrl) throw new Error('--routes requires --base-url <url>');
  const routes = opts.routes.split(',').map((s) => s.trim()).filter(Boolean);
  const m = manifestFromRoutes({
    fileKey: opts.file,
    baseUrl: opts.baseUrl,
    routes,
    mobileModules: opts.mobileModules,
    tabletModules: opts.tabletModules,
  });
  log(`  built manifest from ${m.pages.length} inline route(s)`);
  return { manifest: m, manifestPath: null };
}

async function runBatch(opts) {
  const { manifest, manifestPath } = await loadManifestFromOpts(opts);

  const shortKey = (manifest.fileKey || '').slice(0, 12) || 'unknown';
  const defaultStatusPath = manifestPath
    ? manifestPath.replace(/\.json$/, `.${shortKey}.status.json`)
    : path.resolve(`figma-capture-${shortKey}.status.json`);
  const statusPath = opts.status ? path.resolve(opts.status) : defaultStatusPath;

  let status = await loadJson(statusPath);
  if (!status) status = { completed: {}, failed: {} };
  if (opts.force) status = { completed: {}, failed: {} };

  // Defensive: drop completed entries that belong to a different fileKey.
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
    pageNameMap: {},
    pageIdMap: {},
    appendExisting: !!opts.appendExisting,
  };
  if (pageSuffix) log(`page suffix: "— ${pageSuffix}" appended to every figmaPage`);

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

  const concurrency = Math.max(1, Math.min(8, Number(opts.concurrency) || 1));
  if (concurrency > 1) log(`concurrency: ${concurrency} (parallel captures)`);

  let ok = 0;
  let fail = 0;
  let nextIndex = 0;
  let writeChain = Promise.resolve();
  const persistStatus = () => {
    writeChain = writeChain.then(() =>
      writeFile(statusPath, JSON.stringify(status, null, 2) + '\n', 'utf8').catch(() => {})
    );
    return writeChain;
  };

  async function worker(workerIdx) {
    while (true) {
      const i = nextIndex++;
      if (i >= todo.length) return;
      const page = todo[i];
      const tag = concurrency > 1 ? `[w${workerIdx} ${i + 1}/${todo.length}]` : `[${i + 1}/${todo.length}]`;
      log(`${tag} ${page.route} → ${page.figmaPage} / "${page.name}"`);
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
        log(`  ✗ ${page.route} failed: ${e?.message ?? e}`);
      }
      await persistStatus();
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, (_, w) => worker(w + 1))
  );
  await writeChain;

  log(`done — ${ok} ok, ${fail} failed, status: ${statusPath}`);
  if (fail > 0) process.exitCode = 1;
}
