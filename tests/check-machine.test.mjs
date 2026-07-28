import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { inspect, render, resolveProfile, advisory, main, FOOTER } from '../scripts/check-machine.mjs';
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

/** Runs main with everything impure injected. Returns the exit code and output. */
const runMain = (args, present, extra = {}) => {
  const out = [];
  const code = main(['node', 'check-machine.mjs', ...args], {
    entries: ENTRIES, probe: probeAll(present), log: (l) => out.push(l), cwd: emptyDir(), ...extra,
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
