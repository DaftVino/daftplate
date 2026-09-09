// The branch-name gate, exercised through Git's own hook runner.
//
// Asserting that the generated hook CONTAINS a regex proves nothing about what
// Git does with it: the shebang, the line endings, the stdin protocol and the
// exit code are the contract, and every one of them is invisible to a string
// match. `git hook run` feeds a real hook real stdin, so it is what runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyDir } from './helpers/make-repo.mjs';
import { installBranchNameHook, BRANCH_BYPASS_ENV } from '../scripts/setup-repo.mjs';

const ZERO = '0'.repeat(40);
const SHA = 'a'.repeat(40);

/** A git repo with the hook installed. */
function repoWithHook() {
  const dir = emptyDir();
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  installBranchNameHook(dir);
  return { dir, git };
}

/** Run the installed pre-push hook with one ref line per push. `git hook run`
 *  exists precisely so a hook can be exercised without a remote.
 *
 *  `--to-stdin`, never a pipe. Measured 2026-08-23: `git hook run` does NOT
 *  forward the parent process's stdin to the hook, so piping the ref lines in
 *  makes the hook read EOF immediately, its `while read` body never executes,
 *  and every branch — valid or not — "passes" with an empty stderr. A suite
 *  written that way reports green while enforcing nothing, which is the exact
 *  failure this file exists to prevent, and it is how the first draft of it
 *  behaved. */
function runHook(dir, refs, env = {}) {
  const lines = refs
    .map(({ localSha = SHA, remoteRef }) => `refs/heads/x ${localSha} ${remoteRef} ${ZERO}`)
    .join('\n');
  const stdinFile = join(dir, 'refs-under-test.txt');
  writeFileSync(stdinFile, `${lines}\n`, 'utf8');
  return spawnSync(
    'git',
    ['-C', dir, 'hook', 'run', '--ignore-missing', `--to-stdin=${stdinFile}`, 'pre-push'],
    { encoding: 'utf8', env: { ...process.env, [BRANCH_BYPASS_ENV]: '', ...env } },
  );
}

const push = (branch, localSha = SHA) => ({ remoteRef: `refs/heads/${branch}`, localSha });

test('installation writes an executable pre-push hook with LF endings', () => {
  const { dir } = repoWithHook();
  const path = join(dir, '.git', 'hooks', 'pre-push');
  const text = readFileSync(path, 'utf8');

  assert.equal(existsSync(path), true);
  // Not pre-commit: that slot belongs to gitleaks and overwriting it would
  // disable secret scanning to install a naming rule.
  assert.equal(existsSync(join(dir, '.git', 'hooks', 'pre-commit')), false);
  assert.equal(text.startsWith('#!/bin/sh\n'), true);
  // Git for Windows runs hooks through sh, and a CRLF shebang fails with a bare
  // "not found" that names nothing useful.
  assert.equal(text.includes('\r'), false);
});

test('an existing pre-push hook is preserved without --force and replaced with it', () => {
  const { dir } = repoWithHook();
  const path = join(dir, '.git', 'hooks', 'pre-push');
  const theirs = '#!/bin/sh\n# someone else\nexit 0\n';
  writeFileSync(path, theirs, 'utf8');

  assert.equal(installBranchNameHook(dir), 'present');
  assert.equal(readFileSync(path, 'utf8'), theirs);

  assert.equal(installBranchNameHook(dir, { force: true }), 'installed');
  assert.notEqual(readFileSync(path, 'utf8'), theirs);
});

test('a compliant branch passes, for more than one type and a multi-word slug', () => {
  const { dir } = repoWithHook();
  for (const branch of [
    'fix/62-scaffold-dest-guard',
    'test/104-routing-resolution-guard',
    'feat/7-a',
    'chore/1234-long-multi-word-slug-here',
  ]) {
    const r = runHook(dir, [push(branch)]);
    assert.equal(r.status, 0, `rejected ${branch}: ${r.stderr}`);
  }
});

test('every malformed shape is rejected', () => {
  const { dir } = repoWithHook();
  for (const branch of [
    'fix/scaffold-dest-guard',        // no issue number
    'fix/62-',                        // empty slug
    'fix/62',                         // no slug
    'Fix/62-guard',                   // uppercase type
    'fix/62-Guard',                   // uppercase slug
    'fix/062-guard',                  // leading zero
    'fix/0-guard',                     // zero is not an issue number
    'fix/62/guard',                   // extra slash
    'fix/62--guard',                  // malformed kebab
    'fix/62-guard-',                  // trailing hyphen
    '62-guard',                       // no type
  ]) {
    const r = runHook(dir, [push(branch)]);
    assert.equal(r.status, 1, `accepted ${branch}`);
    assert.match(r.stderr, /must be type\/N-slug/);
  }
});

test('a direct push to main or master is refused with rename guidance', () => {
  const { dir } = repoWithHook();
  for (const branch of ['main', 'master']) {
    const r = runHook(dir, [push(branch)]);
    assert.equal(r.status, 1, `accepted a direct push to ${branch}`);
    assert.match(r.stderr, new RegExp(`refusing to push directly to ${branch}`));
    assert.match(r.stderr, /open a PR/);
  }
});

test('the bypass permits one push and says so on stderr', () => {
  const { dir } = repoWithHook();
  const r = runHook(dir, [push('no-number-here')], { [BRANCH_BYPASS_ENV]: '1' });

  assert.equal(r.status, 0, r.stderr);
  // Named, not silent: a gate with a silent exit gets left on by people who do
  // not know it is bypassed, and a gate with no exit gets deleted wholesale.
  assert.match(r.stderr, new RegExp(BRANCH_BYPASS_ENV));
});

test('tags and deletions are ignored', () => {
  const { dir } = repoWithHook();

  // A tag is not a branch; a naming rule that says nothing about tags must not
  // block a release.
  const tag = runHook(dir, [{ remoteRef: 'refs/tags/v1.0.0' }]);
  assert.equal(tag.status, 0, tag.stderr);

  // A deletion carries the all-zero local sha and has no name left to check —
  // blocking it would trap a badly named branch in the remote forever.
  const deletion = runHook(dir, [push('whatever-this-was', ZERO)]);
  assert.equal(deletion.status, 0, deletion.stderr);
});

test('one invalid branch among several refs rejects the whole push', () => {
  // Validating only the first ref lets a later invalid branch through, which is
  // the shape `git push --all` actually has.
  const { dir } = repoWithHook();
  const r = runHook(dir, [push('fix/62-good'), push('bad-name'), push('feat/9-also-good')]);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /bad-name/);
});
