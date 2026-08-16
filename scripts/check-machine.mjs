#!/usr/bin/env node
// Second-pass machine verification: reports which tools from
// scripts/lib/toolchain.mjs this machine has. Detects; never installs, and
// writes nothing anywhere — no snapshot, no ignore list, no bookkeeping.
// Usage: node scripts/check-machine.mjs [--profile <name>] [--json]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { TOOLCHAIN, toolsFor } from './lib/toolchain.mjs';
import { readProvenance } from './lib/provenance.mjs';
import { runCli } from './lib/cli.mjs';
import { commandExists } from './lib/probe.mjs';
import { findCheckoutSpan } from './lib/checkout-marker.mjs';

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

  if (inspection.checkout) {
    if (lines.length) lines.push('');
    lines.push('daftplate checkout', ...renderCheckout(inspection.checkout));
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
    // The checkout is RECEIVED, never computed here. inspect() has a second caller —
    // setup-repo.mjs:311 runs advisory(inspect({...})) once per scaffolded repo — and
    // computing it here would spawn three git processes per scaffold for a result
    // advisory() never reads. Absent means absent: render() and toJson() omit the
    // section rather than reporting a checkout nobody asked about.
    ...(opts.checkout ? { checkout: opts.checkout } : {}),
    ok: missingRequired.length === 0,
  };
}

/** The four markers of a daftplate checkout, and the reason each is here.
 *  apply-layer.mjs and profiles/ are the scaffolding engine: they are what makes a
 *  checkout daftplate rather than a repo that once copied the standards. Identity by
 *  capability, not by remote URL — the public export, a fork and the private build all
 *  have different remotes and all are legitimately daftplate (D6). */
export const CHECKOUT_MARKERS = [
  'engineering-standards/repo-standards.md',
  'scripts/apply-layer.mjs',
  'profiles',
];

/**
 * Does `path` hold daftplate itself?
 *
 * Measured 2026-08-16: five repos in this workspace vendor the stale standards
 * snapshot, and every one of them is a git repo containing repo-standards.md. A check
 * of those two conditions would certify the exact artifacts that caused #98 — so the
 * scaffolding engine has to be there too. The reason names which marker is absent,
 * because "that is a git repo with a standards file but no profiles/, so it is a
 * vendored copy" is the message that actually helps.
 */
export function isCheckout(path, opts = {}) {
  const run = opts.run ?? gitRun;
  if (!path) return { ok: false, reason: 'no path was recorded' };

  const missing = CHECKOUT_MARKERS.filter((rel) => !existsSync(join(path, rel)));
  const git = run(path, ['rev-parse', '--git-dir']);
  if (git.status !== 0) {
    return { ok: false, reason: `${path} is not a git repository${missing.length ? `, and is missing ${missing.join(', ')}` : ''}` };
  }
  if (missing.length) {
    return { ok: false, reason: `${path} is a git repository but is missing ${missing.join(', ')} — a vendored copy of the standards, not a checkout` };
  }
  return { ok: true, reason: null };
}

/** `git -C <path> …`. Never inherits the process's own directory: without `-C` the
 *  checker reports staleness for whatever repo the developer happens to be standing
 *  in and calls it the daftplate checkout (D4). */
