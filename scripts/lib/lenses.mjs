// The five lenses the issue hunters look through, and the shape a finding must
// take to be one. `#194 (FORGE-260)`, Phase 1 of
// docs/designs/2026-08-27-plan-issue-hunters.md.
//
// Two rules govern everything below and neither is negotiable here.
//
// **A lens invokes a doctrine; it does not re-derive one.** Each lens names an
// existing doctrine — /investigate, /review, /audit, /cso, and the guards in
// tests/publish.test.mjs — and its whole job is selection, scoping and
// structuring. A lens that reimplemented /audit's reasoning inline would be a
// worse /audit whose findings trace to nothing anyone reviewed, so `doctrine`
// and `doctrineSource` are required fields and `provenance.doctrine` on every
// finding is checked against them. An unattributed assertion is not a finding.
//
// **Nothing here files anything.** Not in this phase and not from this module.
// Filing arrives in Phase 4 behind a per-lens gate that a run reads and cannot
// write (ADR 0008 row 6), and closing arrives never. PERMITTED_OPERATIONS is the
// enumeration a test asserts over, and it is short on purpose.
import { violation } from './cli.mjs';

/** The only mode any lens is in until Phase 3 measures its precision. It is the
 *  default the runner starts in rather than a flag bolted on later: there is no
 *  other value, so there is no phase in which a lens files because nobody
 *  remembered to switch it off. */
export const MODE_REPORT_ONLY = 'report-only';

/** Everything a hunt run may do. `create-issue` is absent because Phase 4 owns
 *  it; `close-issue` is absent because ADR 0008 row 6 gives it to nobody — file
 *  yes, close never. A test asserts over this list, so widening it is a visible
 *  act rather than a diff nobody reads. */
export const PERMITTED_OPERATIONS = Object.freeze([
  'read-repository',
  'invoke-doctrine',
  'write-report',
]);

/** Named so a test can assert their absence by name rather than by asserting the
 *  absence of everything. These are operations this feature will never perform
 *  in any phase and in any mode, distinct from ones a later phase adds. */
export const NEVER_PERMITTED_OPERATIONS = Object.freeze([
  'close-issue',
  'merge',
  'push-main',
]);

/** ADR 0008 rows 1 and 2. The first two entries are the permission-mode escapes,
 *  which are refused and never downgraded; the third is `--add-dir`, which only
 *  widens a boundary the callee already enforces against the cwd it was given.
 *
 *  Matched as substrings rather than as whole tokens, because the escape also
 *  arrives glued to its flag as `--permission-mode=<escape>`, which a token
 *  comparison waves through.
 *
 *  These three strings appear in this file exactly here and nowhere else — not in
 *  a comment, not in a usage example, not in a disabled branch — and
 *  tests/agent-hunter.test.mjs pins that. A named flag in a comment is a flag
 *  somebody copies. */
export const FORBIDDEN_ARGV_SUBSTRINGS = Object.freeze([
  '--dangerously-skip-permissions',
  'bypassPermissions',
  '--add-dir',
]);

/** ADR 0008 row 1: the only measured mode that is both usable and bounded.
 *  `dontAsk` is not the safer alternative — it cannot write in its own working
 *  directory, so it buys safety by being unable to do the work. Settled there;
 *  restated here so the value has one source. */
export const PERMISSION_MODE = 'acceptEdits';

/** The evidence classes, and the reason this field exists at all. "This fails"
 *  and "this looks like it would fail" are a bug report and a guess. The
 *  distinction is stated, never blurred, and never defaulted — a finding that
 *  omits it is rejected rather than assumed to be reasoned. */
export const EVIDENCE_KINDS = Object.freeze(['reproduced', 'reasoned']);

export const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);

/** The five lenses. They are five because one "find bugs" agent produces mush
 *  and because these five doctrines already exist here asking genuinely
 *  different questions. Every gate downstream is per-lens: a security lens at
 *  90% precision and a correctness lens at 30% are different features and must
 *  not share a switch. */
