import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TOOLCHAIN, TIERS, INSTALLERS, REQUIRED_FIELDS, validateToolchain, toolsFor,
} from '../scripts/lib/toolchain.mjs';

// A well-formed entry to mutate. Built here rather than copied from TOOLCHAIN so
// a real entry going bad cannot quietly make these negative cases pass.
const GOOD = {
  command: 'widget',
  name: 'Widget',
  tier: 'recommended',
  blocksScripts: false,
  why: 'testing',
  installer: 'winget',
  install: 'winget install Acme.Widget',
  url: 'https://example.com/widget',
  author: 'Acme',
};

const messages = (entries) => validateToolchain(entries).map((v) => v.message).join('\n');

test('the shipped manifest is clean', () => {
  assert.deepEqual(validateToolchain(), []);
});

test('every entry omitting a required field is caught, one field at a time', () => {
  for (const field of REQUIRED_FIELDS) {
    const { [field]: _dropped, ...missing } = GOOD;
    assert.match(
      messages([missing]),
      new RegExp(`missing \`${field}\``),
      `dropping ${field} produced no violation`,
    );
  }
});

test('an empty string is as bad as a missing field', () => {
  assert.match(messages([{ ...GOOD, why: '' }]), /`why` is empty/);
});

test('blocksScripts false is a value, not an omission', () => {
  // The one required field whose valid value is falsy — an emptiness check that
  // did not special-case it would reject every non-blocking entry in the file.
  assert.deepEqual(validateToolchain([{ ...GOOD, blocksScripts: false }]), []);
  assert.match(messages([{ ...GOOD, blocksScripts: 'false' }]), /must be a boolean/);
});

test('tier is one of exactly two values', () => {
  assert.deepEqual(TIERS, ['required', 'recommended']);
  assert.match(messages([{ ...GOOD, tier: 'optional' }]), /tier `optional` is not one of/);
  for (const tier of TIERS) assert.deepEqual(validateToolchain([{ ...GOOD, tier }]), []);
});

test('no entry may carry a license field', () => {
  assert.match(messages([{ ...GOOD, license: 'MIT' }]), /`license` field/);
  for (const entry of TOOLCHAIN) assert.equal('license' in entry, false, `${entry.command} carries a license`);
});

test('the install string must match its declared installer', () => {
  assert.match(
    messages([{ ...GOOD, installer: 'npm', install: 'winget install Acme.Widget' }]),
    /does not start with `npm install -g `/,
  );
  assert.match(messages([{ ...GOOD, installer: 'brew' }]), /installer `brew` is not one of/);
});

test('every installer in the table is exercisable and every entry uses one', () => {
  for (const [installer, prefix] of Object.entries(INSTALLERS)) {
    assert.deepEqual(validateToolchain([{ ...GOOD, installer, install: `${prefix}thing` }]), []);
  }
  for (const entry of TOOLCHAIN) {
    assert.ok(entry.install.startsWith(INSTALLERS[entry.installer]), `${entry.command} install string`);
  }
});

test('urls are https', () => {
  assert.match(messages([{ ...GOOD, url: 'http://example.com' }]), /url must be https/);
});

test('duplicate commands are rejected', () => {
  assert.match(messages([GOOD, { ...GOOD, name: 'Other' }]), /duplicate command/);
});

