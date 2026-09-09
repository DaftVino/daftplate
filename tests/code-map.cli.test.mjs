import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, tempDir } from './helpers/make-repo.mjs';
import { main } from '../scripts/code-map.mjs';

test('main returns 2 and prints usage when no repo is given', () => {
  assert.equal(main(['node', 'code-map.mjs']), 2);
});

test('main writes the map and returns 0', () => {
  const dir = makeRepo({ 'app.js': `${'// filler\n'.repeat(400)}function a() {}\n` });

  assert.equal(main(['node', 'code-map.mjs', dir]), 0);
  assert.equal(existsSync(join(dir, 'docs', 'code-map.md')), true);
});

test('main parses --min-bytes as a number, not a string', () => {
  const dir = makeRepo({ 'small.js': 'function a() {}\n' });

  assert.equal(main(['node', 'code-map.mjs', dir, '--min-bytes', '0']), 0);
  assert.match(readFileSync(join(dir, 'docs', 'code-map.md'), 'utf8'), /`small\.js:1`/);
});

test('main honours --out', () => {
  const dir = makeRepo({ 'app.js': 'function a() {}\n' });

  assert.equal(main(['node', 'code-map.mjs', dir, '--min-bytes', '0', '--out', 'docs/m.md']), 0);
  assert.equal(existsSync(join(dir, 'docs', 'm.md')), true);
});

test('main honours an absolute --out', () => {
  const dir = makeRepo({ 'app.js': 'function a() {}\n' });
  const outPath = join(tempDir('pt-cli-out-'), 'map.md');

  assert.equal(main(['node', 'code-map.mjs', dir, '--min-bytes', '0', '--out', outPath]), 0);

  assert.equal(existsSync(outPath), true);
  assert.match(readFileSync(outPath, 'utf8'), /`app\.js:1`/);
  assert.deepEqual(readdirSync(dir), ['app.js']);
});
