import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import {
  detectBoard, readBoard, pollDelegated, claimIssue, readClaim, releaseClaim,
  claimPath, claimsDir, branchForIssue, freeBranchForIssue, MAX_BRANCH_ATTEMPTS, parseAgentRunArgs, main,
  DELEGATION_LABEL, CLAIM_KIND,
} from '../scripts/agent-fixer.mjs';
import { createWorktree, worktreePath, reapWorktree, OUTCOME_REPORTED } from '../scripts/lib/worktree.mjs';
import { agentStatePath, ENABLEMENT_KIND } from '../scripts/lib/agent-state.mjs';
import { ENABLEMENT_CONDITIONS } from '../scripts/lib/enablement.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

// The two `Board:` lines base/files/ROADMAP.md ships, quoted rather than
// paraphrased: detection reads these exact sentences in every scaffolded repo.
const LINEAR_LINE = 'Board: issues are created in GitHub and managed in Linear (ADR 0006) — the\n'
  + '[daftplate](https://linear.app/x) project, team `FORGE`. GitHub is canonical for\n'
  + 'whether an issue exists; Linear is canonical for its state.';
const PROJECTS_LINE = 'Board: the GitHub Project for this repository. The issue is canonical and the\n'
  + 'project is a view of it; where the two disagree, the issue wins.';