export const LENSES = Object.freeze([
  {
    id: 'correctness',
    title: 'Correctness',
    doctrine: '/investigate',
    doctrineSource: 'skills/gstack-investigate/SKILL.md (installed, ADR 0002)',
    question: 'Does this do what it claims, and what breaks it?',
    defectClasses: Object.freeze([
      'logic-error',
      'unhandled-error',
      'contract-violation',
      'state-corruption',
      'resource-leak',
    ]),
    scope: 'scripts/**/*.mjs and the behaviour their tests claim',
  },
  {
    id: 'diff-risk',
    title: 'Diff risk',
    doctrine: '/review',
    doctrineSource: 'skills/gstack-review/SKILL.md (installed, ADR 0002)',
    question: 'What did this change put at risk?',
    defectClasses: Object.freeze([
      'regression-risk',
      'missing-test',
      'breaking-change',
      'incomplete-change',
    ]),
    scope: 'the diff between the working branch and its merge base',
  },
  {
    id: 'test-authenticity',
    title: 'Test authenticity',
    doctrine: '/audit',
    doctrineSource: 'skills/audit/SKILL.md',
    question: 'Would this test have caught the bug it claims to cover?',
    defectClasses: Object.freeze([
      'assertion-accepts-mutant',
      'tautological-assertion',
      'unexercised-path',
      'fixture-masks-failure',
    ]),
    scope: 'tests/**/*.test.mjs, read as raw bodies rather than in summary',
  },
  {
    id: 'security',
    title: 'Security',
    doctrine: '/cso',
    doctrineSource: 'skills/gstack-cso/SKILL.md (installed, ADR 0002)',
    question: 'What does this expose, and to whom?',
    defectClasses: Object.freeze([
      'secret-exposure',
      'injection',
      'path-traversal',
      'privilege-excess',
      'destructive-operation',
    ]),
    scope: 'every path that spawns, writes outside a temp root, or reads a credential',
  },
  {
    id: 'export-integrity',
    title: 'Export integrity',
    doctrine: 'tests/publish.test.mjs guards',
    doctrineSource: 'tests/publish.test.mjs',
    question: 'Does the public artifact work for a stranger?',
    defectClasses: Object.freeze([
      'dangling-reference',
      'withheld-dependency',
      'leaked-private-path',
      'stranger-cannot-run',
    ]),
    scope: 'scripts/publish.mjs selection against what the export actually ships',
  },
]);

export const LENS_IDS = Object.freeze(LENSES.map((l) => l.id));

export function lensById(id) {
  return LENSES.find((l) => l.id === id) ?? null;
}

/** Refuses an argv this feature must never produce, at the moment it is built
 *  rather than at the moment it is spawned. AC 9 is asserted over the argv
 *  actually handed out, which is why buildInvocation calls this itself and why
 *  there is no path to an invocation that skipped it. */
export function assertInvocationSafe(invocation) {
  if (invocation.permissionMode !== PERMISSION_MODE) {
    throw new Error(`hunt: permission mode must be ${PERMISSION_MODE} (ADR 0008 row 1), got ${invocation.permissionMode}`);
  }
  if (!invocation.cwd) {
    throw new Error('hunt: an invocation must name its own working directory (ADR 0008 row 2)');
  }
  for (const token of invocation.argv) {
    for (const banned of FORBIDDEN_ARGV_SUBSTRINGS) {
      if (String(token).includes(banned)) {
        throw new Error(`hunt: refusing an invocation carrying ${banned} (ADR 0008 rows 1-2); a request for it is refused, never downgraded`);
      }
    }
  }
  return invocation;
}

/** Refuses a run that claims an operation this feature does not have. Separate
 *  from the argv check because they fail differently: an argv slip is a flag
 *  someone added, and an operation slip is a phase quietly acquiring authority
 *  it was not granted. */
