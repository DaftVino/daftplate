import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import {
  injectFragments, fillPlaceholders, scaffold, assertEmptyDest, SCAFFOLD_INPUT_TOKENS,
} from '../scripts/scaffold.mjs';
import { walkFiles } from '../scripts/lib/fs.mjs';
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

test('fillPlaceholders refuses a token declared with no value when it is matched, and is silent when it is not', () => {
  // D1. A key present in the values map holding `undefined` is a declared-missing
  // input: matching it is a composition daftplate cannot perform, and performing
  // it anyway wrote the five-letter string `undefined` into people's LICENSEs.
  // Absence is the other answer and is tested below; the guard this replaces
  // collapsed the two, which is why a caller that spread an absent token map got
  // own properties holding `undefined` straight through it.
  const values = { PROJECT_NAME: 'x', YEAR: undefined };

  const matched = makeRepo({ LICENSE: 'Copyright (c) <YEAR> Someone\n' });
  assert.throws(() => fillPlaceholders(matched, values), /YEAR/);
  assert.throws(() => fillPlaceholders(matched, values), /LICENSE/);
  assert.equal(readFileSync(join(matched, 'LICENSE'), 'utf8'), 'Copyright (c) <YEAR> Someone\n');

  const unmatched = makeRepo({ 'README.md': '# <PROJECT_NAME>\n' });
  assert.equal(fillPlaceholders(unmatched, values), 1);
  assert.equal(readFileSync(join(unmatched, 'README.md'), 'utf8'), '# x\n');
});

test('fillPlaceholders leaves an unknown token alone even when the values map declares a missing one', () => {
  // The regression D1 must not cause, and the one a gate keyed on absence rather
  // than on a declared-missing value would introduce: `<UNSET_TOKEN>` is not
  // daftplate's to substitute and never was, so a repo carrying an angle-bracketed
  // word of its own must keep passing straight through.
  const dest = makeRepo({ 'README.md': '<PROJECT_NAME> <UNSET_TOKEN>\n' });
  assert.equal(fillPlaceholders(dest, { PROJECT_NAME: 'x', YEAR: undefined }), 1);
  assert.equal(readFileSync(join(dest, 'README.md'), 'utf8'), 'x <UNSET_TOKEN>\n');
});

