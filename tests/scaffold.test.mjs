import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import {
  injectFragments, fillPlaceholders, scaffold, SCAFFOLD_INPUT_TOKENS,
} from '../scripts/scaffold.mjs';
import {
  PROVENANCE_FILE, MAX_PROVENANCE_SCHEMA, fileDigest, readProvenance,
} from '../scripts/lib/provenance.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('injectFragments replaces each marker with the matching profile file body', () => {
  const dest = makeRepo({
    'CLAUDE.md': '# CLAUDE.md\n\n<!-- profile:constraints -->\n\n<!-- profile:routing -->\n\n<!-- profile:context -->\n',
  });
  const profileDir = makeRepo({
    'claude-md-fragment.md': '## Repo-specific constraints\n\n1. No.\n',
    'skill-routing.md': '## Pipeline\n\nx\n\n## Off\n\ny\n',
    'context-rules.md': '## Context budget\n\nz\n\n## Subagent defaults\n\nw\n',
  });

  const replaced = injectFragments(dest, profileDir);
  const text = readFileSync(join(dest, 'CLAUDE.md'), 'utf8');

  assert.equal(replaced.length, 3);
  assert.equal(text.includes('<!-- profile:'), false);
  assert.equal(text.includes('## Repo-specific constraints'), true);
  assert.equal(text.includes('## Subagent defaults'), true);
});

test('injectFragments throws when a marker has no matching profile file', () => {
  const dest = makeRepo({ 'CLAUDE.md': '<!-- profile:constraints -->\n' });
  assert.throws(() => injectFragments(dest, makeRepo({})), /claude-md-fragment\.md/);
});

test('fillPlaceholders replaces tokens across every text file', () => {
  const dest = makeRepo({
    'README.md': '# <PROJECT_NAME>\n\n<PROJECT_SUMMARY>\n',
    LICENSE: 'Copyright (c) <YEAR> James M. Baker\n',
    'assets/logo.png': '<PROJECT_NAME>\n',
  });

  const count = fillPlaceholders(dest, {
    PROJECT_NAME: 'dry-gas', PROJECT_SUMMARY: 'A thing.', YEAR: '2026',
  });

  assert.equal(count, 3);
  assert.equal(readFileSync(join(dest, 'README.md'), 'utf8'), '# dry-gas\n\nA thing.\n');
  assert.equal(readFileSync(join(dest, 'LICENSE'), 'utf8'), 'Copyright (c) 2026 James M. Baker\n');
  assert.equal(readFileSync(join(dest, 'assets/logo.png'), 'utf8'), '<PROJECT_NAME>\n');
});

test('fillPlaceholders leaves unknown tokens alone so the verifier can catch them', () => {
  const dest = makeRepo({ 'README.md': '<PROJECT_NAME> <UNSET_TOKEN>\n' });
  fillPlaceholders(dest, { PROJECT_NAME: 'x' });
  assert.equal(readFileSync(join(dest, 'README.md'), 'utf8'), 'x <UNSET_TOKEN>\n');
});

test('scaffold writes a provenance manifest naming the profile and the version', () => {
  const dest = emptyDir();
  scaffold(ROOT, 'web-app', dest, {
    year: 2026,
    tokens: { PROJECT_NAME: 'dry-prov', PROJECT_SUMMARY: 'A throwaway scaffold.' },
  });

  const p = readProvenance(dest);
  assert.equal(p.profile, 'web-app');
  assert.match(p.daftplate, /^\d+\.\d+\.\d+$/);
  assert.ok(existsSync(join(dest, PROVENANCE_FILE)));
});

test('provenance digests match the files as substituted, not as templated', () => {
  const dest = emptyDir();
  scaffold(ROOT, 'web-app', dest, {
    year: 2026,
    tokens: { PROJECT_NAME: 'dry-prov', PROJECT_SUMMARY: 'A throwaway scaffold.' },
  });

  const p = readProvenance(dest);
  for (const [rel, entry] of Object.entries(p.files)) {
    assert.equal(entry.digest, fileDigest(join(dest, rel)), `${rel} digest is stale`);
  }
  assert.equal('CLAUDE.md' in p.files, true);
  assert.equal(readFileSync(join(dest, 'CLAUDE.md'), 'utf8').includes('<PROJECT_NAME>'), false);
});

test('provenance covers the appended .gitignore and does not list itself', () => {
  const dest = emptyDir();
  scaffold(ROOT, 'web-app', dest, {
    year: 2026,
    tokens: { PROJECT_NAME: 'dry-prov', PROJECT_SUMMARY: 'A throwaway scaffold.' },
  });

  const p = readProvenance(dest);
  assert.equal(p.files['.gitignore'].mode, 'appended');
  assert.equal(p.files['.gitignore'].layer, 'profile');
  assert.equal(PROVENANCE_FILE in p.files, false);
});

test('provenance records the substitution tokens so a later sync can reproduce the output', () => {
  const dest = emptyDir();
  scaffold(ROOT, 'web-app', dest, {
    year: 2026,
    tokens: { PROJECT_NAME: 'dry-prov', PROJECT_SUMMARY: 'A throwaway scaffold.' },
  });

  const p = readProvenance(dest);
  assert.equal(p.tokens.PROJECT_NAME, 'dry-prov');
  assert.equal(p.tokens.YEAR, '2026');
});

test('every base-layer file is recorded as layer base, mode copied', () => {
  const dest = emptyDir();
  scaffold(ROOT, 'web-app', dest, {
    year: 2026,
    tokens: { PROJECT_NAME: 'dry-prov', PROJECT_SUMMARY: 'A throwaway scaffold.' },
  });

  const p = readProvenance(dest);
  assert.equal(p.files['README.md'].layer, 'base');
  assert.equal(p.files['README.md'].mode, 'copied');
  assert.equal(p.files['.github/workflows/ci.yml'].layer, 'base');
});

test('scaffold writes only current-schema managed entries', () => {
  const dest = emptyDir();
  scaffold(ROOT, 'web-app', dest, {
    year: 2026,
    tokens: {
      PROJECT_NAME: 'schema-two',
      PROJECT_SUMMARY: 'Schema 2 fixture.',
    },
  });

  const manifest = readProvenance(dest);

  assert.equal(manifest.schema, MAX_PROVENANCE_SCHEMA);
  assert.ok(Object.values(manifest.files).length > 0);
  assert.equal(
    Object.values(manifest.files).every(
      (entry) => entry.ownership === 'managed' && !('templateDigest' in entry),
    ),
    true,
  );
});

test('scaffold exports the enrollment input token contract', () => {
  // The token names scaffold() cannot derive. VERIFY_COMMAND, TEST_COMMAND and
  // DEPLOY_COMMAND are read from profile.md, so an operator never supplies them;
  // enrollment consumes this export rather than restating the list.
  assert.deepEqual(SCAFFOLD_INPUT_TOKENS, ['YEAR', 'PROJECT_NAME', 'PROJECT_SUMMARY']);
});
