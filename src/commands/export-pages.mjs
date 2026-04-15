/**
 * Scans a Next.js App Router project for page.tsx files and emits a JSON
 * manifest usable by `figma-capture batch`. Route groups ((foo)) are
 * stripped from URLs. Dynamic segments ([id], [...slug]) are preserved
 * in the route and flagged with dynamic=true — fill in concrete values
 * in dynamicParams before batch capture can render them.
 *
 * Usage:
 *   figma-capture export-pages \
 *     --root ./my-next-app \
 *     --base-url http://localhost:3000 \
 *     --file <FIGMA_FILE_KEY> \
 *     --out pages.json
 */
import { readdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  humanName,
  moduleName,
  figmaPageForModule,
  viewportForModule,
  isDynamic,
} from '../manifest.mjs';

export function registerExportPages(program) {
  program
    .command('export-pages')
    .description('Emit a pages.json manifest from a Next.js app/ directory')
    .requiredOption('-r, --root <dir>', 'Project root (containing app/ directory)')
    .requiredOption('-b, --base-url <url>', 'Base URL to prepend to each route')
    .requiredOption('-f, --file <fileKey>', 'Target Figma fileKey')
    .option('-o, --out <file>', 'Output JSON file', 'pages.json')
    .option('--include-dynamic', 'Include dynamic routes (with placeholder values) in output', true)
    .option('--app-dir <name>', 'Next.js app directory name', 'app')
    .option(
      '--mobile-modules <list>',
      'Comma-separated module names that should default to the mobile viewport (e.g. "consumer,auth")',
      ''
    )
    .option(
      '--tablet-modules <list>',
      'Comma-separated module names that should default to the tablet viewport',
      ''
    )
    .action(runExportPages);
}

async function walk(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.next')) continue;
      await walk(full, out);
    } else if (e.isFile() && e.name === 'page.tsx') {
      out.push(full);
    }
  }
  return out;
}

function fileToRoute(absFile, appRoot) {
  const rel = path.relative(appRoot, absFile);
  const dir = path.dirname(rel);
  const segments = dir === '.' ? [] : dir.split(path.sep);
  const urlSegs = segments.filter((s) => !/^\(.+\)$/.test(s));
  return '/' + urlSegs.join('/').replace(/^\/?$/, '');
}

async function runExportPages(opts) {
  const appRoot = path.join(opts.root, opts.appDir);
  try {
    const s = await stat(appRoot);
    if (!s.isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(`[export-pages] app dir not found: ${appRoot}`);
    process.exit(1);
  }

  const files = await walk(appRoot);
  files.sort();

  const mobileSet = new Set(opts.mobileModules.split(',').map((s) => s.trim()).filter(Boolean));
  const tabletSet = new Set(opts.tabletModules.split(',').map((s) => s.trim()).filter(Boolean));

  const pages = files.map((f) => {
    const route = fileToRoute(f, appRoot);
    const dynamic = isDynamic(route);
    const mod = moduleName(route);
    return {
      name: humanName(route),
      route,
      module: mod,
      figmaPage: figmaPageForModule(mod),
      viewport: viewportForModule(mod, mobileSet, tabletSet),
      dynamic,
      dynamicParams: dynamic ? {} : undefined,
      source: path.relative(opts.root, f),
    };
  });

  const included = opts.includeDynamic ? pages : pages.filter((p) => !p.dynamic);
  const skipped = pages.filter((p) => p.dynamic).map((p) => p.route);

  const manifest = {
    baseUrl: opts.baseUrl.replace(/\/$/, ''),
    fileKey: opts.file,
    generatedAt: new Date().toISOString(),
    counts: {
      total: pages.length,
      included: included.length,
      dynamicSkipped: skipped.length,
    },
    pages: included,
    ...(skipped.length && !opts.includeDynamic ? { dynamicSkipped: skipped } : {}),
  };

  const outPath = path.resolve(opts.out);
  await writeFile(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const byModule = {};
  for (const p of included) byModule[p.figmaPage] = (byModule[p.figmaPage] ?? 0) + 1;

  console.log(`[export-pages] wrote ${outPath}`);
  console.log(`  ${included.length} pages included, ${skipped.length} dynamic skipped`);
  console.log(`  grouped by Figma page:`);
  for (const [fp, n] of Object.entries(byModule).sort()) {
    console.log(`    ${fp.padEnd(30)}  ${n}`);
  }
}
