import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo } from './helpers/make-repo.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/verify-templates.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

const UNPINNED = [
  'name: ci',
  '',
  'jobs:',
  '  test:',
  '    runs-on: ubuntu-latest',
  '    permissions:',
  '      contents: read',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '',
].join('\n');

test('CLI exits 2 and prints usage when given no root', () => {
  const result = run();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});

test('CLI exits 0 and prints clean on this repo as shipped', () => {
  const result = run(fileURLToPath(new URL('..', import.meta.url)));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /clean/);
});

test('CLI exits 1 and names the file when a floating action tag is reintroduced', () => {
  const root = makeRepo({ 'base/files/dot-github/workflows/ci.yml': UNPINNED });
  const result = run(root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /workflow-unpinned-action: base\/files\/dot-github\/workflows\/ci\.yml/);
});
