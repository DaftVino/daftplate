import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeRepo, MINIMAL } from './helpers/make-repo.mjs';
import { checkRootFiles, checkRootNaming } from '../scripts/verify-repo.mjs';

test('checkRootFiles passes on a minimal repo', () => {
  assert.deepEqual(checkRootFiles(makeRepo(MINIMAL)), []);
});

test('checkRootFiles reports each missing required root file', () => {
  const { 'CHANGELOG.md': _changelog, LICENSE: _license, ...rest } = MINIMAL;
  const violations = checkRootFiles(makeRepo(rest));
  assert.deepEqual(violations.map((v) => v.path).sort(), ['CHANGELOG.md', 'LICENSE']);
  assert.equal(violations[0].rule, 'root-files');
});

test('checkRootNaming allows canonical uppercase files and kebab files', () => {
  const dir = makeRepo({ ...MINIMAL, 'SECURITY.md': '# Security\n', 'renovate.json': '{}\n' });
  assert.deepEqual(checkRootNaming(dir), []);
});

test('checkRootNaming rejects a non-canonical uppercase root file', () => {
  const dir = makeRepo({ ...MINIMAL, 'ARCHITECTURE.md': '# nope\n' });
  const violations = checkRootNaming(dir);
  assert.deepEqual(violations.map((v) => v.path), ['ARCHITECTURE.md']);
  assert.equal(violations[0].rule, 'naming');
});

test('checkRootNaming ignores dotfiles and directories', () => {
  const dir = makeRepo({ ...MINIMAL, '.clasp.json.example': '{}\n', 'Some-Dir/file.md': 'x\n' });
  assert.deepEqual(checkRootNaming(dir), []);
});

import { walkFiles, checkDocsNaming, checkDocsSubdirs, checkClaudeMdLength } from '../scripts/verify-repo.mjs';

test('walkFiles skips excluded directories entirely', () => {
  const dir = makeRepo({
    ...MINIMAL,
    'node_modules/pkg/index.js': 'x\n',
    '.git/config': 'x\n',
    'src/app.js': 'x\n',
  });
  const rels = walkFiles(dir).map((e) => e.rel);
  assert.equal(rels.some((r) => r.startsWith('node_modules')), false);
  // `.gitignore` is in MINIMAL, so match the directory, not the prefix.
  assert.equal(rels.some((r) => r === '.git' || r.startsWith('.git/')), false);
  assert.equal(rels.includes('src/app.js'), true);
});

test('walkFiles returns an empty list for a missing directory', () => {
  assert.deepEqual(walkFiles(join(makeRepo(MINIMAL), 'nope')), []);
});

test('checkDocsNaming rejects a non-kebab doc at any depth', () => {
  const dir = makeRepo({ ...MINIMAL, 'docs/adr/0001-Some-Decision.md': '# x\n' });
  const violations = checkDocsNaming(dir);
  assert.deepEqual(violations.map((v) => v.path), ['docs/adr/0001-Some-Decision.md']);
});

test('checkDocsNaming passes on kebab docs', () => {
  const dir = makeRepo({ ...MINIMAL, 'docs/adr/0001-some-decision.md': '# x\n', 'docs/setup-guide.md': '# x\n' });
  assert.deepEqual(checkDocsNaming(dir), []);
});

test('checkDocsNaming is a no-op when there is no docs directory', () => {
  const { 'docs/architecture.md': _arch, ...rest } = MINIMAL;
  assert.deepEqual(checkDocsNaming(makeRepo(rest)), []);
});

test('checkDocsSubdirs allows designs, adr and records by default, rejects others', () => {
  const dir = makeRepo({
    ...MINIMAL,
    'docs/designs/2026-07-21-x.md': '# x\n',
    'docs/records/deliberate/2026-07-25-x.md': '# x\n',
    'docs/bugs/x.md': '# x\n',
  });
  assert.deepEqual(checkDocsSubdirs(dir).map((v) => v.path), ['docs/bugs']);
});

test('checkDocsSubdirs honours profile-declared extra subdirs', () => {
  const dir = makeRepo({ ...MINIMAL, 'docs/architecture/context.md': '# x\n' });
  assert.deepEqual(checkDocsSubdirs(dir, ['designs', 'adr', 'architecture']), []);
});

// The load-bearing half of the universal buckets: a profile's docs-subdirs ADDS
// to designs/adr/records rather than replacing them. Every profile.md restates
// "designs, adr" and none restates "records", so a replacing implementation
// would flag /deliberate's own output as a layout violation in all eight.
test('checkDocsSubdirs treats profile subdirs as additions, not a replacement', () => {
  const dir = makeRepo({
    ...MINIMAL,
    'docs/records/deliberate/2026-07-25-x.md': '# x\n',
    'docs/database/schema.md': '# x\n',
  });
  assert.deepEqual(checkDocsSubdirs(dir, ['designs', 'adr', 'database']), []);
});

