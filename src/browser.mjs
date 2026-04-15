import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';

let playwrightModule = null;

/**
 * Ensure `playwright` and a Chromium browser binary are installed. We intentionally
 * resolve `playwright` dynamically so we can fall back to `npx playwright install`
 * before the first `import`, which would otherwise fail for users that cloned this
 * repo without running `npm install`.
 */
export async function ensurePlaywright({ log = () => {} } = {}) {
  if (playwrightModule) return playwrightModule;

  try {
    playwrightModule = await import('playwright');
  } catch {
    log('playwright not installed — running `npx -y playwright@latest install-deps chromium`');
    const r = spawnSync('npx', ['-y', 'playwright@latest', 'install', 'chromium'], { stdio: 'inherit' });
    if (r.status !== 0) {
      throw new Error('Failed to install playwright via npx. Install manually: npm i -D playwright && npx playwright install chromium');
    }
    playwrightModule = await import('playwright');
  }

  // Playwright is resolved — now make sure its Chromium binary exists. If not,
  // `chromium.launch()` throws a cryptic error; we pre-install eagerly.
  try {
    const exec = playwrightModule.chromium.executablePath();
    if (!exec || !existsSync(exec)) throw new Error('missing');
  } catch {
    log('installing Chromium via `npx playwright install chromium`');
    const r = spawnSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit' });
    if (r.status !== 0) {
      throw new Error('Failed to install Chromium. Run: npx playwright install chromium');
    }
  }

  return playwrightModule;
}

export function isPortOpen(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Legacy path: user has a shell alias that launches their desktop Chrome with
 * --remote-debugging-port. Kept for advanced users but no longer the default.
 */
export async function ensureChromeCdp({ port, aliasCommand = 'chrome-cdp', timeoutMs = 20000 }) {
  if (await isPortOpen(port)) return { started: false };

  const child = spawn('bash', ['-ic', aliasCommand], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return { started: true };
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(
    `Chrome CDP port ${port} did not open within ${timeoutMs}ms. ` +
    `Make sure the '${aliasCommand}' alias is defined in your shell rc file ` +
    `and launches Chrome with --remote-debugging-port=${port}.`
  );
}
