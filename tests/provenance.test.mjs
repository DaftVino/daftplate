import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo } from './helpers/make-repo.mjs';
import {
  PROVENANCE_FILE, MAX_PROVENANCE_SCHEMA, fileDigest, buildProvenance, writeProvenance,
  readProvenance, validateProvenance, unnormalizeProvenance,
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

  // Byte-for-byte again now that the writer emits everything the reader
  // interprets: normalization is the identity on a schema 2 manifest, and a
  // round trip that quietly gained or lost a field would fail here.
  assert.deepEqual(readProvenance(root), p);
});

// --------------------------------------------------------------------------
// The schema gate (Phase 2, Task 2.0). Every read goes through it so
// enrollment and synchronization cannot disagree about what a manifest means.
// --------------------------------------------------------------------------

const entry = (over = {}) => ({
  digest: `sha256:${'a'.repeat(64)}`,
  layer: 'base',
  mode: 'copied',
  ownership: 'managed',
  ...over,
});

const manifestWith = (files, over = {}) => ({
  schema: MAX_PROVENANCE_SCHEMA,
  daftplate: '1.5.0',
  profile: 'web-app',
  tokens: {},
  files,
  ...over,
});

test('readProvenance interprets schema 1 missing ownership as managed without rewriting', () => {
  const raw = `${JSON.stringify({
    daftplate: '1.3.0',
    profile: 'web-app',
    tokens: { YEAR: '2026', PROJECT_NAME: 'x', PROJECT_SUMMARY: 'summary' },
    files: {
      'README.md': {
        digest: `sha256:${'a'.repeat(64)}`,
        layer: 'base',
        mode: 'copied',
      },
    },
  }, null, 2)}\n`;
  const root = makeRepo({ [PROVENANCE_FILE]: raw });

  const manifest = readProvenance(root);

  assert.equal(manifest.files['README.md'].ownership, 'managed');
  assert.equal(readFileSync(join(root, PROVENANCE_FILE), 'utf8'), raw);
});

test('validateProvenance refuses an unsupported schema', () => {
  assert.throws(
    () => validateProvenance(manifestWith({}, { schema: MAX_PROVENANCE_SCHEMA + 1 })),
    /unsupported .*schema: 4/i,
  );
});

test('validateProvenance refuses an unknown ownership value', () => {
  assert.throws(
    () => validateProvenance(manifestWith({ 'README.md': entry({ ownership: 'shared' }) })),
    /unknown ownership.*shared/i,
  );
});

test('validateProvenance requires templateDigest for divergent ownership', () => {
  assert.throws(
    () => validateProvenance(manifestWith({ 'README.md': entry({ ownership: 'diverged' }) })),
    /templateDigest.*required/i,
  );
});

test('validateProvenance forbids templateDigest for managed ownership', () => {
  assert.throws(
    () => validateProvenance(manifestWith({
      'README.md': entry({
        templateDigest: `sha256:${'b'.repeat(64)}`,
        ownership: 'managed',
      }),
    })),
    /managed.*forbids templateDigest/i,
  );
});

test('buildProvenance writes schema 3 and explicit managed ownership', () => {
  const root = makeRepo({ 'README.md': '# x\n' });

  const manifest = buildProvenance({
    root,
    version: '1.5.0',
    profile: 'web-app',
    tokens: {},
    files: [{ rel: 'README.md', layer: 'base', mode: 'copied' }],
  });

  assert.equal(manifest.schema, MAX_PROVENANCE_SCHEMA);
  assert.deepEqual(manifest.files['README.md'], {
    digest: fileDigest(join(root, 'README.md')),
    layer: 'base',
    mode: 'copied',
    ownership: 'managed',
  });
});

// --------------------------------------------------------------------------
// Schema 3 and declined ownership (#123, Phase 1)
// --------------------------------------------------------------------------

test('validateProvenance accepts schema 3', () => {
  const manifest = validateProvenance(manifestWith(
    { 'README.md': entry() },
    { schema: 3 },
  ));

  assert.equal(manifest.schema, 3);
});

