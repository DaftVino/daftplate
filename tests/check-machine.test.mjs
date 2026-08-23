import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  inspect, render, toJson, resolveProfile, advisory, main, FOOTER,
  inspectCheckout, isCheckout, gitAhead,
} from '../scripts/check-machine.mjs';
import { renderCheckoutBlock } from '../scripts/lib/checkout-marker.mjs';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-machine.mjs');

// A tiny stand-in manifest. Tests drive this rather than the real TOOLCHAIN so a
// manifest edit cannot silently change what these assert — the shipped array is
// tests/toolchain.test.mjs's job.
const ENTRIES = [
  { command: 'alpha', name: 'Alpha', tier: 'required', blocksScripts: true, why: 'it is needed', installer: 'winget', install: 'winget install Acme.Alpha', url: 'https://example.com/alpha', author: 'Acme' },
  { command: 'beta', name: 'Beta', tier: 'recommended', blocksScripts: false, why: 'it is nice', installer: 'npm', install: 'npm install -g beta', url: 'https://example.com/beta', author: 'Beta Co' },
];

// An injected prober: nothing in this file ever touches PATH.
const probeAll = (present) => (command) => present.includes(command);

test('a machine with everything present is ok', () => {
  const result = inspect({ entries: ENTRIES, probe: probeAll(['alpha', 'beta']) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missingRequired, []);
  assert.deepEqual(result.missingRecommended, []);
});

test('a machine missing only a recommended tool is still ok', () => {
  const result = inspect({ entries: ENTRIES, probe: probeAll(['alpha']) });
  assert.equal(result.ok, true, 'a recommended tool must never fail the run');
  assert.deepEqual(result.missingRecommended.map((t) => t.command), ['beta']);
});

test('a machine missing a required tool is not ok', () => {
  const result = inspect({ entries: ENTRIES, probe: probeAll(['beta']) });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingRequired.map((t) => t.command), ['alpha']);
});

test('every tool carries its probe result', () => {
  const result = inspect({ entries: ENTRIES, probe: probeAll(['alpha']) });
  assert.deepEqual(
    result.tools.map((t) => [t.command, t.present]),
    [['alpha', true], ['beta', false]],
  );
});

test('the footer names the manifest, so a newly installed tool has somewhere to go', () => {
  assert.match(FOOTER, /scripts\/lib\/toolchain\.mjs/);
});

// --- the report -------------------------------------------------------------

const renderWith = (present) => render(inspect({ entries: ENTRIES, probe: probeAll(present) }));

test('the report groups by tier, required first', () => {
  const lines = renderWith(['alpha', 'beta']);
  const tiers = lines.filter((l) => /^(required|recommended)$/.test(l));
  assert.deepEqual(tiers, ['required', 'recommended']);
});

test('a missing tool is reported with its reason, install command and credit', () => {
  const text = renderWith([]).join('\n');
  assert.match(text, /Alpha/);
  assert.match(text, /it is needed/, 'the why must say what it is for');
  assert.match(text, /winget install Acme\.Alpha/, 'the install command must be copy-pasteable');
  assert.match(text, /Acme · https:\/\/example\.com\/alpha/, 'credit names author and url');
});

test('a present tool is not nagged about with an install command', () => {
  const text = renderWith(['alpha', 'beta']).join('\n');
  assert.match(text, /Alpha/, 'it is still listed');
  assert.equal(text.includes('winget install Acme.Alpha'), false);
});

test('the footer is the last line on every run, clean machine or not', () => {
  for (const present of [[], ['alpha'], ['alpha', 'beta']]) {
    assert.equal(renderWith(present).at(-1), FOOTER, `missing footer for ${JSON.stringify(present)}`);
  }
});

// --- profiles ---------------------------------------------------------------

const PROFILED = [
  ...ENTRIES,
  { command: 'gamma', name: 'Gamma', tier: 'recommended', blocksScripts: false, why: 'deploys', installer: 'npm', install: 'npm install -g gamma', url: 'https://example.com/gamma', author: 'Gamma Co', profiles: ['gas-webapp'] },
];

test('a bare run does not nag about a tool restricted to a profile', () => {
  const result = inspect({ entries: PROFILED, probe: probeAll([]) });
  assert.equal(result.tools.some((t) => t.command === 'gamma'), false);
  assert.equal(result.missingRecommended.some((t) => t.command === 'gamma'), false);
});

