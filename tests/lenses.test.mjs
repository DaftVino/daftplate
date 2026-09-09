import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LENSES, LENS_IDS, lensById,
  MODE_REPORT_ONLY, PERMITTED_OPERATIONS, NEVER_PERMITTED_OPERATIONS,
  FORBIDDEN_ARGV_SUBSTRINGS, PERMISSION_MODE, EVIDENCE_KINDS, SEVERITIES,
  assertInvocationSafe, assertOperationsPermitted,
  buildInvocation, buildPrompt,
  findingViolations, normalizeFinding, normalizeFindings,
} from '../scripts/lib/lenses.mjs';

/** A finding that validates. Every test below mutates exactly one field of it,
 *  so a rule that stopped being enforced shows up as one failing test rather
 *  than as a suite that got quieter. */
const good = () => ({
  lens: 'security',
  path: 'scripts/publish.mjs',
  symbol: 'selectPaths',
  defectClass: 'path-traversal',
  severity: 'high',
  severityReasoning: 'reachable from a CLI argument, and the write it guards is recursive',
  evidence: 'reasoned',
  reproduction: null,
  summary: 'selectPaths does not reject a traversing path',
  detail: 'A `..` segment in the allowlist would walk out of the repository root.',
  provenance: { doctrine: '/cso', invocation: 'run-1:security' },
});

const rules = (raw) => findingViolations(raw).map((v) => v.rule);

// --- the five lenses, and their provenance -----------------------------------

test('there are exactly five lenses, in the spec order', () => {
  // Mutation killed: adding, dropping or renaming a lens without deciding to.
  assert.deepEqual(LENS_IDS, [
    'correctness', 'diff-risk', 'test-authenticity', 'security', 'export-integrity',
  ]);
});

test('every lens names an existing doctrine it invokes rather than re-derives', () => {
  // Mutation killed: a lens whose `doctrine` is blank or invented — the finding it
  // produces would trace to no reasoning anyone reviewed.
  assert.deepEqual(
    LENSES.map((l) => l.doctrine),
    ['/investigate', '/review', '/audit', '/cso', 'tests/publish.test.mjs guards'],
  );
  for (const lens of LENSES) {
    assert.equal(typeof lens.doctrineSource, 'string');
    assert.notEqual(lens.doctrineSource.trim(), '');
  }
});

test('every lens declares at least two defect classes, and no class is shared between lenses', () => {
  const seen = new Map();
  for (const lens of LENSES) {
    assert.ok(lens.defectClasses.length >= 2, `${lens.id} declares too few defect classes`);
    for (const cls of lens.defectClasses) {
      // Mutation killed: giving two lenses the same defect class, which would make
      // the Phase 2 fingerprint over lens|path|symbol|class collide across lenses.
      assert.equal(seen.has(cls), false, `${cls} is claimed by both ${seen.get(cls)} and ${lens.id}`);
      seen.set(cls, lens.id);
    }
  }
});

test('lensById returns null for an unknown id rather than undefined', () => {
  assert.equal(lensById('nope'), null);
  assert.equal(lensById('security').title, 'Security');
});

// --- what a run is permitted to do (ADR 0008 rows 1, 2, 6) -------------------

test('report-only is the only mode, and it is what the module exports', () => {
  assert.equal(MODE_REPORT_ONLY, 'report-only');
});

test('the permitted operations do not include filing or closing an issue', () => {
  // ADR 0008 row 6: file yes, close never — and filing is Phase 4's, gated on a
  // precision measurement that does not exist yet.
  // Mutation killed: adding 'create-issue' or 'close-issue' to PERMITTED_OPERATIONS.
  assert.deepEqual(PERMITTED_OPERATIONS, ['read-repository', 'invoke-doctrine', 'write-report']);
  assert.equal(PERMITTED_OPERATIONS.includes('create-issue'), false);
  assert.equal(PERMITTED_OPERATIONS.includes('close-issue'), false);
});

test('closing an issue is named as never permitted, not merely absent', () => {
  // An operation that is absent is one nobody got round to; one that is named is
  // one somebody refused. ADR 0008 row 6 is the refusal.
  assert.equal(NEVER_PERMITTED_OPERATIONS.includes('close-issue'), true);
  for (const op of NEVER_PERMITTED_OPERATIONS) {
    assert.equal(PERMITTED_OPERATIONS.includes(op), false, `${op} is both permitted and never-permitted`);
  }
});

