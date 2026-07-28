#!/usr/bin/env node
// Installs skills/<name>/ into ~/.claude/skills/<name>/ (see ADR 0002).
// Copies over the top; never deletes. That directory holds every other skill you use.
// Usage: node scripts/install-skills.mjs [--target <dir>] [--dry-run]
import { existsSync, readdirSync, lstatSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

export const GATE_SOURCE_REL = join('skills', 'crit', 'scripts', 'report-gate.mjs');
export const GATE_INSTALLED_NAME = 'crit-report-gate.mjs';

/**
 * Install the /crit report gate user-level and register it on Stop.
 *
 * Registered here rather than shipped in `base/files/dot-claude/settings.json`
 * for ADR 0002's reason applied to hooks: that file lands in a *scaffolded*
 * repo's `.claude/`, and design reviews happen in repos that were never
 * scaffolded. Phase 2c binds — the hook and the skill it enforces ship together,
 * so no gate in the source means no registration.
 *
 * It only ever adds. An existing Stop hook keeps its place and its contents; a
 * settings.json that will not parse is left exactly as it is.
 */
export function registerReportGate(sourceRoot, claudeDir, opts = {}) {
  const source = join(sourceRoot, GATE_SOURCE_REL);
  if (!existsSync(source)) return { skipped: `${GATE_SOURCE_REL} is not in this checkout`, registered: false };

  const dest = join(claudeDir, GATE_INSTALLED_NAME);
  const settingsPath = join(claudeDir, 'settings.json');

  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      return { skipped: `${settingsPath} could not be parsed; nothing was changed`, registered: false };
    }
  }

  const command = `node "${dest.replace(/\\/g, '/')}"`;
  const stop = Array.isArray(settings.hooks?.Stop) ? settings.hooks.Stop : [];
  const already = stop
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .some((hook) => typeof hook?.command === 'string' && hook.command.includes(GATE_INSTALLED_NAME));

  if (!opts.dryRun) {
    cpSync(source, dest, { force: true });
    if (!already) {
      const next = {
        ...settings,
        hooks: { ...settings.hooks, Stop: [...stop, { hooks: [{ type: 'command', command }] }] },
      };
      writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    }
  }

  return { skipped: null, registered: !already, path: dest, command };
}

function main(argv) {
  const args = argv.slice(2);
  const targetFlag = args.indexOf('--target');
  const target = targetFlag === -1 ? join(homedir(), '.claude', 'skills') : args[targetFlag + 1];
  const dryRun = args.includes('--dry-run');
  const result = installSkills(process.cwd(), target, { dryRun });
  console.log(`${dryRun ? 'would install' : 'installed'} ${result.installed.length} skill(s) to ${target}: ${result.installed.join(', ') || 'none'}`);
  for (const name of result.skipped) console.error(`skipped (no SKILL.md): ${name}`);

  const gate = registerReportGate(process.cwd(), dirname(target), { dryRun });
  if (gate.skipped) console.error(`report gate not registered: ${gate.skipped}`);
  else if (gate.registered) console.log(`${dryRun ? 'would register' : 'registered'} the /crit report gate on Stop: ${gate.path}`);
  else console.log(`/crit report gate already registered: ${gate.path}`);
  return 0;
}

export { main };
runCli(import.meta.url, main);