test('a run under the matching profile includes its tool', () => {
  const result = inspect({ entries: PROFILED, profile: 'gas-webapp', probe: probeAll([]) });
  assert.ok(result.missingRecommended.some((t) => t.command === 'gamma'));
  assert.ok(result.tools.some((t) => t.command === 'alpha'), 'unrestricted tools still apply');
});

test('a run under a different profile leaves it out', () => {
  const result = inspect({ entries: PROFILED, profile: 'web-app', probe: probeAll([]) });
  assert.equal(result.tools.some((t) => t.command === 'gamma'), false);
});

test('resolveProfile takes --profile from the command line', () => {
  assert.equal(resolveProfile(['--profile', 'gas-webapp'], emptyDir()), 'gas-webapp');
});

test('resolveProfile falls back to the profile the repo records in .daftplate.json', () => {
  const dir = makeRepo({ '.daftplate.json': JSON.stringify({ daftplate: '1.2.0', profile: 'web-app', files: {} }) });
  assert.equal(resolveProfile([], dir), 'web-app');
});

test('an explicit --profile beats the one on disk', () => {
  const dir = makeRepo({ '.daftplate.json': JSON.stringify({ daftplate: '1.2.0', profile: 'web-app', files: {} }) });
  assert.equal(resolveProfile(['--profile', 'gas-webapp'], dir), 'gas-webapp');
});

test('no flag and no .daftplate.json means no profile', () => {
  assert.equal(resolveProfile([], emptyDir()), null);
});

test('a --profile with no value is not read as a profile named undefined', () => {
  assert.equal(resolveProfile(['--profile'], emptyDir()), null);
  assert.equal(resolveProfile(['--profile', '--json'], emptyDir()), null, 'the next flag is not a value');
});

test('an unreadable .daftplate.json degrades to no profile rather than throwing', () => {
  const dir = makeRepo({ '.daftplate.json': '{ not json' });
  assert.equal(resolveProfile([], dir), null);
});

// A manifest from a LATER daftplate is structurally valid, not corrupt, so the
// schema gate throws rather than parsing it. That throw lands in the same catch,
// which is right -- refusing to report on a machine because another repo is
// ahead would help nobody -- but it is now a decision with a test rather than a
// side effect. Whether check-machine should print a distinguishing line is a
// check-machine question and is deliberately not reopened here.
test('an unsupported schema degrades resolveProfile to no-profile rather than throwing', () => {
  const dir = makeRepo({
    '.daftplate.json': `${JSON.stringify({ schema: 99, profile: 'web-app', files: {} })}
`,
  });

  assert.equal(resolveProfile([], dir), null);
});

test('an empty tier prints no heading', () => {
  const onlyRequired = ENTRIES.filter((t) => t.tier === 'required');
  const lines = render(inspect({ entries: onlyRequired, probe: probeAll([]) }));
  assert.equal(lines.includes('recommended'), false);
});

// --- the advisory setup-repo prints -----------------------------------------
// One line, never blocking. setup-repo already runs once per new repo, which is
// the recurring trigger the panel picked; a second gate is not wanted.

const advisoryFor = (present, entries = ENTRIES) =>
  advisory(inspect({ entries, probe: probeAll(present) }));

test('there is no advisory when every recommended tool is present', () => {
  assert.equal(advisoryFor(['alpha', 'beta']), null);
});

test('the advisory names the missing recommended tools and where to look', () => {
  const line = advisoryFor(['alpha']);
  assert.match(line, /Beta/);
  assert.match(line, /check-machine/, 'it must point at the command that explains');
});

test('the advisory says nothing about a missing required tool', () => {
  // A required tool is already a blocking violation in setup-repo's own report.
  // Repeating it here as advice would suggest it is optional.
  const line = advisoryFor(['beta']);
  assert.equal(line, null);
});

test('the advisory is a single line, so it cannot bury the violation report', () => {
  assert.equal(advisoryFor([]).includes('\n'), false);
});

// --- the command ------------------------------------------------------------

/** Runs main with everything impure injected. Returns the exit code and output.
 *  `checkout: null` by default so these stay off the real ~/.claude/CLAUDE.md and
 *  spawn no git; the cases that care about the checkout pass their own. */