test('profiles, when present, is a non-empty array of names', () => {
  assert.deepEqual(validateToolchain([{ ...GOOD, profiles: ['gas-webapp'] }]), []);
  for (const bad of [[], 'gas-webapp', [''], [1]]) {
    assert.match(messages([{ ...GOOD, profiles: bad }]), /non-empty array/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('versionArgs, when present, is a non-empty array of strings', () => {
  assert.deepEqual(validateToolchain([{ ...GOOD, versionArgs: ['version'] }]), []);
  for (const bad of [[], 'version', [''], [1]]) {
    assert.match(messages([{ ...GOOD, versionArgs: bad }]), /non-empty array/, `accepted ${JSON.stringify(bad)}`);
  }
});

// Verified by running both forms on 2026-07-27, not written from recall:
// `restic --version` exits 1 with "unknown flag: --version"; `restic version`
// exits 0. Every other installed entry answers `--version`.
test('restic declares the probe form it actually answers to', () => {
  assert.deepEqual(TOOLCHAIN.find((t) => t.command === 'restic').versionArgs, ['version']);
});

test('every other entry omits versionArgs rather than restating the default', () => {
  const declaring = TOOLCHAIN.filter((t) => 'versionArgs' in t).map((t) => t.command);
  assert.deepEqual(declaring, ['restic']);
});

test('the four blocking tools are exactly the ones repo bootstrap needs', () => {
  assert.deepEqual(
    TOOLCHAIN.filter((t) => t.blocksScripts).map((t) => t.command),
    ['git', 'gh', 'node', 'gitleaks'],
  );
});

test('every blocking tool is also required — a script cannot depend on an optional tool', () => {
  for (const t of TOOLCHAIN.filter((x) => x.blocksScripts)) assert.equal(t.tier, 'required');
});

test('toolsFor omits profile-restricted entries from a bare run', () => {
  const bare = toolsFor(undefined).map((t) => t.command);
  assert.equal(bare.includes('clasp'), false);
  assert.equal(bare.includes('wrangler'), false);
  assert.ok(bare.includes('git'));
});

test('toolsFor includes an entry when its profile is the active one', () => {
  const gas = toolsFor('gas-webapp').map((t) => t.command);
  assert.ok(gas.includes('clasp'));
  assert.equal(gas.includes('wrangler'), false, 'a different profile must not leak in');
  assert.ok(gas.includes('git'), 'unrestricted entries still apply under a profile');
});

// --- the prose front door ----------------------------------------------------
// docs/setup-guide.md is the primary interface: on a new machine there is no
// checkout to run check-machine.mjs from, so the guide on github.com is the only
// thing a reader has. That makes drift between it and the manifest a defect
// rather than a discovery, and this is where it turns red.

const GUIDE = new URL('../docs/setup-guide.md', import.meta.url);

/** Which unrestricted entries the guide fails to carry, and in what respect.
 *  Takes the text so the detector can be driven with a guide that is missing
 *  something — asserting only against the real file proves today's prose is
 *  fine, never that tomorrow's omission is caught. */
function guideGaps(guide, entries = TOOLCHAIN) {
  const gaps = [];
  for (const tool of toolsFor(undefined, entries)) {
    // Word-bounded: a bare `includes` would let "GitHub CLI" satisfy "Git", so
    // deleting the Git row would leave every assertion here green.
    const name = new RegExp(`\\b${tool.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (!name.test(guide)) gaps.push(`${tool.command} (name)`);
    if (!guide.includes(tool.install)) gaps.push(`${tool.command} (install)`);
  }
  return gaps;
}

test('every unrestricted manifest entry appears in the setup guide', () => {
  assert.deepEqual(guideGaps(readFileSync(GUIDE, 'utf8')), []);
});

test('a name dropped from the guide is a gap, and a substring does not cover it', () => {
  const guide = readFileSync(GUIDE, 'utf8');
  const git = TOOLCHAIN.find((t) => t.command === 'git');

  // Strip the Git row's two identifying strings; "GitHub CLI" survives in the
  // table below it and must not be allowed to stand in for "Git".
  const without = guide.split(`[${git.name}](`).join('[](').split(git.install).join('');

  assert.deepEqual(guideGaps(without), ['git (name)', 'git (install)']);
});

test('a profile-restricted entry is not required to appear', () => {
  const restricted = { ...GOOD, command: 'nowhere', name: 'Nowhere', profiles: ['gas-webapp'] };
  assert.deepEqual(guideGaps('', [restricted]), []);
  assert.deepEqual(guideGaps('', [{ ...restricted, profiles: undefined }]), [
    'nowhere (name)', 'nowhere (install)',
  ]);
});
