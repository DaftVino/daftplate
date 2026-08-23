#!/usr/bin/env node
// Installs skills/<name>/ into ~/.claude/skills/<name>/ (see ADR 0002).
// Copies over the top; never deletes. That directory holds every other skill you use.
// Usage: node scripts/install-skills.mjs [--target <dir>] [--dry-run]
import {
  existsSync, readdirSync, lstatSync, cpSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCli } from './lib/cli.mjs';
import { renderCheckoutBlock, findCheckoutSpan } from './lib/checkout-marker.mjs';
// Temp-file-plus-rename with mode preservation, EPERM retry and exact cleanup.
// It lived here until enrollment needed the same guarantees for .daftplate.json.
import { writeAtomically } from './lib/atomic-write.mjs';

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

export const GLOBAL_TEMPLATE_REL = join('engineering-standards', 'claude-md-global.md');

/** The line that decides `gatesPresent`. One constant, pinned against the shipped
 *  template by a test, because if the two drift every install on earth reports the
 *  gates missing. */
export const GATES_SENTINEL = '## Non-negotiable gates';

/** Splice the block into `text`, or append it when there is no span yet.
 *  Returns null when a marker is present but its span is unusable — that is a
 *  refusal, never a repair.
 *
 *  `replaced` rather than `previous !== null` is what tells the caller which happened:
 *  a span whose delimiters are sound but whose path line has been edited away is a
 *  replacement with no previous path, and calling that 'added' would report an append
 *  where a rewrite occurred. */
function placeBlock(text, block) {
  const span = findCheckoutSpan(text);
  if (span.ok) {
    return { text: text.slice(0, span.start) + block + text.slice(span.end), previous: span.path, replaced: true };
  }
  if (span.present) return null;

  const separator = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return { text: `${text}${separator}${block}\n`, previous: null, replaced: false };
}

/**
 * Record the daftplate checkout path in <claudeDir>/CLAUDE.md, so the standards
 * pointer every scaffolded repo carries resolves to something (#98, ADR 0001).
 *
 *                     ~/.claude/CLAUDE.md
 *                             │
 *               ┌─────────────┴─────────────┐
 *          does not exist                 exists
 *               │                           │
 *     ┌─────────┴─────────┐        count marker pairs
 *     │                   │                 │
 *  template            template     ┌───────┼────────────────┐
 *  missing              present     0       1            2+, or
 *     │                   │         │    well-formed    unclosed/
 *  REFUSED             CREATED   ADDED       │          reordered
 *  (D2 cost)          seed from  append      │              │
 *                     the global  block   compare       REFUSED
 *                     template      │      path        (D7, CLAUDE.md #5)
 *                        │          │         │
 *                        └──────────┴────┬────┴──────┐
 *                                     equal      different
 *                                        │            │
 *                                     CURRENT      UPDATED
 *                                    no write    rewrite in
 *                                    (D1)        place (D3)
 *                                        │            │
 *                                        └─────┬──────┘
 *                                        atomic write (D7)
 *                                              │
 *                                    ┌─────────┴─────────┐
 *                               rename OK          EPERM ×3
 *                                    │                   │
 *                                  done              REFUSED
 *                                                  (file untouched)
 *
 * This diagram is the truth table for all seven cells and each has a test; keeping it
 * accurate is part of any later change to these branches, because the next reader will
 * trust it.
 *
 * `gatesPresent` is reported, never repaired. Splicing template prose into a
 * user-authored file writes content daftplate did not create into someone else's
 * document — CLAUDE.md #5's spirit even though nothing is deleted. The human merges it.
 */