function gitRun(path, args) {
  return spawnSync('git', ['-C', path, ...args], { encoding: 'utf8' });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far behind its upstream the recorded checkout is, and how long since it fetched.
 *
 * Never fetches — this command's contract is that it writes nothing anywhere, and
 * `git fetch` writes to `.git`. So the comparison is against the last-fetched upstream
 * and the fetch age is reported alongside it, making a stale comparison visible rather
 * than trusted.
 *
 * Three rules, each of which was wrong in this plan's first draft:
 * - the comparison target is resolved from `origin/HEAD`, never `@{u}` — `@{u}` is the
 *   upstream of whatever branch the checkout was left on;
 * - FETCH_HEAD is located with `rev-parse --git-path`, never by joining `.git` onto the
 *   path, because a worktree's `.git` is a file;
 * - anything other than a zero exit throws, and the caller maps that to `unknown`. A
 *   missing git binary returns `status: null` with an error and no exit code at all
 *   (measured), so `status > 0` or a truthiness check would fall through to a silent
 *   false-`current`.
 *
 * The fetch age is a weak signal by construction: FETCH_HEAD is rewritten by any fetch
 * of any ref, so a young age does not prove `origin/<default>` was refreshed. It is
 * reported as last-fetch-of-any-ref for that reason, and a repo that has never fetched
 * reports null rather than 0.
 */
export function gitAhead(path, opts = {}) {
  const run = opts.run ?? gitRun;
  const must = (args, what) => {
    const r = run(path, args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${path} (${what})`);
    return r.stdout.trim();
  };

  const target = must(['rev-parse', '--abbrev-ref', 'origin/HEAD'], 'no origin/HEAD to compare against');
  const counted = must(['rev-list', '--count', `HEAD..${target}`], 'commit count');
  const behind = Number.parseInt(counted, 10);
  // A zero exit is not a number. NaN fails `behind > 0` and would land on `current`,
  // which is the same silent false-fresh this function refuses everywhere else.
  if (!Number.isInteger(behind)) throw new Error(`git rev-list printed a commit count that will not parse in ${path}: ${counted}`);

  let fetchAgeDays = null;
  const located = run(path, ['rev-parse', '--git-path', 'FETCH_HEAD']);
  if (located.status === 0) {
    const at = resolve(path, located.stdout.trim());
    if (existsSync(at)) fetchAgeDays = Math.floor((Date.now() - statSync(at).mtimeMs) / DAY_MS);
  }

  return { target, behind, fetchAgeDays };
}

/** Read the machine-level CLAUDE.md, or null when there is none to read. */
export function readGlobal(claudeDir = join(homedir(), '.claude')) {
  const at = join(claudeDir, 'CLAUDE.md');
  return existsSync(at) ? readFileSync(at, 'utf8') : null;
}

/**
 * What the machine records about the daftplate checkout, and whether it is any good.
 *
 * `missing` — nothing recorded, or a marker whose span cannot be bounded
 * `unresolvable` — a path is recorded and it is not a daftplate checkout (D6)
 * `current` / `behind` — resolved, and compared against the last-fetched upstream
 * `unknown` — resolved, but the comparison could not be made. Never `current`: a
 *   staleness check that goes green when it could not check is worse than none.
 *
 * Everything impure is injected, matching inspect()'s discipline — no branch here needs
 * a real home directory, a real repository or a network.
 */
export function inspectCheckout(opts = {}) {
  const read = opts.readGlobal ?? readGlobal;
  const resolves = opts.isCheckout ?? isCheckout;
  const ahead = opts.gitAhead ?? gitAhead;
  const blank = { recorded: null, resolves: false, behind: null, fetchAgeDays: null, reason: null };

  const text = read();
  if (!text) return { ...blank, state: 'missing', reason: 'no ~/.claude/CLAUDE.md records a daftplate checkout' };

  const span = findCheckoutSpan(text);
  if (!span.ok || !span.path) {
    return { ...blank, state: 'missing', reason: span.ok ? 'the recorded block carries no path line' : span.reason };
  }

  const recorded = span.path;
  const verdict = resolves(recorded);
  if (!verdict.ok) return { ...blank, recorded, state: 'unresolvable', reason: verdict.reason };

  try {
    const { target, behind, fetchAgeDays } = ahead(recorded);
    // `unknown` rather than `current` for a count that is not a number: the injected
    // seam has to hold the same line gitAhead holds, or the guard only covers the
    // path that happens to spawn git.
    if (!Number.isInteger(behind)) {
      return { ...blank, recorded, resolves: true, state: 'unknown', reason: `the commit count against ${target ?? 'the upstream'} did not parse` };
    }
    return {
      recorded,
      resolves: true,
      target: target ?? null,
      behind,
      fetchAgeDays,
      state: behind > 0 ? 'behind' : 'current',
      reason: null,
    };
  } catch (err) {
    return { ...blank, recorded, resolves: true, state: 'unknown', reason: err.message };
  }
}

/** The checkout section of the report. Its own function so render() stays a list of
 *  sections rather than a nest of conditionals. */
function renderCheckout(checkout) {
  const age = checkout.fetchAgeDays === null
    ? 'never fetched, so the comparison has nothing behind it'
    : `last fetch of any ref: ${checkout.fetchAgeDays} day(s) ago`;

  switch (checkout.state) {
    case 'missing':
      return ['  [ ] no daftplate checkout recorded', `      ${checkout.reason}`,
        '      fix: run `node scripts/install-skills.mjs` from your daftplate checkout'];
    case 'unresolvable':
      return [`  [ ] recorded: ${checkout.recorded}`, `      ${checkout.reason}`,
        '      fix: run `node scripts/install-skills.mjs` from the real checkout to rewrite it'];
    case 'unknown':
      return [`  [x] recorded: ${checkout.recorded}`, `      up to date? unknown — ${checkout.reason}`];
    case 'behind':
      return [`  [x] recorded: ${checkout.recorded}`,
        `      ${checkout.behind} commit(s) behind ${checkout.target ?? 'its upstream'} — ${age}`];
    default:
      return [`  [x] recorded: ${checkout.recorded}`, `      up to date — ${age}`];
  }
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
    ...(inspection.checkout ? { checkout: inspection.checkout } : {}),
  };
}

// The only impure part. Everything it decides with is injected, so every branch
// above is testable without touching PATH, the filesystem or stdout.
function main(argv, opts = {}) {
  const args = argv.slice(2);
  const log = opts.log ?? console.log;
  const cwd = opts.cwd ?? process.cwd();
  // Computed here rather than inside inspect(), so setup-repo.mjs's per-scaffold call
  // stays free of it. `checkout: null` is how a test opts out.
  const checkout = 'checkout' in opts ? opts.checkout : inspectCheckout();
  const inspection = inspect({
    entries: opts.entries,
    probe: opts.probe,
    profile: resolveProfile(args, cwd),
    checkout,
  });

  if (args.includes('--json')) log(JSON.stringify(toJson(inspection), null, 2));
  else for (const line of render(inspection)) log(line);

  // Non-zero on a missing `required` tool and nothing else: a recommended tool
  // that fails a CI job would get itself removed from the manifest within a week.
  // A missing, unresolvable or stale checkout is advice and never changes this —
  // it is a fact about another directory, not about whether this machine can build.
  return inspection.ok ? 0 : 1;
}

export { main };
runCli(import.meta.url, main);
