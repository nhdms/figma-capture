# Changelog

All notable changes to this project will be documented in this file. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-04-15

Initial public release.

### Added
- Single `figma-capture` binary with four subcommands:
  - `figma-capture <url> --file <key>` — capture one URL (default).
  - `figma-capture batch` — batch capture with three input modes:
    `--manifest <file>`, `--sitemap <url>`, or `--routes <list>`. No
    `pages.json` required for the latter two. Supports retry, resume,
    and `--concurrency <n>` (1–8 parallel workers).
  - `figma-capture export-pages` — walk a Next.js App Router `app/`
    directory and emit a `pages.json` manifest.
  - `figma-capture install-skill` — install the bundled Claude Code skill
    (`skills/figma-capture/SKILL.md`) so Claude Code can drive the CLI
    without prompting.
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
