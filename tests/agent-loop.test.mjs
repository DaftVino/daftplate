// The loop wired end to end: claim, brief, invoke, publish, record, reap.
//
// Phase 6 of #193 (FORGE-259). Phases 2 to 5 each built one step and left the next
// uncalled, so `recordInvocation`, `closeRunRecord` and `stopSettingsArgs` had no
// caller until this one. What is measured here is the wiring — that each step is
// handed what the step before it produced, and that a run's own record afterwards
// says what really happened rather than what the run claimed.
//
// **Three seams are injected and each is named rather than assumed.**
//
// 1. `spawn` — the agent. A real headless `claude` cannot be invoked here: the
//    feature is gated shut (ADR 0008, *Consequences*), and invoking one would be
//    the enabling act this phase must not perform. The stand-in writes a failing
//    test into the worktree and commits it, which is the only artifact the rest of
//    the loop reads.
// 2. `lsRemote` — the isolation probe. Phase 1 measured the real refusal against a
//    private remote; a local bare repository answers every reader, so a live call
//    here would prove anonymity rather than isolation, which `verifyIsolation`
//    already refuses to certify. The seam models P2's measured outcome and the
//    real classifier decides what it means.
// 3. `gh` — every outbound GitHub call. A pull request opened against a real
//    remote cannot be withdrawn without a residue this machine's token can no
//    longer clear (ADR 0008 row 7), so it is asserted at the seam. `git push` is
//    NOT a seam: it goes to a bare repository this file created, with genuine push
//    semantics and the real pre-push hook.
//
// The one thing this file cannot demonstrate is the journey — a real issue,
// delegated on the board, producing a reviewed pull request. Two owner-held acts
// stand in the way and neither is a code change: the `Delegated` workflow state
// does not exist in the FORGE team, and ADR 0008's second enablement condition is
// open. `journey-accepted` is therefore NOT reached by this phase, and the gate
// test below is what stops that from being quietly forgotten.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { emptyDir, makeRepo } from './helpers/make-repo.mjs';
import { installBranchNameHook } from '../scripts/setup-repo.mjs';
import {
  runLoop, enablementRefusal, newRunId, main, readClaim, claimPath,
  ENABLEMENT_CONDITIONS, LOOP_REFUSALS,
} from '../scripts/agent-fixer.mjs';
import { AGENT_STEPS, RUN_PROHIBITIONS, composePrompt } from '../scripts/lib/agent-brief.mjs';
import { buildInvocation, PERMISSION_MODE, FORBIDDEN_FLAGS, FORBIDDEN_MODES } from '../scripts/lib/agent-invoke.mjs';
import { ATTRIBUTION_TELLS } from '../scripts/lib/publish-run.mjs';
import { OUTCOME_REPORTED } from '../scripts/lib/worktree.mjs';
import { readRunRecord, requestStop, settingsPath, RUN_STATES } from '../scripts/lib/run-record.mjs';
import { bodyPath } from '../scripts/lib/publish-run.mjs';
import { containedIn } from '../scripts/lib/worktree.mjs';

// stderr is dropped: git narrates CRLF conversion on every add in these fixtures,
// and that noise would bury a real failure in the suite's output.
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const ISSUE = {
  number: 5,
  title: 'the thing breaks on save',
  body: [
    'Saving a record throws.',
    '',
    '## Acceptance criteria',
    '',
    '- saving a record does not throw',
    '- the existing suite stays green',
    '',
  ].join('\n'),
};

const VAGUE_ISSUE = { number: 6, title: 'it is broken', body: 'It is broken. Please fix it.\n' };

const FAILING_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('saving a record does not throw', () => { assert.equal(1, 2, 'saving throws'); });",
  '',
].join('\n');