export function assertOperationsPermitted(operations) {
  for (const op of operations) {
    if (!PERMITTED_OPERATIONS.includes(op)) {
      throw new Error(`hunt: operation "${op}" is not permitted in ${MODE_REPORT_ONLY}; permitted are ${PERMITTED_OPERATIONS.join(', ')}`);
    }
  }
  return operations;
}

/** The prompt handed to the doctrine. It says what to look at and what shape to
 *  answer in, and it does not restate the doctrine's own reasoning — that is the
 *  whole point of invoking one. */
export function buildPrompt(lens, { repoRoot, runId }) {
  return [
    `You are the ${lens.title} lens of hunt run ${runId} over the repository at ${repoRoot}.`,
    '',
    `Invoke the ${lens.doctrine} doctrine (${lens.doctrineSource}) and apply it. Do not`,
    'restate or re-derive it: your job is selection, scoping and structuring, not',
    'judgement about what counts as a defect. That judgement belongs to the doctrine.',
    '',
    `Question: ${lens.question}`,
    `Scope: ${lens.scope}`,
    '',
    'Report every finding as one object in a JSON array, with exactly these fields:',
    `  lens              "${lens.id}"`,
    '  path              repository-relative, forward slashes, never absolute',
    '  symbol            the nearest enclosing symbol, or null for a file-level finding',
    `  defectClass       one of: ${lens.defectClasses.join(', ')}`,
    `  severity          one of: ${SEVERITIES.join(', ')}`,
    '  severityReasoning why that severity and not the next one down',
    '  evidence          "reproduced" if you ran it and saw it, "reasoned" if you did not',
    '  reproduction      the exact command and observed output when reproduced; null when reasoned',
    '  summary           one line',
    '  detail            what is wrong and what it costs',
    `  provenance        { "doctrine": "${lens.doctrine}", "invocation": "${runId}:${lens.id}" }`,
    '',
    'The evidence field has no default. If you did not run it, say "reasoned" — a',
    'guess labelled as a reproduction is worse than no finding at all.',
    '',
    'File nothing. Create no issue, in GitHub or in Linear. Comment on nothing.',
    'Close nothing. Open no pull request. Write only your JSON array.',
  ].join('\n');
}

/** The invocation contract for one lens: what a driver must run, under what
 *  authority, in which directory. Built and asserted here so the safety
 *  properties hold over the argv that exists rather than over the argv someone
 *  meant to build. */
export function buildInvocation(lens, { repoRoot, runId }) {
  return assertInvocationSafe({
    lens: lens.id,
    doctrine: lens.doctrine,
    doctrineSource: lens.doctrineSource,
    permissionMode: PERMISSION_MODE,
    cwd: repoRoot,
    argv: ['--permission-mode', PERMISSION_MODE, '--print'],
    prompt: buildPrompt(lens, { repoRoot, runId }),
  });
}

const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * What shape a `reproduction` is, if it is one at all: `'string'`, `'structured'`
 * for a `{command, output}` pair with both non-empty, or a sentence naming what is
 * wrong with it.
 *
 * #194 (FORGE-260) D8. A lens answered with the structured form -- rerunnable,
 * complete, correct -- and the ingest refused it with *"a reproduction nobody can
 * rerun is a guess with a better label"*. That message describes dishonesty and
 * the cause was a type, and it dropped a critical finding in hunt run B.
 *
 * The strictness is unchanged and is worth keeping: across 40 findings in two runs
 * the evidence/reproduction pairing produced zero violations, which is the shape
 * doing its job. What changes is that a well-formed answer stops being accused of
 * guessing, and that a wrong-shaped one is told what was actually wrong.
 */