// stderr is dropped: git narrates CRLF conversion on every add in these fixtures,
// and that noise would bury a real failure in the suite's output.
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function repoWithCommit(files = {}) {
  const root = makeRepo(files);
  git(['init', '--initial-branch=main', root]);
  git(['config', 'user.email', 'test@example.invalid'], root);
  git(['config', 'user.name', 'Test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  git(['add', '-A'], root);
  git(['commit', '-m', 'first'], root);
  return root;
}

// Phase 2: every run-scoped path is per-agent now, and omitting the agent throws
// rather than falling back to the flat layout both agents used to share.
const runsFor = (agent = 'fixer') => ({ runsDir: emptyDir(), agent });

// --- trigger detection -----------------------------------------------------

test('the board variant is read from the ROADMAP line and nowhere else', () => {
  assert.equal(detectBoard(LINEAR_LINE).variant, 'linear');
  assert.equal(detectBoard(LINEAR_LINE).team, 'FORGE');
  assert.equal(detectBoard(PROJECTS_LINE).variant, 'github-projects');
});

test('the Linear line is not read as GitHub Projects, though it names GitHub twice', () => {
  // The ordering hazard: the Linear sentence says "GitHub is canonical for whether
  // an issue exists". Testing for a GitHub Project first would match it and poll
  // the wrong board silently.
  assert.match(LINEAR_LINE, /GitHub/);
  assert.equal(detectBoard(LINEAR_LINE).variant, 'linear');
});

test('no line, and two lines, are both refusals rather than guesses', () => {
  assert.equal(detectBoard('# ROADMAP\n\nno declaration here\n').reason, 'no-board-line');
  const two = detectBoard(`${LINEAR_LINE}\n${PROJECTS_LINE}`);
  assert.equal(two.ok, false);
  assert.equal(two.reason, 'ambiguous-board');
  assert.equal(two.count, 2);
});

test('a Board line naming neither variant is refused by name', () => {
  const odd = detectBoard('Board: a whiteboard in the hall.\n');
  assert.equal(odd.ok, false);
  assert.equal(odd.reason, 'unrecognized-board');
});

// `detection agrees with check-roadmap on this repository` moved to
// tests/daftplate-checkout.test.mjs: it reads this repo's own ROADMAP.md, which
// the export withholds, so it arrived red in a stranger's clone.

test('a repo with no ROADMAP declares no variant, and that is said rather than skipped', () => {
  // Where this departs from /continuum §4, which skips in silence. There the board
  // is an enrichment; here it is the trigger, and a silent skip would read as a
  // board with nothing delegated on it.
  assert.equal(readBoard(emptyDir()).reason, 'no-roadmap');
});

// --- the poll --------------------------------------------------------------

test('the GitHub Projects poll asks for open issues carrying the delegation label', () => {
  const seen = [];
  const gh = (args) => {
    seen.push(args);
    if (args[0] === 'label') return { status: 0, stdout: `[{"name":"${DELEGATION_LABEL}"}]`, stderr: '' };
    return { status: 0, stdout: '[{"number":7,"title":"a bug"}]', stderr: '' };
  };
  const polled = pollDelegated(detectBoard(PROJECTS_LINE), { gh });
  assert.deepEqual(polled.issues, [{ number: 7, title: 'a bug' }]);
  // Found by verb rather than by position: the label-existence check now runs
  // first, and an index would have quietly started asserting about that call.
  const list = seen.find((a) => a[0] === 'issue');
  assert.ok(list.includes('--label'));
  assert.ok(list.includes(DELEGATION_LABEL));
  assert.ok(list.includes('--state') && list.includes('open'));
});

test('the Linear variant is polled through the synced label, not refused', () => {
  // **The refusal this replaces was right on the evidence it had and is now
  // wrong.** It reasoned that Linear delegates by a `Delegated` workflow state,
  // that the GitHub Issues Sync does not project a state back onto the issue, and
  // that therefore nothing a `gh` call could read is evidence of a delegation.
  //
  // Measured 2026-08-28 against a Linear-synced repository on this team: a label
  // applied in Linear reaches the GitHub issue in **seconds** — `agent:delegated` on
  // at `13:42:14Z` and off at `13:42:43Z`, with a second label removed and re-added
  // in the same window, which is the sync reconciling the whole label set rather
  // than a hand click. So the gesture crosses, the existing GitHub code path reads
  // it, and no Linear credential is involved at any point. The repository is named
  // in the measurement on `#193 (FORGE-259)` rather than here, because this file
  // ships in the public export.
  //
  // Recorded on `#193 (FORGE-259)` at the time and left unimplemented for six days.
  const seen = [];
  const gh = (args) => {
    seen.push(args);
    if (args[0] === 'label') return { status: 0, stdout: `[{"name":"${DELEGATION_LABEL}"}]`, stderr: '' };
    return { status: 0, stdout: '[{"number":9,"title":"delegated in linear"}]', stderr: '' };
  };
  const polled = pollDelegated(detectBoard(LINEAR_LINE), { gh });
  assert.equal(polled.ok, true, polled.reason ?? '');
  assert.deepEqual(polled.issues, [{ number: 9, title: 'delegated in linear' }]);

  // Through the same argv the Projects variant uses. A second code path reading the
  // same label is a second thing to keep in step, and the whole finding is that one
  // path already suffices.
  const list = seen.find((a) => a[0] === 'issue');
  assert.ok(list.includes('--label') && list.includes(DELEGATION_LABEL));
});

test('a repo without the delegation label says so instead of polling clean forever', () => {
  // `gh issue list --label <nonexistent>` exits **0** with `[]` — byte-identical to
  // "the label exists and nothing is delegated". Without this check a repo missing
  // the label polls clean on every tick and never says why, which is the silent
  // half of the same class as a `continue` guard that skips every case.
  //
  // Not hypothetical: a team-level Linear label does not propagate to every synced
  // repository. Measured 2026-08-28 across five Linear-synced repositories on one
  // team — `agent:delegated` present in two and **absent** from three, appearing
  // per-repo on first use. The repositories are named on `#193 (FORGE-259)`.
  const gh = (args) => {
    if (args[0] === 'label') return { status: 0, stdout: '[]', stderr: '' };
    return assert.fail('the poll asked for issues without first checking the label exists');
  };
  const polled = pollDelegated(detectBoard(LINEAR_LINE), { gh });
  assert.equal(polled.ok, false);
  assert.equal(polled.reason, 'no-delegation-label');
  assert.match(polled.message, new RegExp(DELEGATION_LABEL));
});

test('a label that merely contains the delegation label does not answer for it', () => {
  // `gh label list --search` is a **substring** query, so a repository carrying
  // `agent:delegated-later` and not `agent:delegated` gets a non-empty result for a
  // label it does not have. The check therefore compares names exactly.
  //
  // Written because a mutant survived: loosening `l.name === DELEGATION_LABEL` to
  // `l.name.includes(...)` killed nothing in the whole suite, so the exactness was
  // a claim in a comment and nothing more. The near-miss below is the assertion
  // that makes it real.
  const gh = (args) => {
    if (args[0] === 'label') return { status: 0, stdout: `[{"name":"${DELEGATION_LABEL}-later"}]`, stderr: '' };
    return assert.fail('the poll accepted a near-miss label as the delegation label');
  };
  const polled = pollDelegated(detectBoard(LINEAR_LINE), { gh });
  assert.equal(polled.ok, false);
  assert.equal(polled.reason, 'no-delegation-label');
});

test('a gh that fails silently still names a reason, rather than refusing with nothing', () => {
  // `main` prints `polled.message ?? polled.reason`, and `''` is **not nullish**, so
  // an empty message printed an empty line — a refusal naming nothing at all.
  //
  // Reached when the binary is missing: `spawnSync` reports through `error` and
  // leaves both streams empty. Found by CI on Linux against a suite green on
  // Windows, which is what "a green run on one platform is not evidence about the
  // other" costs when nothing checks it.
  const silent = { status: 1, stdout: '', stderr: '', error: new Error('spawn gh ENOENT') };
  const polled = pollDelegated(detectBoard(LINEAR_LINE), { gh: () => silent });
  assert.equal(polled.reason, 'gh-unavailable');
  assert.ok(polled.message.trim().length > 0, 'the refusal carries no words at all');

  // And with nothing to report from any channel, the reason itself is the words.
  const mute = { status: 1, stdout: '', stderr: '' };
  const second = pollDelegated(detectBoard(LINEAR_LINE), { gh: () => mute });
  assert.equal(second.message, 'gh-unavailable');
});

test('an unavailable or unreadable gh is two different refusals', () => {
  const board = detectBoard(PROJECTS_LINE);
  const down = pollDelegated(board, { gh: () => ({ status: 1, stdout: '', stderr: 'not logged in' }) });
  assert.equal(down.reason, 'gh-unavailable');
  const junk = pollDelegated(board, { gh: () => ({ status: 0, stdout: 'not json', stderr: '' }) });
  assert.equal(junk.reason, 'gh-unreadable');
});

// --- the claim ledger ------------------------------------------------------

test('a second claim on the same issue is refused and names the holder', () => {
  const io = runsFor();
  const first = claimIssue({ repoRoot: 'X:/r', issue: 12, runId: 'run-a' }, io);
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = claimIssue({ repoRoot: 'X:/r', issue: 12, runId: 'run-b' }, io);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already-claimed');
  assert.equal(second.holder.runId, 'run-a');
  // The loser must not have overwritten the winner's file.
  assert.equal(readClaim('X:/r', 12, io).runId, 'run-a');
});

test('the claim records who holds it, so a stuck claim can be looked at', () => {
  // Claims never expire, so the file is the only account of why an issue is
  // blocked. Anything missing here is something an operator cannot find out.
  const io = runsFor();
  claimIssue({ repoRoot: 'X:/r', issue: 3, runId: 'run-x', branch: 'fix/3-a', worktree: 'X:/w' }, io);
  const held = readClaim('X:/r', 3, io);
  assert.equal(held.kind, CLAIM_KIND);
  assert.equal(held.issue, 3);
  assert.equal(held.branch, 'fix/3-a');
  assert.equal(held.worktree, 'X:/w');
  assert.equal(held.pid, process.pid);
  assert.match(held.startedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('nothing expires a claim on its own — only an explicit release drops one', () => {
  const io = runsFor();
  claimIssue({
    repoRoot: 'X:/r', issue: 4, runId: 'run-old', pid: 999_999,
    startedAt: '2020-01-01T00:00:00.000Z',
  }, io);
  // A year-old claim held by a pid that cannot be alive is still a claim.
  assert.equal(claimIssue({ repoRoot: 'X:/r', issue: 4, runId: 'run-new' }, io).reason, 'already-claimed');
  assert.equal(releaseClaim('X:/r', 4, io).ok, true);
  assert.equal(claimIssue({ repoRoot: 'X:/r', issue: 4, runId: 'run-new' }, io).ok, true);
});

test('release refuses a file under claims/ that this ledger cannot prove it wrote', () => {
  const io = runsFor();
  const dir = claimsDir('X:/r', io);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, '5.json');
  writeFileSync(path, JSON.stringify({ issue: 5, runId: 'somebody-else' }));
  const released = releaseClaim('X:/r', 5, io);
  assert.equal(released.ok, false);
  assert.equal(released.reason, 'foreign-file');
  assert.equal(existsSync(path), true, 'a file with no daftplate kind was deleted');
  assert.equal(readClaim('X:/r', 5, io), null);
});

test('releasing a claim nobody holds is a refusal, not a silent success', () => {
  assert.equal(releaseClaim('X:/r', 6, runsFor()).reason, 'no-claim');
});

// --- AC 7 ------------------------------------------------------------------

test('AC 7 — two issues claimed in sequence do not interfere', () => {
  // Real worktrees on disk, because the interference this rules out is two runs
  // sharing a checkout, and a mocked lifecycle cannot share anything.
  const repo = repoWithCommit({ 'README.md': '# r\n' });
  const io = runsFor();

  const runs = [11, 22].map((issue) => {
    const runId = `run-${issue}`;
    const branch = branchForIssue(issue, `issue ${issue}`);
    const tree = createWorktree({ repoRoot: repo, runId, branch }, io);
    assert.equal(tree.ok, true, tree.message);
    const claim = claimIssue({ repoRoot: repo, issue, runId, branch, worktree: tree.path }, io);
    assert.equal(claim.ok, true, JSON.stringify(claim));
    return { issue, runId, branch, tree };
  });

  const [a, b] = runs;
  assert.notEqual(a.tree.path, b.tree.path);
  assert.notEqual(claimPath(repo, a.issue, io), claimPath(repo, b.issue, io));
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], a.tree.path).trim(), a.branch);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], b.tree.path).trim(), b.branch);

  // Work in one is invisible to the other.
  writeFileSync(join(a.tree.path, 'only-in-a.txt'), 'a\n');
  assert.equal(existsSync(join(b.tree.path, 'only-in-a.txt')), false);

  // The first issue's claim does not block the second's, and re-claiming the
  // first does not disturb the second.
  assert.equal(claimIssue({ repoRoot: repo, issue: a.issue, runId: 'run-again' }, io).reason, 'already-claimed');
  assert.equal(readClaim(repo, b.issue, io).runId, b.runId);

  // Finishing the second leaves the first exactly as it was, work included.
  assert.equal(reapWorktree(b.tree.path, { state: OUTCOME_REPORTED }, io).ok, true);
  assert.equal(releaseClaim(repo, b.issue, io).ok, true);
  assert.equal(existsSync(b.tree.path), false);
  assert.equal(existsSync(a.tree.path), true);
  assert.equal(readFileSync(join(a.tree.path, 'only-in-a.txt'), 'utf8'), 'a\n');
  assert.equal(readClaim(repo, a.issue, io).runId, a.runId);
});

