import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, MINIMAL } from './helpers/make-repo.mjs';
import {
  PREREQUISITES, checkPrerequisites, installGitleaksHook, checkRepoSetup,
} from '../scripts/setup-repo.mjs';

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