export function recordCheckout(sourceRoot, claudeDir, opts = {}) {
  const target = join(claudeDir, 'CLAUDE.md');
  const block = renderCheckoutBlock(sourceRoot);
  const refuse = (reason) => ({ path: target, action: 'refused', previous: null, gatesPresent: null, reason });

  let base;
  let action;
  let baseName = target;      // whose marker a refusal should name
  if (existsSync(target)) {
    base = readFileSync(target, 'utf8');
    action = 'added';
  } else {
    // D2: seed from the shipped template, gates and all. A thin file carrying only the
    // marker satisfies every check here while making the one thing ADR 0001:25
    // guarantees — the non-negotiable gates — absent.
    const template = join(sourceRoot, GLOBAL_TEMPLATE_REL);
    if (!existsSync(template)) {
      return refuse(`${GLOBAL_TEMPLATE_REL} is not in ${sourceRoot}, and creating the file without it would leave the machine with no gates`);
    }
    base = readFileSync(template, 'utf8');
    baseName = template;
    action = 'created';
  }

  const placed = placeBlock(base, block);
  if (!placed) return refuse(`${baseName} has a marker daftplate cannot bound: ${findCheckoutSpan(base).reason}`);

  const gatesPresent = placed.text.includes(GATES_SENTINEL);
  const result = { path: target, action, previous: placed.previous, gatesPresent, reason: null };

  if (action === 'added' && placed.replaced) {
    // The block was already there: unchanged means no write at all (D1), anything else
    // means the record names the checkout you just installed from (D3).
    result.action = placed.text === base ? 'current' : 'updated';
    if (result.action === 'current') return result;
  }

  if (opts.dryRun) return result;

  const refusal = writeAtomically(target, placed.text, opts);
  return refusal ? refuse(refusal) : result;
}

function main(argv, opts = {}) {
  const args = argv.slice(2);
  const log = opts.log ?? console.log;
  const logError = opts.logError ?? console.error;
  const cwd = opts.cwd ?? process.cwd();
  const claudeDir = opts.claudeDir ?? join(homedir(), '.claude');
  // D8: what gets RECORDED is the checkout that physically contains this script, which
  // is the only thing true regardless of the directory the command was run from.
  // installSkills() and registerReportGate() deliberately keep cwd below — changing what
  // they install FROM is a behaviour change to two working functions and is filed
  // separately (#103). Do not unify the three by reflex.
  const sourceRoot = opts.sourceRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const targetFlag = args.indexOf('--target');
  const given = targetFlag === -1 ? null : args[targetFlag + 1];
  // A --target with nothing after it used to reach dirname() as undefined and take the
  // process down on an uncaught TypeError. Refusing beats resolveProfile's ignore-it
  // treatment of a valueless --profile: a profile is additive information, a target is
  // where files get copied, and defaulting would write to a directory nobody named.
  if (targetFlag !== -1 && (!given || given.startsWith('--'))) {
    logError('--target needs a directory: node scripts/install-skills.mjs --target <dir>');
    return 1;
  }
  const target = given ?? join(claudeDir, 'skills');
  const dryRun = args.includes('--dry-run');

  // D5: the public export ships scripts/ and withholds skills/ (ADR 0002), and its user
  // is exactly the person who needs the checkout recorded. installSkills() keeps
  // throwing — a caller asking it to install from a tree with no skills is making an
  // error — but the CLI reports it and carries on to the work it can still do.
  try {
    const result = installSkills(cwd, target, { dryRun });
    log(`${dryRun ? 'would install' : 'installed'} ${result.installed.length} skill(s) to ${target}: ${result.installed.join(', ') || 'none'}`);
    for (const name of result.skipped) logError(`skipped (no SKILL.md): ${name}`);
  } catch (err) {
    logError(`skills not installed: ${err.message}`);
  }

  // dirname(target) rather than claudeDir: where the hook installs is existing
  // behaviour and moving it is not this change's business.
  const gate = registerReportGate(cwd, dirname(target), { dryRun });
  if (gate.skipped) logError(`report gate not registered: ${gate.skipped}`);
  else if (gate.registered) log(`${dryRun ? 'would register' : 'registered'} the /crit report gate on Stop: ${gate.path}`);
  else log(`/crit report gate already registered: ${gate.path}`);

  const checkout = recordCheckout(sourceRoot, claudeDir, { dryRun });
  if (checkout.action === 'refused') {
    // Exit 0 anyway (1.2b): the skills genuinely installed, and reporting failure for
    // work that succeeded is a false report. check-machine.mjs reports the missing
    // record, so the fact still reaches the user.
    logError(`checkout NOT recorded: ${checkout.reason} (${checkout.path})`);
  } else {
    log(`${dryRun ? 'would record' : 'recorded'} the daftplate checkout in ${checkout.path}: ${checkout.action} (${sourceRoot})`);
    if (!checkout.gatesPresent) {
      logError(`gates missing from ${checkout.path} — merge ${GLOBAL_TEMPLATE_REL} by hand; nothing here will inject them`);
    }
  }
  return 0;
}

export { main };
runCli(import.meta.url, main);
