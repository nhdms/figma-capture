import { ensurePlaywright } from './browser.mjs';

const CAPTURE_SCRIPT_URL = 'https://mcp.figma.com/mcp/html-to-design/capture.js';

const log = (...args) => console.log('[figma-capture]  ', ...args);

// Viewport presets. Every capture at a given preset lands in Figma at exactly
// these dimensions — we pin html/body width (and min-height) before invoking
// captureForDesign() so page-to-page body metrics never drift.
export const VIEWPORT_PRESETS = {
  mobile:  { width: 430,  height: 932  }, // iPhone 14 Pro Max
  tablet:  { width: 1024, height: 1366 }, // iPad Pro 13"
  desktop: { width: 1440, height: 900  }, // MacBook-ish, Figma-friendly
};

function resolveViewport(viewport) {
  if (!viewport) return VIEWPORT_PRESETS.desktop;
  if (typeof viewport === 'object' && viewport.width && viewport.height) return viewport;
  const preset = VIEWPORT_PRESETS[viewport];
  if (!preset) throw new Error(`Unknown viewport preset: ${viewport}. Use mobile|tablet|desktop or {width,height}.`);
  return preset;
}

async function acquireBrowser({ cdpUrl }) {
  const { chromium } = await ensurePlaywright({ log });
  if (cdpUrl) {
    log(`connecting to Chrome CDP at ${cdpUrl}`);
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    return { browser, context, ownsBrowser: false };
  }
  log('launching Playwright-managed Chromium');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  return { browser, context, ownsBrowser: true };
}

/**
 * Opens the target URL, strips CSP headers via route interception, injects the
 * Figma capture script, pins the selector dimensions to the configured viewport
 * (so every output frame in Figma has a consistent size), and triggers
 * captureForDesign().
 */
export async function runCapture({
  cdpUrl,
  url,
  captureId,
  endpoint,
  selector = 'body',
  delayMs = 1500,
  navigationTimeoutMs = 45000,
  captureTimeoutMs = 40000,
  keepPageOpen = false,
  viewport = 'desktop',
  fixedSize = true,
}) {
  const vp = resolveViewport(viewport);
  log(`viewport ${vp.width}x${vp.height}${fixedSize ? ' (pinned)' : ''}`);

  const { browser, context, ownsBrowser } = await acquireBrowser({ cdpUrl });
  const page = await context.newPage();
  await page.setViewportSize(vp);

  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning' || /figma|capture/i.test(msg.text())) {
      console.log(`  [page:${t}]`, msg.text());
    }
  });
  page.on('pageerror', (err) => console.log('  [page:error]', err.message));
  page.on('request', (req) => {
    if (req.url().includes('mcp.figma.com')) console.log('  [net→]', req.method(), req.url());
  });
  page.on('response', (res) => {
    if (res.url().includes('mcp.figma.com')) console.log('  [net←]', res.status(), res.url());
  });

  const targetOrigin = new URL(url).origin;

  await page.route('**/*', async (route, request) => {
    try {
      if (request.resourceType() !== 'document' || !request.url().startsWith(targetOrigin)) {
        return route.continue();
      }
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers['content-security-policy'];
      delete headers['content-security-policy-report-only'];
      await route.fulfill({ response, headers });
    } catch (e) {
      try { await route.continue(); } catch {}
    }
  });

  log(`navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
  log('  dom ready');

  await page.waitForTimeout(delayMs);

  // Pin the captured element to viewport dimensions so every Figma frame for
  // this viewport preset has identical width. Height uses min-height so taller
  // content can still flow — but the baseline fold is always the preset height.
  if (fixedSize) {
    await page.evaluate(({ w, h, sel }) => {
      const style = document.createElement('style');
      style.setAttribute('data-figma-capture-pin', '1');
      style.textContent = `
        html, body { margin: 0 !important; }
        html { width: ${w}px !important; }
        body { width: ${w}px !important; min-height: ${h}px !important; box-sizing: border-box; overflow-x: hidden !important; }
        ${sel !== 'body' ? `${sel} { width: ${w}px !important; min-height: ${h}px !important; box-sizing: border-box; }` : ''}
      `;
      document.head.appendChild(style);
    }, { w: vp.width, h: vp.height, sel: selector });
    // Small re-settle after forcing layout.
    await page.waitForTimeout(250);
  }

  log('fetching capture.js');
  const scriptRes = await fetch(CAPTURE_SCRIPT_URL);
  if (!scriptRes.ok) {
    throw new Error(`Failed to fetch capture.js: ${scriptRes.status} ${scriptRes.statusText}`);
  }
  const scriptSrc = await scriptRes.text();
  await page.addScriptTag({ content: scriptSrc });
  log('  script injected');

  await page.waitForFunction(
    () => typeof window.figma?.captureForDesign === 'function',
    null,
    { timeout: 10000 }
  );

  log('invoking captureForDesign');

  const submitSeen = new Promise((resolve, reject) => {
    const onResp = (res) => {
      if (!res.url().includes(`/capture/${captureId}/submit`)) return;
      page.off('response', onResp);
      if (res.ok()) resolve({ status: res.status() });
      else res.text().then((body) => reject(new Error(`submit HTTP ${res.status()}: ${body.slice(0, 200)}`)));
    };
    page.on('response', onResp);
  });

  page.evaluate(
    ({ captureId, endpoint, selector }) => {
      try {
        const p = window.figma.captureForDesign({ captureId, endpoint, selector });
        Promise.resolve(p).catch((e) => console.error('[captureForDesign] rejected:', e?.message ?? e));
      } catch (e) {
        console.error('[captureForDesign] threw:', e?.message ?? e);
      }
    },
    { captureId, endpoint, selector }
  ).catch(() => {});

  const result = await Promise.race([
    submitSeen,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`submit POST not observed within ${captureTimeoutMs}ms`)), captureTimeoutMs)
    ),
  ]);
  log(`  submitted (HTTP ${result.status})`);

  if (!keepPageOpen) {
    await page.close();
  }
  // For CDP (attached), `close` disconnects. For launched browsers we tear down
  // the browser so `npx` doesn't leave an orphaned Chromium running.
  if (ownsBrowser) await browser.close();
  else await browser.close();

  return result;
}