function reproductionShape(v) {
  if (nonEmptyString(v)) return 'string';
  if (typeof v === 'string') return 'a reproduction was given as an empty string';
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return `a reproduction must be a string or a {command, output} object, got ${JSON.stringify(v)}`;
  }
  const missing = ['command', 'output'].filter((k) => !nonEmptyString(v[k]));
  if (missing.length) {
    return `a structured reproduction needs a non-empty ${missing.join(' and ')}; a command with no output is not something anyone can check`;
  }
  return 'structured';
}

/**
 * Every way a raw lens answer fails to be a finding, reported together rather
 * than one at a time. Returns cli.mjs violations, so a malformed finding reads
 * the same way every other refusal in this repo reads.
 *
 * The four fields the fingerprint will be taken over in Phase 2 — lens, path,
 * symbol, defect class — are all validated here, and `symbol` must be PRESENT
 * even when it is null. A missing key and a deliberate file-level finding are
 * different answers, and a fingerprint that cannot tell them apart hashes two
 * different findings to one.
 */
export function findingViolations(raw, index = 0) {
  const at = `finding[${index}]`;
  const out = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [violation('finding-shape', at, 'not an object')];
  }

  const lens = lensById(raw.lens);
  if (!lens) {
    out.push(violation('finding-lens', at, `unknown lens ${JSON.stringify(raw.lens)}; expected one of ${LENS_IDS.join(', ')}`));
  }

  if (!nonEmptyString(raw.path)) {
    out.push(violation('finding-path', at, 'no path'));
  } else {
    // Separators are normalised once, and then both rules read one string.
    //
    // The escapes rule was `raw.path.split('/')` — a forward-slash-only split on
    // a platform whose separator is `\`. Measured: `../../x.mjs` refused,
    // `..\..\x.mjs` and `scripts\..\..\outside.mjs` ACCEPTED. The guard held
    // against the spelling nobody on this workstation types and waved through the
    // native one. A second `split('\\')` beside the first would fix the symptom
    // and leave two rules that have to be kept in agreement; normalising leaves
    // one rule, so there is nothing to fall out of step with.
    const path = raw.path.replace(/\\/g, '/');
    // A leading separator is the absolute case on both platforms, and it is where
    // a UNC path belongs. `\\srv\share\x.mjs` normalises to `//srv/share/x.mjs`:
    // it contains no `..` and escapes nothing by walking upwards — it names
    // another machine outright, which is the strongest form of "not repo-relative"
    // there is. "is absolute" is the true sentence about it, and it is the one
    // that tells the lens what to send instead; "escapes the repository" would
    // send whoever read the run report looking for a `..` that is not there.
    if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) {
      out.push(violation('finding-path', at, `path ${raw.path} is absolute; findings are repo-relative so they survive a different checkout`));
    } else if (path.split('/').includes('..')) {
      out.push(violation('finding-path', at, `path ${raw.path} escapes the repository`));
    }
  }

  // Presence, not truthiness, and the two failures get separate rules on purpose.
  // "You omitted the field" and "you sent a bad value" want different fixes from
  // whoever is driving the lens, and the run report prints the rule. Collapsing
  // them into one rule would also make the presence check unobservable — the
  // value branch rejects `undefined` on its own — and a check nothing can tell
  // apart from its neighbour is a check no test can hold in place.
  if (!('symbol' in raw)) {
    out.push(violation('finding-symbol-absent', at, 'no symbol field; use null for a file-level finding rather than omitting it'));
  } else if (raw.symbol !== null && !nonEmptyString(raw.symbol)) {
    out.push(violation('finding-symbol', at, 'symbol must be a non-empty string or null'));
  }

  if (lens && !lens.defectClasses.includes(raw.defectClass)) {
    out.push(violation('finding-defect-class', at, `defect class ${JSON.stringify(raw.defectClass)} is not one the ${lens.id} lens declares (${lens.defectClasses.join(', ')})`));
  }

  if (!SEVERITIES.includes(raw.severity)) {
    out.push(violation('finding-severity', at, `severity ${JSON.stringify(raw.severity)} is not one of ${SEVERITIES.join(', ')}`));
  }
  if (!nonEmptyString(raw.severityReasoning)) {
    out.push(violation('finding-severity', at, 'severity carries no reasoning; the label alone is not a judgement anyone can check'));
  }

  // The field that must not be optional. No default, no coercion: an omitted
  // evidence field is a rejection, because defaulting it would silently turn
  // every guess into a bug report.
  if (!EVIDENCE_KINDS.includes(raw.evidence)) {
    out.push(violation('finding-evidence', at, `evidence must be exactly "reproduced" or "reasoned", got ${JSON.stringify(raw.evidence)}; it has no default`));
  } else if (raw.evidence === 'reproduced' && raw.reproduction == null) {
    // Absent. This is a judgement about the FINDING, and the message is right.
    out.push(violation('finding-evidence', at, 'evidence is "reproduced" but no reproduction is given; a reproduction nobody can rerun is a guess with a better label'));
  } else if (raw.evidence === 'reproduced' && reproductionShape(raw.reproduction) !== 'string'
    && reproductionShape(raw.reproduction) !== 'structured') {
    // Present but wrong-shaped. A separate rule, because this is a judgement
    // about the answer's TYPE and saying the lens guessed would be untrue.
    out.push(violation('finding-reproduction-shape', at, reproductionShape(raw.reproduction)));
  } else if (raw.evidence === 'reasoned' && raw.reproduction != null) {
    out.push(violation('finding-evidence', at, 'evidence is "reasoned" but a reproduction is attached; choose one'));
  }

  if (!nonEmptyString(raw.summary)) out.push(violation('finding-summary', at, 'no summary'));
  if (!nonEmptyString(raw.detail)) out.push(violation('finding-detail', at, 'no detail'));

  // Provenance is what separates a finding from an unattributed assertion. A
  // lens that answers with someone else's doctrine, or with none, is reporting
  // reasoning nobody reviewed.
  const prov = raw.provenance;
  if (prov === null || typeof prov !== 'object') {
    out.push(violation('finding-provenance', at, 'no provenance; a finding with no doctrine behind it is an unattributed assertion'));
  } else {
    if (lens && prov.doctrine !== lens.doctrine) {
      out.push(violation('finding-provenance', at, `provenance names doctrine ${JSON.stringify(prov.doctrine)} but the ${lens.id} lens invokes ${lens.doctrine}`));
    }
    if (!nonEmptyString(prov.invocation)) {
      out.push(violation('finding-provenance', at, 'provenance names no invocation'));
    }
  }

  return out;
}

