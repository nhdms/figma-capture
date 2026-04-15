#!/usr/bin/env node
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { registerCapture } from '../src/commands/capture.mjs';
import { registerBatch } from '../src/commands/batch.mjs';
import { registerExportPages } from '../src/commands/export-pages.mjs';
import { registerInstallSkill } from '../src/commands/install-skill.mjs';

const pkg = JSON.parse(
  await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
);

const program = new Command();
program
  .name('figma-capture')
  .description('Capture web pages into a Figma file via the hosted Figma MCP and Playwright')
  .version(pkg.version)
  .showHelpAfterError();

registerCapture(program);   // default subcommand: figma-capture <url> --file <key>
registerBatch(program);     // figma-capture batch ...
registerExportPages(program); // figma-capture export-pages ...
registerInstallSkill(program); // figma-capture install-skill

try {
  await program.parseAsync(process.argv);
} catch (err) {
  console.error('[figma-capture] error:', err?.message ?? err);
  if (err?.stack && process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}
