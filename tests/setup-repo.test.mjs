import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, MINIMAL } from './helpers/make-repo.mjs';
import {
  PREREQUISITES, checkPrerequisites, installGitleaksHook, checkRepoSetup, main,
} from '../scripts/setup-repo.mjs';
import { TOOLCHAIN } from '../scripts/lib/toolchain.mjs';

const withGitDir = (extra = {}) => {
  const dir = makeRepo({ ...MINIMAL, ...extra });
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  return dir;
};

test('PREREQUISITES names an install command for every tool', () => {
  assert.ok(PREREQUISITES.length >= 4);
  for (const p of PREREQUISITES) {
    assert.ok(p.command && p.why && p.install, `${p.command} is missing a field`);
  }
});

// Asserted by value, not by count: PREREQUISITES is now derived from
// scripts/lib/toolchain.mjs, so a manifest edit is one keystroke away from
// changing what every repo bootstrap blocks on. `restic` and `codex` are
// `required` in the manifest and must NOT appear here — the filter is
// `blocksScripts`, and this is the test that says so.
test('PREREQUISITES is the blocksScripts slice of the toolchain manifest', () => {
  assert.deepEqual(PREREQUISITES.map((p) => p.command), ['git', 'gh', 'node', 'gitleaks']);
  assert.deepEqual(PREREQUISITES, TOOLCHAIN.filter((t) => t.blocksScripts));
  for (const t of TOOLCHAIN) {
    if (!t.blocksScripts) assert.equal(PREREQUISITES.includes(t), false, `${t.command} must not block bootstrap`);
  }
});

test('the derived prerequisites report the same text the inline list did', () => {
  const violations = checkPrerequisites(() => false, () => '');
  assert.deepEqual(violations.map((v) => v.path), ['git', 'gh', 'node', 'gitleaks']);
  assert.equal(
    violations[0].message,
    'not on PATH — needed for version control. Install: winget install Git.Git',
  );
});

test('checkPrerequisites passes when everything resolves and gh has the project scope', () => {
  assert.deepEqual(checkPrerequisites(() => true, () => "Token scopes: 'gist', 'project', 'repo'"), []);
});

test('checkPrerequisites reports the install command for what is missing', () => {
  const violations = checkPrerequisites((cmd) => cmd !== 'gitleaks', () => "Token scopes: 'project'");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'prerequisite');
  assert.match(violations[0].message, /winget install Gitleaks\.Gitleaks/);
});

test('checkPrerequisites reports a gh token missing the project scope', () => {
  const violations = checkPrerequisites(() => true, () => "Token scopes: 'gist', 'repo'");
  assert.deepEqual(violations.map((v) => v.rule), ['gh-scope']);
  assert.match(violations[0].message, /gh auth refresh -s project/);
});

test('checkPrerequisites does not check scopes when gh itself is missing', () => {
  const violations = checkPrerequisites((cmd) => cmd !== 'gh', () => '');
  assert.deepEqual(violations.map((v) => v.rule), ['prerequisite']);
});

// Drives main() rather than a helper, deliberately. M1 shipped a feature that
// was inert in production while every test passed, because the tests called the
// helper and main's own forwarder dropped an argument. An advisory that main
// never prints is worth nothing.
const captureMain = (args, opts) => {
  const lines = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (l) => lines.push(String(l));
  console.error = () => {};
  try {
    const code = main(['node', 'setup-repo.mjs', ...args], undefined, opts);
    return { code, text: lines.join('\n') };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
};

test('main advises about missing recommended tools', () => {
  const dir = withGitDir();
  const { text } = captureMain([dir], { resolve: () => false, scopes: () => '' });
  assert.match(text, /recommended, not installed:/);
  assert.match(text, /ripgrep/, 'it names the tool, not just a count');
  assert.match(text, /check-machine/, 'and where to get the install command');
});

test('the advisory never blocks — it does not change the exit code', () => {
  const dir = withGitDir();
  installGitleaksHook(dir);
  // Every prerequisite present, every recommended tool absent.
  const present = new Set(PREREQUISITES.map((p) => p.command));
  const { code, text } = captureMain([dir], {
    resolve: (cmd) => present.has(cmd),
    scopes: () => "Token scopes: 'project'",
  });
  assert.match(text, /recommended, not installed:/, 'the advice is printed');
  assert.equal(code, 0, 'and it is still a clean run');
});

test('main says nothing when every recommended tool is present', () => {
  const dir = withGitDir();
  const { text } = captureMain([dir], { resolve: () => true, scopes: () => "Token scopes: 'project'" });
  assert.equal(text.includes('recommended, not installed'), false);
});

test('installGitleaksHook writes an executable pre-commit hook with LF endings', () => {
  const dir = withGitDir();
  assert.equal(installGitleaksHook(dir), 'installed');
  const hook = readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8');
  assert.match(hook, /^#!\/bin\/sh\n/);
  assert.match(hook, /gitleaks git --staged/);
  assert.equal(hook.includes('\r\n'), false);
});

test('installGitleaksHook does not clobber an existing hook without force', () => {
  const dir = withGitDir();
  const path = join(dir, '.git', 'hooks', 'pre-commit');
  installGitleaksHook(dir);
  const mine = '#!/bin/sh\necho custom\n';
  writeFileSync(path, mine);

  assert.equal(installGitleaksHook(dir), 'present');
  assert.equal(readFileSync(path, 'utf8'), mine);

  assert.equal(installGitleaksHook(dir, { force: true }), 'installed');
  assert.match(readFileSync(path, 'utf8'), /gitleaks git --staged/);
});

test('installGitleaksHook reports when the target is not a git repo', () => {
  assert.equal(installGitleaksHook(makeRepo(MINIMAL)), 'no-git-dir');
});

test('checkRepoSetup reports a missing hook without writing one', () => {
  const dir = withGitDir();
  const violations = checkRepoSetup(dir, { resolve: () => true, scopes: () => "Token scopes: 'project'" });
  assert.deepEqual(violations.map((v) => v.rule), ['pre-commit-hook']);
  assert.equal(existsSync(join(dir, '.git', 'hooks', 'pre-commit')), false);
});

test('checkRepoSetup is clean once the hook is installed', () => {
  const dir = withGitDir();
  installGitleaksHook(dir);
  assert.deepEqual(checkRepoSetup(dir, { resolve: () => true, scopes: () => "Token scopes: 'project'" }), []);
});

test('checkRepoSetup flags a hook that does not invoke gitleaks', () => {
  const dir = withGitDir();
  installGitleaksHook(dir);
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  assert.deepEqual(checkRepoSetup(dir, { resolve: () => true, scopes: () => "Token scopes: 'project'" }).map((v) => v.rule), ['pre-commit-hook']);
});
