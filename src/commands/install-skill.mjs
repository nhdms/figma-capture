/**
 * Installs the figma-capture Claude Code skill so Claude Code can drive
 * this CLI without you having to explain it every conversation.
 *
 * Default destination: ~/.claude/skills/figma-capture/SKILL.md
 */
import { mkdir, copyFile, access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(
  new URL('../../skills/figma-capture/SKILL.md', import.meta.url)
);

export function registerInstallSkill(program) {
  program
    .command('install-skill')
    .description('Install the figma-capture Claude Code skill (SKILL.md)')
    .option('--dest <dir>', 'Destination directory containing SKILL.md (overrides default)')
    .option('--project', 'Install into ./.claude/skills/figma-capture/ instead of ~/.claude/...')
    .option('--print', 'Print SKILL.md to stdout instead of installing')
    .option('--force', 'Overwrite without prompting if SKILL.md already exists')
    .action(runInstallSkill);
}

async function exists(p) {
  try { await access(p, constants.F_OK); return true; }
  catch { return false; }
}

async function runInstallSkill(opts) {
  if (!(await exists(SOURCE))) {
    console.error(`[install-skill] source SKILL.md missing: ${SOURCE}`);
    console.error('  This usually means the package was installed without the skills/ dir.');
    process.exit(1);
  }

  if (opts.print) {
    process.stdout.write(await readFile(SOURCE, 'utf8'));
    return;
  }

  let destDir;
  if (opts.dest) {
    destDir = path.resolve(opts.dest);
  } else if (opts.project) {
    destDir = path.resolve(process.cwd(), '.claude', 'skills', 'figma-capture');
  } else {
    destDir = path.join(homedir(), '.claude', 'skills', 'figma-capture');
  }

  const destFile = path.join(destDir, 'SKILL.md');
  const already = await exists(destFile);
  if (already && !opts.force) {
    console.error(`[install-skill] SKILL.md already exists at ${destFile}`);
    console.error('  Re-run with --force to overwrite.');
    process.exit(2);
  }

  await mkdir(destDir, { recursive: true });
  await copyFile(SOURCE, destFile);
  console.log(`[install-skill] ${already ? 'updated' : 'installed'}: ${destFile}`);
  console.log('[install-skill] Restart Claude Code (or open a new session) for it to pick up the skill.');
}
