import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import { parseProfileMeta } from '../scripts/verify-templates.mjs';
import { scaffold } from '../scripts/scaffold.mjs';
import {
  VAULT_BUCKETS, notes, checkBuckets,
  REQUIRED_FIELDS, parseFrontmatter, checkFrontmatter,
  checkLinks, validateVault,
} from '../profiles/design-vault/files/scripts/validate-vault.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const values = (name) => ({
  year: 2026,
  tokens: { PROJECT_NAME: name, PROJECT_SUMMARY: 'A throwaway scaffold used to verify daftplate.' },
});

test('VAULT_BUCKETS carries the numbered scheme plus designs and adr', () => {
  assert.deepEqual(VAULT_BUCKETS, [
    '00-project', '10-world', '20-design', '30-content',
    '40-research', '50-technical', '90-production', 'designs', 'adr',
  ]);
});

test('notes lists markdown files depth-first and skips .obsidian', () => {
  const root = makeRepo({
    'docs/00-project/brief.md': '# brief\n',
    'docs/10-world/places/harbour.md': '# harbour\n',
    'docs/10-world/cover.png': 'not markdown',
    '.obsidian/workspace.json': '{}',
  });

  assert.deepEqual(
    notes(`${root}/docs`, 'docs').sort(),
    ['docs/00-project/brief.md', 'docs/10-world/places/harbour.md'],
  );
});

test('notes skips symlinked entries', (t) => {
  const root = makeRepo({ 'docs/10-world/real.md': '# real\n' });
  try {
    symlinkSync(join(root, 'docs/10-world/real.md'), join(root, 'docs/10-world/link.md'));
  } catch {
    t.skip('symlinks are not permitted in this environment');
    return;
  }

  assert.deepEqual(notes(`${root}/docs`, 'docs').sort(), ['docs/10-world/real.md']);
});

test('checkBuckets accepts every canonical bucket', () => {
  const root = makeRepo(Object.fromEntries(
    VAULT_BUCKETS.map((b) => [`docs/${b}/note.md`, '# n\n']),
  ));

  assert.deepEqual(checkBuckets(root), []);
});

test('checkBuckets rejects an unknown directory under docs/', () => {
  const root = makeRepo({ 'docs/00-project/brief.md': '# b\n', 'docs/scratch/idea.md': '# i\n' });

  const issues = checkBuckets(root);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'bucket');
  assert.equal(issues[0].path, 'docs/scratch');
  assert.match(issues[0].message, /00-project/);
});

test('checkBuckets is silent when there is no docs/ directory yet', () => {
  assert.deepEqual(checkBuckets(makeRepo({ 'README.md': '# r\n' })), []);
});

// --- Task 3b.2: frontmatter (B1 scalar-only parser) ---

const NOTE = (body = '') => `---\ntitle: Harbour\nupdated: 2026-07-22\n---\n\n${body}`;

test('REQUIRED_FIELDS is title and updated', () => {
  assert.deepEqual(REQUIRED_FIELDS, ['title', 'updated']);
});

test('parseFrontmatter unquotes a quoted scalar and tolerates CRLF', () => {
  assert.equal(parseFrontmatter('---\ntitle: "Harbour"\nupdated: 2026-07-22\n---\n').values.title, 'Harbour');
  const crlf = parseFrontmatter('---\r\ntitle: Harbour\r\nupdated: 2026-07-22\r\n---\r\n\r\nbody\r\n');
  assert.deepEqual(crlf.values, { title: 'Harbour', updated: '2026-07-22' });
});

test('parseFrontmatter keeps a value containing a colon whole', () => {
  assert.equal(
    parseFrontmatter('---\ntitle: The Harbour: a study\nupdated: 2026-07-22\n---\n').values.title,
    'The Harbour: a study',
  );
});

test('parseFrontmatter records a block-list key in structured and skips its items', () => {
  const parsed = parseFrontmatter('---\ntitle: H\nupdated: 2026-07-22\ntags:\n  - fiction\n  - draft\n---\n\nbody\n');
  assert.equal(parsed.values.title, 'H');
  assert.equal('tags' in parsed.values, false);
  assert.ok(parsed.structured.has('tags'));
});

test('parseFrontmatter ignores an inline aliases list', () => {
  const parsed = parseFrontmatter('---\ntitle: H\nupdated: 2026-07-22\naliases: [harbour, docks]\n---\n');
  assert.equal('aliases' in parsed.values, false);
  assert.ok(parsed.structured.has('aliases'));
});

test('parseFrontmatter ignores a comment line', () => {
  const parsed = parseFrontmatter('---\n# a comment\ntitle: H\nupdated: 2026-07-22\n---\n');
  assert.deepEqual(parsed.values, { title: 'H', updated: '2026-07-22' });
});

test('checkFrontmatter passes a note whose extra tags block list sits beside valid fields', () => {
  const root = makeRepo({
    'docs/10-world/harbour.md': '---\ntitle: Harbour\nupdated: 2026-07-22\ntags:\n  - place\n---\n\nbody\n',
  });

  assert.deepEqual(checkFrontmatter(root), []);
});

test('checkFrontmatter fails a required title written as a block list, by name', () => {
  const root = makeRepo({
    'docs/10-world/harbour.md': '---\ntitle:\n  - A\n  - B\nupdated: 2026-07-22\n---\n\nbody\n',
  });

  const issues = checkFrontmatter(root);

  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /title must be a single-line/);
});

test('checkFrontmatter passes a well-formed vault', () => {
  const root = makeRepo({ 'docs/10-world/harbour.md': NOTE('The harbour.\n') });

  assert.deepEqual(checkFrontmatter(root), []);
});