test('assertOperationsPermitted throws on an operation outside the permitted set', () => {
  // Mutation killed: turning the throw into a warning, or into a filter that drops
  // the offending operation and carries on.
  assert.throws(
    () => assertOperationsPermitted(['read-repository', 'create-issue']),
    /operation "create-issue" is not permitted/,
  );
  assert.deepEqual(assertOperationsPermitted(['read-repository']), ['read-repository']);
});

// --- AC 9: the argv actually built ------------------------------------------

test('every lens invocation runs under acceptEdits and carries no boundary-disabling flag', () => {
  // AC 9, asserted over the argv actually handed out for all five lenses rather
  // than over one sample.
  for (const lens of LENSES) {
    const inv = buildInvocation(lens, { repoRoot: '/tmp/wt', runId: 'r1' });
    assert.equal(inv.permissionMode, 'acceptEdits');
    assert.equal(inv.cwd, '/tmp/wt');
    const joined = inv.argv.join(' ');
    for (const banned of FORBIDDEN_ARGV_SUBSTRINGS) {
      // Mutation killed: adding --dangerously-skip-permissions or --add-dir to the
      // argv builder for any single lens.
      assert.equal(joined.includes(banned), false, `${lens.id} argv carries ${banned}`);
    }
  }
});

test('assertInvocationSafe refuses each forbidden argv substring by name', () => {
  const base = { permissionMode: PERMISSION_MODE, cwd: '/tmp/wt', argv: [] };
  for (const banned of FORBIDDEN_ARGV_SUBSTRINGS) {
    // Mutation killed: dropping any one entry from FORBIDDEN_ARGV_SUBSTRINGS, or
    // switching the check from substring to exact-token so
    // `--permission-mode=bypassPermissions` slips through.
    assert.throws(
      () => assertInvocationSafe({ ...base, argv: ['--print', `--permission-mode=${banned}`] }),
      new RegExp(`refusing an invocation carrying ${banned.replace(/[-]/g, '\\-')}`),
      `${banned} was not refused`,
    );
  }
});

test('assertInvocationSafe refuses a permission mode that is not acceptEdits', () => {
  // ADR 0008 row 1: a request for a wider mode is refused, never downgraded.
  // Mutation killed: relaxing the equality to "not bypassPermissions", which would
  // silently accept `dontAsk` — a mode that cannot write in its own worktree.
  assert.throws(
    () => assertInvocationSafe({ permissionMode: 'dontAsk', cwd: '/tmp/wt', argv: [] }),
    /permission mode must be acceptEdits/,
  );
});

test('assertInvocationSafe refuses an invocation with no working directory', () => {
  // ADR 0008 row 2: cwd is the security-relevant choice, so it cannot be implicit.
  assert.throws(
    () => assertInvocationSafe({ permissionMode: PERMISSION_MODE, cwd: '', argv: [] }),
    /must name its own working directory/,
  );
});

test('the prompt tells the lens to invoke the doctrine and to file nothing', () => {
  const prompt = buildPrompt(lensById('test-authenticity'), { repoRoot: '/tmp/wt', runId: 'r1' });
  assert.match(prompt, /Invoke the \/audit doctrine/);
  assert.match(prompt, /Do not\nrestate or re-derive it/);
  // Mutation killed: dropping the refusal clause from the prompt, which would let a
  // lens file on its own initiative in a phase that grants it no such authority.
  assert.match(prompt, /Create no issue, in GitHub or in Linear/);
  assert.match(prompt, /Close nothing/);
  // The prompt must offer the lens's own classes, not the union of all five.
  assert.match(prompt, /one of: assertion-accepts-mutant, tautological-assertion/);
  assert.equal(prompt.includes('path-traversal'), false);
});

// --- the finding shape ------------------------------------------------------

test('a well-formed finding validates and is copied field for field', () => {
  const result = normalizeFinding(good());
  assert.equal(result.ok, true);
  assert.deepEqual(result.finding, good());
});