test('checkDocsSubdirs is a no-op when there is no docs directory', () => {
  const { 'docs/architecture.md': _arch, ...rest } = MINIMAL;
  assert.deepEqual(checkDocsSubdirs(makeRepo(rest)), []);
});

test('checkClaudeMdLength rejects a CLAUDE.md over the limit', () => {
  const dir = makeRepo({ ...MINIMAL, 'CLAUDE.md': '# CLAUDE.md\n'.repeat(61) });
  const violations = checkClaudeMdLength(dir);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'claude-md-length');
});

test('checkClaudeMdLength is a no-op when CLAUDE.md is missing', () => {
  const { 'CLAUDE.md': _claude, ...rest } = MINIMAL;
  assert.deepEqual(checkClaudeMdLength(makeRepo(rest)), []);
});

import {
  checkNoVendoredStandards, checkExampleTwins, checkNoUnresolvedPlaceholders, verifyRepo,
} from '../scripts/verify-repo.mjs';

test('checkNoVendoredStandards rejects a copied standards tree', () => {
  const dir = makeRepo({ ...MINIMAL, 'engineering-standards/repo-standards.md': '# copied\n' });
  assert.deepEqual(checkNoVendoredStandards(dir).map((v) => v.path), ['engineering-standards']);
});

test('checkExampleTwins requires a twin for every gitignored secret config', () => {
  const dir = makeRepo({ ...MINIMAL, '.gitignore': 'node_modules/\n.clasp.json\n.dev.vars\n' });
  assert.deepEqual(checkExampleTwins(dir).map((v) => v.path).sort(), ['.clasp.json.example', '.dev.vars.example']);
});

test('checkExampleTwins passes when the twins are committed', () => {
  const dir = makeRepo({
    ...MINIMAL,
    '.gitignore': '.clasp.json\n',
    '.clasp.json.example': '{ "scriptId": "REPLACE_ME" }\n',
  });
  assert.deepEqual(checkExampleTwins(dir), []);
});

test('checkExampleTwins is a no-op when there is no .gitignore', () => {
  const { '.gitignore': _ignore, ...rest } = MINIMAL;
  assert.deepEqual(checkExampleTwins(makeRepo(rest)), []);
});

test('checkNoUnresolvedPlaceholders catches markers and ALL_CAPS tokens in CLAUDE.md', () => {
  const dir = makeRepo({
    ...MINIMAL,
    'CLAUDE.md': '# CLAUDE.md\n\n<PROJECT_SUMMARY>\n\n<!-- profile:routing -->\n',
  });
  const messages = checkNoUnresolvedPlaceholders(dir).map((v) => v.message).sort();
  assert.deepEqual(messages, [
    'unresolved placeholder <PROJECT_SUMMARY>',
    'unresolved profile marker <!-- profile:routing -->',
  ]);
});

test('checkNoUnresolvedPlaceholders scans every text file, not just CLAUDE.md', () => {
  const dir = makeRepo({
    ...MINIMAL,
    'README.md': '# <PROJECT_NAME>\n',
    LICENSE: 'Copyright (c) <YEAR> James M. Baker\n',
    'docs/architecture.md': '<PROJECT_SUMMARY>\n',
  });
  const paths = checkNoUnresolvedPlaceholders(dir).map((v) => v.path).sort();
  assert.deepEqual(paths, ['LICENSE', 'README.md', 'docs/architecture.md']);
});

test('checkNoUnresolvedPlaceholders skips binary files', () => {
  const dir = makeRepo({ ...MINIMAL, 'assets/logo.png': '<NOT_TEXT>\n' });
  assert.deepEqual(checkNoUnresolvedPlaceholders(dir), []);
});

test('verifyRepo aggregates every check and passes the minimal repo', () => {
  assert.deepEqual(verifyRepo(makeRepo(MINIMAL)), []);
});

test('verifyRepo passes docsSubdirs through to the docs-layout check', () => {
  const dir = makeRepo({ ...MINIMAL, 'docs/database/erd.md': '# x\n' });
  assert.equal(verifyRepo(dir).length, 1);
  assert.deepEqual(verifyRepo(dir, { docsSubdirs: ['designs', 'adr', 'database'] }), []);
});

test('verifyRepo reports violations from more than one rule', () => {
  const { LICENSE: _license, ...rest } = MINIMAL;
  const dir = makeRepo({ ...rest, 'engineering-standards/x.md': '# x\n' });
  const rules = new Set(verifyRepo(dir).map((v) => v.rule));
  assert.deepEqual([...rules].sort(), ['root-files', 'vendored-standards']);
});
