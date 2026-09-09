// The CLI contract, exercised by spawning it. An injected main() proves the
// argv-to-engine mapping and nothing about what an operator sees: not that the
// refusal reaches stderr rather than a stack trace, and not that the exit code
// reaches the shell. Follows tests/publish.cli.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/scaffold.mjs', import.meta.url));
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

const both = (r) => `${r.stdout}\n${r.stderr}`;

// Any recursive-delete wording, not just the exact command that used to be printed.
const DELETION = /Remove-Item|rm\s+-rf|rmdir\s+\/s|--recursive.*--force|remove it and retry/i;

test('scaffold CLI prints usage and exits 2 with no args', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: node scripts\/scaffold\.mjs/);
});

test('scaffold CLI exits 0 and reports clean on a good scaffold', () => {
  const dest = emptyDir();
  const r = run([ROOT, 'local-tool', dest, '--name=cli-clean', '--summary=A clean scaffold.']);
  assert.equal(r.status, 0, both(r));
  assert.match(r.stdout, /scaffolded cli-clean \(local-tool\).*— clean/);
});

test('a populated destination is a clean refusal, not a stack trace', () => {
  const dest = makeRepo({ 'README.md': '# mine\n' });
  const r = run([ROOT, 'local-tool', dest, '--name=nope', '--summary=Should never land.']);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to scaffold:/);
  assert.doesNotMatch(both(r), /at .*scaffold\.mjs/);
  assert.equal(readFileSync(join(dest, 'README.md'), 'utf8'), '# mine\n');
});

test('the refusal offers no deletion command', () => {
  const dest = makeRepo({ 'README.md': '# mine\n' });
  const r = run([ROOT, 'local-tool', dest, '--name=nope', '--summary=Should never land.']);
  assert.doesNotMatch(both(r), DELETION);
});

test('a post-write verification failure offers no deletion command either', () => {
  // The essential case. A populated-destination refusal never reaches the
  // violations branch, so it cannot prove the old hint is gone from it. This one
  // does: a .git-only destination is accepted, scaffolded, and then fails
  // verification because the summary carries an unresolved <TOKEN>.
  const dest = makeRepo({ '.git/HEAD': 'ref: refs/heads/main\n' });
  const r = run([ROOT, 'local-tool', dest, '--name=cli-violations', '--summary=Holds a <LEFTOVER> token.']);

  assert.equal(r.status, 1, both(r));
  assert.match(r.stderr, /scaffold is incomplete/);
  assert.match(r.stderr, /nothing was cleaned up/);
  assert.doesNotMatch(both(r), DELETION);
  assert.equal(readFileSync(join(dest, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n');
});

test('an unknown profile is reported without a stack frame', () => {
  const dest = emptyDir();
  const r = run([ROOT, 'no-such-profile', dest, '--name=nope', '--summary=Should never land.']);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown profile type: no-such-profile/);
  assert.doesNotMatch(both(r), /at .*scaffold\.mjs/);
});