test('checkFrontmatter reports a note with no frontmatter block at all', () => {
  const root = makeRepo({ 'docs/10-world/harbour.md': '# Harbour\n' });

  const issues = checkFrontmatter(root);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'frontmatter');
  assert.equal(issues[0].path, 'docs/10-world/harbour.md');
  assert.match(issues[0].message, /no --- frontmatter/);
});

test('checkFrontmatter names each truly-absent field separately', () => {
  const root = makeRepo({ 'docs/10-world/harbour.md': '---\nsummary: x\n---\n\nbody\n' });

  const messages = checkFrontmatter(root).map((v) => v.message);

  assert.equal(messages.length, 2);
  assert.ok(messages.some((m) => m.includes('title') && m.includes('missing')));
  assert.ok(messages.some((m) => m.includes('updated') && m.includes('missing')));
});

test('checkFrontmatter rejects a non-ISO updated date', () => {
  const root = makeRepo({ 'docs/10-world/harbour.md': '---\ntitle: H\nupdated: July 2026\n---\n\nb\n' });

  const issues = checkFrontmatter(root);

  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /YYYY-MM-DD/);
  assert.match(issues[0].message, /July 2026/);
});

test('checkFrontmatter ignores the adr and designs process buckets and root docs', () => {
  const root = makeRepo({
    'docs/architecture.md': '# Architecture, no frontmatter\n',
    'docs/adr/0001-choice.md': '# ADR 0001\n\n- Status: Accepted\n',
    'docs/designs/2026-07-22-plan.md': '# A plan with no frontmatter\n',
  });

  assert.deepEqual(checkFrontmatter(root), []);
});

// --- Task 3b.3: links (B2 wikilink + markdown, fence-aware) and validateVault ---

test('checkLinks accepts a wikilink that resolves to a note anywhere in the vault', () => {
  const root = makeRepo({
    'docs/10-world/harbour.md': NOTE('See [[fishing-fleet]].\n'),
    'docs/30-content/fishing-fleet.md': NOTE('The fleet.\n'),
  });

  assert.deepEqual(checkLinks(root), []);
});

test('checkLinks accepts alias and heading suffixes', () => {
  const root = makeRepo({
    'docs/10-world/harbour.md': NOTE('[[fishing-fleet|the fleet]] and [[fishing-fleet#ships]].\n'),
    'docs/30-content/fishing-fleet.md': NOTE('x\n'),
  });

  assert.deepEqual(checkLinks(root), []);
});

test('checkLinks reports a wikilink with no target note', () => {
  const root = makeRepo({ 'docs/10-world/harbour.md': NOTE('See [[the-lost-city]].\n') });

  const issues = checkLinks(root);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'link');
  assert.equal(issues[0].path, 'docs/10-world/harbour.md');
  assert.match(issues[0].message, /the-lost-city/);
});

test('checkLinks resolves a markdown link by stem and reports a broken one', () => {
  const ok = makeRepo({
    'docs/10-world/harbour.md': NOTE('See [the fleet](../30-content/fishing-fleet.md).\n'),
    'docs/30-content/fishing-fleet.md': NOTE('x\n'),
  });
  assert.deepEqual(checkLinks(ok), []);

  const broken = makeRepo({ 'docs/10-world/harbour.md': NOTE('See [gone](../30-content/gone.md).\n') });
  const issues = checkLinks(broken);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /gone/);
});

test('checkLinks ignores links inside a fenced code block, and external links', () => {
  const root = makeRepo({
    'docs/10-world/harbour.md': NOTE('```\n[[not-a-real-note]] and [x](../30-content/nope.md)\n```\n\nSee [docs](https://example.com).\n'),
  });

  assert.deepEqual(checkLinks(root), []);
});

test('validateVault runs all three checks and concatenates their findings', () => {
  const root = makeRepo({
    'docs/scratch/idea.md': '# no frontmatter\n\n[[nowhere]]\n',
  });

  const rules = new Set(validateVault(root).map((v) => v.rule));

  assert.deepEqual([...rules].sort(), ['bucket', 'frontmatter', 'link']);
});

test('validateVault is clean on a well-formed vault', () => {
  const root = makeRepo({
    'docs/00-project/brief.md': NOTE('See [[harbour]].\n'),
    'docs/10-world/harbour.md': NOTE('Back to [[brief]].\n'),
  });

  assert.deepEqual(validateVault(root), []);
});

// --- Task 3b.4: the profile ships a validator that agrees with its metadata,
//     and that validator runs where it lands ---

test('VAULT_BUCKETS matches the profile metadata that verify-repo runs on', () => {
  const meta = parseProfileMeta(readFileSync(
    new URL('../profiles/design-vault/profile.md', import.meta.url), 'utf8'));

  assert.deepEqual(meta.docsSubdirs, VAULT_BUCKETS);
});

test('validate-vault.mjs runs inside a scaffolded design-vault repo', () => {
  const dest = emptyDir();
  scaffold(ROOT, 'design-vault', dest, values('dry-vault'));

  const result = spawnSync(process.execPath, [join(dest, 'scripts', 'validate-vault.mjs'), dest], { encoding: 'utf8' });

  assert.equal(result.status, 0, `exited ${result.status}: ${result.stderr}`);
});

// --- Task 3b.5: the whole design rests on this file shipping without daftplate ---

test('validate-vault.mjs imports only node: builtins, because it ships without daftplate', () => {
  const source = readFileSync(
    new URL('../profiles/design-vault/files/scripts/validate-vault.mjs', import.meta.url),
    'utf8',
  );
  const specifiers = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);

  assert.ok(specifiers.length > 0, 'no imports found — did the file move?');
  const foreign = specifiers.filter((s) => !s.startsWith('node:'));
  assert.deepEqual(foreign, [], `these would not resolve in a scaffolded vault: ${foreign.join(', ')}`);
});
