#!/usr/bin/env node
// Installs skills/<name>/ into ~/.claude/skills/<name>/ (see ADR 0002).
// Copies over the top; never deletes. That directory holds every other skill you use.
// Usage: node scripts/install-skills.mjs [--target <dir>] [--dry-run]
import {
  existsSync, readdirSync, lstatSync, cpSync, readFileSync, writeFileSync,
  mkdirSync, mkdtempSync, renameSync, unlinkSync, rmdirSync, statSync, chmodSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCli } from './lib/cli.mjs';
import { renderCheckoutBlock, findCheckoutSpan } from './lib/checkout-marker.mjs';

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

const RENAME_ATTEMPTS = 3;
const RENAME_RETRY_MS = 150;

/** Sync sleep with no dependency and no busy-wait. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write `contents` over `target` without ever leaving it half-written.
 *
 * Temp-file-plus-rename, with the temp file on the same volume as the target so the
 * rename is a rename and not a copy (measured 2026-08-16: a cross-volume rename fails
 * EXDEV). The staging directory is mkdtemp-derived rather than a fixed name, so two
 * concurrent installs cannot clobber each other's staging file.
 *
 * On NTFS a rename over a file that any process holds open throws EPERM — an editor
 * tab, antivirus mid-scan, another agent reading it. POSIX permits it. Retried three
 * times to clear a transient scan, then refused. It never falls back to a plain
 * writeFileSync: that would reintroduce the torn write precisely when contention makes
 * it most likely, and this file holds the user's non-negotiable gates (D7).
 *
 * Returns null on success, or the refusal reason.
 */
function writeAtomically(claudeDir, target, contents, opts = {}) {
  const rename = opts.rename ?? renameSync;
  mkdirSync(claudeDir, { recursive: true });
  const staging = mkdtempSync(join(claudeDir, '.daftplate-'));
  const temp = join(staging, 'CLAUDE.md');

  try {
    writeFileSync(temp, contents, 'utf8');
    // Replacing by rename gives the new file the temp file's mode (0600 from mkdtemp),
    // which would silently tighten permissions on a file the user may have deliberately
    // made group-readable. No-op on Windows.
    if (existsSync(target)) chmodSync(temp, statSync(target).mode);

    for (let attempt = 1; ; attempt += 1) {
      try {
        rename(temp, target);
        return null;
      } catch (err) {
        if (err.code !== 'EPERM') throw err;   // only EPERM is a contention signal
        if (attempt >= RENAME_ATTEMPTS) {
          return `${target} is open in another process, so it was left untouched`;
        }
        pause(RENAME_RETRY_MS);
      }
    }
  } finally {
    // A failed rename leaves the temp file behind — daftplate debris in the user's
    // .claude/. Guarded so a cleanup failure never masks the original error, and
    // scoped to the directory this function itself created (CLAUDE.md #5).
    try {
      if (existsSync(temp)) unlinkSync(temp);
      rmdirSync(staging);
    } catch { /* nothing here is worth losing the real error over */ }
  }
}

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

  const refusal = writeAtomically(claudeDir, target, placed.text, opts);
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