const runMain = (args, present, extra = {}) => {
  const out = [];
  const code = main(['node', 'check-machine.mjs', ...args], {
    entries: ENTRIES, probe: probeAll(present), log: (l) => out.push(l), cwd: emptyDir(), checkout: null, ...extra,
  });
  return { code, text: out.join('\n') };
};

test('a machine missing only a recommended tool exits 0 and still names it', () => {
  const { code, text } = runMain([], ['alpha']);
  assert.equal(code, 0, 'a recommended tool must never fail CI');
  assert.match(text, /Beta/);
});

test('a machine missing a required tool exits non-zero and names it', () => {
  const { code, text } = runMain([], ['beta']);
  assert.notEqual(code, 0);
  assert.match(text, /Alpha/);
});

test('--json emits parseable JSON carrying the same verdict', () => {
  const { code, text } = runMain(['--json'], ['alpha']);
  const parsed = JSON.parse(text);
  assert.equal(code, 0);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.missingRecommended, ['beta']);
  assert.deepEqual(parsed.missingRequired, []);
  assert.equal(parsed.profile, null);
});

test('--json reports a failing machine as ok:false with the exit code to match', () => {
  const { code, text } = runMain(['--json'], []);
  assert.equal(code, 1);
  assert.equal(JSON.parse(text).ok, false);
  assert.deepEqual(JSON.parse(text).missingRequired, ['alpha']);
});

test('--json prints no prose, so it can be piped', () => {
  const { text } = runMain(['--json'], ['alpha', 'beta']);
  assert.doesNotThrow(() => JSON.parse(text));
  assert.equal(text.includes(FOOTER), false);
});

test('--profile reaches the report through main', () => {
  const { text } = runMain(['--profile', 'gas-webapp', '--json'], [], { entries: PROFILED });
  assert.ok(JSON.parse(text).missingRecommended.includes('gamma'));
  assert.equal(JSON.parse(text).profile, 'gas-webapp');
});

// The probe form is a per-tool fact, not a universal one: `restic --version` is
// an unknown flag, and a probe that assumed otherwise reported an installed
// restic as missing. inspect must hand the entry's own form to the prober.
test('inspect passes each entry its declared versionArgs, and nothing when it has none', () => {
  const calls = [];
  const entries = [
    { ...ENTRIES[0], versionArgs: ['version'] },
    ENTRIES[1],
  ];
  inspect({ entries, probe: (command, versionArgs) => { calls.push([command, versionArgs]); return true; } });

  assert.deepEqual(calls, [['alpha', ['version']], ['beta', undefined]]);
});

test('inspect probes each reported tool exactly once and does nothing else', () => {
  const calls = [];
  inspect({ entries: PROFILED, probe: (c) => { calls.push(c); return true; } });
  assert.deepEqual(calls, ['alpha', 'beta'], 'a restricted tool is not even probed');
});

// The design's invariant, asserted against the real command rather than a
// re-implementation: no snapshot, no ignore list, no adopt/dismiss bookkeeping.
// Every location a state file could plausibly go is redirected into temp dirs,
// so anything written lands where this can see it.
//
// `gh` is the one permitted residue, and it is not ours: probing `gh --version`
// makes gh itself create `$XDG_STATE_HOME/gh`. Isolated by running each env var
// separately — USERPROFILE, HOME and XDG_CONFIG_HOME all stay clean. The
// variable is deliberately left redirected rather than unset: hiding the one
// setting that reveals a write would make this test agree with any future
// version of check-machine that started keeping state there.
const THIRD_PARTY_RESIDUE = ['gh'];

const runReal = (env) => {
  const cwd = emptyDir();
  const state = emptyDir();
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: state, USERPROFILE: state, XDG_STATE_HOME: state,
      XDG_CONFIG_HOME: state, XDG_DATA_HOME: state, XDG_CACHE_HOME: state,
      ...env,
    },
  });
  return { result, cwd, residue: readdirSync(state) };
};

test('the real command writes nothing where it runs', () => {
  const { result, cwd } = runReal();
  assert.deepEqual(readdirSync(cwd), [], 'check-machine wrote into the working directory');
  assert.match(result.stdout, /required/, 'and it did actually run');
});

test('the real command keeps no state of its own', () => {
  const { residue } = runReal();
  const ours = residue.filter((name) => !THIRD_PARTY_RESIDUE.includes(name));
  assert.deepEqual(ours, [], `check-machine kept state: ${ours.join(', ')}`);
});