// A declined prior. `digest` is deliberately absent by default -- per D5, its
// presence IS the record of whether the path held an unowned file at decline
// time, so tests that need a declined COLLISION add it explicitly.
const declinedEntry = (over = {}) => ({
  templateDigest: `sha256:${'b'.repeat(64)}`,
  layer: 'base',
  mode: 'copied',
  ownership: 'declined',
  ...over,
});

test('validateProvenance accepts a declined entry with no digest, meaning nothing was at the path', () => {
  const manifest = validateProvenance(manifestWith(
    { 'docs/database/database.dbml': declinedEntry() },
    { schema: 3 },
  ));

  const stored = manifest.files['docs/database/database.dbml'];
  assert.equal(stored.ownership, 'declined');
  assert.equal('digest' in stored, false);
});

test('validateProvenance accepts a declined entry with a digest, meaning an unowned file sat at the path', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const manifest = validateProvenance(manifestWith(
    { 'docs/architecture/overview.md': declinedEntry({ digest }) },
    { schema: 3 },
  ));

  assert.equal(manifest.files['docs/architecture/overview.md'].digest, digest);
});

test('validateProvenance refuses a declined entry missing templateDigest', () => {
  // There is always a candidate -- the template produced the offer that was
  // declined -- so templateDigest is required exactly like the divergent case.
  assert.throws(
    () => validateProvenance(manifestWith(
      { 'README.md': { layer: 'base', mode: 'copied', ownership: 'declined' } },
      { schema: 3 },
    )),
    /declined.*templateDigest.*required/i,
  );
});

test('validateProvenance refuses a declined entry with a malformed digest', () => {
  assert.throws(
    () => validateProvenance(manifestWith(
      { 'README.md': declinedEntry({ digest: 'not-a-digest' }) },
      { schema: 3 },
    )),
    /malformed digest/i,
  );
});

test('validateProvenance refuses declined ownership under schema 2, as an unknown ownership', () => {
  assert.throws(
    () => validateProvenance(manifestWith(
      { 'README.md': declinedEntry() },
      { schema: 2 },
    )),
    /unknown ownership.*declined/i,
  );
});

test('validateProvenance refuses declined ownership under schema 1, as an unknown ownership', () => {
  assert.throws(
    () => validateProvenance(manifestWith(
      { 'README.md': declinedEntry() },
      { schema: 1 },
    )),
    /unknown ownership.*declined/i,
  );
});

test('validateProvenance still requires digest for managed ownership', () => {
  // The declined branch made digest conditional; this guards against that
  // conditional weakening the managed and diverged requirement too.
  assert.throws(
    () => validateProvenance(manifestWith(
      { 'README.md': { layer: 'base', mode: 'copied', ownership: 'managed' } },
    )),
    /malformed digest/i,
  );
});

test('validateProvenance still requires digest for diverged ownership', () => {
  // Same guard as the managed case: the declined branch's conditional digest
  // must not have loosened the diverged requirement too.
  assert.throws(
    () => validateProvenance(manifestWith(
      {
        'README.md': {
          layer: 'base',
          mode: 'copied',
          ownership: 'diverged',
          templateDigest: `sha256:${'b'.repeat(64)}`,
        },
      },
    )),
    /malformed digest/i,
  );
});

test('validateProvenance refuses an entry with no ownership under a schema that requires it', () => {
  // entry() defaults to explicit ownership now, which means nothing else in
  // this file proves the schema-1-only default still refuses when omitted
  // under a later schema -- this is that proof.
  assert.throws(
    () => validateProvenance(manifestWith(
      { 'README.md': { digest: `sha256:${'a'.repeat(64)}`, layer: 'base', mode: 'copied' } },
    )),
    /missing ownership; only schema 1 may omit it/i,
  );
});

// ---------------------------------------------------------------------------
// unnormalizeProvenance() -- the write-side inverse of validateProvenance()'s
// normalization (#125). Every field a reader supplies when it is absent is a
// field a writer must not state, or the file declares one schema while carrying
// another's shape.

test('unnormalizeProvenance drops the schema key only when it declares 1', () => {
  // Absence reads as schema 1, so 1 is the one number a manifest never states.
  // Any other number is the entire reason the field exists.
  const at = (schema) => unnormalizeProvenance({
    schema, daftplate: '1.0.0', profile: 'demo', tokens: { A: 'b' }, files: {},
  });

  assert.equal('schema' in at(1), false);
  assert.equal(at(2).schema, 2);
  assert.equal(at(3).schema, 3);
});

