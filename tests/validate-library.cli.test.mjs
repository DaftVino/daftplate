import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo } from './helpers/make-repo.mjs';

const SCRIPT = fileURLToPath(new URL('../profiles/content-library/files/scripts/validate-library.mjs', import.meta.url));
const run = (args = [], opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', ...opts });

const ITEM = (title, category) =>
  `---\ntitle: ${title}\ncategory: ${category}\nsummary: A short line.\nupdated: 2026-07-22\n---\n\nBody.\n`;

test('CLI exits 1 and names index-stale when the committed index has drifted', () => {
  const dir = makeRepo({
    'library/finance/a.md': ITEM('A', 'finance'),
    'docs/library-index.md': '# Library index\n\nstale\n',
  });

  const result = run([dir]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /index-stale/);
});

test('CLI --write-index writes the index and exits 0', () => {
  const dir = makeRepo({ 'library/finance/a.md': ITEM('A', 'finance') });

  const result = run([dir, '--write-index']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(dir, 'docs', 'library-index.md')), true);
  assert.match(result.stdout, /clean/);
});

test('CLI defaults the root to the working directory when given no argument', () => {
  const dir = makeRepo({ 'library/finance/a.md': ITEM('A', 'finance') });
  run([dir, '--write-index']); // generate the index first so the tree is clean

  const result = run([], { cwd: dir });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /clean/);
});

test('the import.meta.url guard runs main when the file is executed directly', () => {
  // Only main prints the "N violation(s)" summary; seeing it proves the guard
  // fired and executed main rather than the file merely being importable.
  const result = run([makeRepo({ 'library/finance/a.md': ITEM('A', 'finance') })]);

  assert.match(result.stdout, /violation\(s\)/);
});