test('nothing it leaves behind is named after this tool or its manifest', () => {
  const { residue } = runReal();
  for (const name of residue) {
    assert.doesNotMatch(name, /check-machine|toolchain|daftplate/, `${name} looks like our own bookkeeping`);
  }
});

test('the real command installs nothing — a missing tool stays missing', () => {
  // The inherited invariant. PATH is emptied so every probe fails; if any code
  // path reached for an installer, the second run would differ from the first.
  const first = runReal({ PATH: emptyDir(), Path: emptyDir() });
  const second = runReal({ PATH: emptyDir(), Path: emptyDir() });
  assert.equal(first.result.stdout, second.result.stdout, 'the run changed the machine');
  assert.match(first.result.stdout, /install: winget install Git\.Git/, 'it reports rather than acts');
});

// --- the recorded daftplate checkout (#100) ----------------------------------

const block = (p) => `# gates\n\n${renderCheckoutBlock(p)}\n`;
const RESOLVES = () => ({ ok: true, reason: null });
const baseInspection = inspect({ entries: [], probe: () => true });

test('a machine with no checkout record reports missing, and does not fail the run', () => {
  const r = inspectCheckout({ readGlobal: () => null });
  assert.equal(r.state, 'missing');
});

test('a record pointing at a directory that is not a daftplate checkout reports unresolvable', () => {
  // D6: existence is not resolution. This directory IS there; it just is not a
  // checkout, and the old existsSync-only design would have called it current.
  const r = inspectCheckout({
    readGlobal: () => block('X:/gone'),
    isCheckout: () => ({ ok: false, reason: 'no profiles/' }),
  });
  assert.equal(r.state, 'unresolvable');
  assert.equal(r.recorded, 'X:/gone');          // the wrong path must be visible
});

test('a current checkout reports current, with no commit count', () => {
  const r = inspectCheckout({
    readGlobal: () => block('X:/Projects/daftplate'),
    isCheckout: RESOLVES,
    gitAhead: () => ({ behind: 0, fetchAgeDays: 1 }),
  });
  assert.equal(r.state, 'current');
  assert.equal(r.behind, 0);
});

test('a checkout behind origin reports the commit count and the fetch age', () => {
  const r = inspectCheckout({
    readGlobal: () => block('X:/Projects/daftplate'),
    isCheckout: RESOLVES,
    gitAhead: () => ({ behind: 12, fetchAgeDays: 40 }),
  });
  assert.equal(r.state, 'behind');
  assert.equal(r.behind, 12);
  assert.equal(r.fetchAgeDays, 40);
});

test('an unavailable upstream reports unknown rather than current', () => {
  // D4: a staleness check that goes green when origin/HEAD is unresolvable is
  // worse than no check at all.
  const r = inspectCheckout({
    readGlobal: () => block('X:/Projects/daftplate'),
    isCheckout: RESOLVES,
    gitAhead: () => { throw new Error('no origin/HEAD'); },
  });
  assert.equal(r.state, 'unknown');
});

test('a machine with no git at all reports unknown, not current', () => {
  // Measured: spawnSync on a missing binary returns status: null and an error
  // object — NO exit code. `status > 0` or a truthiness check would fall
  // through to 'current' here, which is the silent false-fresh D4 forbids.
  const enoent = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  const r = inspectCheckout({
    readGlobal: () => block('X:/Projects/daftplate'),
    isCheckout: RESOLVES,
    gitAhead: () => { throw enoent; },
  });
  assert.equal(r.state, 'unknown');
  assert.notEqual(r.state, 'current');
});

test('gitAhead runs against the recorded checkout, not the process cwd', () => {
  // The defect this plan's own first draft shipped: without -C, the checker
  // reports staleness for whatever repo the developer is standing in.
  const seen = [];
  inspectCheckout({
    readGlobal: () => block('X:/Projects/daftplate'),
    isCheckout: RESOLVES,
    gitAhead: (p) => { seen.push(p); return { behind: 0, fetchAgeDays: 0 }; },
  });
  assert.deepEqual(seen, ['X:/Projects/daftplate']);
});

test('a marker daftplate cannot bound is reported, not read as a recorded path', () => {
  const r = inspectCheckout({ readGlobal: () => `${block('X:/a')}\n${block('X:/b')}` });
  assert.equal(r.state, 'missing');
  assert.equal(r.recorded, null);
  assert.match(r.reason, /more than one/);
});

