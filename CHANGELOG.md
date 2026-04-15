# Changelog

All notable changes to this project will be documented in this file. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `figma-capture-batch` now accepts three input modes:
  `--manifest <file>`, `--sitemap <url>`, or `--routes <list>` —
  no `pages.json` required for the latter two.
- `--concurrency <n>` flag on batch (1–8 parallel workers, each in its
  own Playwright Chromium).
- New `figma-capture-install-skill` binary plus a bundled
  `skills/figma-capture/SKILL.md` so Claude Code can drive the CLI
  without prompting.
- New `src/manifest.mjs` module exporting `manifestFromSitemap`,
  `manifestFromRoutes`, and shared route → page-entry helpers.

## [0.1.0] - 2026-04-15

Initial public release.

### Added
- `figma-capture` CLI: capture a single web page into a Figma file via the
  hosted Figma MCP and a Playwright-driven Chromium.
- `figma-capture-batch` CLI: capture every page in a `pages.json` manifest
  with retry/resume and per-page placement on fresh Figma pages.
- `figma-capture-export-pages` CLI: emit a `pages.json` manifest by walking
  a Next.js App Router `app/` directory.
- Three viewport presets (`mobile`, `tablet`, `desktop`) with pinned
  dimensions so every captured frame lands at a consistent size.
- macOS keychain reuse: if Claude Code has already authenticated to the
  Figma MCP, the CLI reuses those tokens automatically. Falls back to
  env-var credentials (`FIGMA_MCP_CLIENT_ID` / `_SECRET`) plus interactive
  OAuth on first run, with refresh-token caching at
  `~/.figma-capture/tokens.json`.
- Auto-install path: if `playwright` or its Chromium binary are missing,
  the CLI runs `npx playwright install chromium` on first use.

[Unreleased]: https://github.com/nhdms/figma-capture/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nhdms/figma-capture/releases/tag/v0.1.0