// --- branch naming ---------------------------------------------------------

test('the branch a run would push is one the pre-push hook accepts', () => {
  // The literal pattern from setup-repo.mjs's hook. A run that did all its work on
  // a branch the hook refuses has nothing it can publish in Phase 4.
  const HOOK = /^[a-z]+\/[1-9][0-9]*-[a-z0-9]+(-[a-z0-9]+)*$/;
  const cases = [
    [62, 'scaffold dest guard'],
    [193, 'A bug delegated in Linear becomes a worktree, a tested fix and a PR'],
    [7, '   spaces   and --- punctuation!!!   '],
    [8, 'CAPS and 123 numbers'],
    [9, '!!!'],
    [10, ''],
  ];
  for (const [issue, title] of cases) {
    const branch = branchForIssue(issue, title);
    assert.match(branch, HOOK, `${JSON.stringify(title)} produced ${branch}`);
    assert.ok(branch.startsWith(`fix/${issue}-`), branch);
  }
  assert.equal(branchForIssue(9, '!!!'), 'fix/9-issue', 'an unusable title needs a fallback slug');
  assert.equal(branchForIssue(4, 'a b', 'feat'), 'feat/4-a-b');
});

// --- the CLI ---------------------------------------------------------------

test('parseAgentRunArgs reads the four commands and refuses a bad issue number', () => {
  assert.equal(parseAgentRunArgs(['node', 's']).command, 'plan');
  assert.equal(parseAgentRunArgs(['node', 's', '--list']).command, 'list');
  assert.deepEqual(
    (({ command, issue }) => ({ command, issue }))(parseAgentRunArgs(['node', 's', '--claim=12'])),
    { command: 'claim', issue: 12 },
  );
  assert.equal(parseAgentRunArgs(['node', 's', '--release=12']).command, 'release');
  assert.equal(parseAgentRunArgs(['node', 's', 'X:/r']).repoRoot, 'X:/r');
  assert.equal(parseAgentRunArgs(['node', 's', '--runs-dir=X:/runs']).runsDir, 'X:/runs');
  assert.throws(() => parseAgentRunArgs(['node', 's', '--claim=0']), /issue number/);
  assert.throws(() => parseAgentRunArgs(['node', 's', '--claim=abc']), /issue number/);
  assert.throws(() => parseAgentRunArgs(['node', 's', '--publish']), /unknown option/);
});

