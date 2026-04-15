# figma-capture

> Capture web pages into a Figma file from your terminal.

`figma-capture` is a small CLI that drives Figma's hosted MCP server and
[Playwright](https://playwright.dev) to convert any URL — your local dev
server, a staging environment, or any public site you have permission to
capture — into a real, editable frame inside a Figma file.

It ships three binaries:

| Binary | Purpose |
|---|---|
| `figma-capture` | Capture a single URL into a Figma file. |
| `figma-capture-batch` | Capture every page in a `pages.json` manifest. Retry, resume, place on fresh Figma pages. |
| `figma-capture-export-pages` | Walk a Next.js App Router `app/` directory and emit a `pages.json` manifest. |

## Why

Figma's hosted MCP server can already convert a rendered web page into a
Figma frame, but only from inside an MCP-aware client. This CLI lets you
trigger the same flow from your shell, batch it across an entire app, and
script it into a CI job.

## Install

```sh
# Global
npm install -g figma-capture

# Or run on demand without installing
npx figma-capture <url> --file <fileKey>
```

`playwright` is an **optional peer dependency**. The first time you run a
capture, the CLI will run `npx playwright install chromium` if it can't
find one (~150MB, one-time). If you already have Playwright installed
elsewhere, it'll be reused.

Requires **Node ≥ 18.17**.

## Quick start

```sh
# 1. Authenticate the Figma MCP once (see "Auth" below).
# 2. Capture a page:
figma-capture http://localhost:3000/dashboard --file <FIGMA_FILE_KEY>
```

Output:

```
[figma-capture] Ensuring Playwright Chromium
[figma-capture] Requesting capture target for file=...
[figma-capture]   captureId=cap_abc123
[figma-capture] Capturing http://localhost:3000/dashboard
...
[figma-capture] Done
https://www.figma.com/design/<fileKey>/<file>?node-id=12-345
```

## Auth

The CLI needs an authenticated connection to `https://mcp.figma.com/mcp`.
It tries three sources, in order:

1. **Persisted tokens** at `~/.figma-capture/tokens.json` (cached refresh
   tokens from prior runs).
2. **Environment variables** `FIGMA_MCP_CLIENT_ID` and
   `FIGMA_MCP_CLIENT_SECRET` — for users who want a dedicated Figma app.
3. **macOS keychain** entry `Claude Code-credentials` — if you've already
   authenticated the Figma MCP inside [Claude Code](https://claude.com/claude-code),
   `figma-capture` reuses those tokens automatically. Zero setup.
   Refresh results are written to `~/.figma-capture/tokens.json`, never
   back to the keychain.

If none are available you'll see:

```
No Figma MCP OAuth credentials found.
```

…and the CLI prints instructions for both options.

### Manual app registration (option 2)

For non-macOS users or anyone who prefers their own Figma app:

1. Visit https://www.figma.com/developers/apps and create an app.
2. Set the redirect URI to `http://127.0.0.1:41718/callback`.
3. Add the scope `mcp:connect`.
4. Export the credentials and run the CLI:
   ```sh
   export FIGMA_MCP_CLIENT_ID=...
   export FIGMA_MCP_CLIENT_SECRET=...
   figma-capture <url> --file <fileKey>
   ```

The first run opens your browser, you authorize, and tokens are cached at
`~/.figma-capture/tokens.json` for subsequent runs.

## Options — `figma-capture`

```
figma-capture <url> --file <fileKey> [options]
```

| Option | Default | Description |
|---|---|---|
| `-f, --file <fileKey>` | required | Target Figma file key. |
| `-n, --node <nodeId>` | — | Optional Figma node to place the capture inside. |
| `-s, --selector <sel>` | `body` | CSS selector to capture. |
| `-v, --viewport <preset>` | `desktop` | `mobile` (430×932), `tablet` (1024×1366), `desktop` (1440×900). |
| `--no-fixed-size` | off | Do not pin the selector to viewport dimensions (variable-size captures). |
| `--delay <ms>` | `1500` | Wait before triggering capture. |
| `--cdp` | off | Use an already-running Chrome via CDP (advanced). |
| `-p, --port <port>` | `9225` | Chrome CDP port (only with `--cdp`). |
| `--alias <name>` | `chrome-cdp` | Shell alias to launch Chrome with CDP (only with `--cdp`). |
| `--keep-page` | off | Leave the captured page open after success. |
| `--no-poll` | off | Submit and exit; don't wait for Figma conversion. |

## Batch capture

Generate a manifest from a Next.js project and capture every page:

```sh
# 1. Walk app/ → pages.json
figma-capture-export-pages \
  --root ./my-next-app \
  --base-url http://localhost:3000 \
  --file <FIGMA_FILE_KEY> \
  --mobile-modules "consumer,auth" \
  --out pages.json

# 2. Capture every page in the manifest
figma-capture-batch --manifest pages.json
```

Per-page progress is persisted to a `pages.<fileKey>.status.json` next to
the manifest, so re-running picks up where you stopped. See
`figma-capture-batch --help` and `figma-capture-export-pages --help` for
all flags.

The exporter is Next.js App Router-specific today (it walks for `page.tsx`
files, strips `(routegroup)` segments, preserves `[dynamic]` segments).
You can also write `pages.json` by hand for any framework.

## How it works

1. The CLI connects to the Figma MCP at `https://mcp.figma.com/mcp` over
   streamable HTTP.
2. It calls `generate_figma_design` with your `fileKey` to receive a
   `captureId` and a submit endpoint.
3. It launches (or attaches to) Chromium via Playwright, navigates to the
   target URL, strips `Content-Security-Policy` headers via route
   interception, and inlines `https://mcp.figma.com/mcp/html-to-design/capture.js`.
4. It calls `window.figma.captureForDesign({ captureId, endpoint, selector })`
   inside the page. The capture script POSTs the rendered DOM to Figma's
   submit endpoint.
5. It polls `generate_figma_design` until the Figma server finishes
   converting the capture into a frame, then prints the resulting Figma URL.

## Responsible use

Capturing a web page strips its CSP headers in the local browser
context — necessary because the Figma capture script must inject inline.
**Only use this against pages you own or have explicit permission to
capture.** This tool is intended for shipping your own designs into Figma,
not for scraping other people's sites.

The CLI never sends page content anywhere except to Figma's own MCP
submit endpoint over HTTPS. No telemetry, no analytics.

## Troubleshooting

- **`No Figma MCP OAuth credentials found`** — on macOS, run Claude Code
  once and trigger any Figma MCP tool to authenticate; on other systems,
  set `FIGMA_MCP_CLIENT_ID` / `FIGMA_MCP_CLIENT_SECRET`.
- **`captureForDesign is not available`** — the page's CSP blocked the
  injected script, or the site has a strict JS runtime. Try
  `--selector "#root"` or a narrower element. Sites with aggressive CSP
  may fail entirely.
- **OAuth browser doesn't open** — `~/.figma-capture/tokens.json` may
  hold partial state. Delete it and retry.
- **Chromium binary missing** — `npx playwright install chromium`.
- **Port 9225 never opens (with `--cdp`)** — confirm your `chrome-cdp`
  alias passes `--remote-debugging-port=9225` and a dedicated
  `--user-data-dir`.

## Contributing

Issues and PRs welcome at https://github.com/nhdms/figma-capture.

## License

[MIT](./LICENSE)