test('evidence has no default: a finding that omits it is rejected', () => {
  // The field the plan calls the one that must not be optional. "This fails" and
  // "this looks like it would fail" are a bug report and a guess.
  // Mutation killed: `raw.evidence ?? 'reasoned'` anywhere in the validator or the
  // normalizer — a default here silently turns every guess into a bug report.
  const raw = good();
  delete raw.evidence;
  assert.deepEqual(rules(raw), ['finding-evidence']);
  assert.equal(normalizeFinding(raw).ok, false);
});

test('evidence must be exactly reproduced or reasoned', () => {
  // Mutation killed: accepting any truthy string, e.g. "probably".
  assert.deepEqual(rules({ ...good(), evidence: 'probably' }), ['finding-evidence']);
  assert.deepEqual(EVIDENCE_KINDS, ['reproduced', 'reasoned']);
});

test('a reproduced finding without a reproduction is rejected', () => {
  // Mutation killed: dropping the reproduction requirement, which would let a lens
  // claim it ran something by writing one word.
  assert.deepEqual(
    rules({ ...good(), evidence: 'reproduced', reproduction: null }),
    ['finding-evidence'],
  );
  assert.equal(normalizeFinding({ ...good(), evidence: 'reproduced', reproduction: 'node --test tests/x.test.mjs → 1 fail' }).ok, true);
});

test('a reasoned finding that attaches a reproduction is rejected', () => {
  // The distinction is stated, never blurred. A finding that is both is neither.
  // Mutation killed: allowing the pair, which lets a guess ship with evidence
  // attached and read as reproduced to anyone skimming.
  assert.deepEqual(
    rules({ ...good(), evidence: 'reasoned', reproduction: 'node --test' }),
    ['finding-evidence'],
  );
});

test('normalizeFinding drops a reproduction from a reasoned finding rather than carrying it', () => {
  const result = normalizeFinding({ ...good(), evidence: 'reasoned', reproduction: null });
  assert.equal(result.finding.reproduction, null);
});

test('symbol must be present; null is an answer and absent is not', () => {
  // The Phase 2 fingerprint is over lens|path|symbol|class. A missing key and a
  // deliberate file-level finding are different findings, and a fingerprint that
  // cannot tell them apart hashes two things to one.
  const raw = good();
  delete raw.symbol;
  // The absent case and the bad-value case carry separate rules, so the presence
  // check is observable rather than shadowed by the value check that would reject
  // `undefined` anyway.
  // Mutation killed: dropping the `'symbol' in raw` branch, which leaves the
  // omission reported as a bad value and loses the distinction Phase 2's
  // fingerprint depends on.
  assert.deepEqual(rules(raw), ['finding-symbol-absent']);
  assert.equal(normalizeFinding({ ...good(), symbol: null }).ok, true);
  assert.deepEqual(rules({ ...good(), symbol: '' }), ['finding-symbol']);
});

test('a path must be repository-relative', () => {
  // Mutation killed: dropping the absolute-path check. A finding keyed on
  // /home/someone/repo/scripts/x.mjs fingerprints differently in every checkout.
  assert.deepEqual(rules({ ...good(), path: '/etc/passwd' }), ['finding-path']);
  assert.deepEqual(rules({ ...good(), path: 'C:/Windows/system32' }), ['finding-path']);
  assert.deepEqual(rules({ ...good(), path: '../outside/thing.mjs' }), ['finding-path']);
  assert.deepEqual(rules({ ...good(), path: '' }), ['finding-path']);
});