test('the CLI claims an issue, and refuses to claim it twice', (t) => {
  const repo = repoWithCommit({ 'README.md': '# r\n' });
  const io = runsFor();
  const said = [];
  t.mock.method(console, 'log', (line) => said.push(String(line)));
  t.mock.method(console, 'error', (line) => said.push(String(line)));

  const argv = ['node', 'agent-fixer.mjs', repo, '--claim=31', '--title=a real bug', `--runs-dir=${io.runsDir}`];
  assert.equal(main(argv), 0, said.join('\n'));
  const held = readClaim(repo, 31, io);
  assert.equal(held.branch, 'fix/31-a-real-bug');
  assert.equal(existsSync(held.worktree), true);

  assert.equal(main(argv), 1, 'the second claim succeeded');
  assert.ok(said.some((l) => /already claimed/.test(l)), said.join('\n'));
  assert.equal(readClaim(repo, 31, io).runId, held.runId);
});

test('the CLI never publishes and never invokes an agent in this phase', () => {
  // Asserted over the source, because the guarantee is an absence and an absence
  // has no call site to observe. Phase 3 adds the invocation and Phase 4 the push;
  // until then a match here means one of them arrived early and unreviewed.
  const source = readFileSync(join(REPO, 'scripts/agent-fixer.mjs'), 'utf8');
  for (const forbidden of [
    '--dangerously-skip-permissions',   // ADR 0008 row 1, in any phase
    'bypassPermissions',
    "spawnSync('claude'",               // Phase 3's invocation
    "'pr'",                             // gh pr create — Phase 4's publication
    "'push'",                           // git push — likewise
  ]) {
    assert.equal(source.includes(forbidden), false,
      `scripts/agent-fixer.mjs contains ${forbidden}, which belongs to a later phase`);
  }
  // The one command this phase spawns, and the only argv it builds for it.
  assert.equal(source.match(/spawnSync\(/g).length, 1);
  assert.match(source, /spawnSync\('gh'/);
});

test('a board the plan command could not reach is never reported as an empty one', (t) => {
  // The guard this test was written for, kept verbatim: an unreachable board must
  // not print like a reachable board with nothing on it. Those are opposite facts
  // and merging them tells an operator their queue is clear when it is unread.
  //
  // What changed is *why* it is unreachable. The Linear variant used to be refused
  // by name before any call; it is now polled like any other board, so this fixture
  // — a temp directory with no git remote — fails at the `gh` call instead. The
  // assertion moved from the old refusal's wording to the property that mattered.
  const repo = makeRepo({ 'ROADMAP.md': `# ROADMAP\n\n${LINEAR_LINE}\n` });
  const said = [];
  t.mock.method(console, 'log', (line) => said.push(String(line)));
  t.mock.method(console, 'error', (line) => said.push(String(line)));
  assert.equal(main(['node', 'agent-fixer.mjs', repo]), 1);
  const output = said.join('\n');
  assert.match(output, /board: linear/);
  assert.equal(/no open issue/.test(output), false, 'a board it could not poll was reported as empty');
  // That the failure is *named*, not which words name it. The first version matched
  // the message this box happens to produce (`not a git repository`) and went red on
  // Linux CI, where `gh` is absent and the wording differs entirely. The property is
  // that some reason reaches the operator; the exact sentence is the platform's.
  const reason = said.filter((l) => !/^board:/.test(l)).join('').trim();
  assert.ok(reason.length > 0, 'the failure is not named at all');
});

test('the plan command claims nothing and creates nothing', (t) => {
  const repo = makeRepo({ 'ROADMAP.md': `# ROADMAP\n\n${LINEAR_LINE}\n` });
  const io = runsFor();
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  main(['node', 'agent-fixer.mjs', repo, `--runs-dir=${io.runsDir}`]);
  assert.equal(existsSync(claimsDir(repo, io)), false);
  assert.equal(existsSync(worktreePath(repo, 'anything', io)), false);
});

test('a second run on one issue gets a fresh branch instead of a refusal', () => {
  // A reap leaves the branch standing, so the retry the spec's repeat-delegation
  // case describes — start clean in a new worktree — would otherwise die on
  // `fatal: a branch named '...' already exists`. Real repository, real refs.
  const repo = repoWithCommit({ 'README.md': '# r\n' });
  const io = runsFor();

  const first = freeBranchForIssue(repo, 193, 'a real bug', 'fix', io);
  assert.equal(first.branch, 'fix/193-a-real-bug');
  assert.equal(first.priorAttempts, 0);
  const made = createWorktree({ repoRoot: repo, runId: 'fixer-1', branch: first.branch }, io);
  assert.equal(made.ok, true, made.message);
  assert.equal(reapWorktree(made.path, { state: OUTCOME_REPORTED }, io).ok, true);

  const second = freeBranchForIssue(repo, 193, 'a real bug', 'fix', io);
  assert.equal(second.branch, 'fix/193-a-real-bug-2', 'the retry reused a branch that still exists');
  assert.equal(second.priorAttempts, 1, 'the prior attempt was not reported');
  const again = createWorktree({ repoRoot: repo, runId: 'fixer-2', branch: second.branch }, io);
  assert.equal(again.ok, true, JSON.stringify(again));

  // And a third, so the counter is a counter and not a one-shot suffix.
  const third = freeBranchForIssue(repo, 193, 'a real bug', 'fix', io);
  assert.equal(third.branch, 'fix/193-a-real-bug-3');
  assert.equal(third.priorAttempts, 2);
});

test('every retry branch is still one the pre-push hook accepts', () => {
  // The suffix must not buy a retry at the cost of a branch that cannot be pushed.
  const HOOK = /^[a-z]+\/[1-9][0-9]*-[a-z0-9]+(-[a-z0-9]+)*$/;
  for (const [issue, title] of [[193, 'a real bug'], [9, '!!!'], [10, '']]) {
    for (let n = 2; n <= 12; n += 1) {
      assert.match(`${branchForIssue(issue, title)}-${n}`, HOOK);
    }
  }
});

test('fifty leftover branches is reported, not guessed past', () => {
  // A repository nobody is cleaning up. Guessing a fifty-first would hide that.
  const repo = repoWithCommit({ 'README.md': '# r\n' });
  const io = runsFor();
  const exhausted = freeBranchForIssue(repo, 7, 'x', 'fix', {
    ...io,
    git: () => ({ status: 0, stdout: 'deadbeef\n', stderr: '' }),   // every name exists
  });
  assert.equal(exhausted.branch, null);
  assert.equal(exhausted.reason, 'branch-names-exhausted');
  assert.equal(exhausted.priorAttempts, MAX_BRANCH_ATTEMPTS);
});

// --- the run command, and the gate it stopped consulting ------------------

/** A home directory holding one agent's enablement state. */
function homeWithFixer(enabled) {
  const home = emptyDir();
  mkdirSync(join(home, '.daftplate', 'agents'), { recursive: true });
  writeFileSync(agentStatePath('fixer', { homeDir: home }), JSON.stringify({
    kind: ENABLEMENT_KIND, agent: 'fixer', enabled,
  }));
  return home;
}

const LABELLED = (number, title) => (args) => (args[0] === 'label'
  ? { status: 0, stdout: `[{"name":"${DELEGATION_LABEL}"}]`, stderr: '' }
  : { status: 0, stdout: JSON.stringify([{ number, title }]), stderr: '' });

test('a permitted --run reaches the loop instead of refusing at the gate', (t) => {
  // **`--run` refused unconditionally.** It called `printEnablementGate()` and
  // returned a violation without ever reading `gate.ok`, so no state of the world
  // could make it proceed — and `runLoop`, the whole feature, had no caller outside
  // this suite. That was honest while ADR 0008's second condition could not be
  // closed. It closed on 2026-09-04 and nothing failed, because every test asserted
  // the refusal and none asserted the permitted path.
  const repo = repoWithCommit({ 'ROADMAP.md': `# ROADMAP\n\n${LINEAR_LINE}\n` });
  const said = [];
  t.mock.method(console, 'log', (l) => said.push(String(l)));
  t.mock.method(console, 'error', (l) => said.push(String(l)));

  const reached = [];
  main(['node', 'agent-fixer.mjs', repo, '--run=312', `--runs-dir=${emptyDir()}`], {
    homeDir: homeWithFixer(true),
    gh: LABELLED(312, 'a delegated bug'),
    runLoop: (spec) => { reached.push(spec); return { ok: true, published: false, outcome: OUTCOME_REPORTED }; },
  });

  assert.equal(reached.length, 1, 'the loop was never reached');
  assert.equal(reached[0].issue.number, 312);
  assert.equal(said.join('\n').includes('still open'), false, 'a permitted run was told a condition is open');
});

test('an un-permitted --run still refuses, and still prints both conditions', (t) => {
  // The regression that matters more than the feature. The gate is now consulted
  // rather than assumed, so it has to keep saying no when it should.
  const repo = repoWithCommit({ 'ROADMAP.md': `# ROADMAP\n\n${LINEAR_LINE}\n` });
  const said = [];
  t.mock.method(console, 'log', (l) => said.push(String(l)));
  t.mock.method(console, 'error', (l) => said.push(String(l)));

  const reached = [];
  const code = main(['node', 'agent-fixer.mjs', repo, '--run=312'], {
    homeDir: homeWithFixer(false),
    gh: LABELLED(312, 'a delegated bug'),
    runLoop: (spec) => { reached.push(spec); return { ok: true }; },
  });

  assert.equal(reached.length, 0, 'an agent nobody switched on reached the loop');
  assert.notEqual(code, 0);
  const output = said.join('\n');
  assert.match(output, /the agent is off/);
  // Both conditions, with their standing — an operator told only "no" learns nothing.
  //
  // **The standing is the half that was asserted by nothing.** `#339 (FORGE-370)`:
  // the loop below read `row.condition` and stopped, so a mutant emptying
  // `row.evidence` inside `printEnablementGate` left an operator looking at a gate
  // that names two conditions and says nothing about where either stands, with the
  // suite green. Read off what the command printed, never off the constant — the
  // constant is the data, and the defect was in the rendering of it.
  assert.match(output, /\[closed\]/, 'a closed condition must be visibly closed');
  for (const row of ENABLEMENT_CONDITIONS) {
    assert.ok(output.includes(row.condition), `the gate never showed: ${row.condition}`);
    assert.ok(row.closed, 'this assertion reads the evidence branch; a reopened condition needs the act one');
    assert.ok(output.includes(row.evidence), `the gate showed no evidence for: ${row.condition}`);
  }
});

/**
 * A condition standing open, held here rather than reached through the constant.
 *
 * Both real conditions closed on 2026-09-04 (ADR 0011), so the `act` branch of
 * `printEnablementGate` is unreachable through `ENABLEMENT_CONDITIONS` on this
 * machine — and it is the branch that would render the word `undefined` at an
 * owner, since a closed row carries no `act` at all. Injected through the
 * `conditions` seam `main` already threads to the gate, which is the same seam and
 * the same reasoning as `tests/agent-menu-edits.test.mjs`'s `ONE_OPEN`.
 */
const ONE_OPEN = [
  { condition: 'a condition this file holds closed', closed: true, evidence: 'tests/agent-fixer.test.mjs' },
  { condition: 'a condition this file holds open', closed: false, act: 'an owner does the outstanding thing' },
];

test('the gate renders an open condition as open, and names the act that would close it', (t) => {
  // The other half of the screen above. An agent an owner *has* switched on, held
  // by a condition that has not closed — which is the case ADR 0008 row 8 is about,
  // and the only case where the act line is what the operator needs.
  //
  // Mutation killed: emptying `row.act` in the print at `agent-fixer.mjs:842`. No
  // other test in the suite reaches that branch.
  const repo = repoWithCommit({ 'ROADMAP.md': `# ROADMAP\n\n${LINEAR_LINE}\n` });
  const said = [];
  t.mock.method(console, 'log', (l) => said.push(String(l)));
  t.mock.method(console, 'error', (l) => said.push(String(l)));

  const reached = [];
  const code = main(['node', 'agent-fixer.mjs', repo, '--run=312'], {
    homeDir: homeWithFixer(true),
    conditions: ONE_OPEN,
    gh: LABELLED(312, 'a delegated bug'),
    runLoop: (spec) => { reached.push(spec); return { ok: true }; },
  });

  assert.equal(reached.length, 0, 'an agent held by an open condition reached the loop');
  assert.notEqual(code, 0);
  const output = said.join('\n');
  assert.match(output, /\[ open \]/, 'an open condition must be visibly open on the screen');
  assert.match(output, /\[closed\]/, 'a closed condition must be visibly closed');
  assert.doesNotMatch(output, /^\s+undefined$/m, 'the gate rendered the word undefined at an operator');
  for (const row of ONE_OPEN) {
    assert.ok(output.includes(row.condition), `the gate never showed: ${row.condition}`);
    assert.ok(output.includes(row.closed ? row.evidence : row.act),
      `the gate showed no ${row.closed ? 'evidence' : 'act'} for: ${row.condition}`);
  }
});

test('--run refuses an issue that carries no delegation label', (t) => {
  // The label is the delegation. Running an issue nobody delegated would make
  // `--run` a second, unlabelled trigger with none of the gesture's meaning.
  const repo = repoWithCommit({ 'ROADMAP.md': `# ROADMAP\n\n${LINEAR_LINE}\n` });
  t.mock.method(console, 'log', () => {});
  const said = [];
  t.mock.method(console, 'error', (l) => said.push(String(l)));

  const reached = [];
  const code = main(['node', 'agent-fixer.mjs', repo, '--run=999', `--runs-dir=${emptyDir()}`], {
    homeDir: homeWithFixer(true),
    gh: LABELLED(312, 'a different issue entirely'),
    runLoop: (spec) => { reached.push(spec); return { ok: true }; },
  });

  assert.equal(reached.length, 0, 'an undelegated issue was run');
  assert.notEqual(code, 0);
  assert.match(said.join('\n'), new RegExp(DELEGATION_LABEL));
});

test('the run fetches the issue body, which the poll does not carry', (t) => {
  // **The poll asks for `number,title` and nothing else.** `sourceAcceptanceCriteria`
  // reads `issue.body`, so handing it a polled issue gives it `undefined`, and it
  // fails closed with `no-issue-body` — on an issue whose body is right there.
  //
  // Measured on the first real delegation, 2026-09-05: #312 carries an explicit
  // `## Acceptance criteria` section and the run refused for having none. Every
  // loop test passed throughout, because each builds its own issue fixture with a
  // body — a shape no production caller could produce, and there was no production
  // caller until `#313` added one.
  const repo = repoWithCommit({ 'ROADMAP.md': `# ROADMAP\n\n${LINEAR_LINE}\n` });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});

  const reached = [];
  main(['node', 'agent-fixer.mjs', repo, '--run=312', `--runs-dir=${emptyDir()}`], {
    homeDir: homeWithFixer(true),
    gh: (a) => {
      if (a[0] === 'label') return { status: 0, stdout: `[{"name":"${DELEGATION_LABEL}"}]`, stderr: '' };
      if (a[0] === 'issue' && a[1] === 'list') return { status: 0, stdout: '[{"number":312,"title":"a bug"}]', stderr: '' };
      // Built with `JSON.stringify` rather than written as a JSON literal. A raw
      // newline inside a JSON string is invalid, and hand-escaping one in a fixture
      // is exactly how this test first went red against correct code — the parse
      // threw and the run reported `issue-unreadable`, which is what it should do.
      const body = ['## Acceptance criteria', '', '1. it works'].join('\n');
      return { status: 0, stdout: JSON.stringify({ number: 312, title: 'a bug', body }), stderr: '' };
    },
    runLoop: (spec) => { reached.push(spec); return { ok: true, published: false, outcome: OUTCOME_REPORTED }; },
  });

  assert.equal(reached.length, 1, 'the loop was never reached');
  assert.match(reached[0].issue.body ?? '', /Acceptance criteria/,
    'the loop was handed an issue with no body, so it cannot source criteria');
});

