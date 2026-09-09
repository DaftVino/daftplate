import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { makeRepo, emptyDir, MINIMAL } from './helpers/make-repo.mjs';
import {
  PREREQUISITES, checkPrerequisites, installGitleaksHook, installBranchNameHook,
  VENDORED_STANDARDS_PATTERN, PRODUCER_CHECKOUT_MARKERS,
  checkRepoSetup, main,
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
  // Both managed hooks are reported, and --check writes neither: doctor mode is
  // a diagnosis, so a missing hook it could install is still only reported.
  assert.deepEqual(violations.map((v) => v.rule), ['pre-commit-hook', 'pre-push-hook']);
  assert.equal(existsSync(join(dir, '.git', 'hooks', 'pre-commit')), false);
  assert.equal(existsSync(join(dir, '.git', 'hooks', 'pre-push')), false);
});

test('checkRepoSetup is clean once both managed hooks are installed', () => {
  const dir = withGitDir();
  installGitleaksHook(dir);
  installBranchNameHook(dir);
  assert.deepEqual(checkRepoSetup(dir, { resolve: () => true, scopes: () => "Token scopes: 'project'" }), []);
});

test('checkRepoSetup reports the branch hook alone when only gitleaks is installed', () => {
  // Kills the mutation that checks the pre-commit hook and calls it done.
  const dir = withGitDir();
  installGitleaksHook(dir);
  const rules = checkRepoSetup(dir, { resolve: () => true, scopes: () => "Token scopes: 'project'" })
    .map((v) => v.rule);
  assert.deepEqual(rules, ['pre-push-hook']);
});

test('an unrelated pre-push hook is reported rather than counted as ours', () => {
  const dir = withGitDir();
  installGitleaksHook(dir);
  writeFileSync(join(dir, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
  const rules = checkRepoSetup(dir, { resolve: () => true, scopes: () => "Token scopes: 'project'" })
    .map((v) => v.rule);
  assert.deepEqual(rules, ['pre-push-hook']);
});

test('checkRepoSetup flags a hook that does not invoke gitleaks', () => {
  const dir = withGitDir();
  installGitleaksHook(dir);
  installBranchNameHook(dir);
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  assert.deepEqual(checkRepoSetup(dir, { resolve: () => true, scopes: () => "Token scopes: 'project'" }).map((v) => v.rule), ['pre-commit-hook']);
});

// --- the vendored-standards refusal barriers (#101, #74, #75) ----------------
//
// Exercised through git's own hook runner. Asserting the generated hook CONTAINS
// a grep proves nothing about whether git runs it, what it exits, or whether the
// gitleaks half still fires afterwards.

/** A git repo with the managed pre-commit hook installed. */
function hookedRepo(files = {}) {
  const dir = emptyDir();
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  for (const [rel, body] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, 'utf8');
  }
  installGitleaksHook(dir);
  return { dir, git };
}

const runPreCommit = (dir) => spawnSync(
  'git',
  ['-C', dir, 'hook', 'run', '--ignore-missing', 'pre-commit'],
  { encoding: 'utf8' },
);

test('the hook refuses a staged vendored engineering-standards path', () => {
  const { dir, git } = hookedRepo({
    'engineering-standards/repo-standards.md': '# a frozen copy\n',
    'README.md': '# x\n',
  });
  git('add', '-A');

  const r = runPreCommit(dir);

  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refusing to commit a vendored copy/);
  assert.match(r.stderr, /engineering-standards\/repo-standards\.md/);
  assert.match(r.stderr, /ADR 0001/);
});

test('the refusal names no deletion command and removes nothing', () => {
  // CLAUDE.md #5: a hook that removed a directory the operator staged would be
  // destroying work to enforce a documentation rule.
  const { dir, git } = hookedRepo({ 'engineering-standards/repo-standards.md': '# copy\n' });
  git('add', '-A');

  const r = runPreCommit(dir);
  const both = `${r.stdout}\n${r.stderr}`;

  assert.match(both, /this hook never deletes anything/);
  assert.doesNotMatch(both, /rm -rf|Remove-Item|git rm/);
  assert.equal(existsSync(join(dir, 'engineering-standards', 'repo-standards.md')), true);
});

