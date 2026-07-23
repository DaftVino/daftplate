import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo } from './helpers/make-repo.mjs';
import {
  LARGE_FILE_BYTES, hasLargeFile, orientContext,
} from '../base/files/dot-claude/orient-hook.mjs';

/** A repo whose largest file is `bytes` long. */
const repoWith = (bytes, extra = {}) => makeRepo({
  'README.md': '# x\n',
  'src/big.js': 'x'.repeat(bytes),
  ...extra,
});

const installed = { '.claude/skills/orient/SKILL.md': '---\nname: orient\n---\n' };

test('orientContext emits a SessionStart payload when the orient skill is installed', () => {
  const home = makeRepo(installed);

  const payload = JSON.parse(orientContext(home));

  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(payload.hookSpecificOutput.additionalContext, /orient/);
});

test('orientContext emits nothing when the orient skill is not installed', () => {
  assert.equal(orientContext(makeRepo({})), '');
});

test('orientContext emits nothing when the skills directory exists but orient does not', () => {
  const home = makeRepo({ '.claude/skills/new-project/SKILL.md': '---\nname: new-project\n---\n' });
  assert.equal(orientContext(home), '');
});

test('a repo with a large file gets the payload carrying the 50KB read discipline', () => {
  const context = JSON.parse(
    orientContext(makeRepo(installed), repoWith(LARGE_FILE_BYTES + 1)),
  ).hookSpecificOutput.additionalContext;

  assert.match(context, /50KB/);
  assert.match(context, /code-map/);
});

test('a repo with no large file gets a payload that omits the read discipline and says why', () => {
  const context = JSON.parse(
    orientContext(makeRepo(installed), repoWith(LARGE_FILE_BYTES - 1)),
  ).hookSpecificOutput.additionalContext;

  assert.equal(/50KB/.test(context), false, 'the size rule is inert here and must not be sent');
  assert.match(context, /no file/i);
});

test('both payloads let a session with a specific task skip the brief', () => {
  const big = JSON.parse(orientContext(makeRepo(installed), repoWith(LARGE_FILE_BYTES + 1)));
  const small = JSON.parse(orientContext(makeRepo(installed), repoWith(10)));

  for (const payload of [big, small]) {
    assert.match(payload.hookSpecificOutput.additionalContext, /unless/i);
  }
});

test('hasLargeFile ignores node_modules and .git, which are not the repo', () => {
  const root = makeRepo({
    'README.md': '# x\n',
    'node_modules/dep/bundle.js': 'x'.repeat(LARGE_FILE_BYTES + 1),
    '.git/objects/pack/big.pack': 'x'.repeat(LARGE_FILE_BYTES + 1),
  });

  assert.equal(hasLargeFile(root), false);
});

test('hasLargeFile finds a large file nested at depth', () => {
  const root = makeRepo({ 'a/b/c/deep.js': 'x'.repeat(LARGE_FILE_BYTES + 1) });
  assert.equal(hasLargeFile(root), true);
});

test('hasLargeFile stops at the scan limit and assumes large, because a repo that big is', () => {
  const files = {};
  for (let i = 0; i < 12; i += 1) files[`f${i}.txt`] = 'x';

  assert.equal(hasLargeFile(makeRepo(files), { limit: 5 }), true);
});
