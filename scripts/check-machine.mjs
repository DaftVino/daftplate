#!/usr/bin/env node
// Second-pass machine verification: reports which tools from
// scripts/lib/toolchain.mjs this machine has. Detects; never installs, and
// writes nothing anywhere — no snapshot, no ignore list, no bookkeeping.
// Usage: node scripts/check-machine.mjs [--profile <name>] [--json]
import { TOOLCHAIN, toolsFor } from './lib/toolchain.mjs';
import { readProvenance } from './lib/provenance.mjs';
import { runCli } from './lib/cli.mjs';
import { commandExists } from './lib/probe.mjs';

export const FOOTER = 'Installed a developer tool recently? Add it to `scripts/lib/toolchain.mjs`.';

/** An explicit --profile wins; otherwise the profile the repo you are standing
 *  in recorded at scaffold time. A malformed .daftplate.json degrades to "no
 *  profile" — this command reports, and refusing to run because a provenance
 *  file is corrupt would help nobody. */
export function resolveProfile(args, cwd) {
  const at = args.indexOf('--profile');
  if (at !== -1) {
    const value = args[at + 1];
    return value && !value.startsWith('--') ? value : null;
  }
  try {
    return readProvenance(cwd)?.profile ?? null;
  } catch {
    return null;
  }
}

export const TIER_ORDER = ['required', 'recommended'];

/** Pure: an inspection in, display lines out. Nothing here prints, so the whole
 *  report is assertable without capturing stdout. */
export function render(inspection) {
  const lines = [];

  for (const tier of TIER_ORDER) {
    const group = inspection.tools.filter((t) => t.tier === tier);
    if (!group.length) continue;
    if (lines.length) lines.push('');
    lines.push(tier);
    for (const tool of group) {
      lines.push(`  [${tool.present ? 'x' : ' '}] ${tool.name}`);
      // Detail only for what is absent. A present tool needs no install command,
      // and 12 entries times four lines would bury the two that matter.
      if (tool.present) continue;
      lines.push(`      ${tool.why}`);
      lines.push(`      install: ${tool.install}`);
      lines.push(`      ${tool.author} · ${tool.url}`);
    }
  }

  lines.push('', FOOTER);
  return lines;
}

export function inspect(opts = {}) {
  const entries = opts.entries ?? TOOLCHAIN;
  const probe = opts.probe ?? commandExists;
  const profile = opts.profile ?? null;

  const tools = toolsFor(profile, entries).map((t) => ({ ...t, present: probe(t.command, t.versionArgs) }));
  const missing = (tier) => tools.filter((t) => !t.present && t.tier === tier);
  const missingRequired = missing('required');

  return {
    profile,
    tools,
    missingRequired,
    missingRecommended: missing('recommended'),
    ok: missingRequired.length === 0,
  };
}

/** One never-blocking line for setup-repo, which already runs once per new repo
 *  and is therefore the recurring trigger. Returns null when there is nothing to
 *  say — including when a *required* tool is missing, because setup-repo already
 *  reports that as a blocking violation and repeating it as advice would read as
 *  "optional". */
export function advisory(inspection) {
  const missing = inspection.missingRecommended;
  if (!missing.length) return null;
  return `recommended, not installed: ${missing.map((t) => t.name).join(', ')}`
    + ' — run `node scripts/check-machine.mjs` for install commands';
}

/** The --json shape: commands rather than whole entries, because a consumer
 *  wants to know what is missing, and the manifest is where the detail lives. */
export function toJson(inspection) {
  return {
    ok: inspection.ok,
    profile: inspection.profile,
    missingRequired: inspection.missingRequired.map((t) => t.command),
    missingRecommended: inspection.missingRecommended.map((t) => t.command),
    tools: inspection.tools.map((t) => ({ command: t.command, tier: t.tier, present: t.present })),
  };
}

// The only impure part. Everything it decides with is injected, so every branch
// above is testable without touching PATH, the filesystem or stdout.
function main(argv, opts = {}) {
  const args = argv.slice(2);
  const log = opts.log ?? console.log;
  const cwd = opts.cwd ?? process.cwd();
  const inspection = inspect({
    entries: opts.entries,
    probe: opts.probe,
    profile: resolveProfile(args, cwd),
  });

  if (args.includes('--json')) log(JSON.stringify(toJson(inspection), null, 2));
  else for (const line of render(inspection)) log(line);

  // Non-zero on a missing `required` tool and nothing else: a recommended tool
  // that fails a CI job would get itself removed from the manifest within a week.
  return inspection.ok ? 0 : 1;
}

export { main };
runCli(import.meta.url, main);