test('a path escapes with either separator, and a UNC path is refused as absolute', () => {
  // `#215 (FORGE-275)`. The escapes rule was `raw.path.split('/')` — a
  // forward-slash-only split on a platform whose separator is `\`. Measured
  // against the real export before the fix:
  //
  //   "../../x.mjs"          refused: escapes the repository
  //   "..\..\x.mjs"          ACCEPTED
  //   "\\srv\share\x.mjs"    ACCEPTED
  //   "C:\x.mjs"             refused: is absolute
  //
  // A finding's path becomes an issue body, a fingerprint, and something a filing
  // step reads — so the accepted spelling is the native one on the workstation
  // the hunt runs on, which is the half that mattered.
  //
  // Mutation killed — M6: restore `split('/')` on the un-normalised `raw.path`.
  // The two backslash rows go red; the forward-slash rows stay green, which is
  // the whole shape of the bug.
  const rulesFor = (path) => rules({ ...good(), path });
  assert.deepEqual(rulesFor('../../x.mjs'), ['finding-path']);
  assert.deepEqual(rulesFor(String.raw`..\..\x.mjs`), ['finding-path']);
  assert.deepEqual(rulesFor(String.raw`scripts\..\..\outside.mjs`), ['finding-path']);
  assert.deepEqual(rulesFor(String.raw`C:\x.mjs`), ['finding-path']);
  assert.deepEqual(rulesFor(String.raw`\\srv\share\x.mjs`), ['finding-path']);

  // An ordinary repo-relative path is still a finding, in either separator. The
  // normalisation must not turn the rule into "no backslashes anywhere", which
  // would refuse every path a Windows lens quotes out of a stack trace.
  assert.deepEqual(rulesFor('scripts/lib/ok.mjs'), []);
  assert.deepEqual(rulesFor(String.raw`scripts\lib\ok.mjs`), []);

  // Which rule fires is the judgement, not an accident of ordering. A UNC path
  // carries no `..` and escapes nothing by walking upwards — it names another
  // machine outright — so "is absolute" is the true sentence about it, and it is
  // the one that tells the lens what to send instead. Asserted on the message a
  // human reads, because that is the whole difference between the two rules.
  const messageFor = (path) => findingViolations({ ...good(), path })
    .filter((v) => v.rule === 'finding-path')[0].message;
  //
  // Mutation killed — M6b: restore the un-normalised `raw.path.startsWith('/')`
  // in the absolute rule. The UNC row goes red, and it goes red as an ACCEPTANCE
  // rather than as a reclassification: `//srv/share/x.mjs` holds no `..`, so with
  // the absolute rule blind to it there is no second rule to catch it.
  assert.match(messageFor(String.raw`\\srv\share\x.mjs`), /is absolute/);
  assert.match(messageFor(String.raw`..\..\x.mjs`), /escapes the repository/);
  // And the message quotes the path as it was SENT, not as this rule normalised
  // it — a refusal naming a string the lens never produced is a refusal nobody
  // can act on.
  assert.match(messageFor(String.raw`..\..\x.mjs`), /\.\.\\\.\.\\x\.mjs/);
});

test('a defect class must be one the finding lens declares', () => {
  // Mutation killed: checking the class against the union of all lenses' classes,
  // which would let the security lens file a missing-test finding and make the
  // per-lens precision numbers Phase 3 measures meaningless.
  assert.deepEqual(rules({ ...good(), defectClass: 'missing-test' }), ['finding-defect-class']);
  assert.deepEqual(rules({ ...good(), defectClass: 'invented' }), ['finding-defect-class']);
});

test('severity carries its reasoning, not just its label', () => {
  // Mutation killed: accepting the label alone. A severity nobody can check is a
  // number pulled out of the air.
  assert.deepEqual(rules({ ...good(), severityReasoning: '' }), ['finding-severity']);
  assert.deepEqual(rules({ ...good(), severity: 'catastrophic' }), ['finding-severity']);
  assert.deepEqual(SEVERITIES, ['critical', 'high', 'medium', 'low']);
});

test('provenance must name the doctrine the finding lens actually invokes', () => {
  // This is what makes a finding attributable rather than an unattributed
  // assertion: the security lens cannot answer with /audit's authority.
  // Mutation killed: accepting any non-empty doctrine string, or dropping the
  // provenance check entirely.
  assert.deepEqual(
    rules({ ...good(), provenance: { doctrine: '/audit', invocation: 'run-1:security' } }),
    ['finding-provenance'],
  );
  assert.deepEqual(rules({ ...good(), provenance: null }), ['finding-provenance']);
  assert.deepEqual(
    rules({ ...good(), provenance: { doctrine: '/cso', invocation: '' } }),
    ['finding-provenance'],
  );
});

test('summary and detail are both required', () => {
  assert.deepEqual(rules({ ...good(), summary: '' }), ['finding-summary']);
  assert.deepEqual(rules({ ...good(), detail: '   ' }), ['finding-detail']);
});

test('a non-object answer is rejected once rather than field by field', () => {
  assert.deepEqual(findingViolations('a string').map((v) => v.rule), ['finding-shape']);
  assert.deepEqual(findingViolations([]).map((v) => v.rule), ['finding-shape']);
  assert.deepEqual(findingViolations(null).map((v) => v.rule), ['finding-shape']);
});