test('a body that could not be fetched is a named refusal, not an empty body', (t) => {
  // The failure this repository keeps meeting: an unreadable answer and a genuinely
  // empty one are different facts, and merging them reports "this issue has no
  // acceptance criteria" about an issue nobody could read. The run must say which.
  const repo = repoWithCommit({ 'ROADMAP.md': `# ROADMAP\n\n${LINEAR_LINE}\n` });
  t.mock.method(console, 'log', () => {});
  const said = [];
  t.mock.method(console, 'error', (l) => said.push(String(l)));

  const reached = [];
  const code = main(['node', 'agent-fixer.mjs', repo, '--run=312', `--runs-dir=${emptyDir()}`], {
    homeDir: homeWithFixer(true),
    gh: (a) => {
      if (a[0] === 'label') return { status: 0, stdout: `[{"name":"${DELEGATION_LABEL}"}]`, stderr: '' };
      if (a[0] === 'issue' && a[1] === 'list') return { status: 0, stdout: '[{"number":312,"title":"a bug"}]', stderr: '' };
      return { status: 1, stdout: '', stderr: 'could not resolve to an Issue' };
    },
    runLoop: (spec) => { reached.push(spec); return { ok: true }; },
  });

  assert.equal(reached.length, 0, 'the loop ran on an issue that could not be read');
  assert.notEqual(code, 0);
  // `gh`'s own words, not merely *a* refusal. The alternation this replaced accepted
  // the JSON-parse branch too, which reports an empty truncated stdout and tells an
  // operator nothing — so deleting the status check killed no test. The status
  // branch exists precisely because it is the one that can quote stderr.
  assert.match(said.join('\n'), /could not resolve to an Issue/);
});

