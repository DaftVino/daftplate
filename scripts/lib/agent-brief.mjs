// The brief an unattended run is given: the ordered steps, the prohibitions, and
// the prompt they are composed into.
//
// Phase 6 of docs/designs/2026-08-27-plan-delegated-fix-loop.md, for
// #193 (FORGE-259). Phase 3 left `prompt` as a caller's string and built the
// machinery around it — `sourceAcceptanceCriteria` fails closed, `buildInvocation`
// puts the prompt last, `recordInvocation` digests it rather than storing it. This
// is the caller, and the string.
//
// **The steps and the prohibitions are data, not prose.** `skills/agent-fixer/SKILL.md`
// states the same sentences for a human and `tests/agent-fixer-skill.test.mjs` pins
// the two together, so a brief edited here and not there fails rather than drifts.
// A skill describing a loop that briefs its runs differently is worse than no
// skill: it is a document a reviewer would believe.
//
// **The prompt may not name the flags ADR 0008 row 1 forbids.**
// `assertInvocationSafe` scans every argv element for them by substring, the
// prompt included, and refuses the invocation — deliberately, because under
// `acceptEdits` a prompt naming the flag is a run asking the agent to pass it. So
// the prohibition against widening the permission mode is written without naming
// what it forbids, and `tests/agent-loop.test.mjs` proves the composed prompt
// survives the guard rather than leaving that to be discovered at the spawn.
import { issueReference } from './publish-run.mjs';

/**
 * What the run does, in order. Step 1 is the one the plan singles out: a run that
 * cannot state what it was asked for does not guess, and `sourceAcceptanceCriteria`
 * has already refused before this brief is ever composed. Restating it here is not
 * redundancy — the machine check settles whether criteria *exist*, and this settles
 * whether the run has *read* them before it starts editing.
 */
export const AGENT_STEPS = [
  'State the acceptance criteria before implementing anything.',
  'Write a test that fails on the base commit for the reason the issue describes, and commit it.',
  'Fix the smallest thing that makes that test pass.',
  'Change as little as you can outside the fix and its test. You cannot run the suite from here, '
    + 'and you are not asked to: after you stop, your committed tests are replayed against the base '
    + 'commit in a separate checkout, and a test you broke is found there rather than by you.',
  'Commit on this run\'s branch every change you want kept, including the test. '
    + 'Work left uncommitted is discarded: nothing reads this worktree afterwards, and the '
    + 'publisher decides by replaying the tests in your commits against the base. '
    + 'Then stop there — push nothing, open nothing, comment nowhere.',
  'Report what could not be done rather than widening the change until it could.',
];

/**
 * What the run may not do. Each is a row of ADR 0008 or a repository rule stated
 * to the party that would otherwise break it, rather than only to the reviewer who
 * would later find that it had.
 */
export const RUN_PROHIBITIONS = [
  'Do not push, do not open a pull request, do not comment on the issue, and never merge or close anything. '
    + 'Publication happens after this process has exited, in a process that holds a credential this one does not.',
  'Do not delete or overwrite anything this run did not create. A stop is not a delete.',
  'Do not work outside the worktree named above. Its path is the whole of the boundary and there is no second directory.',
  'Do not ask for, and do not pass on, a permission mode wider than the one this run was invoked with. '
    + 'An invocation carrying one is refused before the process exists, so asking only wastes the run.',
  'Do not weaken, skip or delete a test to make a suite green. A suite made green that way measures nothing, '
    + 'and the reproduction is the only evidence that decides whether this run publishes at all.',
  'Do not go beyond what the issue asks, and treat its `Out of scope` section as binding. '
    + 'This holds even where you are right: a wider change may be the better engineering and it is still '
    + 'not yours to make here. If you can see the larger fix, report it in your account and make the '
    + 'smaller one — a run that widens its own scope produces work nobody can merge, however good it is.',
  'Do not put anything from this worktree anywhere outside it, by any route — no gist, no paste site, no upload, '
    + 'no request to a service that keeps what it is sent. Output that needs to be read leaves through the branch '
    + 'and the pull request, which a later process opens; there is no faster channel and asking for one is the error.',
];

/** Where the criteria came from, phrased for the run rather than for a log. */
function sourceLine(sourced) {
  if (sourced?.source === 'document') return `\`${sourced.document}\`, named by the issue`;
  return 'the issue body';
}

/**
 * The prompt an unattended run is invoked with.
 *
 * The criteria come first and the steps second, in that order on purpose: the run
 * is told what it is being measured against before it is told how to proceed, so
 * the first instruction it reads is one it can already check itself against.
 *
 * `issueReference` is publish-run.mjs's, imported rather than restated: the issue
 * is named `<short>-<N>` on a Linear-variant repo and `#N` elsewhere (ADR 0014),
 * the Linear key never appears, and one implementation of that rule is enough.
 *
 * It ends at its last substantive line. No attribution footer, no trailer, no
 * session URL — this string reaches `recordInvocation`'s digest and, through the
 * run, the commits a reviewer reads.
 */
export function composePrompt({ issue, branch, worktree, shortName = null, sourced }) {
  const criteria = sourced?.criteria ?? [];
  const title = issue?.title ? `: "${issue.title}"` : '';
  const lines = [
    `You are an unattended fix run on ${issueReference(issue?.number, shortName)}${title}.`,
    '',
    `The git worktree at \`${worktree}\` is yours, on branch \`${branch}\`. Everything`,
    'outside it belongs to somebody else. This run holds no authority to publish and',
    'no credential with which to try.',
    '',
    `## The acceptance criteria, sourced from ${sourceLine(sourced)}`,
    '',
    ...criteria.map((c, i) => `${i + 1}. ${c}`),
    '',
    'Restate these in your own words before you change one line, and say which of',
    'them each commit is for. A criterion you cannot tell whether you have met is one',
    'to report, not one to interpret generously.',
    '',
    '## What this run does, in order',
    '',
    ...AGENT_STEPS.map((s, i) => `${i + 1}. ${s}`),
    '',
    '## What this run may not do',
    '',
    ...RUN_PROHIBITIONS.map((p) => `- ${p}`),
    '',
    'This run is judged on the commits in its worktree and on nothing it says about',
    'them. A pull request opens only if a test in those commits fails on the base',
    'commit, replayed there by a process that does not ask this one what happened.',
  ];
  return `${lines.join('\n')}\n`;
}
