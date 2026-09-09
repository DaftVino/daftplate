import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { emptyDir } from './helpers/make-repo.mjs';
import {
  RECORD_KIND, STOP_KIND, RUN_STATES, RECORD_REFUSALS,
  recordPath, recordsDir, stopPath, stopsDir, settingsPath,
  openRunRecord, readRunRecord, listRunRecords, recordInvocation, closeRunRecord,
  requestStop, checkStop, holderAlive, markStopped, buildStopSettings, stopSettingsArgs,
} from '../scripts/lib/run-record.mjs';
import { stopDecision, readStopFile } from '../scripts/lib/run-stop-hook.mjs';
import {
  createWorktree, reapWorktree, containedIn, worktreePath, OUTCOME_REPORTED,
} from '../scripts/lib/worktree.mjs';
import { claimIssue, claimPath, resolveRun } from '../scripts/agent-fixer.mjs';
import { buildInvocation } from '../scripts/lib/agent-invoke.mjs';

// Rows 8 and 9 are the two rows of ADR 0008 that a reader can only be sure of by
// watching them happen, so the two that matter are demonstrated against real
// processes and a real worktree: a second `node` process stops a run it did not
// start, and a record outlives the checkout it describes because the checkout is
// actually removed. Everything else here is the small stuff those two rest on.
const REPO = fileURLToPath(new URL('..', import.meta.url));
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function repoWithCommit() {
  const root = emptyDir();
  git(['init', '--initial-branch=main', root]);
  git(['config', 'user.email', 'test@example.invalid'], root);
  git(['config', 'user.name', 'Test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  git(['add', 'README.md'], root);
  git(['commit', '-m', 'first'], root);
  return root;
}

// Phase 2: every run-scoped path is per-agent now, and omitting the agent throws
// rather than falling back to the flat layout both agents used to share.
const runsFor = (agent = 'fixer') => ({ runsDir: emptyDir(), agent });

// ---------------------------------------------------------------------------
// Row 9 — the record
// ---------------------------------------------------------------------------

test('the record lives outside every worktree, which is the whole of row 9', () => {
  const io = runsFor();
  const repo = 'X:/one/daftplate';
  assert.equal(containedIn(worktreePath(repo, 'fixer-1', io), recordPath(repo, 'fixer-1', io)), false);
  assert.equal(containedIn(worktreePath(repo, 'fixer-1', io), stopPath(repo, 'fixer-1', io)), false);
  assert.equal(containedIn(worktreePath(repo, 'fixer-1', io), settingsPath(repo, 'fixer-1', io)), false);
});

test('an opened record answers the six questions row 9 asks, with nulls for what is not known yet', () => {
  const io = runsFor();
  const repo = repoWithCommit();
  const opened = openRunRecord({
    repoRoot: repo, runId: 'fixer-7', issue: 7, linearKey: 'FORGE-9', issueTitle: 'a bug',
    branch: 'fix/7-a-bug', worktree: 'X:/w', baseCommit: 'abc123',
  }, io);
  assert.equal(opened.ok, true, opened.message);

  const held = readRunRecord(repo, 'fixer-7', io);
  assert.equal(held.kind, RECORD_KIND);
  assert.equal(held.state, RUN_STATES.RUNNING);
  // Against which issue · under what authority · what ran · what changed · what
  // it tested · what it published. Six answers, present even when empty, so a
  // record of a run that died early shows which were never filled in.
  assert.deepEqual(held.issue, { number: 7, linearKey: 'FORGE-9', title: 'a bug' });
  assert.equal(held.authority.adr, '0008');
  assert.equal(held.authority.permissionMode, 'acceptEdits');
  assert.equal(held.authority.pid, process.pid);
  // `account` joined this in the run that added it — the path to what the run said
  // it did, kept because three consecutive real runs behaved unexpectedly and the
  // one artefact that would have explained them was discarded every time.
  //
  // **Additive, and `RECORD_KIND` is deliberately not bumped.** Records now exist on
  // this machine, so the earlier justification — that none had ever been written —
  // no longer applies and the question has to be answered on its merits. A reader of
  // `/1` that does not know the field ignores it, and `closeRunRecord` falls back
  // through `held.ran.account ?? null`, so a record written before this reads
  // exactly as it did. A bump would invalidate three real records to describe a key
  // nothing older depends on.
  //
  // Pinned as a key set rather than checked for membership, for the reason the stop
  // settings are: a seventh answer appearing here is a schema change and should fail
  // in a test somebody has to argue with.
  assert.deepEqual(held.ran, { command: null, argv: null, prompt: null, status: null, account: null });
  assert.equal(held.changed.baseCommit, 'abc123');
  assert.equal(held.tested.reproduction, null);
  assert.deepEqual(held.published, { commit: null, pr: null, comment: null });
});

test('a second open on the same run id is refused rather than overwriting the first', () => {
  // The authority an earlier run acted under is the one thing row 9 exists to
  // keep, so the write that would erase it is the write that must fail.
  const io = runsFor();
  const repo = repoWithCommit();
  assert.equal(openRunRecord({ repoRoot: repo, runId: 'fixer-1', issue: 1, branch: 'a' }, io).ok, true);
  const again = openRunRecord({ repoRoot: repo, runId: 'fixer-1', issue: 2, branch: 'b' }, io);
  assert.equal(again.ok, false);
  assert.equal(again.reason, RECORD_REFUSALS.EXISTS);
  assert.equal(readRunRecord(repo, 'fixer-1', io).issue.number, 1);
});

test('a file under records/ that this ledger did not write reads as no record', () => {
  const io = runsFor();
  const repo = repoWithCommit();
  mkdirSync(recordsDir(repo, io), { recursive: true });
  writeFileSync(recordPath(repo, 'run-x', io), JSON.stringify({ kind: 'somebody.else/1', runId: 'run-x' }));
  assert.equal(readRunRecord(repo, 'run-x', io), null);
  assert.deepEqual(listRunRecords(repo, io), []);
});

test('what ran is the argv, and the prompt is digested rather than kept', () => {
  const io = runsFor();
  const repo = repoWithCommit();
  openRunRecord({ repoRoot: repo, runId: 'fixer-3', issue: 3 }, io);
  const prompt = 'fix the bug described in the issue body, which is quoted here at length';
  const invocation = buildInvocation({ worktree: 'X:/w', prompt, env: {} });
  const noted = recordInvocation(repo, 'fixer-3', { command: invocation.command, args: invocation.args, prompt }, io);
  assert.equal(noted.ok, true, noted.message);

  const held = readRunRecord(repo, 'fixer-3', io);
  assert.equal(held.ran.command, 'claude');
  // Every ADR 0008 row 1 and row 2 flag is kept in full — that is what the record
  // is for — and the issue text is not.
  assert.deepEqual(held.ran.argv, ['--print', '--permission-mode', 'acceptEdits']);
  assert.equal(held.ran.argv.includes(prompt), false);
  assert.equal(held.ran.prompt.bytes, Buffer.byteLength(prompt, 'utf8'));
  assert.match(held.ran.prompt.sha256, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(recordPath(repo, 'fixer-3', io), 'utf8').includes(prompt), false);
});

test("closing keys the state off publishRun's own outcome and commit, not a third vocabulary", () => {
  const io = runsFor();
  const repo = repoWithCommit();
  openRunRecord({ repoRoot: repo, runId: 'fixer-4', issue: 4 }, io);
  // Exactly the shape publishRun returns on its published path.
  const publish = {
    ok: true, published: true, outcome: 'published', commit: 'deadbee',
    reproduction: { ok: true, changed: ['scripts/a.mjs', 'tests/a.test.mjs'], tests: ['tests/a.test.mjs'], replay: { verdict: 'failed' } },
    pr: { url: 'https://github.com/o/r/pull/9' },
  };
  closeRunRecord(repo, 'fixer-4', { publish, generation: { agent: { status: 0 } } }, io);

  const held = readRunRecord(repo, 'fixer-4', io);
  assert.equal(held.state, publish.outcome, 'the state is publishRun\'s outcome verbatim');
  assert.equal(held.published.commit, publish.commit);
  assert.equal(held.published.pr, 'https://github.com/o/r/pull/9');
  assert.deepEqual(held.changed.files, ['scripts/a.mjs', 'tests/a.test.mjs']);
  assert.equal(held.tested.reproduction, true);
  assert.equal(held.tested.verdict, 'failed');
  assert.equal(held.ran.status, 0);
  assert.notEqual(held.endedAt, null);
});

test('a run that published nothing records that it published nothing', () => {
  const io = runsFor();
  const repo = repoWithCommit();
  openRunRecord({ repoRoot: repo, runId: 'fixer-5', issue: 5 }, io);
  const publish = {
    ok: false, reason: 'no-reproduction', published: false, outcome: 'reported', pr: null,
    reproduction: { ok: false, reason: 'no-test-in-the-diff', changed: ['scripts/a.mjs'], tests: [] },
    comment: { path: 'X:/runs/bodies/run-5-comment.md' },
  };
  closeRunRecord(repo, 'fixer-5', { publish }, io);

  const held = readRunRecord(repo, 'fixer-5', io);
  assert.equal(held.state, RUN_STATES.REPORTED);
  assert.equal(held.published.commit, null);
  assert.equal(held.published.pr, null);
  assert.equal(held.published.comment, 'X:/runs/bodies/run-5-comment.md');
  assert.equal(held.tested.reproduction, false);
  assert.equal(held.tested.reason, 'no-test-in-the-diff');
});

test('THE RECORD SURVIVES THE WORKTREE — demonstrated by removing one', () => {
  // Row 9's literal wording is "retained after the worktree is gone", so the
  // worktree is really made and really removed by the reaper that would remove it
  // in a run, rather than by a test deleting a directory to prove a path.
  const repo = repoWithCommit();
  const io = runsFor();
  const made = createWorktree({ repoRoot: repo, runId: 'fixer-9', branch: 'fix/9-a' }, io);
  assert.equal(made.ok, true, made.message);
  openRunRecord({
    repoRoot: repo, runId: 'fixer-9', issue: 9, branch: 'fix/9-a',
    worktree: made.path, baseCommit: made.baseCommit,
  }, io);
  closeRunRecord(repo, 'fixer-9', {
    publish: { outcome: 'reported', reproduction: { ok: false, reason: 'no-test-in-the-diff', changed: [], tests: [] } },
  }, io);

  const reaped = reapWorktree(made.path, { state: OUTCOME_REPORTED }, io);
  assert.equal(reaped.ok, true, JSON.stringify(reaped));
  assert.equal(existsSync(made.path), false, 'the worktree is really gone');

  const held = readRunRecord(repo, 'fixer-9', io);
  assert.notEqual(held, null, 'the record went with the worktree');
  assert.equal(held.authority.worktree, made.path, 'it still names the checkout that no longer exists');
  assert.equal(held.changed.baseCommit, made.baseCommit);
  assert.equal(held.state, RUN_STATES.REPORTED);
});

// ---------------------------------------------------------------------------
// Row 8 — discovery and stop
// ---------------------------------------------------------------------------

test('a second stop request does not overwrite the record of who asked first', () => {
  const io = runsFor();
  const repo = repoWithCommit();
  openRunRecord({ repoRoot: repo, runId: 'fixer-2', issue: 2 }, io);
  const first = requestStop({ repoRoot: repo, runId: 'fixer-2', issue: 2, reason: 'it is looping' }, io);
  assert.equal(first.ok, true);
  const second = requestStop({ repoRoot: repo, runId: 'fixer-2', issue: 2, reason: 'me too' }, io);
  assert.equal(second.ok, false);
  assert.equal(second.reason, RECORD_REFUSALS.ALREADY_REQUESTED);
  assert.equal(checkStop(repo, 'fixer-2', io).reason, 'it is looping');
});

test('a file under stops/ that this ledger did not write is not a stop request', () => {
  // A stop halts a run; reading a stranger's file as one would halt it on nobody's
  // say-so, which is the claim ledger's reason for validating its own kind.
  const io = runsFor();
  const repo = repoWithCommit();
  mkdirSync(stopsDir(repo, io), { recursive: true });
  writeFileSync(stopPath(repo, 'fixer-6', io), JSON.stringify({ runId: 'fixer-6', stop: true }));
  assert.equal(checkStop(repo, 'fixer-6', io), null);
});

test('holderAlive answers about this process and about a pid that cannot be one', () => {
  assert.equal(holderAlive(process.pid), true);
  assert.equal(holderAlive(0), false);
  assert.equal(holderAlive(-1), false);
  assert.equal(holderAlive(null), false);
});

test('A RUN IS FOUND AND STOPPED BY A SECOND PROCESS THAT DID NOT START IT', async () => {
  // ADR 0008 row 8, demonstrated rather than reasoned about. Two real processes:
  // one running under its own pid with a record on disk, and a second — the CLI, a
  // separate `node` — that learns of the first only from the ledger.
  const repo = repoWithCommit();
  const io = runsFor();
  const made = createWorktree({ repoRoot: repo, runId: 'fixer-11', branch: 'fix/11-a' }, io);
  assert.equal(made.ok, true, made.message);
  claimIssue({ repoRoot: repo, issue: 11, runId: 'fixer-11', branch: 'fix/11-a', worktree: made.path }, io);

  const child = spawn(process.execPath, [
    join(REPO, 'tests/helpers/stoppable-run.mjs'), repo, io.runsDir, 'fixer-11', '11', made.path,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((res) => child.on('exit', (code) => res(code)));
  await new Promise((res, rej) => {
    child.stdout.on('data', (d) => { if (String(d).includes('ready')) res(); });
    child.on('exit', () => rej(new Error('the run exited before it was ready')));
  });

  // Everything below here is what a human at a second terminal has: a listing, and
  // a run id. No transcript, no handle on the child, no shared memory.
  const listed = execFileSync(process.execPath, [
    join(REPO, 'scripts/agent-fixer.mjs'), repo, '--list', `--runs-dir=${io.runsDir}`,
  ], { encoding: 'utf8' });
  assert.match(listed, /fixer-11/, 'the second process could not find the run');
  assert.match(listed, new RegExp(`pid ${child.pid} alive`), listed);

  const stopped = execFileSync(process.execPath, [
    join(REPO, 'scripts/agent-fixer.mjs'), repo, '--stop=11', '--reason=a drill', `--runs-dir=${io.runsDir}`,
  ], { encoding: 'utf8' });
  assert.match(stopped, /stop requested for fixer-11/);

  assert.equal(await exited, 42, 'the run did not honour the stop');
  assert.equal(readRunRecord(repo, 'fixer-11', io).state, RUN_STATES.STOPPED);
  assert.equal(checkStop(repo, 'fixer-11', io).reason, 'a drill');

  // A stop is not a delete. The stopper created neither the worktree nor the
  // claim, so it removes neither — CLAUDE.md #5, and the reaper would refuse this
  // worktree anyway because no in-process record vouches for it.
  assert.equal(existsSync(made.path), true, 'the stop removed the worktree');
  assert.equal(existsSync(claimPath(repo, 11, io)), true, 'the stop released the claim');
  assert.match(stopped, /worktree left untouched for inspection/);
  assert.match(stopped, /still stands/);
});

test('a claimed run is discoverable from another process before it has done anything', () => {
  // The record opens at the claim and not at the end, because the run nobody can
  // find is the one that died early — and a record written at the end is written
  // by the runs that needed it least.
  // No ROADMAP.md: claiming does not read the board, and `--list` reports the
  // absence rather than refusing, which is what makes a run findable on a repo
  // whose board declaration is the thing that went wrong.
  const repo = repoWithCommit();
  const io = runsFor();
  const cli = (extra) => execFileSync(process.execPath, [
    join(REPO, 'scripts/agent-fixer.mjs'), repo, ...extra, `--runs-dir=${io.runsDir}`,
  ], { encoding: 'utf8' });

  cli(['--claim=21', '--title=a real bug']);
  const [run] = listRunRecords(repo, io);
  assert.equal(run.issue.number, 21);
  assert.equal(run.state, RUN_STATES.RUNNING);
  assert.equal(run.authority.branch, 'fix/21-a-real-bug');
  assert.equal(existsSync(run.authority.worktree), true);
  assert.match(cli(['--list']), new RegExp(`${run.runId}.+#21`));
});

test('stopping by issue refuses to guess between two runs that are still going', () => {
  const io = runsFor();
  const repo = repoWithCommit();
  openRunRecord({ repoRoot: repo, runId: 'run-a', issue: 12 }, io);
  openRunRecord({ repoRoot: repo, runId: 'run-b', issue: 12 }, io);
  const found = resolveRun(repo, { issue: 12, target: '12' }, io);
  assert.equal(found.ok, false);
  assert.equal(found.reason, 'ambiguous-run');

  // Naming the run id resolves it, which is why the refusal is safe to make.
  assert.equal(resolveRun(repo, { issue: null, target: 'run-b' }, io).run.runId, 'run-b');
  assert.equal(resolveRun(repo, { issue: null, target: 'run-nope' }, io).reason, 'no-such-run');
});

test('resolveRun finds another agent\'s run, by id and by issue, without throwing', () => {
  // A caller asking `resolveRun` this does not yet know which agent to look
  // under — "just been told an agent is loose" is `listRunRecords`'s own reason
  // for taking no agent at all, and `resolveRun` is the CLI's front door onto it.
  // Before this, both branches forced `opts.agent` through to `readRunRecord` and
  // `listRunRecords`: by id, a run named by a DIFFERENT known agent threw
  // `assertRunIdAgent`'s mismatch error instead of being found; by issue, a run
  // any agent but the caller's own had claimed was silently invisible.
  const repo = repoWithCommit();
  const runs = emptyDir();
  const fixer = { runsDir: runs, agent: 'fixer' };
  const hunter = { runsDir: runs, agent: 'hunter' };
  openRunRecord({ repoRoot: repo, runId: 'hunter-77-20260101T000000Z', issue: 77 }, hunter);

  // Asked under `fixer`'s own opts — the only opts a fixer-run CLI has.
  const byId = resolveRun(repo, { issue: null, target: 'hunter-77-20260101T000000Z' }, fixer);
  assert.equal(byId.ok, true, JSON.stringify(byId));
  assert.equal(byId.run.runId, 'hunter-77-20260101T000000Z');
  assert.equal(byId.run.agent, 'hunter');

  const byIssue = resolveRun(repo, { issue: 77, target: '77' }, fixer);
  assert.equal(byIssue.ok, true, JSON.stringify(byIssue));
  assert.equal(byIssue.run.runId, 'hunter-77-20260101T000000Z');
  assert.equal(byIssue.run.agent, 'hunter');
});

test('the fixer\'s own CLI lists and stops another agent\'s run rather than crashing on it', () => {
  // `agent-fixer.mjs` runs as `fixer` (THIS_AGENT) and hands that agent through as
  // its own `io` — the collision this whole phase exists to prevent for a write.
  // `--list` and `--stop`, though, are lookups, and before this fix both threaded
  // that same fixed agent into `listRunRecords`/`resolveRun`, so a run any other
  // agent held either never appeared (`--list`) or crashed the process
  // (`--stop <that run's id>`, via `assertRunIdAgent`'s mismatch throw).
  const repo = repoWithCommit();
  const runs = emptyDir();
  const runId = 'hunter-88-20260101T000000Z';
  openRunRecord({ repoRoot: repo, runId, issue: 88 }, { runsDir: runs, agent: 'hunter' });

  const listed = execFileSync(process.execPath, [
    join(REPO, 'scripts/agent-fixer.mjs'), repo, '--list', `--runs-dir=${runs}`,
  ], { encoding: 'utf8' });
  assert.match(listed, new RegExp(`${runId}.+#88`), listed);

  const stopped = execFileSync(process.execPath, [
    join(REPO, 'scripts/agent-fixer.mjs'), repo, `--stop=${runId}`, `--runs-dir=${runs}`,
  ], { encoding: 'utf8' });
  assert.match(stopped, new RegExp(`stop requested for ${runId}`), stopped);
  assert.equal(checkStop(repo, runId, { runsDir: runs, agent: 'hunter' })?.runId, runId);
});

test('a stop asked of a run whose holder is gone says so instead of pretending', () => {
  const io = runsFor();
  const repo = repoWithCommit();
  openRunRecord({ repoRoot: repo, runId: 'fixer-13', issue: 13, pid: 2 ** 22 - 1 }, io);
  const said = execFileSync(process.execPath, [
    join(REPO, 'scripts/agent-fixer.mjs'), repo, '--stop=13', `--runs-dir=${io.runsDir}`,
  ], { encoding: 'utf8' });
  assert.match(said, /nothing is left to honour this request/);
  // Still written, because the request is also the record of who asked.
  assert.notEqual(checkStop(repo, 'fixer-13', io), null);
});

test('markStopped is terminal and leaves the request beside the record', () => {
  const io = runsFor();
  const repo = repoWithCommit();
  openRunRecord({ repoRoot: repo, runId: 'fixer-14', issue: 14 }, io);
  const asked = requestStop({ repoRoot: repo, runId: 'fixer-14', issue: 14, reason: 'budget' }, io);
  markStopped(repo, 'fixer-14', asked.request, io);
  const held = readRunRecord(repo, 'fixer-14', io);
  assert.equal(held.state, RUN_STATES.STOPPED);
  assert.notEqual(held.endedAt, null);
  assert.equal(existsSync(stopPath(repo, 'fixer-14', io)), true, 'the evidence of who asked was cleared');
});

// ---------------------------------------------------------------------------
// The stop the agent session honours
// ---------------------------------------------------------------------------

test('the hook halts a session when a stop stands, and is silent when none does', () => {
  const io = runsFor();
  const repo = repoWithCommit();
  const hook = join(REPO, 'scripts/lib/run-stop-hook.mjs');
  const path = stopPath(repo, 'fixer-15', io);

  // Run as a real process, because that is how Claude Code runs it: the contract
  // is stdout and an exit code, not a returned object.
  const quiet = execFileSync(process.execPath, [hook, path], { encoding: 'utf8' });
  assert.equal(quiet.trim(), '', 'a hook with no standing request halted a session');

  openRunRecord({ repoRoot: repo, runId: 'fixer-15', issue: 15 }, io);
  requestStop({ repoRoot: repo, runId: 'fixer-15', issue: 15, reason: 'a drill' }, io);
  const loud = JSON.parse(execFileSync(process.execPath, [hook, path], { encoding: 'utf8' }));
  assert.equal(loud.continue, false, 'the hook did not halt the session');
  assert.equal(loud.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(loud.stopReason, /a drill/);
  assert.match(loud.stopReason, /Nothing has been removed/);
});

test('the hook treats an unreadable or foreign file as no request, never as a stop', () => {
  // A stop mechanism that halted every run whenever its own plumbing broke is a
  // stop mechanism somebody switches off.
  const dir = emptyDir();
  const bad = join(dir, 'not-json.json');
  writeFileSync(bad, '{ this is not json');
  assert.equal(readStopFile(bad), null);
  assert.equal(stopDecision(readStopFile(bad)), null);
  assert.equal(stopDecision(null), null);
  assert.equal(stopDecision({ kind: 'somebody.else/1', requestedAt: 'now' }), null);
  assert.equal(stopDecision({ kind: STOP_KIND, requestedAt: 'now' }).continue, false);
});

test('the settings the run carries name the hook outside the worktree, and pass the argv guard', () => {
  const io = runsFor();
  const repo = repoWithCommit();
  const worktree = worktreePath(repo, 'fixer-16', io);
  const built = stopSettingsArgs({ repoRoot: repo, runId: 'fixer-16' }, io);
  assert.equal(built.ok, true, built.message);

  // Under acceptEdits the agent may edit anything in cwd, so a hook read from the
  // worktree would be a stop the run could switch off.
  assert.equal(containedIn(worktree, built.hook), false);
  assert.equal(containedIn(worktree, built.path), false);
  assert.equal(existsSync(built.hook), true, 'the settings name a hook that is not there');
  assert.equal(JSON.parse(readFileSync(built.path, 'utf8')).hooks.PreToolUse[0].hooks[0].command.includes(built.hook), true);

  // The seam Phase 3 left is used rather than a second argv builder, so these
  // flags go through assertInvocationSafe with everything else.
  const invocation = buildInvocation({ worktree, prompt: 'fix it', env: {}, extraArgs: built.extraArgs });
  assert.deepEqual(invocation.args.slice(0, 5), ['--print', '--permission-mode', 'acceptEdits', '--settings', built.path]);
});

test('the stop settings add one hook, one allowlist and one denylist, and claim nothing about what else the session loads', () => {
  // The panel record's *What no seat looked for* names --settings as the cheap,
  // unexamined surface. Settings levels merge, so this cannot assert it stripped
  // the inherited hooks — and it does not try to.
  //
  // The key set is pinned rather than merely checked for membership: this file
  // composing a third thing into a run's settings is exactly the drift the panel
  // record warned about, and it should fail here and be argued for rather than
  // arrive unnoticed. `#205 (FORGE-266)` AC 3 added the second key and that was
  // the argument for it.
  const io = runsFor();
  const built = buildStopSettings({ repoRoot: repoWithCommit(), runId: 'fixer-17' }, io);
  assert.deepEqual(Object.keys(built.settings), ['permissions', 'hooks']);
  // `allow` joined `deny` for `#321 (FORGE-359)`: a run could not commit at all,
  // measured on 2.1.261, so five real runs produced work and published none of it.
  // Order is pinned with the keys — the file is read by a human comparing two runs,
  // and a key set that reshuffles between them is noise in a diff nobody wanted.
  assert.deepEqual(Object.keys(built.settings.permissions), ['allow', 'deny']);
  assert.deepEqual(Object.keys(built.settings.hooks), ['PreToolUse']);
  const source = readFileSync(join(REPO, 'scripts/lib/run-record.mjs'), 'utf8');
  for (const forbidden of ['--dangerously-skip-permissions', 'bypassPermissions']) {
    assert.equal(source.includes(forbidden), false, `run-record.mjs names ${forbidden}`);
  }
});

test('nothing in row 8 or row 9 removes anything', () => {
  // The one way this mechanism turns into a data loss is a stop that tidies up, so
  // the absence is asserted rather than left to review. rmSync, unlinkSync and a
  // forced worktree removal all appear nowhere in either module.
  for (const file of ['scripts/lib/run-record.mjs', 'scripts/lib/run-stop-hook.mjs']) {
    const source = readFileSync(join(REPO, file), 'utf8');
    for (const verb of ['rmSync', 'unlinkSync', 'rmdirSync', "'--force'"]) {
      assert.equal(source.includes(verb), false, `${file} calls ${verb}`);
    }
  }
});
