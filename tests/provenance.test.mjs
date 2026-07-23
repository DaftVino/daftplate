import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo } from './helpers/make-repo.mjs';
import {
  PROVENANCE_FILE, fileDigest, buildProvenance, writeProvenance, readProvenance,
} from '../scripts/lib/provenance.mjs';

test('fileDigest is a stable sha256 of the file bytes', () => {
  const dir = makeRepo({ 'a.txt': 'hello\n', 'b.txt': 'hello\n', 'c.txt': 'other\n' });

  const a = fileDigest(join(dir, 'a.txt'));
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a, fileDigest(join(dir, 'b.txt')));
  assert.notEqual(a, fileDigest(join(dir, 'c.txt')));
});

test('buildProvenance records version, profile, tokens, and one entry per file, key-sorted', () => {
  const root = makeRepo({
    'README.md': '# x\n',
    '.github/workflows/ci.yml': 'on: push\n',
    'CLAUDE.md': '# CLAUDE.md\n',
  });

  const p = buildProvenance({
    root,
    version: '0.2.0',
    profile: 'web-app',
    tokens: { PROJECT_NAME: 'my-app', PROJECT_SUMMARY: 'A thing.', YEAR: '2026' },
    files: [
      { rel: 'README.md', layer: 'base', mode: 'copied' },
      { rel: '.github/workflows/ci.yml', layer: 'base', mode: 'copied' },
      { rel: 'CLAUDE.md', layer: 'base', mode: 'copied' },
    ],
  });

  assert.equal(p.daftplate, '0.2.0');
  assert.equal(p.profile, 'web-app');
  assert.equal(p.tokens.PROJECT_NAME, 'my-app');
  assert.deepEqual(Object.keys(p.files), ['.github/workflows/ci.yml', 'CLAUDE.md', 'README.md']);
  assert.match(p.files['README.md'].digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(p.files['README.md'].layer, 'base');
  assert.equal(p.files['README.md'].mode, 'copied');
});

test('buildProvenance preserves layer and mode so a sync can refuse to touch an override', () => {
  const root = makeRepo({ 'docs/deploy-guide.md': '# guide\n', '.gitignore': 'node_modules/\n' });

  const p = buildProvenance({
    root,
    version: '0.2.0',
    profile: 'web-app',
    tokens: {},
    files: [
      { rel: 'docs/deploy-guide.md', layer: 'profile', mode: 'overridden' },
      { rel: '.gitignore', layer: 'profile', mode: 'appended' },
    ],
  });

  assert.equal(p.files['docs/deploy-guide.md'].mode, 'overridden');
  assert.equal(p.files['.gitignore'].mode, 'appended');
  assert.equal(p.files['.gitignore'].layer, 'profile');
});

test('buildProvenance skips a listed file that does not exist rather than throwing', () => {
  const root = makeRepo({ 'README.md': '# x\n' });
  const p = buildProvenance({
    root, version: '0.2.0', profile: 'web-app', tokens: {},
    files: [{ rel: 'README.md', layer: 'base', mode: 'copied' }, { rel: 'gone.md', layer: 'base', mode: 'copied' }],
  });
  assert.deepEqual(Object.keys(p.files), ['README.md']);
});

test('writeProvenance emits parseable JSON with a trailing newline', () => {
  const root = makeRepo({ 'README.md': '# x\n' });
  const p = buildProvenance({
    root, version: '0.2.0', profile: 'web-app', tokens: {},
    files: [{ rel: 'README.md', layer: 'base', mode: 'copied' }],
  });

  const written = writeProvenance(root, p);

  assert.equal(written, join(root, PROVENANCE_FILE));
  const raw = readFileSync(written, 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(raw), p);
});

test('readProvenance round-trips what writeProvenance wrote, and is null when absent', () => {
  const root = makeRepo({ 'README.md': '# x\n' });
  assert.equal(readProvenance(root), null);

  const p = buildProvenance({
    root, version: '0.2.0', profile: 'web-app', tokens: { YEAR: '2026' },
    files: [{ rel: 'README.md', layer: 'base', mode: 'copied' }],
  });
  writeProvenance(root, p);

  assert.deepEqual(readProvenance(root), p);
});
