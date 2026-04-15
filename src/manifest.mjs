/**
 * Shared helpers for building a `pages` manifest, used by:
 *   - src/commands/export-pages.mjs (Next.js scanner)
 *   - src/commands/batch.mjs        (--sitemap / --routes input modes)
 *
 * A manifest looks like:
 *   {
 *     baseUrl: "http://localhost:3000",
 *     fileKey: "abc",
 *     generatedAt: "2026-...",
 *     counts: { total, included, dynamicSkipped },
 *     pages: [{ name, route, module, figmaPage, viewport, dynamic, dynamicParams?, source? }]
 *   }
 */

export function prettifySegment(s) {
  return s
    .split('-')
    .map((w) => (w.length === 0 ? '' : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

export function humanName(route) {
  const parts = route.split('/').filter(Boolean);
  if (parts.length === 0) return 'Root';
  return parts
    .map((p) => (p.startsWith('[') ? `{${p.slice(1, -1)}}` : prettifySegment(p)))
    .join(' / ');
}

export function moduleName(route) {
  const parts = route.split('/').filter(Boolean);
  return parts[0] ?? '_root';
}

export function figmaPageForModule(mod) {
  if (mod === '_root') return 'Root — Captures';
  return `${prettifySegment(mod)} — Captures`;
}

export function viewportForModule(mod, mobileSet = new Set(), tabletSet = new Set()) {
  if (mobileSet.has(mod)) return 'mobile';
  if (tabletSet.has(mod)) return 'tablet';
  return 'desktop';
}

export function isDynamic(route) {
  return /\[[^\]]+\]/.test(route);
}

function pageEntry(route, { mobileSet, tabletSet, source } = {}) {
  const dynamic = isDynamic(route);
  const mod = moduleName(route);
  return {
    name: humanName(route),
    route,
    module: mod,
    figmaPage: figmaPageForModule(mod),
    viewport: viewportForModule(mod, mobileSet ?? new Set(), tabletSet ?? new Set()),
    dynamic,
    dynamicParams: dynamic ? {} : undefined,
    ...(source ? { source } : {}),
  };
}

/**
 * Build a manifest from an explicit list of routes — the simplest path:
 *
 *   manifestFromRoutes({
 *     fileKey: 'abc',
 *     baseUrl: 'http://localhost:3000',
 *     routes: ['/', '/dashboard', '/billing'],
 *   });
 */
export function manifestFromRoutes({ fileKey, baseUrl, routes, mobileModules = '', tabletModules = '' }) {
  if (!fileKey) throw new Error('fileKey is required');
  if (!baseUrl) throw new Error('baseUrl is required');
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error('At least one route is required');
  }

  const mobileSet = new Set(splitList(mobileModules));
  const tabletSet = new Set(splitList(tabletModules));

  const normalized = routes
    .map((r) => normalizeRoute(r))
    .filter(Boolean);

  const seen = new Set();
  const pages = [];
  for (const r of normalized) {
    if (seen.has(r)) continue;
    seen.add(r);
    pages.push(pageEntry(r, { mobileSet, tabletSet }));
  }

  return manifestEnvelope({ baseUrl, fileKey, pages });
}

/**
 * Build a manifest by fetching a sitemap.xml. Handles sitemap indexes
 * (recursively expands nested <sitemap><loc>...</loc></sitemap>) and skips
 * URLs whose origin doesn't match the resolved baseUrl.
 *
 *   await manifestFromSitemap({
 *     fileKey: 'abc',
 *     sitemapUrl: 'http://localhost:3000/sitemap.xml',
 *   });
 *
 * If `baseUrl` is omitted, the sitemap URL's origin is used.
 */
export async function manifestFromSitemap({ fileKey, sitemapUrl, baseUrl, mobileModules = '', tabletModules = '' }) {
  if (!fileKey) throw new Error('fileKey is required');
  if (!sitemapUrl) throw new Error('sitemapUrl is required');

  const resolvedBase = (baseUrl ?? new URL(sitemapUrl).origin).replace(/\/$/, '');
  const urls = await fetchSitemapUrls(sitemapUrl);

  const mobileSet = new Set(splitList(mobileModules));
  const tabletSet = new Set(splitList(tabletModules));

  const seen = new Set();
  const pages = [];
  for (const u of urls) {
    const route = absUrlToRoute(u, resolvedBase);
    if (route === null) continue;
    if (seen.has(route)) continue;
    seen.add(route);
    pages.push(pageEntry(route, { mobileSet, tabletSet, source: u }));
  }

  if (pages.length === 0) {
    throw new Error(
      `No usable URLs found in sitemap ${sitemapUrl} (origin: ${resolvedBase}). ` +
      `If your sitemap lists URLs on a different origin, pass --base-url to override.`
    );
  }

  return manifestEnvelope({ baseUrl: resolvedBase, fileKey, pages });
}

// ---- internals ----------------------------------------------------------

function manifestEnvelope({ baseUrl, fileKey, pages }) {
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    fileKey,
    generatedAt: new Date().toISOString(),
    counts: {
      total: pages.length,
      included: pages.length,
      dynamicSkipped: 0,
    },
    pages,
  };
}

function splitList(csv) {
  return String(csv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeRoute(r) {
  if (!r) return null;
  let s = String(r).trim();
  if (!s) return null;
  // Accept full URLs; strip origin to a route.
  try {
    const u = new URL(s);
    s = u.pathname + (u.search || '');
  } catch { /* not a full URL — fine */ }
  if (!s.startsWith('/')) s = '/' + s;
  // Collapse trailing slash except for root.
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function absUrlToRoute(absUrl, baseUrl) {
  let u;
  try { u = new URL(absUrl); } catch { return null; }
  let base;
  try { base = new URL(baseUrl); } catch { return null; }
  if (u.origin !== base.origin) return null;
  let route = u.pathname + (u.search || '');
  if (route.length > 1 && route.endsWith('/')) route = route.slice(0, -1);
  return route || '/';
}

async function fetchSitemapUrls(sitemapUrl, depth = 0) {
  if (depth > 4) throw new Error(`Sitemap nesting too deep: ${sitemapUrl}`);
  const res = await fetch(sitemapUrl);
  if (!res.ok) throw new Error(`Sitemap fetch failed: HTTP ${res.status} ${sitemapUrl}`);
  const text = await res.text();

  // Sitemap index — recurse into each child sitemap.
  if (/<sitemapindex[\s>]/i.test(text)) {
    const childUrls = matchLocs(text);
    const all = await Promise.all(childUrls.map((c) => fetchSitemapUrls(c, depth + 1)));
    return all.flat();
  }

  return matchLocs(text);
}

function matchLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) out.push(decodeXmlEntities(m[1]));
  return out;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
