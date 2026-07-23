import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import { targetName, applyLayer } from '../scripts/apply-layer.mjs';

test('targetName restores dotfile names', () => {
  assert.equal(targetName('dot-gitignore'), '.gitignore');
  assert.equal(targetName('dot-github'), '.github');
  assert.equal(targetName('README.md'), 'README.md');
});

test('applyLayer copies the files/ tree and renames dot- entries at any depth', () => {
  const layer = makeRepo({
    'files/README.md': '# scaffolded\n',
    'files/dot-gitignore': 'node_modules/\n',
    'files/dot-github/PULL_REQUEST_TEMPLATE.md': '## What\n',
    'files/docs/architecture.md': '# Architecture\n',
    'profile.md': 'not copied\n',
  });
  const dest = emptyDir();

  const result = applyLayer(layer, dest);

  assert.deepEqual(result.copied, [
    '.github/PULL_REQUEST_TEMPLATE.md', '.gitignore', 'README.md', 'docs/architecture.md',
  ]);
  assert.equal(readFileSync(join(dest, '.gitignore'), 'utf8'), 'node_modules/\n');
  assert.equal(existsSync(join(dest, 'profile.md')), false);
});

test('applyLayer appends gitignore-append instead of copying it', () => {
  const base = makeRepo({ 'files/dot-gitignore': 'node_modules/\n' });
  const overlay = makeRepo({ 'files/gitignore-append': '.clasp.json\ndist/\n' });
  const dest = emptyDir();

  applyLayer(base, dest);
  const result = applyLayer(overlay, dest);

  assert.deepEqual(result.appended, ['.gitignore']);
  assert.deepEqual(result.copied, []);
  assert.equal(readFileSync(join(dest, '.gitignore'), 'utf8'), 'node_modules/\n.clasp.json\ndist/\n');
});

test('applyLayer skips existing files unless force is set', () => {
  const layer = makeRepo({ 'files/README.md': '# from layer\n' });
  const dest = makeRepo({ 'README.md': '# already here\n' });

  const skipRun = applyLayer(layer, dest);
  assert.deepEqual(skipRun.skipped, ['README.md']);
  assert.equal(readFileSync(join(dest, 'README.md'), 'utf8'), '# already here\n');

  const forceRun = applyLayer(layer, dest, { force: true });
  assert.deepEqual(forceRun.copied, ['README.md']);
  assert.equal(readFileSync(join(dest, 'README.md'), 'utf8'), '# from layer\n');
});

test('applyLayer overwrites from files-override and reports it separately', () => {
  const layer = makeRepo({ 'files-override/docs/architecture.md': '# vault-specific\n' });
  const dest = makeRepo({ 'docs/architecture.md': '# generic base stub\n' });

  const result = applyLayer(layer, dest);

  assert.deepEqual(result.overridden, ['docs/architecture.md']);
  assert.deepEqual(result.skipped, []);
  assert.equal(readFileSync(join(dest, 'docs/architecture.md'), 'utf8'), '# vault-specific\n');
});

test('applyLayer throws when the layer has neither files/ nor files-override/', () => {
  const layer = makeRepo({ 'profile.md': '# docs only\n' });
  assert.throws(() => applyLayer(layer, emptyDir()), /no files\/ directory/);
});
