import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import open from 'open';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { readClaudeFigmaTokens } from './claude-tokens.mjs';

const FIGMA_MCP_URL = 'https://mcp.figma.com/mcp';
const CALLBACK_PORT = 41718;
const CONFIG_DIR = path.join(homedir(), '.figma-capture');
const TOKENS_FILE = path.join(CONFIG_DIR, 'tokens.json');

// Figma MCP OAuth (from https://mcp.figma.com/.well-known/oauth-authorization-server)
// - Dynamic client registration is blocked (403), so we either (a) reuse
//   Claude Code's stored Figma MCP OAuth creds from the macOS keychain, or
//   (b) use env-provided credentials from a Figma app you registered yourself.
// - Redirect URI in the Figma app config must be http://127.0.0.1:41718/callback
// - Scope required: mcp:connect
const ENV_CLIENT_ID = process.env.FIGMA_MCP_CLIENT_ID;
const ENV_CLIENT_SECRET = process.env.FIGMA_MCP_CLIENT_SECRET;

async function readState() {
  try { return JSON.parse(await readFile(TOKENS_FILE, 'utf8')); }
  catch { return {}; }
}
async function writeState(state) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Tokens contain OAuth client_secret + access/refresh tokens. Restrict to
  // the owning user — the default 0o644 would expose them to other local
  // processes running as the same user group.
  await writeFile(TOKENS_FILE, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/**
 * Converts a Claude-Code-stored Figma token entry into the shape expected by
 * the MCP SDK's OAuthTokens interface (access_token, token_type, expires_in,
 * refresh_token, scope).
 */
function toOauthTokens(claudeTokens) {
  if (!claudeTokens?.accessToken) return undefined;
  const now = Date.now();
  const expiresInSec = claudeTokens.expiresAt
    ? Math.max(0, Math.floor((claudeTokens.expiresAt - now) / 1000))
    : undefined;
  return {
    access_token: claudeTokens.accessToken,
    token_type: 'Bearer',
    ...(expiresInSec !== undefined ? { expires_in: expiresInSec } : {}),
    ...(claudeTokens.refreshToken ? { refresh_token: claudeTokens.refreshToken } : {}),
    scope: 'mcp:connect',
  };
}

function toClientInfo(clientId, clientSecret, redirectUrl) {
  return {
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: clientSecret ? 'client_secret_post' : 'none',
    scope: 'mcp:connect',
  };
}

/**
 * OAuth provider that:
 *  - First tries to seed from Claude Code's keychain-stored Figma MCP creds
 *  - Falls back to env vars (FIGMA_MCP_CLIENT_ID / _SECRET) + interactive auth
 *  - Persists any refresh results to ~/.figma-capture/tokens.json so the
 *    Claude keychain entry itself is never mutated.
 */
class FileTokenProvider {
  constructor({ seededClientInfo, seededTokens } = {}) {
    this._state = null;
    this._seededClientInfo = seededClientInfo;
    this._seededTokens = seededTokens;
    this._codeResolver = null;
    this._codePromise = new Promise((res) => { this._codeResolver = res; });
  }

  async _load() {
    if (!this._state) this._state = await readState();
    return this._state;
  }
  async _save() { await writeState(this._state ?? {}); }

  get redirectUrl() { return `http://127.0.0.1:${CALLBACK_PORT}/callback`; }

  get clientMetadata() {
    return {
      client_name: 'figma-capture-cli',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: 'mcp:connect',
    };
  }

  async clientInformation() {
    const s = await this._load();
    if (s.clientInformation) return s.clientInformation;
    if (this._seededClientInfo) return this._seededClientInfo;
    return undefined;
  }
  async saveClientInformation(info) {
    const s = await this._load();
    s.clientInformation = info;
    await this._save();
  }
  async tokens() {
    const s = await this._load();
    if (s.tokens) return s.tokens;
    if (this._seededTokens) return this._seededTokens;
    return undefined;
  }
  async saveTokens(tokens) {
    const s = await this._load();
    s.tokens = tokens;
    await this._save();
  }
  async codeVerifier() {
    const s = await this._load();
    if (!s.codeVerifier) throw new Error('No code verifier stored');
    return s.codeVerifier;
  }
  async saveCodeVerifier(v) {
    const s = await this._load();
    s.codeVerifier = v;
    await this._save();
  }

  async redirectToAuthorization(authUrl) {
    console.log('\n→ Figma MCP requires authorization.');
    console.log('  Opening browser:', authUrl.toString(), '\n');
    this._startCallbackServer();
    await open(authUrl.toString());
  }

  _startCallbackServer() {
    if (this._server) return;
    this._server = http.createServer((req, res) => {
      const url = new URL(req.url, this.redirectUrl);
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (code) {
        res.end('<h2>Authorized ✓</h2><p>You can close this tab and return to the CLI.</p>');
        this._codeResolver({ code });
      } else {
        res.end(`<h2>Authorization failed</h2><pre>${err ?? 'no code'}</pre>`);
        this._codeResolver({ error: err ?? 'no code returned' });
      }
      setTimeout(() => this._server.close(), 250);
    });
    this._server.listen(CALLBACK_PORT, '127.0.0.1');
  }

  async waitForCode() {
    const r = await this._codePromise;
    if (r.error) throw new Error(`OAuth error: ${r.error}`);
    return r.code;
  }
}

async function resolveSeedCredentials() {
  // 1) Local persisted state wins (refresh results from previous runs).
  const state = await readState();
  if (state.clientInformation && state.tokens) {
    return {
      seededClientInfo: state.clientInformation,
      seededTokens: state.tokens,
      source: 'file',
    };
  }

  // 2) Env vars override (explicit user choice).
  if (ENV_CLIENT_ID) {
    return {
      seededClientInfo: toClientInfo(ENV_CLIENT_ID, ENV_CLIENT_SECRET, `http://127.0.0.1:${CALLBACK_PORT}/callback`),
      seededTokens: undefined,
      source: 'env',
    };
  }

  // 3) Reuse Claude Code's stored Figma MCP creds from macOS keychain.
  const claude = await readClaudeFigmaTokens();
  if (claude?.clientId) {
    return {
      seededClientInfo: toClientInfo(claude.clientId, claude.clientSecret, `http://127.0.0.1:${CALLBACK_PORT}/callback`),
      seededTokens: toOauthTokens(claude),
      source: 'claude-keychain',
    };
  }

  return { source: 'none' };
}

let cachedClient = null;

async function connectClient() {
  if (cachedClient) return cachedClient;

  const { seededClientInfo, seededTokens, source } = await resolveSeedCredentials();

  if (!seededClientInfo) {
    throw new Error(
      'No Figma MCP OAuth credentials found. Either:\n' +
      '  (a) Authenticate the Figma MCP once in Claude Code so tokens are stored\n' +
      '      in the macOS keychain (service: "Claude Code-credentials"), OR\n' +
      '  (b) Register your own app at https://www.figma.com/developers/apps with\n' +
      '      redirect URI http://127.0.0.1:41718/callback, then run with:\n' +
      '        FIGMA_MCP_CLIENT_ID=... FIGMA_MCP_CLIENT_SECRET=... figma-capture ...'
    );
  }

  console.log(`[figma-capture]   auth source: ${source}`);

  const authProvider = new FileTokenProvider({ seededClientInfo, seededTokens });
  const transport = new StreamableHTTPClientTransport(new URL(FIGMA_MCP_URL), { authProvider });
  const client = new Client(
    { name: 'figma-capture-cli', version: '0.1.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
  } catch (e) {
    if (e instanceof UnauthorizedError || /unauthorized|401/i.test(e?.message ?? '')) {
      console.log('[figma-capture]   seeded token rejected, falling back to interactive auth');
      const code = await authProvider.waitForCode();
      await transport.finishAuth(code);
      const freshTransport = new StreamableHTTPClientTransport(new URL(FIGMA_MCP_URL), { authProvider });
      await client.connect(freshTransport);
    } else {
      throw e;
    }
  }

  cachedClient = client;
  return client;
}

function extractTextContent(result) {
  const parts = result?.content ?? [];
  return parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
}

export async function getCaptureTarget({ fileKey, nodeId }) {
  const client = await connectClient();
  const args = { outputMode: 'existingFile', fileKey };
  if (nodeId) args.nodeId = nodeId;
  const res = await client.callTool({ name: 'generate_figma_design', arguments: args });
  const text = extractTextContent(res);

  const idMatch = text.match(/Capture ID generated:\s*`([^`]+)`/i);
  const captureId = idMatch?.[1];
  if (!captureId) {
    throw new Error(`Could not extract captureId from MCP response:\n${text}`);
  }
  return {
    captureId,
    endpoint: `https://mcp.figma.com/mcp/capture/${captureId}/submit`,
    rawResponse: text,
  };
}

export async function pollCaptureResult({ captureId, maxAttempts = 24, intervalMs = 5000 }) {
  const client = await connectClient();
  for (let i = 1; i <= maxAttempts; i++) {
    const res = await client.callTool({
      name: 'generate_figma_design',
      arguments: { captureId },
    });
    const text = extractTextContent(res);
    if (/added to your existing file|node-id=/i.test(text)) {
      const urlMatch = text.match(/https:\/\/www\.figma\.com\/design\/[^\s)]+/);
      const nodeMatch = text.match(/node-id=([0-9:\-]+)/);
      const nodeId = nodeMatch?.[1]?.replace('-', ':');
      return { figmaUrl: urlMatch?.[0], nodeId, raw: text };
    }
    if (/failed|error/i.test(text) && !/pending|processing/i.test(text)) {
      throw new Error(`Capture failed: ${text}`);
    }
    process.stdout.write(`   poll ${i}/${maxAttempts}…\r`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Polling timed out after ${maxAttempts} attempts`);
}

/**
 * Generic MCP tool invocation for callers that need tools beyond
 * generate_figma_design (e.g. use_figma for renaming/moving captured frames).
 */
export async function callMcpTool(name, args) {
  const client = await connectClient();
  return client.callTool({ name, arguments: args });
}
