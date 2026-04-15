import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * Reads Claude Code's stored Figma MCP OAuth credentials from the macOS
 * keychain. Claude Code stores all MCP OAuth data under the keychain service
 * "Claude Code-credentials" as a single JSON blob:
 *
 *   {
 *     "claudeAiOauth": { ... },
 *     "mcpOAuth": {
 *       "plugin:figma:figma|<hash>": {
 *         "serverName", "serverUrl", "accessToken", "expiresAt",
 *         "clientId", "clientSecret", "refreshToken", "discoveryState"
 *       }
 *     }
 *   }
 *
 * Returns null on non-macOS hosts or when no Figma entry is present.
 */
export async function readClaudeFigmaTokens({ service = 'Claude Code-credentials' } = {}) {
  if (process.platform !== 'darwin') return null;

  let raw;
  try {
    const { stdout } = await execFileP('security', ['find-generic-password', '-s', service, '-w']);
    raw = stdout.trim();
  } catch {
    return null;
  }

  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }

  const mcp = parsed?.mcpOAuth;
  if (!mcp || typeof mcp !== 'object') return null;

  // Find the figma entry — key looks like "plugin:figma:figma|<hash>".
  const key = Object.keys(mcp).find((k) => /(^|[:|])figma(:|\|)/i.test(k));
  if (!key) return null;

  const entry = mcp[key];
  if (!entry?.accessToken || !entry?.clientId) return null;

  return {
    serverUrl: entry.serverUrl ?? 'https://mcp.figma.com/mcp',
    clientId: entry.clientId,
    clientSecret: entry.clientSecret,
    accessToken: entry.accessToken,
    refreshToken: entry.refreshToken,
    expiresAt: entry.expiresAt, // ms since epoch
  };
}
