import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { emptyDir } from './helpers/make-repo.mjs';
import { scaffold } from '../scripts/scaffold.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const values = (name) => ({
  year: 2026,
  tokens: { PROJECT_NAME: name, PROJECT_SUMMARY: 'A throwaway scaffold used to verify daftplate.' },
});

// Read from disk rather than hardcoding: a profile added without a test edit is
// covered by construction, and forgetting to add one cannot ship green.
const PROFILES = readdirSync(join(ROOT, 'profiles'))
  .filter((name) => lstatSync(join(ROOT, 'profiles', name)).isDirectory())
  .sort();

test('every profile directory is exercised by this suite', () => {
  assert.ok(PROFILES.length >= 4, `found ${PROFILES.length} profiles: ${PROFILES.join(', ')}`);
});

for (const type of PROFILES) {
  test(`scaffolding ${type} from the real layers produces a clean repo`, () => {
    const dest = emptyDir();
    const { violations } = scaffold(ROOT, type, dest, values(`dry-${type}`));
    assert.deepEqual(violations, []);
  });

  test(`scaffolded ${type} CLAUDE.md is complete and under 60 lines`, () => {
    const dest = emptyDir();
    scaffold(ROOT, type, dest, values(`dry-${type}`));
    const text = readFileSync(join(dest, 'CLAUDE.md'), 'utf8');
    assert.equal(text.includes('<!-- profile:'), false);
    assert.equal(text.includes('<PROJECT_SUMMARY>'), false);
    assert.ok(text.split(/\r?\n/).length <= 60, `CLAUDE.md is ${text.split(/\r?\n/).length} lines`);
  });
}

test('a scaffolded repo carries a runnable orient hook', () => {
  const dest = emptyDir();
  scaffold(ROOT, 'web-app', dest, values('dry-hook'));

  const hook = join(dest, '.claude', 'orient-hook.mjs');
  assert.equal(existsSync(hook), true, 'orient-hook.mjs did not survive the dot- rename');

  const result = spawnSync(process.execPath, [hook], { encoding: 'utf8' });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
});

test('scaffold rejects an unknown profile type', () => {
  assert.throws(() => scaffold(ROOT, 'no-such-type', emptyDir(), values('x')), /unknown profile type/);
});