// --- refusals that name nothing --------------------------------------------

// `#327 (FORGE-367)`. Six sites in this runner render a refusal for a human as a
// `message` falling back to a `reason`, and `??` falls back only on null and
// undefined. A producer whose message is the empty string therefore prints
// `run: #312 — ` with nothing after the dash, or, on the plan path, a literally
// empty line: a refusal that names nothing, from a command that exits non-zero.
//
// Two of the six — both poll refusals — were already asserted through captured
// output. The other four had **no test of any kind**: a reviewer restored `??` at
// the run refusal and the entire suite stayed green. Each test below drives the
// CLI and reads what it wrote, because the returned object is precisely where this
// defect is invisible — every one of these refusals is a `reason` field that is
// perfectly correct on the way past.
//
// The seams. `runLoop` was already injectable; `createWorktree`, `openRunRecord`
// and `requestStop` were not, and that is *why* their three sites had no test —
// none of the three can be made to refuse with an empty message from outside, and
// their real writers never produce one (`writeAtomically` returns null or a
// sentence; `createWorktree` returns git's own streams). Stubbing the producer is
// the only way to reach the print site with the value that breaks it, so `main`
// gained three seams in `opts.runLoop`'s idiom. A caller supplying one outside the
// suite is substituting its own worktree, run record or stop request.