/** A raw lens answer, accepted or refused. Nothing is repaired on the way
 *  through: a finding that does not validate is rejected with its violations,
 *  never coerced into one that does. */
export function normalizeFinding(raw, index = 0) {
  const violations = findingViolations(raw, index);
  if (violations.length) return { ok: false, violations, raw };
  return {
    ok: true,
    violations: [],
    finding: {
      lens: raw.lens,
      path: raw.path,
      symbol: raw.symbol,
      defectClass: raw.defectClass,
      severity: raw.severity,
      severityReasoning: raw.severityReasoning,
      evidence: raw.evidence,
      reproduction: raw.evidence === 'reproduced' ? raw.reproduction : null,
      summary: raw.summary,
      detail: raw.detail,
      provenance: { doctrine: raw.provenance.doctrine, invocation: raw.provenance.invocation },
    },
  };
}

/** Normalize a whole lens answer. Accepted and rejected are both returned:
 *  a run that silently dropped its malformed findings would report a clean lens
 *  and a quiet loss, which is the failure mode this repo refuses elsewhere. */
export function normalizeFindings(raws) {
  const accepted = [];
  const rejected = [];
  raws.forEach((raw, i) => {
    const result = normalizeFinding(raw, i);
    if (result.ok) accepted.push(result.finding);
    else rejected.push({ index: i, violations: result.violations, raw });
  });
  return { accepted, rejected };
}