/** A committed fixture repository with the pre-push hook the real push exercises. */
function fixtureRepo(files = { 'README.md': '# fixture\n' }) {
  const root = makeRepo(files);
  git(['init', '--initial-branch=main', root]);
  git(['config', 'user.email', 'test@example.invalid'], root);
  git(['config', 'user.name', 'Test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  git(['add', '-A'], root);
  git(['commit', '-m', 'first'], root);
  installBranchNameHook(root);
  return root;
}

/** A local bare repository standing in for the remote. */
function bareRemote(repoRoot, name = 'origin') {
  const bare = emptyDir();
  git(['init', '--bare', bare]);
  git(['remote', 'add', name, bare], repoRoot);
  return bare;
}

// Phase 2: every run-scoped path is per-agent now, and omitting the agent throws
// rather than falling back to the flat layout both agents used to share.
const runsFor = (agent = 'fixer') => ({ runsDir: emptyDir(), agent });

/** The gate, opened for a fixture. Not a boolean parameter on `runLoop`: a mode a
 *  caller can choose is a mode a caller can choose wrong, and this seam says in
 *  its own return value why it is being opened. */
const fixtureGate = () => ({
  ok: true,
  why: 'a fixture repository, a bare remote this process created, and an injected agent — no act reaches GitHub',
});

/** An agent that writes the files it was going to write and commits them. */
function agentWriting(files, said = 'done') {
  const calls = [];
  return {
    calls,
    spawn: (command, args, options) => {
      calls.push({ command, args: [...args], cwd: options.cwd, env: options.env });
      for (const [rel, contents] of Object.entries(files)) {
        const target = join(options.cwd, rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents, 'utf8');
      }
      git(['add', '-A'], options.cwd);
      git(['commit', '-m', "the run's work"], options.cwd);
      return { status: 0, stdout: said, stderr: '' };
    },
  };
}

/** P2's measured outcome: the ambient environment authenticates, the isolated one
 *  is refused with the exact refusal `git` produces when prompts are disabled. */
const measuredIsolation = (useEnv) => (useEnv?.GIT_CONFIG_GLOBAL
  ? { status: 128, stdout: '', stderr: 'fatal: could not read Username for \'https://github.com\': terminal prompts disabled' }
  : { status: 0, stdout: 'aaaa\trefs/heads/main\n', stderr: '' });

/** The `gh` half of the same probe, added by `#304 (FORGE-350)`.
 *  `verifyIsolation` runs both halves now, and seaming one of them leaves the
 *  other shelling out — which on a machine with no ambient `gh` login refuses
 *  every run in this file for a reason none of them is about. Measured on `gh`
 *  2.96.0: a redirected GH_CONFIG_DIR answers `You are not logged into any
 *  GitHub hosts`, and the ambient configuration answers `Logged in to
 *  github.com`. */
const measuredGhIsolation = (useEnv) => (useEnv?.GH_CONFIG_DIR
  ? { status: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' }
  : { status: 0, stdout: 'github.com\n  Logged in to github.com account DaftVino\n', stderr: '' });

/** A recording `gh` seam that fails loudly on anything unexpected. */
function ghRecorder(result = { status: 0, stdout: 'https://example.invalid/pr/1', stderr: '' }) {
  const calls = [];
  return { calls, gh: (args, cwd) => { calls.push({ args: [...args], cwd }); return result; } };
}

// ===========================================================================
// The brief
// ===========================================================================

test('the prompt states the acceptance criteria before it states a single step', () => {
  // Mutation killed: moving the criteria under the steps, or dropping them into a
  // trailing appendix. Step 1 asks the run to state what it was asked for, and a
  // brief that gives the instruction before the content makes that unanswerable.
  const prompt = composePrompt({
    issue: ISSUE, branch: 'fix/5-the-thing', worktree: 'X:/w',
    sourced: { ok: true, source: 'issue-body', criteria: ['saving a record does not throw'] },
  });

  assert.ok(prompt.indexOf('saving a record does not throw') < prompt.indexOf(AGENT_STEPS[0]));
  assert.match(prompt, /## The acceptance criteria, sourced from the issue body/);
  assert.equal(AGENT_STEPS[0], 'State the acceptance criteria before implementing anything.');
});

test('the prompt names the issue in the repo\'s form and never computes a Linear key', () => {
  // ADR 0014: `<short>-<N>` on a Linear-variant repo, `#N` elsewhere.
  const linear = composePrompt({
    issue: ISSUE, branch: 'b', worktree: 'w', shortName: 'daftplate', sourced: { ok: true, criteria: ['a'] },
  });
  const other = composePrompt({ issue: ISSUE, branch: 'b', worktree: 'w', sourced: { ok: true, criteria: ['a'] } });

  assert.match(linear, /fix run on daftplate-5:/);
  assert.match(other, /fix run on #5:/);
  // Neither carries a Linear key: under ADR 0014 it never appears in prose, and
  // a key derived from the GitHub number names somebody else's issue.
  assert.doesNotMatch(linear, /FORGE-/);
  assert.doesNotMatch(other, /FORGE-|daftplate-/);
});

test('a run on a Linear-variant repo names the issue from the repo\'s own Board: line', () => {
  // Through the whole loop, and asserted on the comment a human reads. runLoop
  // takes no identifier parameter: the form is a fact about the repo (ADR 0014),
  // so nothing a caller passes can put a Linear key back into the prose.
  const repo = fixtureRepo({
    'README.md': '# fixture\n',
    'ROADMAP.md': 'Board: issues are created in GitHub and managed in Linear (ADR 0006) — the\n'
      + '[daftplate](https://linear.app/x/project/daftplate-1) project, team `FORGE`.\n',
  });
  const io = runsFor();
  bareRemote(repo);
  const rec = ghRecorder({ status: 0, stdout: '', stderr: '' });
  const result = runLoop({ repoRoot: repo, issue: VAGUE_ISSUE, linearKey: 'FORGE-260' }, {
    ...io, runId: newRunId('fixer', 7), gate: fixtureGate, lsRemote: measuredIsolation,
    ghAuth: measuredGhIsolation, gh: rec.gh,
    spawn: () => assert.fail('an agent was invoked for an issue with no acceptance criteria'),
  });
  assert.equal(result.ok, false);
  const args = rec.calls[0].args;
  const body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
  assert.match(body, new RegExp(`for daftplate-${VAGUE_ISSUE.number}\\b`));
  assert.doesNotMatch(body, /FORGE-/, 'a caller-supplied key reached the prose');
});

test('the prompt names a sourcing document when the criteria came from one', () => {
  const prompt = composePrompt({
    issue: ISSUE, branch: 'b', worktree: 'w',
    sourced: { ok: true, source: 'document', document: 'docs/spec.md', criteria: ['a'] },
  });
  assert.match(prompt, /sourced from `docs\/spec\.md`, named by the issue/);
});

test('the composed prompt survives the invocation guard it is passed through', () => {
  // The trap this brief could walk into and would only discover at the spawn:
  // `assertInvocationSafe` scans EVERY argv element for the forbidden flags by
  // substring, the prompt included, because under acceptEdits a prompt naming one
  // is a run being asked to pass it. A brief that spelled out what it forbids
  // would refuse its own invocation. Mutation killed: writing the fourth
  // prohibition as "never pass --dangerously-skip…".
  const prompt = composePrompt({
    issue: ISSUE, branch: 'fix/5-x', worktree: 'X:/w', sourced: { ok: true, criteria: ['a'] },
  });
  for (const needle of [...FORBIDDEN_FLAGS, ...FORBIDDEN_MODES]) {
    assert.equal(prompt.toLowerCase().includes(needle.toLowerCase()), false, `the brief names ${needle}`);
  }
  const built = buildInvocation({ worktree: 'X:/w', prompt, env: {}, extraArgs: [] });
  assert.equal(built.args.at(-1), prompt);
  assert.ok(built.args.includes(PERMISSION_MODE));
});

test('the brief ends at its last substantive line', () => {
  // It reaches the record's digest and, through the run, the commits a reviewer
  // reads. No attribution footer, no trailer, no session URL.
  const prompt = composePrompt({ issue: ISSUE, branch: 'b', worktree: 'w', sourced: { ok: true, criteria: ['a'] } });
  for (const tell of ATTRIBUTION_TELLS) {
    assert.equal(prompt.toLowerCase().includes(tell.toLowerCase()), false, `the brief carries ${tell}`);
  }
});

test('the brief does not ask the run to run a suite it cannot run', () => {
  // `#321 (FORGE-359)`. Step 4 read *"Run the whole suite, and treat a test that was
  // green and is now red as this run's own failure"* — and `npm test` is refused to
  // an unattended run, measured on 2.1.261. That is the `#317 (FORGE-355)` failure
  // exactly: a brief demanding what the invocation forbids, which a run can only
  // answer by ignoring it or by inventing a result.
  //
  // The suite is not lost. `defaultMeasure` replays the run's committed tests against
  // the base commit in its own checkout, in the runner process — so verification
  // moved to where it always belonged, out of reach of the party being verified.
  const prompt = composePrompt({ issue: ISSUE, branch: 'b', worktree: 'w', sourced: { ok: true, criteria: ['a'] } });
  assert.equal(/Run the whole suite/i.test(prompt), false, 'the brief still demands a suite the run cannot run');
  // And it says who does verify, so a run does not conclude that nothing does.
  assert.match(prompt, /replay|publisher|verified/i, 'the brief never says the work is verified elsewhere');
  assert.equal(AGENT_STEPS.length, 6, 'a step was dropped rather than rewritten');
});

test("the brief forbids exceeding the issue's stated scope", () => {
  // **An unattended run overrode a written scope boundary, and it was right to think
  // it could.** `#312 (FORGE-353)` said, in as many words: *"Any other use of `??` in
  // this file. This is about the one report site, not a sweep."* Run
  // `fixer-312-20260905T062523Z` swept all six sites and gave its reason — *"a rule
  // kept only where the value is made is a rule the next producer does not know
  // about"* — which is a better argument than the instruction it broke.
  //
  // That is the problem, not the diff. `#193 (FORGE-259)`'s own body says *"Never
  // widen its own scope"*, and **no prohibition said so.** The six covered
  // publishing, deleting, leaving the worktree, permission modes, weakening tests and
  // publishing outside it. Step 6 says *"Report what could not be done rather than
  // widening the change until it could"*, which is about widening to make something
  // work — not about an `Out of scope` section the run disagrees with.
  //
  // So the run used judgement where it had been given none, and produced good code
  // that could not be merged. A boundary nobody stated is a boundary nobody broke.
  const prompt = composePrompt({ issue: ISSUE, branch: 'b', worktree: 'w', sourced: { ok: true, criteria: ['a'] } });
  assert.match(prompt, /out of scope/i, 'the brief never mentions the section it must obey');
  // The disagreement case specifically: a run that thinks the boundary is wrong is
  // the case this exists for, and a prohibition that only covers accidental drift
  // would not have stopped the run that prompted it.
  assert.match(prompt, /disagree|even if|better/i,
    'the brief does not say what to do when the run thinks the scope is wrong');
  assert.equal(RUN_PROHIBITIONS.length, 7);
});

test('the brief says that uncommitted work is discarded, where it asks for the commit', () => {
  // **The first real unattended run left a correct, verified fix uncommitted** —
  // `fixer-312-20260905T021218Z`, 2026-09-05. Its test failed on the base commit and
  // passed with its fix, so the only thing between it and a draft pull request was a
  // `git commit` nothing had told it to make.
  //
  // Step 5 read `Commit on this run's branch, and stop there — push nothing, open
  // nothing, comment nowhere`: one imperative followed by three prohibitions, in the
  // order that makes an over-cautious run stop early. And an unattended run has every
  // reason to be over-cautious, because the rest of its brief is a list of things it
  // must not touch.
  //
  // The consequence belongs in the step rather than in a seventh prohibition. Leaving
  // work uncommitted is not a thing the run may not do; committing is the thing the
  // run is for.
  const prompt = composePrompt({ issue: ISSUE, branch: 'b', worktree: 'w', sourced: { ok: true, criteria: ['a'] } });
  assert.match(prompt, /uncommitted/i, 'the brief never mentions work left uncommitted');
  // Asserted through the render, and on the consequence rather than the word: a run
  // needs to know the work is *lost*, not merely that the word appears somewhere.
  assert.match(prompt, /nothing reads|is discarded|never read/i,
    'the brief mentions uncommitted work without saying what happens to it');

  // Still six steps. This sharpens one rather than adding another.
  assert.equal(AGENT_STEPS.length, 6);
});

test('the brief states every prohibition, and each one says what it protects', () => {
  const prompt = composePrompt({ issue: ISSUE, branch: 'b', worktree: 'w', sourced: { ok: true, criteria: ['a'] } });
  assert.equal(RUN_PROHIBITIONS.length, 7);
  for (const rule of RUN_PROHIBITIONS) {
    assert.ok(prompt.includes(rule), `the brief drops: ${rule.slice(0, 40)}…`);
    // Mutation killed: a prohibition reduced to an imperative with no reason. A
    // run told only "do not push" routes around it; one told why does not.
    assert.ok(rule.length > 80, `too short to carry its reason: ${rule}`);
  }
});

// ===========================================================================
// The gate — ADR 0008, Consequences
// ===========================================================================

test('the loop refuses to run at all, and names which condition is still open', () => {
  // **Both ADR 0008 conditions closed on 2026-09-04** — the second by the owner's
  // own act on their own credential, recorded in
  // `results-2026-09-04-ambient-narrowing.md` and argued in ADR 0011. So the reason
  // this loop still refuses has changed, and the assertion changes with it rather
  // than being dropped along with the condition that used to carry it.
  //
  // What used to protect this was "a condition is open". What protects it now is
  // the owner's switch, and that is the whole of it — which makes this assertion
  // more load-bearing than before, not less. The mutant it kills is no longer
  // flipping `closed`; it is a gate that reads the conditions and forgets to read
  // `enabled`, which is exactly the disagreement `runAuthorization` was written to
  // end: three surfaces answered this and the two that said yes were the two an
  // owner acts on.
  //
  // `homeDir` is injected for the same reason the seam exists at all: this asserted
  // `enabled === false` by reading the operator's own home, which is a fact about
  // their machine and not about this code. It began failing when the fixer was
  // switched on — correctly, and for the wrong reason.
  const refused = enablementRefusal({ agentId: 'fixer', homeDir: emptyDir() });

  assert.equal(refused.ok, false);
  assert.equal(refused.reason, LOOP_REFUSALS.ENABLEMENT_GATE);
  assert.equal(refused.enabled, false, 'an agent with no state file is not on');
  assert.equal(ENABLEMENT_CONDITIONS.length, 2);
  assert.equal(refused.outstanding.length, 0, 'both conditions are closed as of ADR 0011');
  assert.match(refused.message, /the agent is off/);

  // The other half of this — that each closed condition's cited evidence is a file
  // actually on disk — moved to tests/daftplate-checkout.test.mjs. It stats a path
  // under docs/designs/, which the export withholds, so it could only ever be red
  // in a stranger's clone. The behaviour above runs anywhere and stays here.
});

test('runLoop with no gate seam creates nothing at all', () => {
  // Not "returns a refusal" — creates nothing. Every seam that would touch the
  // disk fails the test if it is reached, so a gate checked after the worktree
  // was made would be caught here rather than by reading the function.
  //
  // **The gate is given an off agent rather than inherited from this machine.**
  // Without `homeDir` this read the operator's own `~/.daftplate/`, so the test
  // asserted a refusal only while nobody had switched the fixer on — and started
  // failing the day somebody did. A test whose verdict turns on the machine it runs
  // on is testing the machine.
  const repo = fixtureRepo();
  const result = runLoop({ repoRoot: repo, issue: ISSUE }, {
    ...runsFor(),
    gate: () => enablementRefusal({ agentId: 'fixer', homeDir: emptyDir() }),
    git: () => assert.fail('the gate let a git call through'),
    spawn: () => assert.fail('the gate let an agent be invoked'),
    gh: () => assert.fail('the gate let an outbound call through'),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, LOOP_REFUSALS.ENABLEMENT_GATE);
  assert.equal(result.published, false);
});

test('--run is refused by the same gate, and claims nothing on the way', () => {
  const repo = fixtureRepo();
  const io = runsFor();
  const code = main(['node', 'agent-fixer.mjs', repo, `--runs-dir=${io.runsDir}`, '--run=5']);

  assert.equal(code, 1);
  assert.equal(readClaim(repo, 5, io), null);
  assert.equal(existsSync(claimPath(repo, 5, io)), false);
});

// ===========================================================================
// The loop, end to end
// ===========================================================================

test('a run with a reproduction claims, is briefed, publishes and is reaped', () => {
  const repo = fixtureRepo();
  const io = runsFor();
  const remote = bareRemote(repo);
  const agent = agentWriting({ 'tests/save.test.mjs': FAILING_TEST });
  const rec = ghRecorder();
  const runId = newRunId('fixer', 5);

  const result = runLoop({ repoRoot: repo, issue: ISSUE }, {
    ...io, runId, gate: fixtureGate, spawn: agent.spawn, lsRemote: measuredIsolation,
    ghAuth: measuredGhIsolation, gh: rec.gh,
  });

  assert.equal(result.ok, true, JSON.stringify({ reason: result.reason, publish: result.publish?.reason }, null, 2));
  assert.equal(result.published, true);
  assert.equal(result.branch, 'fix/5-the-thing-breaks-on-save');

  // The claim was taken and — deliberately — still stands. Claims do not expire
  // and nothing clears one automatically; `--release` is the act by a human who
  // has looked at what the run left.
  assert.equal(readClaim(repo, 5, io).runId, runId);

  // The push was real. The branch is on the bare remote at the run's tip.
  assert.equal(git(['rev-parse', `refs/heads/${result.branch}`], remote).trim(), result.publish.commit);

  // Exactly one outbound call, and it is the draft pull request.
  assert.equal(rec.calls.length, 1);
  assert.deepEqual(rec.calls[0].args.slice(0, 2), ['pr', 'create']);
  assert.ok(rec.calls[0].args.includes('--draft'));

  // The worktree was created by this process, reached a terminal state clean at
  // the published commit, and so was reaped.
  assert.equal(result.reaped.ok, true, JSON.stringify(result.reaped));
  assert.equal(existsSync(result.worktree), false);
});

test('the record afterwards names what ran, under what authority, and what was published', () => {
  // Row 9, measured rather than described: the record is written by the runner
  // from the publisher's verdict, never from the agent's self-report.
  const repo = fixtureRepo();
  const io = runsFor();
  bareRemote(repo);
  const agent = agentWriting({ 'tests/save.test.mjs': FAILING_TEST });
  const rec = ghRecorder();
  const runId = newRunId('fixer', 5);

  const result = runLoop({ repoRoot: repo, issue: ISSUE }, {
    ...io, runId, gate: fixtureGate, spawn: agent.spawn, lsRemote: measuredIsolation,
    ghAuth: measuredGhIsolation, gh: rec.gh,
  });
  assert.equal(result.ok, true, result.reason ?? '');

  const record = readRunRecord(repo, runId, io);
  assert.equal(record.state, RUN_STATES.PUBLISHED);
  assert.equal(record.published.pr, 'https://example.invalid/pr/1');
  assert.equal(record.published.commit, result.publish.commit);
  assert.equal(record.tested.reproduction, true);
  assert.deepEqual(record.changed.files, ['tests/save.test.mjs']);

  // `recordInvocation` was called with the argv really handed to the spawn, and
  // the record keeps the argv in full because that is where every ADR 0008 row 1
  // and row 2 flag would be.
  // Everything the spawn was handed except the prompt, which is dropped by VALUE
  // rather than by position — so the record would still exclude it the day
  // `buildInvocation` stops putting it last.
  assert.deepEqual(record.ran.argv, agent.calls[0].args.slice(0, -1));
  assert.equal(record.ran.command, 'claude');
  assert.ok(record.ran.argv.includes('--permission-mode'));
  assert.ok(record.ran.argv.includes(PERMISSION_MODE));
  assert.equal(record.ran.argv.includes('--add-dir'), false);
  assert.equal(record.ran.status, 0);

  // The prompt is digested, not stored — and the digest is of the brief this
  // phase composes, which is what ties the record to the instructions.
  const expected = composePrompt({
    issue: ISSUE, branch: result.branch, worktree: result.worktree,
    sourced: { ok: true, source: 'issue-body', criteria: ['saving a record does not throw', 'the existing suite stays green'] },
  });
  assert.equal(record.ran.prompt.sha256, createHash('sha256').update(expected).digest('hex'));
});

test('the run carries its own stop settings, and the hook is the runner\'s copy', () => {
  // `stopSettingsArgs` had no caller until this phase. Wiring it is what closes
  // the only window the runner-side poll cannot reach — the whole duration of the
  // agent process — so the assertion is over the argv actually spawned.
  const repo = fixtureRepo();
  const io = runsFor();
  bareRemote(repo);
  const agent = agentWriting({ 'tests/save.test.mjs': FAILING_TEST });
  const runId = newRunId('fixer', 5);

  const result = runLoop({ repoRoot: repo, issue: ISSUE }, {
    ...io, runId, gate: fixtureGate, spawn: agent.spawn, lsRemote: measuredIsolation,
    ghAuth: measuredGhIsolation, gh: ghRecorder().gh,
  });
  assert.equal(result.ok, true, result.reason ?? '');

  const argv = agent.calls[0].args;
  const at = argv.indexOf('--settings');
  assert.notEqual(at, -1, 'the invocation carries no --settings file');
  assert.equal(argv[at + 1], settingsPath(repo, runId, io));

  // The settings file names this run's stop request and the runner's own copy of
  // the hook. A hook read from inside the worktree would be a stop the run could
  // edit away, since acceptEdits writes freely within cwd.
  const settings = JSON.parse(readFileSync(argv[at + 1], 'utf8'));
  const command = settings.hooks.PreToolUse[0].hooks[0].command;
  assert.match(command, /run-stop-hook\.mjs/);
  assert.match(command, new RegExp(runId));
  assert.equal(command.includes(result.worktree), false, 'the hook was read from inside the agent\'s write boundary');
});

test('the run is launched denied the gist gesture, in the one settings file it already carries', () => {
  // `#205 (FORGE-266)` AC 3. **Defence in depth against the accidental path, and
  // never a boundary** — the same claim ADR 0008 makes when it rejects tool
  // allowlists, and it applies to a denylist unchanged. The publication is still
  // reachable through `curl`, through a script the run writes and then runs,
  // through `git` against `gist.github.com`, or through any of them shaped so the
  // prefix does not match. What this bounds is the typed gesture: a run told to
  // *share the failing output* reaches for `gh gist create` because that is the
  // one-command way to do it, and that is the shape intercepted here.
  //
  // Asserted through the file the invocation actually names rather than through
  // `buildStopSettings`' return value, because the settings only bind the session
  // if they reach it — and through the argv rather than the composition, because
  // a second `--settings` flag would silently replace the first.
  const repo = fixtureRepo();
  const io = runsFor();
  bareRemote(repo);
  const agent = agentWriting({ 'tests/save.test.mjs': FAILING_TEST });
  const runId = newRunId('fixer', 9);

  const result = runLoop({ repoRoot: repo, issue: ISSUE }, {
    ...io, runId, gate: fixtureGate, spawn: agent.spawn, lsRemote: measuredIsolation,
    ghAuth: measuredGhIsolation, gh: ghRecorder().gh,
  });
  assert.equal(result.ok, true, result.reason ?? '');

  const argv = agent.calls[0].args;
  assert.equal(argv.filter((a) => a === '--settings').length, 1, 'a run carries more than one --settings flag');
  const settings = JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8'));

  const deny = settings.permissions?.deny ?? [];
  for (const rule of ['Bash(gh gist:*)', 'Bash(gh api gists:*)', 'Bash(gh api /gists:*)']) {
    assert.ok(deny.includes(rule), `the run is not denied ${rule}`);
  }

  // The deny list composes into the file the stop hook already lives in rather
  // than displacing it. Both halves reaching the session is the whole point of
  // composing rather than adding a second flag.
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command.includes('run-stop-hook.mjs'), true);
});

test('a stop standing before the agent is invoked stops the run and removes nothing', () => {
  const repo = fixtureRepo();
  const io = runsFor();
  const runId = newRunId('fixer', 5);
  requestStop({ repoRoot: repo, runId, issue: 5, reason: 'the board changed its mind' }, io);

  const result = runLoop({ repoRoot: repo, issue: ISSUE }, {
    ...io, runId, gate: fixtureGate, lsRemote: measuredIsolation,
    ghAuth: measuredGhIsolation,
    spawn: () => assert.fail('an agent was invoked after a stop was requested'),
    gh: () => assert.fail('a stopped run reached an outbound call'),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, LOOP_REFUSALS.STOPPED);
  assert.equal(result.published, false);

  // A stop is not a delete. The worktree stands and the claim stands; both are
  // reported and cleared deliberately or not at all (CLAUDE.md #5).
  assert.equal(existsSync(result.worktree), true);
  assert.equal(readClaim(repo, 5, io).runId, runId);
  assert.equal(readRunRecord(repo, runId, io).state, RUN_STATES.STOPPED);
});

test('an underspecified issue files a comment, pushes nothing and records no argv', () => {
  // AC 3 through the whole loop rather than at one function. The refusal is
  // Phase 3's, the comment is Phase 4's, and what this proves is that the wiring
  // between them never reads `branch` optimistically on the way.
  const repo = fixtureRepo();
  const io = runsFor();
  const remote = bareRemote(repo);
  const rec = ghRecorder({ status: 0, stdout: '', stderr: '' });
  const runId = newRunId('fixer', 6);

  const result = runLoop({ repoRoot: repo, issue: VAGUE_ISSUE }, {
    ...io, runId, gate: fixtureGate, lsRemote: measuredIsolation,
    ghAuth: measuredGhIsolation, gh: rec.gh,
    spawn: () => assert.fail('an agent was invoked for an issue with no acceptance criteria'),
  });

  assert.equal(result.ok, false);
  assert.equal(result.invoked, false);
  assert.equal(result.published, false);

  // One comment, no pull request, and nothing reached the remote.
  assert.equal(rec.calls.length, 1);
  assert.deepEqual(rec.calls[0].args.slice(0, 2), ['issue', 'comment']);
  assert.equal(git(['for-each-ref', '--format=%(refname)', 'refs/heads'], remote).trim(), '');

  // `recordInvocation` is called only when something was invoked. A record
  // claiming an argv for a run that never spawned would be the record lying about
  // the one thing it exists to answer.
  const record = readRunRecord(repo, runId, io);
  assert.equal(record.ran.argv, null);
  assert.equal(record.ran.command, null);
  assert.equal(record.ran.prompt, null);
  // `null`, not `false`. Nothing was measured, because the run was refused before
  // it could produce anything to measure — and a record that answered "no
  // reproduction" would be reporting a verdict it never reached. Everything
  // unknown stays present and null so an auditor sees which answers were never
  // filled in.
  assert.equal(record.tested.reproduction, null);
  assert.equal(record.state, RUN_STATES.REPORTED);
  assert.equal(record.published.comment !== null, true);
});

test('a run that reports releases its claim, so the issue can be delegated again', () => {
  // **The refusal tells the operator to delegate again, and the ledger made that
  // impossible.** Measured on the first real delegation: a run refused
  // `no-issue-body`, filed a comment saying *"Add an `## Acceptance criteria`
  // section ... and delegate it again"*, reaped its worktree, closed its record —
  // and left `claims/312.json` standing. Every later `--run` answered
  // `already-claimed` on behalf of a run that had ended.
  //
  // Claims not expiring is deliberate: it is what stops two runs on one issue. A
  // claim outliving the run that took it is a different thing — a lock with no
  // holder — and the worktree being gone is what makes it unambiguous.
  const repo = fixtureRepo();
  const io = runsFor();
  bareRemote(repo);
  const runId = newRunId('fixer', 21);

  const result = runLoop({ repoRoot: repo, issue: VAGUE_ISSUE }, {
    ...io, runId, gate: fixtureGate, lsRemote: measuredIsolation,
    ghAuth: measuredGhIsolation, gh: ghRecorder().gh,
    spawn: () => assert.fail('an agent was invoked for an issue with no acceptance criteria'),
  });

  assert.equal(result.published, false);
  assert.equal(result.outcome, OUTCOME_REPORTED);
  assert.equal(readClaim(repo, VAGUE_ISSUE.number, io), null,
    'a reported run left its claim behind, so the issue it asked to be re-delegated cannot be');
});

test('a run that published keeps its claim, because a pull request is standing', () => {
  // The other half, and the reason this is not "always release". A published run
  // leaves a PR open; a second run on the same issue would duplicate it against a
  // branch a human is already reading. The claim is what says so.
  const repo = fixtureRepo();
  const io = runsFor();
  bareRemote(repo);
  const agent = agentWriting({ 'tests/save.test.mjs': FAILING_TEST });
  const runId = newRunId('fixer', 22);

  const result = runLoop({ repoRoot: repo, issue: ISSUE }, {
    ...io, runId, gate: fixtureGate, spawn: agent.spawn, lsRemote: measuredIsolation,
    ghAuth: measuredGhIsolation, gh: ghRecorder().gh,
  });

  assert.equal(result.ok, true, result.reason ?? '');
  assert.equal(result.published, true);
  const held = readClaim(repo, ISSUE.number, io);
  assert.notEqual(held, null, 'a published run released its claim, so a second run could duplicate its PR');
  assert.equal(held.runId, runId);
});

test('the run\'s own account of itself is kept, outside the worktree', () => {
  // **Three consecutive real runs could not be diagnosed** because the one artefact
  // that would have answered *"why did you not commit?"* was thrown away each time.
  // `runGeneration` returns `agent.stdout`; nothing ever wrote it down, so the record
  // held argv, a prompt digest and an exit status — and no account.
  //
  // **Kept as evidence, never as a verdict.** ADR 0008 is emphatic that a run's own
  // account of itself is the thing the publication boundary exists to stop deciding
  // publication, and that is untouched: the publisher still replays committed tests
  // and reads this file never. Retaining it for a human to read afterwards is a
  // different act from trusting it, and the difference is the whole point.
  const repo = fixtureRepo();
  const io = runsFor();
  bareRemote(repo);
  const agent = agentWriting({ 'tests/save.test.mjs': FAILING_TEST }, 'I wrote a test and then stopped.');
  const runId = newRunId('fixer', 31);

  const result = runLoop({ repoRoot: repo, issue: ISSUE }, {
    ...io, runId, gate: fixtureGate, spawn: agent.spawn, lsRemote: measuredIsolation,
    ghAuth: measuredGhIsolation, gh: ghRecorder().gh,
  });
  assert.equal(result.ok, true, result.reason ?? '');

  const kept = bodyPath(repo, runId, 'account', io);
  assert.equal(existsSync(kept), true, 'the run left no account of itself');
  assert.match(readFileSync(kept, 'utf8'), /I wrote a test and then stopped\./);

  // Outside the worktree, for row 9's reason: the checkout is disposable and the
  // account has to outlive it.
  assert.equal(containedIn(result.worktree, kept), false, 'the account lives inside the worktree');

  // And the record names it, so a human finds it without knowing the layout.
  const held = readRunRecord(repo, runId, io);
  assert.equal(held.ran.account, kept);
});

test('the run is launched able to commit its own work, and nothing wider', () => {
  // `#321 (FORGE-359)`. Measured 2026-09-05 on Claude Code 2.1.261
  // (`results-2026-09-05-acceptedits-bash.md`): `acceptEdits` auto-accepts Write and
  // refuses mutating Bash, so five real runs produced complete work and could not
  // commit a line of it. ADR 0008's line 62 — *"acceptEdits auto-accepts Bash"* —
  // was measured against 2.1.247 and is no longer true.
  //
  // **This restores the grant rather than widening it.** Row 3 already permits a run
  // to push its own branch and row 4 to open a pull request; committing inside a
  // disposable worktree is strictly less than either, and the architecture is
  // stricter still — the run pushes nothing, `publish-run.mjs` does, out of process
  // and argv-guarded.
  //
  // **Two commands, and deliberately not the suite.** `npm test` and `node --test`
  // are not granted: the publisher replays the run's committed tests itself, in its
  // own checkout, in the runner process, so the reproduction predicate never depended
  // on the agent executing anything. Granting them would hand arbitrary code
  // execution to a run that has none, and buy nothing publication needs.
  const repo = fixtureRepo();
  const io = runsFor();
  bareRemote(repo);
  const agent = agentWriting({ 'tests/save.test.mjs': FAILING_TEST });
  const runId = newRunId('fixer', 41);

  const result = runLoop({ repoRoot: repo, issue: ISSUE }, {
    ...io, runId, gate: fixtureGate, spawn: agent.spawn, lsRemote: measuredIsolation,
    ghAuth: measuredGhIsolation, gh: ghRecorder().gh,
  });
  assert.equal(result.ok, true, result.reason ?? '');

  const argv = agent.calls[0].args;
  const settings = JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8'));
  assert.deepEqual(settings.permissions.allow, ['Bash(git add:*)', 'Bash(git commit:*)']);

  // Pinned as a whole list, not checked for membership: a third entry appearing here
  // is a widening of what an unattended run may do, and it should fail in a test
  // somebody has to argue with rather than arrive in a helper.
  for (const forbidden of ['npm', 'node', 'gh', 'git push', 'curl']) {
    assert.equal(
      settings.permissions.allow.some((a) => a.includes(forbidden)), false,
      `the run is allowed ${forbidden}, which publication does not need`,
    );
  }
});