test('render and toJson both carry the checkout result', () => {
  const opts = { readGlobal: () => null };
  assert.equal(render(inspect({ entries: [], probe: () => true, checkout: inspectCheckout(opts) }))
    .some((l) => /checkout/i.test(l)), true);
  assert.equal('checkout' in toJson(inspect({ entries: [], probe: () => true, checkout: inspectCheckout(opts) })), true);
});

test('render and toJson omit the checkout entirely when it was not inspected', () => {
  // setup-repo.mjs:311 calls inspect() without one, and computing it there would
  // spawn three git processes per scaffold for a result advisory() never reads.
  // Without this the protection is invisible and the next refactor removes it.
  assert.equal(render(baseInspection).some((l) => /checkout/i.test(l)), false);
  assert.equal('checkout' in toJson(baseInspection), false);
});

test('a broken or stale checkout is advice, not a gate', () => {
  // Written so it can fail: main(..., { entries: [] }) returns 0 under any
  // implementation, so every required tool is present here and only the
  // checkout state varies.
  for (const bad of ['missing', 'unresolvable', 'behind', 'unknown']) {
    const { code } = runMain([], ['alpha', 'beta'], {
      checkout: { recorded: 'X:/somewhere', state: bad, behind: 12, fetchAgeDays: 40, reason: null },
    });
    assert.equal(code, 0, `${bad} must not change the exit code`);
  }
});

// --- the two impure functions, against real trees and a real git -------------

