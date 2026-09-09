import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo } from './helpers/make-repo.mjs';
import {
  parseArgs, selectLenses, buildPlan, readAnswers, collect, renderReport,
  RUN_OPERATIONS, MODE_REPORT_ONLY,
} from '../scripts/agent-hunter.mjs';
import { LENSES, FORBIDDEN_ARGV_SUBSTRINGS } from '../scripts/lib/lenses.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const finding = (over = {}) => ({
  lens: 'correctness',
  path: 'scripts/publish.mjs',
  symbol: 'selectPaths',
  defectClass: 'logic-error',
  severity: 'medium',
  severityReasoning: 'only reachable from a flag nobody passes in CI',
  evidence: 'reasoned',
  reproduction: null,
  summary: 'the allowlist is applied after the denylist',
  detail: 'Order matters here and the comment says the opposite.',
  provenance: { doctrine: '/investigate', invocation: 'r1:correctness' },
  ...over,
});

/** Answers on disk, one JSON file per lens, the way a driver leaves them. */
const answersDir = (byLens) => makeRepo(
  Object.fromEntries(Object.entries(byLens).map(([lens, raws]) => [`${lens}.json`, JSON.stringify(raws)])),
);

// --- arguments ---------------------------------------------------------------

test('parseArgs refuses a run with no repository rather than defaulting to .', () => {
  // ADR 0008 row 2: the repo becomes every invocation's cwd, so it is the
  // security-relevant choice and cannot be implicit.
  // Mutation killed: restoring `opts.dir ??= '.'`, which aims a run at whatever
  // directory the caller happened to be standing in.
  assert.throws(() => parseArgs(['node', 'agent-hunter.mjs']), /no repository given/);
});

test('parseArgs reads the repo, repeated lenses, the ingest dir, the out path and the runs dir', () => {
  assert.deepEqual(
    parseArgs(['node', 'agent-hunter.mjs', '/tmp/wt', '--lens', 'security', '--lens', 'correctness', '--ingest', '/tmp/a', '--out', '/tmp/r.md', '--run-id', 'r9', '--runs-dir', '/tmp/runs']),
    {
      dir: '/tmp/wt', lenses: ['security', 'correctness'], ingest: '/tmp/a', out: '/tmp/r.md',
      runId: 'r9', scheduled: false, runsDir: '/tmp/runs',
    },
  );
  // `deepEqual` over the whole object is the point: a flag added without a
  // default fails here rather than reaching a path builder as `undefined`, which
  // `runsRoot` would silently resolve to the developer's real home.
  assert.equal(parseArgs(['node', 'agent-hunter.mjs', '/tmp/wt']).runsDir, null);
});

test('parseArgs understands --scheduled rather than throwing on it', () => {
  // The sweeper passes this, declared as the entry's `unattended.args`. Before
  // `#223 (FORGE-294)` it fell through to the unknown-option throw, and under the
  // sweeper's `stdio: 'ignore'` the usage error went nowhere at all — so every
  // scheduled launch died silently and was reported as started.
  assert.equal(parseArgs(['node', 'agent-hunter.mjs', '/tmp/wt', '--scheduled']).scheduled, true);
  assert.equal(parseArgs(['node', 'agent-hunter.mjs', '/tmp/wt']).scheduled, false);
});

test('parseArgs refuses an unknown option instead of ignoring it', () => {
  // Mutation killed: skipping unrecognised `--` args, which turns a typo'd
  // `--lense security` into a silent full-sweep run.
  assert.throws(() => parseArgs(['node', 'agent-hunter.mjs', '/tmp/wt', '--file']), /unknown option --file/);
});

test('selectLenses defaults to all five and refuses an unknown id', () => {
  assert.equal(selectLenses([]).length, 5);
  assert.equal(selectLenses(undefined).length, 5);
  assert.deepEqual(selectLenses(['security']).map((l) => l.id), ['security']);
  // Mutation killed: filtering unknown ids out, which would let a run asked for a
  // lens it does not have report a clean sweep.
  assert.throws(() => selectLenses(['sekurity']), /unknown lens "sekurity"/);
});

// --- the plan ----------------------------------------------------------------

test('a plan is report-only and carries one safe invocation per lens', () => {
  const plan = buildPlan('/tmp/wt', { runId: 'r1' });
  assert.equal(plan.mode, MODE_REPORT_ONLY);
  assert.equal(plan.invocations.length, 5);
  assert.deepEqual(plan.operations, RUN_OPERATIONS);
  for (const inv of plan.invocations) {
    assert.equal(inv.cwd, '/tmp/wt');
    assert.equal(inv.permissionMode, 'acceptEdits');
  }
});