test('a run refusal with an empty message prints the reason, not an empty violation', (t) => {
  const repo = repoWithCommit({ 'ROADMAP.md': `# ROADMAP\n\n${LINEAR_LINE}\n` });
  const said = [];
  t.mock.method(console, 'log', (l) => said.push(String(l)));
  t.mock.method(console, 'error', (l) => said.push(String(l)));

  const code = main(['node', 'agent-fixer.mjs', repo, '--run=312', `--runs-dir=${emptyDir()}`], {
    homeDir: homeWithFixer(true),
    gh: LABELLED(312, 'a delegated bug'),
    // The empty string, not an absent one. `??` already handles absence, and absence
    // is all `runLoop` returns today — it answers `stop-settings-refused` with a
    // `detail` and no `message` at all. The failure is a message that is *present*
    // and says nothing, which is what a `stdout.trim()` produces two sites away and
    // what any later producer taking its words from a stream will produce here.
    runLoop: () => ({ ok: false, reason: 'stop-settings-refused', message: '', published: false, outcome: null }),
  });

  assert.equal(code, 1);
  assert.match(said.join('\n'), /run: #312 — stop-settings-refused/,
    'the run refusal printed a violation line with nothing after the dash');
});

test('a refusal message of nothing but whitespace is no message at all', (t) => {
  // The property belongs to the renderer rather than to its callers. Every producer
  // in this repository trims today, so a rule kept only where the value is made is a
  // rule the seventh producer will not know about — which is how the empty-message
  // shape arrived in the first place.
  const repo = repoWithCommit({ 'ROADMAP.md': `# ROADMAP\n\n${LINEAR_LINE}\n` });
  const said = [];
  t.mock.method(console, 'log', (l) => said.push(String(l)));
  t.mock.method(console, 'error', (l) => said.push(String(l)));

  main(['node', 'agent-fixer.mjs', repo, '--run=312', `--runs-dir=${emptyDir()}`], {
    homeDir: homeWithFixer(true),
    gh: LABELLED(312, 'a delegated bug'),
    runLoop: () => ({ ok: false, reason: 'claim-lost', message: '  \n\t ', published: false, outcome: null }),
  });

  assert.match(said.join('\n'), /run: #312 — claim-lost/,
    'a message of blanks was printed as though it were words');
});