test('every violation carries the index of the answer it came from', () => {
  const [v] = findingViolations({ ...good(), summary: '' }, 7);
  assert.equal(v.path, 'finding[7]');
});

test('normalizeFindings reports what it rejected instead of dropping it', () => {
  const broken = good();
  delete broken.evidence;
  const { accepted, rejected } = normalizeFindings([good(), broken, good()]);
  // Mutation killed: filtering the malformed answer out silently, which reports a
  // clean lens and a quiet loss.
  assert.equal(accepted.length, 2);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].index, 1);
  assert.deepEqual(rejected[0].violations.map((v) => v.rule), ['finding-evidence']);
});

test('several faults in one answer are all reported, not just the first', () => {
  const raw = { ...good(), severity: 'nope', summary: '', path: '/abs' };
  // Mutation killed: an early return after the first violation, which turns a
  // triage pass into a game of whack-a-mole.
  assert.deepEqual(rules(raw).sort(), ['finding-path', 'finding-severity', 'finding-summary']);
});

// --- #194 (FORGE-260) / D8: a structured reproduction is a reproduction -------
//
// The refusal this fixes dropped a real critical finding in hunt run B. The
// export-integrity lens answered with `reproduction` as `{command, output}` --
// rerunnable, complete, correct -- and the ingest refused it with
// "a reproduction nobody can rerun is a guess with a better label". That message
// describes dishonesty; the cause was a type. The strictness stays; what changes
// is that a well-formed answer stops being accused of guessing.

test('a structured reproduction is accepted', () => {
  const raw = { ...good(), evidence: 'reproduced', reproduction: { command: 'npm test', output: '1 fail' } };
  assert.deepEqual(rules(raw), []);
});

test('a structured reproduction survives normalization with both keys intact', () => {
  // Carried through rather than stringified at the boundary: a report that
  // renders `[object Object]` is the same loss by a different route.
  const raw = { ...good(), evidence: 'reproduced', reproduction: { command: 'npm test', output: '1 fail' } };
  const result = normalizeFinding(raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.finding.reproduction, { command: 'npm test', output: '1 fail' });
});

test('a string reproduction is still accepted', () => {
  const raw = { ...good(), evidence: 'reproduced', reproduction: 'node --test → 1 fail' };
  assert.deepEqual(rules(raw), []);
});

test('an absent reproduction keeps finding-evidence and its own message', () => {
  // The two rules must stay separate. Absent is a judgement about the finding;
  // wrong-shaped is a judgement about the answer's type, and telling a lens it
  // guessed when it did not is what made the old message untrue.
  const raw = { ...good(), evidence: 'reproduced', reproduction: null };
  assert.deepEqual(rules(raw), ['finding-evidence']);
  const [v] = findingViolations(raw);
  assert.match(v.message, /no reproduction is given/);
});

test('a structured reproduction missing its command is refused for its shape, not for guessing', () => {
  const raw = { ...good(), evidence: 'reproduced', reproduction: { command: '', output: '1 fail' } };
  assert.deepEqual(rules(raw), ['finding-reproduction-shape']);
  const [v] = findingViolations(raw);
  assert.match(v.message, /command/);
  assert.doesNotMatch(v.message, /guess with a better label/,
    'a type error must not be reported as dishonesty -- that message dropped a real critical finding');
});

test('a structured reproduction missing its output is refused for its shape', () => {
  const raw = { ...good(), evidence: 'reproduced', reproduction: { command: 'npm test', output: '' } };
  assert.deepEqual(rules(raw), ['finding-reproduction-shape']);
});

test('a reproduction that is neither a string nor the structured shape is refused for its shape', () => {
  for (const bad of [42, ['npm test'], { cmd: 'npm test' }, { command: 'npm test' }, true]) {
    const raw = { ...good(), evidence: 'reproduced', reproduction: bad };
    assert.deepEqual(rules(raw), ['finding-reproduction-shape'], `accepted ${JSON.stringify(bad)}`);
  }
});

test('a reasoned finding with a structured reproduction still has to choose', () => {
  // The rule that says "reasoned" and a reproduction cannot both be true is
  // unchanged by widening what a reproduction may look like.
  const raw = { ...good(), evidence: 'reasoned', reproduction: { command: 'npm test', output: '1 fail' } };
  assert.deepEqual(rules(raw), ['finding-evidence']);
});