test('scaffold refuses rather than composing `undefined` when no year is supplied', () => {
  // D2. `YEAR: String(values.year)` turned a missing input into a five-letter
  // string that looks like data before the gate could ever see it, so the gate is
  // only reachable once the coercion stops.
  const dest = emptyDir();

  assert.throws(
    () => scaffold(ROOT, 'web-app', dest, { tokens: { PROJECT_NAME: 'n', PROJECT_SUMMARY: 's' } }),
    /YEAR/,
  );

  // The refusal lands mid-composition, so the partial tree is still on disk. What
  // must not be on it is a substituted `undefined`. Scoped to LICENSE, the one
  // base file carrying <YEAR>: a whole-tree scan for the word would fail on
  // `scripts/resolve-node-version.mjs`, which says `undefined` in its own source.
  const licence = join(dest, 'LICENSE');
  if (existsSync(licence)) {
    assert.match(readFileSync(licence, 'utf8'), /Copyright \(c\) <YEAR>/);
  }
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

// --- the destination boundary (#62) -----------------------------------------
//
// Every byte-preservation assertion below compares exact strings. An existence-only
// or notEqual(..., undefined) check would pass against a mutation that replaced the
// content with null, '' or any other wrong value, which is the failure being guarded.

const listTree = (dir) => walkFiles(dir).map(({ rel }) => rel).sort();

test('assertEmptyDest is read-only: checking a missing path does not create it', () => {
  const dest = join(emptyDir(), 'not', 'there', 'yet');
  assertEmptyDest(dest);
  assert.equal(existsSync(dest), false);
});

test('scaffold creates a nested missing destination and leaves it verifier-clean', () => {
  const dest = join(emptyDir(), 'nested', 'child');
  const { violations } = scaffold(ROOT, 'local-tool', dest, {
    year: 2026,
    tokens: { PROJECT_NAME: 'nested-dest', PROJECT_SUMMARY: 'A nested destination fixture.' },
  });
  assert.deepEqual(violations, []);
  assert.equal(existsSync(join(dest, 'CLAUDE.md')), true);
});

test('a populated destination is refused and nothing in it is touched', () => {
  const dest = makeRepo({
    'README.md': '# mine\n',
    'src/app.js': 'const OWNED = "<PROJECT_NAME>";\n',
  });
  const before = listTree(dest);
  const readme = readFileSync(join(dest, 'README.md'), 'utf8');
  const app = readFileSync(join(dest, 'src/app.js'), 'utf8');

  assert.throws(
    () => scaffold(ROOT, 'local-tool', dest, {
      year: 2026, tokens: { PROJECT_NAME: 'nope', PROJECT_SUMMARY: 'Should never land.' },
    }),
    /^Error: refusing to scaffold: .*is not empty/s,
  );

  assert.deepEqual(listTree(dest), before);
  assert.equal(readFileSync(join(dest, 'README.md'), 'utf8'), readme);
  assert.equal(readFileSync(join(dest, 'src/app.js'), 'utf8'), app);
  assert.equal(existsSync(join(dest, 'CLAUDE.md')), false);
  assert.equal(existsSync(join(dest, PROVENANCE_FILE)), false);
});

test('a non-.git dotfile is refused: the allowlist is exactly .git, not all dotfiles', () => {
  const dest = makeRepo({ '.env': 'SECRET=keep-me\n' });

  assert.throws(
    () => scaffold(ROOT, 'local-tool', dest, {
      year: 2026, tokens: { PROJECT_NAME: 'nope', PROJECT_SUMMARY: 'Should never land.' },
    }),
    /refusing to scaffold: .*is not empty.*\.env/s,
  );

  assert.equal(readFileSync(join(dest, '.env'), 'utf8'), 'SECRET=keep-me\n');
  assert.equal(existsSync(join(dest, 'CLAUDE.md')), false);
});

test('a destination holding only .git is accepted by the helper', () => {
  const dest = makeRepo({ '.git/HEAD': 'ref: refs/heads/main\n' });
  assert.doesNotThrow(() => assertEmptyDest(dest));
});

test('a destination that is a file is refused as not a directory', () => {
  const parent = makeRepo({ 'thing.txt': 'not a directory\n' });
  const dest = join(parent, 'thing.txt');

  assert.throws(() => assertEmptyDest(dest), /refusing to scaffold: .*is not a directory/);
  assert.equal(readFileSync(dest, 'utf8'), 'not a directory\n');
});

test('an existing .daftplate.json is refused rather than re-scaffolded over', () => {
  const manifest = '{ "schema": 3, "daftplate": "9.9.9", "files": {} }\n';
  const dest = makeRepo({ [PROVENANCE_FILE]: manifest });

  assert.throws(
    () => scaffold(ROOT, 'local-tool', dest, {
      year: 2026, tokens: { PROJECT_NAME: 'nope', PROJECT_SUMMARY: 'Should never land.' },
    }),
    /refusing to scaffold: .*is not empty/s,
  );

  assert.equal(readFileSync(join(dest, PROVENANCE_FILE), 'utf8'), manifest);
});

test('an unknown profile leaves a missing destination missing', () => {
  const dest = join(emptyDir(), 'never-created');

  assert.throws(
    () => scaffold(ROOT, 'no-such-profile', dest, {
      year: 2026, tokens: { PROJECT_NAME: 'nope', PROJECT_SUMMARY: 'Should never land.' },
    }),
    /unknown profile type: no-such-profile/,
  );

  assert.equal(existsSync(dest), false);
});

test('substitution touches only the paths the layers wrote', () => {
  const dest = makeRepo({ '.git/hooks/pre-commit': '#!/bin/sh\necho "<PROJECT_NAME>"\n' });

  scaffold(ROOT, 'local-tool', dest, {
    year: 2026,
    tokens: { PROJECT_NAME: 'scoped-sub', PROJECT_SUMMARY: 'A scoped substitution fixture.' },
  });

  // The layers wrote README.md, so it is substituted.
  assert.match(readFileSync(join(dest, 'README.md'), 'utf8'), /scoped-sub/);
  // They did not write this, so its token survives byte-for-byte.
  assert.equal(
    readFileSync(join(dest, '.git/hooks/pre-commit'), 'utf8'),
    '#!/bin/sh\necho "<PROJECT_NAME>"\n',
  );
});