test('no flag in any planned invocation disables the working-directory boundary', () => {
  // AC 9, asserted over the whole plan rather than over one invocation: the
  // serialized plan is exactly what a driver spawns.
  const serialized = JSON.stringify(buildPlan('/tmp/wt', { runId: 'r1' }).invocations.map((i) => i.argv));
  for (const banned of FORBIDDEN_ARGV_SUBSTRINGS) {
    // Mutation killed: adding --add-dir or --dangerously-skip-permissions to the
    // argv of any one lens.
    assert.equal(serialized.includes(banned), false, `the plan carries ${banned}`);
  }
});

test('a plan claims no operation outside the permitted set', () => {
  // Mutation killed: adding 'create-issue' to RUN_OPERATIONS — buildPlan asserts
  // against PERMITTED_OPERATIONS, so the phase fails where it acquired the
  // authority rather than where it used it.
  assert.deepEqual(RUN_OPERATIONS, ['read-repository', 'invoke-doctrine', 'write-report']);
  assert.equal(RUN_OPERATIONS.includes('create-issue'), false);
});

// --- ingesting answers -------------------------------------------------------

test('a lens with no answer file is reported unanswered, not clean', () => {
  const dir = answersDir({ correctness: [finding()] });
  const answers = readAnswers(dir, LENSES);
  const byLens = Object.fromEntries(answers.map((a) => [a.lens, a.answered]));
  // Mutation killed: treating an absent file as an empty findings array. "This
  // lens found nothing" and "this lens never ran" are different results, and
  // Phase 3 measures precision over the difference.
  assert.equal(byLens.correctness, true);
  assert.equal(byLens.security, false);
  assert.equal(answers.filter((a) => a.answered).length, 1);
});

test('readAnswers accepts a bare array or a { findings } wrapper and refuses anything else', () => {
  const dir = makeRepo({
    'correctness.json': JSON.stringify([finding()]),
    'security.json': JSON.stringify({ findings: [] }),
    'diff-risk.json': JSON.stringify({ notFindings: [] }),
  });
  assert.equal(readAnswers(dir, [LENSES[0]])[0].raws.length, 1);
  assert.equal(readAnswers(dir, [LENSES[3]])[0].raws.length, 0);
  // Mutation killed: coercing an unrecognised shape to [] and reporting the lens
  // as answered with nothing found.
  assert.throws(() => readAnswers(dir, [LENSES[1]]), /holds neither an array nor a findings array/);
});

test('collect separates accepted findings from rejected answers and keeps the lens on both', () => {
  const broken = finding();
  delete broken.evidence;
  const collected = collect([
    { lens: 'correctness', answered: true, raws: [finding(), broken] },
    { lens: 'security', answered: false, raws: [] },
  ]);
  assert.equal(collected.findings.length, 1);
  assert.equal(collected.rejected.length, 1);
  // Mutation killed: losing the lens attribution on a rejected answer, which
  // leaves a malformed finding with no lens to charge it against.
  assert.equal(collected.rejected[0].lens, 'correctness');
  assert.deepEqual(collected.rejected[0].violations.map((v) => v.rule), ['finding-evidence']);
});

// --- the report --------------------------------------------------------------