test('a refusal carrying neither message nor reason still says something', (t) => {
  // The last fallback, and the only one that cannot be reached by fixing a producer:
  // a refusal object with nothing in it at all. Printing `run: #312 — ` for it would
  // be the same silence by a different route.
  const repo = repoWithCommit({ 'ROADMAP.md': `# ROADMAP\n\n${LINEAR_LINE}\n` });
  const said = [];
  t.mock.method(console, 'log', (l) => said.push(String(l)));
  t.mock.method(console, 'error', (l) => said.push(String(l)));

  main(['node', 'agent-fixer.mjs', repo, '--run=312', `--runs-dir=${emptyDir()}`], {
    homeDir: homeWithFixer(true),
    gh: LABELLED(312, 'a delegated bug'),
    runLoop: () => ({ ok: false }),
  });

  const line = said.find((l) => l.startsWith('run: #312 — '));
  assert.ok(line, `no run refusal was printed at all:\n${said.join('\n')}`);
  assert.ok(line.slice('run: #312 — '.length).trim().length > 0,
    'the refusal line ended at the dash');
});

test('a worktree refusal with an empty message prints the reason', (t) => {
  // `createWorktree`'s `add-failed` takes its message from `(stderr || stdout).trim()`,
  // so a `git worktree add` that fails while printing to neither stream hands this
  // site the empty string. Whether real git ever does that is not the point and is
  // not claimed here: the value is reachable through the `opts.git` seam every other
  // test in this file already uses, and the print site must survive it either way.
  const repo = repoWithCommit({ 'README.md': '# r\n' });
  const said = [];
  t.mock.method(console, 'log', (l) => said.push(String(l)));
  t.mock.method(console, 'error', (l) => said.push(String(l)));

  const code = main(['node', 'agent-fixer.mjs', repo, '--claim=42', `--runs-dir=${emptyDir()}`], {
    createWorktree: () => ({ ok: false, reason: 'add-failed', path: 'X:/w', message: '' }),
  });

  assert.equal(code, 1);
  assert.match(said.join('\n'), /worktree: X:\/w — add-failed/,
    'the claim command refused a worktree without saying why');
});

test('a record refusal with an empty message prints the reason', (t) => {
  const repo = repoWithCommit({ 'README.md': '# r\n' });
  const io = runsFor();
  const said = [];
  t.mock.method(console, 'log', (l) => said.push(String(l)));
  t.mock.method(console, 'error', (l) => said.push(String(l)));

  const code = main(['node', 'agent-fixer.mjs', repo, '--claim=43', `--runs-dir=${io.runsDir}`], {
    // Stubbed to succeed rather than left real: this test is about the record, and a
    // genuine worktree here would be a checkout created and then abandoned by a run
    // that refuses two lines later.
    createWorktree: () => ({ ok: true, path: join(io.runsDir, 'w'), baseCommit: 'deadbeef' }),
    openRunRecord: () => ({ ok: false, reason: 'record-exists', path: 'X:/rec', message: '' }),
  });

  assert.equal(code, 1);
  assert.match(said.join('\n'), /record: X:\/rec — record-exists/,
    'the claim command refused a run record without saying why');
});

test('a stop refusal with an empty message prints the reason', (t) => {
  // The one refusal an operator reads mid-incident, which is the worst moment for a
  // command to exit non-zero having printed a dash and nothing after it.
  const repo = repoWithCommit({ 'README.md': '# r\n' });
  const io = runsFor();
  const said = [];
  t.mock.method(console, 'log', (l) => said.push(String(l)));
  t.mock.method(console, 'error', (l) => said.push(String(l)));

  // A real claim first, so `--stop` has a run to resolve. Only the request itself is
  // stubbed; everything that finds the run is the CLI's own.
  assert.equal(main(['node', 'agent-fixer.mjs', repo, '--claim=44', '--title=a bug', `--runs-dir=${io.runsDir}`]),
    0, said.join('\n'));

  const code = main(['node', 'agent-fixer.mjs', repo, '--stop=44', `--runs-dir=${io.runsDir}`], {
    requestStop: () => ({ ok: false, reason: 'record-write-failed', path: 'X:/s', message: '' }),
  });

  assert.equal(code, 1);
  assert.match(said.join('\n'), /stop: X:\/s — record-write-failed/,
    'the stop command refused without saying why');
});

test('no refusal in the runner is rendered without the shared helper', () => {
  // Asserted over the source, for the reason the phase-boundary test above is: the
  // guarantee is that a *seventh* site cannot be written in the old shape, and a site
  // nobody has added yet has no behaviour to observe. The five tests above prove the
  // helper is right; this one proves nothing bypasses it.
  //
  // `||` is forbidden alongside `??` deliberately. Inlining the *correct* expression
  // at each site fixes today's six and leaves the next author the same choice to get
  // wrong, which is the shape `#312 (FORGE-354)` shipped and `#327 (FORGE-367)` was
  // filed to replace.
  //
  // The pattern names the fallback-to-reason shape rather than every `.message ||`,
  // because `ghFailureMessage` legitimately writes `r.error?.message || ''` — it is a
  // producer choosing its own words, which is the thing this helper does not replace.
  const source = readFileSync(join(REPO, 'scripts/agent-fixer.mjs'), 'utf8');
  assert.deepEqual(
    source.match(/\.message\s*(?:\?\?|\|\|)\s*(?:[A-Za-z_$][\w$]*\??\.)?reason\b/g) ?? [], [],
    'a refusal in scripts/agent-fixer.mjs renders its own words instead of asking the helper',
  );
  // Six call sites plus the definition. A lower bound, so a docblock naming the
  // helper cannot make this fail for the wrong reason.
  const named = source.match(/refusalWords\(/g) ?? [];
  assert.ok(named.length >= 7,
    `six print sites and one definition should name refusalWords; found ${named.length}`);
});
