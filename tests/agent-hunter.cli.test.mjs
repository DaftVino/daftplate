import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import { main } from '../scripts/agent-hunter.mjs';

const finding = (over = {}) => ({
  lens: 'export-integrity',
  path: 'scripts/publish.mjs',
  symbol: 'selectPaths',
  defectClass: 'dangling-reference',
  severity: 'high',
  severityReasoning: 'the export ships a file whose import resolves to a withheld path',
  evidence: 'reproduced',
  reproduction: 'node --test tests/publish.test.mjs → 1 fail',
  summary: 'an exported test imports a path the export withholds',
  detail: 'A stranger cloning the export cannot run the suite.',
  provenance: { doctrine: 'tests/publish.test.mjs guards', invocation: 'r1:export-integrity' },
  ...over,
});

// **Every call that names a repository routes its run ledger into a throwaway
// directory.** Since `#194 (FORGE-260)` Phase 7 the planning half opens a run
// record, and the default ledger is the developer's real `~/.daftplate/runs/`.
// Measured before this was added: one green run of this file left three
// temp-repo run roots standing there, and `/daft-agent` would have listed the
// hunt among them as live for ever.
const RUNS = emptyDir();
const hunt = (...args) => main(['node', 'agent-hunter.mjs', ...args, '--runs-dir', RUNS]);

test('main returns 2 and prints usage when no repository is given', () => {
  // Usage, not failure. 2 and 1 must not read the same: a run that was never
  // pointed at a repository has not swept one clean.
  // Mutation killed: returning 0 or 1 from the usage branch.
  assert.equal(main(['node', 'agent-hunter.mjs']), 2);
});

test('main returns 2 for an unknown lens rather than sweeping all five', () => {
  assert.equal(hunt('.', '--lens', 'sekurity'), 2);
});

test('main with no --ingest prints the plan and returns 0 without writing anything', () => {
  const dir = emptyDir();
  assert.equal(hunt(dir), 0);
  // Mutation killed: having the plan branch write a report or an answers file. The
  // planning half touches nothing; an empty directory stays empty.
  assert.equal(existsSync(join(dir, 'hunt-report.md')), false);
});

test('main ingests answers, writes the report to --out, and returns 0', () => {
  const answers = makeRepo({ 'export-integrity.json': JSON.stringify([finding()]) });
  const out = join(emptyDir(), 'report.md');

  assert.equal(hunt('.', '--lens', 'export-integrity', '--ingest', answers, '--out', out), 0);

  const report = readFileSync(out, 'utf8');
  assert.match(report, /an exported test imports a path the export withholds/);
  // Mutation killed: dropping the zero-filed line, or letting the report claim a
  // filing count it did not compute.
  assert.match(report, /nothing was filed/);
});

test('main returns 1 when a lens answer is not a finding', () => {
  const broken = finding();
  delete broken.evidence;
  const answers = makeRepo({ 'export-integrity.json': JSON.stringify([broken]) });
  const out = join(emptyDir(), 'report.md');

  // Mutation killed: returning 0 for a run whose answers were all malformed, which
  // is indistinguishable from a run that found nothing.
  assert.equal(hunt('.', '--lens', 'export-integrity', '--ingest', answers, '--out', out), 1);
  assert.match(readFileSync(out, 'utf8'), /finding-evidence/);
});

test('a structured reproduction reaches the report as something rerunnable', () => {
  // #194 (FORGE-260) / D8, AC 13. The plan says "rendered by renderReport rather
  // than stringified at the boundary" and prescribes no shape, so the shape is
  // decided here and asserted: the command and its output, in a fence, because
  // rerunnability is the whole reason the field exists. `[object Object]` is the
  // failure this is written against -- the old interpolation produced exactly
  // that for a well-formed answer.
  const answers = makeRepo({
    'export-integrity.json': JSON.stringify([finding({
      reproduction: { command: 'node --test tests/publish.test.mjs', output: '1 fail, 117 pass' },
    })]),
  });
  const out = join(emptyDir(), 'report.md');
  assert.equal(hunt('.', '--lens', 'export-integrity', '--ingest', answers, '--out', out), 0);

  const report = readFileSync(out, 'utf8');
  assert.doesNotMatch(report, /\[object Object\]/, 'the report stringified a structured reproduction');
  assert.match(report, /node --test tests\/publish\.test\.mjs/, 'the command a reader would rerun is absent');
  assert.match(report, /1 fail, 117 pass/, 'the output that makes the command a reproduction is absent');
});

test('a string reproduction still renders inline', () => {
  // The other shape must not regress while the structured one is taught.
  const answers = makeRepo({ 'export-integrity.json': JSON.stringify([finding()]) });
  const out = join(emptyDir(), 'report.md');
  assert.equal(hunt('.', '--lens', 'export-integrity', '--ingest', answers, '--out', out), 0);
  assert.match(readFileSync(out, 'utf8'), /node --test tests\/publish\.test\.mjs → 1 fail/);
});

test('a structured reproduction missing a key is rejected by shape, and the report says which rule', () => {
  const answers = makeRepo({
    'export-integrity.json': JSON.stringify([finding({ reproduction: { command: 'npm test', output: '' } })]),
  });
  const out = join(emptyDir(), 'report.md');
  assert.equal(hunt('.', '--lens', 'export-integrity', '--ingest', answers, '--out', out), 1);
  assert.match(readFileSync(out, 'utf8'), /finding-reproduction-shape/);
});
