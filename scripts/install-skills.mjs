#!/usr/bin/env node
// Installs skills/<name>/ into ~/.claude/skills/<name>/ (see ADR 0002).
// Copies over the top; never deletes. That directory holds every other skill you use.
// Usage: node scripts/install-skills.mjs [--target <dir>] [--dry-run]
import { existsSync, readdirSync, lstatSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { runCli } from './lib/cli.mjs';

export function installSkills(sourceRoot, targetRoot, opts = {}) {
  const skillsDir = join(sourceRoot, 'skills');
  if (!existsSync(skillsDir)) throw new Error(`${sourceRoot} has no skills/ directory`);

  const installed = [];
  const skipped = [];

  for (const name of readdirSync(skillsDir)) {
    const source = join(skillsDir, name);
    if (!lstatSync(source).isDirectory()) continue;
    if (!existsSync(join(source, 'SKILL.md'))) { skipped.push(name); continue; }
    if (!opts.dryRun) cpSync(source, join(targetRoot, name), { recursive: true, force: true });
    installed.push(name);
  }

  return { installed: installed.sort(), skipped: skipped.sort() };
}

function main(argv) {
  const args = argv.slice(2);
  const targetFlag = args.indexOf('--target');
  const target = targetFlag === -1 ? join(homedir(), '.claude', 'skills') : args[targetFlag + 1];
  const dryRun = args.includes('--dry-run');
  const result = installSkills(process.cwd(), target, { dryRun });
  console.log(`${dryRun ? 'would install' : 'installed'} ${result.installed.length} skill(s) to ${target}: ${result.installed.join(', ') || 'none'}`);
  for (const name of result.skipped) console.error(`skipped (no SKILL.md): ${name}`);
  return 0;
}

export { main };
runCli(import.meta.url, main);