test('the refusal is anchored at the repository root, not at the words', () => {
  // A file that merely mentions the standards, and a nested directory sharing
  // the name, are both legitimate and must commit.
  const { dir, git } = hookedRepo({
    'docs/about-engineering-standards.md': 'we point at engineering-standards/ upstream\n',
    'vendor/other/engineering-standards/notes.md': '# not ours\n',
  });
  git('add', '-A');

  const r = runPreCommit(dir);

  // The claim is about the VENDORED half, so it is asserted against the vendored
  // half. The hook continues into the gitleaks half, which exits 1 with its own
  // message wherever gitleaks is not installed — CI runners included — and an
  // exit-code assertion here would report "refused a legitimate path" for a
  // missing binary. Measured: this failed on ubuntu-latest for exactly that.
  assert.doesNotMatch(r.stderr, /refusing to commit a vendored copy/, r.stderr);
  assert.doesNotMatch(r.stderr, /engineering-standards/, r.stderr);
});

test('the gitleaks half still runs after the vendored check passes', () => {
  // Two refusals share one hook because setup already manages that file. Adding
  // the first one must not shadow the second.
  const { dir, git } = hookedRepo({ 'README.md': '# clean\n' });
  git('add', '-A');

  const r = runPreCommit(dir);
  const both = `${r.stdout}\n${r.stderr}`;

  // "Control reached gitleaks" is the claim, and it is provable without gitleaks
  // installed: reaching it and finding it absent produces the not-on-PATH
  // refusal, which only that half can emit. Both outcomes prove the first
  // refusal did not shadow the second; only one of them needs a binary. The
  // earlier `assert.equal(r.status, 0)` made a machine with no gitleaks
  // indistinguishable from a hook that returned early, and failed on CI.
  assert.match(both, /gitleaks|no leaks found/i, both);
  assert.doesNotMatch(both, /refusing to commit a vendored copy/, both);
});

test('the pattern is exported and anchored, so CI and the hook cannot drift', () => {
  assert.equal(VENDORED_STANDARDS_PATTERN, '^engineering-standards(/|$)');
  const re = new RegExp(VENDORED_STANDARDS_PATTERN);
  assert.equal(re.test('engineering-standards'), true);
  assert.equal(re.test('engineering-standards/repo-standards.md'), true);
  assert.equal(re.test('docs/about-engineering-standards.md'), false);
  assert.equal(re.test('vendor/engineering-standards/x.md'), false);
});

test('the hook does not refuse the producer checkout its own standards', () => {
  // The CI half of this guard shipped refusing daftplate itself; the hook half
  // carries the identical predicate, so it had the identical defect — latent
  // only because setup-repo is not run in this checkout. ADR 0001 makes
  // engineering-standards/ canonical HERE, and a hook that blocked every commit
  // touching it would make the source of the standards the one repo that cannot
  // edit them.
  //
  // Asserted as "the vendored refusal did not fire" rather than "the hook exited
  // 0": the hook continues into the gitleaks half, which exits 1 with its own
  // message on a machine without gitleaks installed. Conflating the two would
  // make this test report the wrong reason on someone else's laptop.
  const { dir, git } = hookedRepo({
    'base/files/CLAUDE.md': '# the base layer\n',
    'profiles/local-tool/profile.md': '# a profile\n',
    'engineering-standards/repo-standards.md': '# the canonical standards\n',
  });
  git('add', '-A');

  const r = runPreCommit(dir);

  assert.doesNotMatch(r.stderr, /refusing to commit a vendored copy/, r.stderr);
  assert.doesNotMatch(r.stderr, /engineering-standards/);
});

test('the hook still refuses a consumer repo holding only one producer marker', () => {
  // Both markers are load-bearing. With `||` in place of `&&` the exemption
  // reaches any repo with a `profiles/` directory, which is an ordinary name.
  const { dir, git } = hookedRepo({
    'profiles/local-tool/profile.md': '# a profile, but no base layer\n',
    'engineering-standards/repo-standards.md': '# a frozen copy\n',
  });
  git('add', '-A');

  const r = runPreCommit(dir);

  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refusing to commit a vendored copy/);
});

test('the hook and the CI guard exempt on the same two markers', () => {
  // The commit that introduced this guard claimed the hook and CI "cannot
  // drift". That was true of the refusal pattern and untrue of the exemption,
  // which did not exist. One exported list now backs both.
  const hook = readFileSync(join(hookedRepo().dir, '.git', 'hooks', 'pre-commit'), 'utf8');
  for (const marker of PRODUCER_CHECKOUT_MARKERS) {
    assert.ok(hook.includes(`[ -d ${marker} ]`), `the hook does not test for ${marker}`);
  }
});
