import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/apply-layer.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('CLI exits 2 without both arguments', () => {
  assert.equal(run().status, 2);
});

test('CLI exits 0 on a clean copy', () => {
  const layer = makeRepo({ 'files/README.md': '# x\n' });
  const result = run(layer, emptyDir());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /copied 1/);
});

test('CLI exits 1 under --strict when a collision is skipped', () => {
  const layer = makeRepo({ 'files/README.md': '# from layer\n' });
  const dest = makeRepo({ 'README.md': '# already here\n' });
  const result = run(layer, dest, '--strict');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /collision/);
});

test('CLI exits 0 on the same collision without --strict', () => {
  const layer = makeRepo({ 'files/README.md': '# from layer\n' });
  const dest = makeRepo({ 'README.md': '# already here\n' });
  assert.equal(run(layer, dest).status, 0);
});
