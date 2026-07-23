import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import { installSkills } from '../scripts/install-skills.mjs';

test('installSkills copies every skill directory into the target', () => {
  const source = makeRepo({
    'skills/new-project/SKILL.md': '---\nname: new-project\n---\nbody\n',
    'skills/orient/SKILL.md': '---\nname: orient\n---\nbody\n',
  });
  const target = emptyDir();

  const result = installSkills(source, target);

  assert.deepEqual(result.installed, ['new-project', 'orient']);
  assert.match(readFileSync(join(target, 'new-project', 'SKILL.md'), 'utf8'), /name: new-project/);
});

test('installSkills overwrites an existing installed copy without deleting it first', () => {
  const source = makeRepo({ 'skills/new-project/SKILL.md': 'new\n' });
  const target = makeRepo({
    'new-project/SKILL.md': 'stale\n',
    'new-project/keep-me.md': 'unrelated file\n',
  });

  installSkills(source, target);

  assert.equal(readFileSync(join(target, 'new-project', 'SKILL.md'), 'utf8'), 'new\n');
  assert.equal(existsSync(join(target, 'new-project', 'keep-me.md')), true);
});

test('installSkills in dry-run mode writes nothing', () => {
  const source = makeRepo({ 'skills/new-project/SKILL.md': 'body\n' });
  const target = emptyDir();

  const result = installSkills(source, target, { dryRun: true });

  assert.deepEqual(result.installed, ['new-project']);
  assert.equal(existsSync(join(target, 'new-project')), false);
});

test('installSkills skips a directory with no SKILL.md', () => {
  const source = makeRepo({ 'skills/notes/readme.md': 'x\n' });
  assert.deepEqual(installSkills(source, emptyDir()), { installed: [], skipped: ['notes'] });
});

test('installSkills throws when there is no skills/ directory', () => {
  assert.throws(() => installSkills(makeRepo({ 'README.md': 'x\n' }), emptyDir()), /no skills\/ directory/);
});
