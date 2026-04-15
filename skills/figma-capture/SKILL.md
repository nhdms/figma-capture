---
name: figma-capture
description: Use when the user wants to capture web pages (their own dev server, staging, or any site they have permission to capture) into a Figma file. Auto-detects sitemaps, accepts inline routes, walks Next.js apps, and captures multiple pages in parallel.
---

# figma-capture

CLI for sending rendered web pages into a Figma file via Figma's hosted MCP
server and Playwright. Three binaries:

| Binary | Use when |
|---|---|
| `figma-capture` | A single URL. |
| `figma-capture-batch` | Many URLs — auto-discover via sitemap, pass inline, or use a `pages.json`. |
| `figma-capture-export-pages` | The user is on Next.js App Router and wants a manifest first. |

## How to invoke

**Always pick the lowest-friction mode for the user's input:**

1. User gives **one URL** → `figma-capture <url> --file <fileKey>`
2. User says "the whole site" / has a **sitemap** → `figma-capture-batch --file <key> --sitemap <sitemapUrl>`
3. User lists a **handful of routes** → `figma-capture-batch --file <key> --base-url <url> --routes "/a,/b,/c"`
4. User has a **Next.js app** AND wants to edit the manifest before capture → `figma-capture-export-pages` then `figma-capture-batch --manifest pages.json`

Do **not** ask the user to write `pages.json` by hand unless they specifically want manifest-based control.

## Parallel captures

For batch jobs, pass `--concurrency <n>` (1–8). Each worker launches its
own Playwright Chromium, so concurrency 4–6 is the practical sweet spot
on a typical dev machine. Example:

```
figma-capture-batch --file <key> --sitemap http://localhost:3000/sitemap.xml --concurrency 4
```

For ad-hoc parallel single-page captures, run multiple `figma-capture`
processes simultaneously via the Bash tool — they share auth via the
cached tokens at `~/.figma-capture/tokens.json`. Useful when the URLs
don't share a common base or sitemap.

## File key

The user must give a Figma `fileKey`. Extract it from any Figma URL:

- `https://www.figma.com/design/<FILEKEY>/<name>` → take `<FILEKEY>`
- `https://www.figma.com/file/<FILEKEY>/...` → take `<FILEKEY>`

If they don't have one yet, ask them to create or open a Figma file and
paste the URL.

## Auth (zero-config on macOS with Claude Code)

The CLI resolves credentials in this order:
1. `~/.figma-capture/tokens.json` (cached refresh tokens)
2. `FIGMA_MCP_CLIENT_ID` / `FIGMA_MCP_CLIENT_SECRET` env vars
3. macOS keychain entry `Claude Code-credentials` — **if Claude Code has
   already authenticated to the Figma MCP, this CLI reuses those tokens
   automatically.** No setup needed.

If the user gets `No Figma MCP OAuth credentials found`:
- On macOS: trigger any Figma MCP tool inside Claude Code once to
  authenticate, then retry. The CLI picks up the keychain entry on the
  next run.
- Other platforms: instruct the user to register a Figma app at
  `https://www.figma.com/developers/apps` with redirect URI
  `http://127.0.0.1:41718/callback` and scope `mcp:connect`, then export
  the env vars.

## Viewport presets

Each captured frame is pinned to its preset's dimensions for consistent
sizing in Figma:

- `mobile` — 430×932 (iPhone 14 Pro Max)
- `tablet` — 1024×1366 (iPad Pro 13")
- `desktop` — 1440×900 (default)

Pass `--viewport <preset>` for single captures. For batch, use
`--mobile-modules "consumer,auth"` / `--tablet-modules "..."` to default
specific top-level path segments to a non-desktop viewport. Or edit the
`viewport` field in `pages.json` per page.

## Common flag reference

### `figma-capture` (single)
```
figma-capture <url> --file <fileKey>
  [-n, --node <nodeId>]              place capture inside a specific Figma node
  [-s, --selector <css>]             default: body
  [-v, --viewport mobile|tablet|desktop]
  [--no-fixed-size]                  variable-size capture
  [--delay <ms>]                     default: 1500
  [--keep-page]                      leave page open after success
  [--no-poll]                        submit and exit without polling
```

### `figma-capture-batch`
```
figma-capture-batch
  # Pick ONE input mode:
  --manifest <file>                  pages.json
  --sitemap <url>                    sitemap.xml URL
  --routes "/a,/b,/c"                inline routes (also needs --base-url)

  --file <fileKey>                   required for --sitemap / --routes
  --base-url <url>                   required for --routes; optional override for --sitemap

  --concurrency <n>                  parallel workers (1–8, default 1)
  --only <module>                    capture only one top-level segment
  --limit <n>                        stop after N pages (smoke test)
  --retries <n>                      per-page retries on failure (default 2)
  --status <file>                    custom status file path
  --force                            ignore status file, recapture everything
  --dry-run                          list what would run
  --no-arrange                       skip placing the captured frame on a fresh page
  --append-existing                  append to existing Figma pages instead of creating new ones
```

### `figma-capture-export-pages` (Next.js App Router)
```
figma-capture-export-pages
  --root <dir>                       path to the project containing app/
  --base-url <url>
  --file <fileKey>
  --out <file>                       default: pages.json
  --mobile-modules "consumer,auth"
  --tablet-modules "..."
```

## Failure modes to handle

- **`captureForDesign is not available`** — the page's CSP blocked
  injection. Suggest a narrower `--selector "#root"` or running with
  `--no-fixed-size`. Some sites are unrecoverable.
- **Polling timed out** — Figma is slow or the submit POST was blocked.
  Re-run; the status file will skip already-completed pages.
- **`No usable URLs found in sitemap`** — sitemap origin doesn't match
  the requested base. Pass `--base-url` to override.

## Responsible use

This CLI strips `Content-Security-Policy` headers locally to inject the
Figma capture script. **Only use against pages the user owns or has
explicit permission to capture.** Do not use to scrape third-party sites.