test('unnormalizeProvenance drops an empty tokens map at every schema', () => {
  // The third normalization, and the one a two-field strip list would have
  // missed: absent tokens read as {} at every schema, so an empty map on disk
  // is a default nobody stated. A non-empty one is content and stays.
  for (const schema of [1, 2, 3]) {
    const base = { schema, daftplate: '1.0.0', profile: 'demo', files: {} };

    assert.equal('tokens' in unnormalizeProvenance({ ...base, tokens: {} }), false);
    assert.deepEqual(unnormalizeProvenance({ ...base, tokens: { A: 'b' } }).tokens, { A: 'b' });
  }
});

test('unnormalizeProvenance drops managed ownership under schema 1 and keeps it above', () => {
  // Absent ownership reads as 'managed' and ONLY under schema 1. From schema 2
  // absence is malformed rather than a default, so there the field is content.
  const entry = { digest: `sha256:${'a'.repeat(64)}`, layer: 'base', mode: 'copied' };
  const at = (schema) => unnormalizeProvenance({
    schema, daftplate: '1.0.0', profile: 'demo', tokens: { A: 'b' },
    files: { 'a.md': { ...entry, ownership: 'managed' } },
  }).files['a.md'];

  assert.equal('ownership' in at(1), false);
  assert.equal(at(2).ownership, 'managed');
  assert.equal(at(3).ownership, 'managed');
});

test('unnormalizeProvenance refuses to write a non-managed entry under schema 1', () => {
  // Stripping here would be the dangerous case, not the tidy one: schema 1 has
  // no way to say 'diverged', so a silent strip publishes a manifest claiming
  // daftplate owns bytes it measured and does not own (CLAUDE.md #5). Sync
  // cannot reach this -- recording either value bumps the schema first (#123) --
  // which is exactly why it must refuse rather than trust that.
  const diverged = {
    digest: `sha256:${'a'.repeat(64)}`, templateDigest: `sha256:${'b'.repeat(64)}`,
    layer: 'base', mode: 'copied', ownership: 'diverged',
  };

  assert.throws(() => unnormalizeProvenance({
    schema: 1, daftplate: '1.0.0', profile: 'demo', tokens: { A: 'b' },
    files: { 'a.md': diverged },
  }), /schema 1 cannot express ownership "diverged"/);
});

test('unnormalizeProvenance leaves unknown properties alone', () => {
  // validateProvenance() preserves a field a later daftplate adds; the inverse
  // must not be the place that drops it.
  const out = unnormalizeProvenance({
    schema: 3, daftplate: '1.0.0', profile: 'demo', tokens: { A: 'b' }, futureField: 42,
    files: { 'a.md': { digest: `sha256:${'a'.repeat(64)}`, layer: 'base', mode: 'copied', ownership: 'managed', futureEntryField: 7 } },
  });

  assert.equal(out.futureField, 42);
  assert.equal(out.files['a.md'].futureEntryField, 7);
});

test('a manifest survives validate -> unnormalize unchanged at every schema', () => {
  // The round-trip property, asserted directly rather than by enumerating the
  // fields normalization supplies -- so the next normalization is caught by a
  // test that could not have named it in advance (#125 D4).
  const entry = { digest: `sha256:${'a'.repeat(64)}`, layer: 'base', mode: 'copied' };
  const shapes = [
    { daftplate: '1.0.0', profile: 'demo', files: { 'a.md': { ...entry } } },
    { daftplate: '1.0.0', profile: 'demo', tokens: { A: 'b' }, files: { 'a.md': { ...entry } } },
    { schema: 2, daftplate: '1.0.0', profile: 'demo', tokens: { A: 'b' }, files: { 'a.md': { ...entry, ownership: 'managed' } } },
    { schema: 3, daftplate: '1.0.0', profile: 'demo', tokens: { A: 'b' }, files: { 'a.md': { ...entry, ownership: 'managed' } } },
  ];

  for (const shape of shapes) {
    const source = JSON.stringify(shape, null, 2);
    assert.equal(
      JSON.stringify(unnormalizeProvenance(validateProvenance(JSON.parse(source))), null, 2),
      source,
    );
  }
});