const git = (dir, args) => {
  const r = spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.error?.message}`);
  return r.stdout.trim();
};

/** A real bare origin and a real clone, so behind-counts are real rather than
 *  mocked. Identity is set per-repo: a CI runner with no global user.email must
 *  not fail these for an unrelated reason. */
const gitRepo = (files = {}, opts = {}) => {
  const work = makeRepo({ 'README.md': '# seed\n', ...files });
  git(work, ['init', '-b', 'main']);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'Test']);
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'seed']);

  const origin = emptyDir();
  git(origin, ['init', '--bare', '-b', 'main']);
  git(work, ['remote', 'add', 'origin', origin]);
  git(work, ['push', '-u', 'origin', 'main']);

  const clone = emptyDir();
  git(clone, ['clone', origin, '.']);

  if (!opts.skipFetch) {
    // origin advances by two commits after the clone, then the clone fetches:
    // that is what makes `behind` a real number rather than a stub.
    for (const n of [1, 2]) {
      writeFileSync(join(work, `later-${n}.md`), `${n}\n`, 'utf8');
      git(work, ['add', '-A']);
      git(work, ['commit', '-m', `later ${n}`]);
    }
    git(work, ['push']);
    git(clone, ['fetch']);
  }
  if (opts.noOriginHead) git(clone, ['remote', 'set-head', 'origin', '--delete']);

  return { work, origin, clone };
};

const addWorktree = (clone) => {
  const at = join(emptyDir(), 'wt');       // must not exist yet
  git(clone, ['worktree', 'add', at]);
  return at;
};

const DAFTPLATE_SHAPE = {
  'engineering-standards/repo-standards.md': '# std\n',
  'scripts/apply-layer.mjs': 'export const x = 1;\n',
  'profiles/web-app/profile.md': '# web-app\n',
};

test('isCheckout refuses a directory that is not a git repo', () => {
  const r = isCheckout(makeRepo(DAFTPLATE_SHAPE));
  assert.equal(r.ok, false);
  assert.match(r.reason, /git/);
});

test('isCheckout refuses a git repo with no standards file', () => {
  assert.equal(isCheckout(gitRepo().clone).ok, false);
});

test('isCheckout refuses a repo that VENDORS the standards but is not daftplate', () => {
  // THE case. Measured 2026-08-16: five unrelated repos in this workspace are
  // git repos holding a vendored engineering-standards/repo-standards.md — the
  // same stale 13,019-byte snapshot (sha256 C117010C), against a canonical
  // 29,091. The pre-D6-revision check passed all five. Certifying one of them
  // as the checkout is the original bug with a green tick on it.
  const { clone } = gitRepo({ 'engineering-standards/repo-standards.md': '# stale\n' });
  const r = isCheckout(clone);
  assert.equal(r.ok, false);
  assert.match(r.reason, /apply-layer|profiles/);      // says WHICH marker is absent
});

test('isCheckout accepts a real daftplate-shaped checkout', () => {
  assert.equal(isCheckout(gitRepo(DAFTPLATE_SHAPE).clone).ok, true);
});

test('gitAhead counts real commits against origin HEAD', () => {
  const { clone } = gitRepo();                 // origin advanced by 2 after cloning
  assert.equal(gitAhead(clone).behind, 2);
});

test('gitAhead resolves FETCH_HEAD in a worktree, where .git is a FILE', () => {
  // D3 accepts worktrees and D4 chose `rev-parse --git-path FETCH_HEAD` for
  // exactly this. Nothing else in the suite proves that choice was right.
  const { clone } = gitRepo();
  const wt = addWorktree(clone);
  git(wt, ['fetch']);            // FETCH_HEAD is per-worktree, so the worktree must fetch
  assert.equal(statSync(join(wt, '.git')).isFile(), true);   // the premise
  assert.equal(gitAhead(wt).behind, 2);
  // A NUMBER, not merely "not undefined": the plan wrote this as
  // notEqual(fetchAgeDays, undefined), which null also satisfies — so the
  // join(path, '.git', 'FETCH_HEAD') mutation this test exists to kill passed it.
  // Issue #97's class, found by applying the mutation rather than trusting the test.
  // It is a number only because --git-path resolves into .git/worktrees/<name>/,
  // which is exactly what path construction onto a .git FILE cannot reach.
  assert.equal(typeof gitAhead(wt).fetchAgeDays, 'number');
});

test('gitAhead reports an unknown age when the repo has never fetched', () => {
  const { clone } = gitRepo({}, { skipFetch: true });
  assert.equal(gitAhead(clone).fetchAgeDays, null);   // null, never 0
});

test('a null fetch age reaches the user as unknown-age, not as a silent current', () => {
  // Proving gitAhead returns null is not the same as proving inspectCheckout
  // does something honest with it. Without this the mapping is unasserted.
  const r = inspectCheckout({
    readGlobal: () => block('X:/Projects/daftplate'),
    isCheckout: RESOLVES,
    gitAhead: () => ({ behind: 0, fetchAgeDays: null }),
  });
  assert.equal(r.fetchAgeDays, null);
  assert.match(render({ ...baseInspection, checkout: r }).join('\n'), /never fetched|age unknown/);
});

test('gitAhead reports unknown when origin/HEAD does not resolve', () => {
  const { clone } = gitRepo({}, { noOriginHead: true });
  assert.throws(() => gitAhead(clone));          // caught by inspectCheckout -> unknown
});

test('the report names the ref it compared against, not a generic upstream', () => {
  // gitAhead resolves origin/HEAD and returns it; if inspectCheckout drops it, the
  // stale line can never say which ref it counted against and renderCheckout's
  // fallback becomes the only branch that ever runs.
  const r = inspectCheckout({
    readGlobal: () => block('X:/Projects/daftplate'),
    isCheckout: RESOLVES,
    gitAhead: () => ({ target: 'origin/main', behind: 12, fetchAgeDays: 2 }),
  });
  assert.equal(r.target, 'origin/main');
  assert.match(render({ ...baseInspection, checkout: r }).join('\n'), /12 commit\(s\) behind origin\/main/);
});

test('a commit count that will not parse is unknown, never current', () => {
  // The silent false-current D4 forbids, one layer lower than the missing-git case:
  // `behind > 0` is false for NaN, so an unparseable count would report a machine
  // that was never actually compared as up to date.
  const r = inspectCheckout({
    readGlobal: () => block('X:/Projects/daftplate'),
    isCheckout: RESOLVES,
    gitAhead: () => ({ behind: Number.NaN, fetchAgeDays: 1 }),
  });
  assert.equal(r.state, 'unknown');
  assert.notEqual(r.state, 'current');
});

test('gitAhead refuses a commit count git did not print as a number', () => {
  const run = (path, args) => (args[1] === '--abbrev-ref'
    ? { status: 0, stdout: 'origin/main\n' }
    : { status: 0, stdout: 'fatal: something went sideways\n' });
  assert.throws(() => gitAhead('X:/anywhere', { run }), /count/);
});