test('the report states report-only and zero filed', () => {
  const plan = buildPlan('/tmp/wt', { runId: 'r1' });
  const report = renderReport(plan, collect([{ lens: 'correctness', answered: true, raws: [finding()] }]));
  // Mutation killed: dropping the mode line, which lets a reader mistake a
  // report-only run's output for a record of what was filed.
  assert.match(report, /\*\*Mode:\*\* `report-only` — nothing was filed/);
  assert.match(report, /No issue was created in GitHub or in\nLinear by this run/);
  assert.match(report, /#194 \(FORGE-260\)/);
});

test('the report distinguishes a reproduced finding from a reasoned one', () => {
  const plan = buildPlan('/tmp/wt', { runId: 'r1' });
  const report = renderReport(plan, collect([{
    lens: 'correctness',
    answered: true,
    raws: [
      finding({ summary: 'reasoned one' }),
      finding({ summary: 'reproduced one', evidence: 'reproduced', reproduction: 'node --test tests/x.test.mjs → 1 fail' }),
    ],
  }]));
  // Mutation killed: rendering the evidence label without the sentence that says
  // what it means, which reads as a bug report either way.
  assert.match(report, /\*\*Evidence:\*\* reproduced — node --test tests\/x\.test\.mjs → 1 fail/);
  assert.match(report, /\*\*Evidence:\*\* reasoned — not reproduced, this is reasoning about the code/);
});

test('the report marks an unanswered lens in the per-lens table', () => {
  const plan = buildPlan('/tmp/wt', { runId: 'r1' });
  const report = renderReport(plan, collect(LENSES.map((l) => ({ lens: l.id, answered: l.id === 'security', raws: [] }))));
  assert.match(report, /\| Security \| `\/cso` \| yes \| 0 \|/);
  // Mutation killed: printing 'no' the same way as 'yes', so a lens that never ran
  // reads as a lens that found nothing.
  assert.match(report, /\| Correctness \| `\/investigate` \| \*\*no\*\* \| 0 \|/);
});

test('the report lists rejected answers rather than swallowing them', () => {
  const broken = finding();
  delete broken.evidence;
  const plan = buildPlan('/tmp/wt', { runId: 'r1' });
  const report = renderReport(plan, collect([{ lens: 'correctness', answered: true, raws: [broken] }]));
  // Mutation killed: omitting the rejected section, which shows a clean lens and a
  // quiet loss.
  assert.match(report, /`correctness` finding\[0\]: finding-evidence — evidence must be exactly/);
  assert.equal(report.includes('None. Every answer returned took the finding shape.'), false);
});

test('findings are ordered by severity, worst first', () => {
  const plan = buildPlan('/tmp/wt', { runId: 'r1' });
  const report = renderReport(plan, collect([{
    lens: 'correctness',
    answered: true,
    raws: [
      finding({ summary: 'the low one', severity: 'low' }),
      finding({ summary: 'the critical one', severity: 'critical' }),
      finding({ summary: 'the medium one', severity: 'medium' }),
    ],
  }]));
  // Mutation killed: leaving the findings in answer order, which buries a critical
  // under whatever the lens happened to say first.
  assert.deepEqual(
    [...report.matchAll(/^### (the \w+ one)$/gm)].map((m) => m[1]),
    ['the critical one', 'the medium one', 'the low one'],
  );
});

// --- the source guard --------------------------------------------------------

test('neither hunt file can file, comment on, or close anything', () => {
  // The plan's exit criterion: a test asserts the runner has no code path that
  // files anything. The strongest available form of that is that neither module
  // can start a process at all — without one there is no `gh`, and without `gh`
  // there is no filing.
  //
  // Mutation killed: adding `import { execSync } from 'node:child_process'` to
  // either file, or writing a `gh issue create` / `gh issue close` call.
  const forbidden = [
    'child_process', 'execSync', 'spawnSync', 'execFileSync',
    'gh issue', 'issue create', 'issue close', 'save_issue', 'linear.app',
  ];
  for (const rel of ['scripts/agent-hunter.mjs', 'scripts/lib/lenses.mjs']) {
    const source = readFileSync(join(ROOT, rel), 'utf8');
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${rel} contains ${token}`);
    }
  }
});

test('a permission-mode escape appears nowhere but the list that refuses it', () => {
  // Not "not passed" — not present. A commented-out `--dangerously-skip-permissions`
  // is a line somebody uncomments at 2am, and an example carrying it teaches the
  // flag to whoever copies the example.
  //
  // The two strings have to appear once each, inside FORBIDDEN_ARGV_SUBSTRINGS,
  // or the refusal could not name what it refuses. That one occurrence is pinned
  // to that literal; anywhere else is a failure.
  //
  // Mutation killed: adding either flag to a usage example, a comment, a default
  // argv, or a disabled code path in either file.
  const escapes = ['--dangerously-skip-permissions', 'bypassPermissions'];

  const runner = readFileSync(join(ROOT, 'scripts/agent-hunter.mjs'), 'utf8');
  for (const escape of escapes) {
    assert.equal(runner.includes(escape), false, `scripts/agent-hunter.mjs names ${escape}`);
  }

  const lenses = readFileSync(join(ROOT, 'scripts/lib/lenses.mjs'), 'utf8');
  const refusalList = lenses.match(/FORBIDDEN_ARGV_SUBSTRINGS = Object\.freeze\(\[[^\]]*\]\)/);
  assert.ok(refusalList, 'the refusal list is not where the guard expects it');
  for (const escape of escapes) {
    assert.equal(
      lenses.split(escape).length - 1, 1,
      `scripts/lib/lenses.mjs names ${escape} more than once`,
    );
    assert.equal(refusalList[0].includes(escape), true, `${escape} is named outside the refusal list`);
  }
});
