import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { emptyDir } from './helpers/make-repo.mjs';
import {
  repoKey, runsRoot, worktreePath, createWorktree, reapWorktree, ownedWorktrees,
  forgetOwnedWorktrees, containedIn, branchExists, assertRunIdAgent, RUN_ID_CHARSET,
  REAP_REFUSALS, OUTCOME_PUBLISHED, OUTCOME_REPORTED,
} from '../scripts/lib/worktree.mjs';

// The reaper is the part of Phase 2 that can destroy work, so it is tested
// against real worktrees on disk rather than a mocked lifecycle. A mock would
// agree with whatever the gates happen to say; git is the thing that has to.
//
// stderr is dropped: git narrates CRLF conversion on every add in these fixtures,
// and that noise would bury a real failure in the suite's output.
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** A real repository with one commit, which is the least `git worktree add` needs. */
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

/** A tracked temp directory standing in for ~/.daftplate/runs. */
// Phase 2: every run-scoped path is per-agent now, and omitting the agent throws
// rather than falling back to the flat layout both agents used to share.
const runsFor = (agent = 'fixer') => ({ runsDir: emptyDir(), agent });

const commitInto = (dir, name) => {
  writeFileSync(join(dir, name), 'x\n');
  git(['add', name], dir);
  git(['commit', '-m', `add ${name}`], dir);
  return git(['rev-parse', 'HEAD'], dir).trim();
};

test('repoKey separates two checkouts that share a basename', () => {
  // Without this they would share a runs root and therefore a claim ledger, and a
  // claim on one would silently block the other.
  const a = repoKey('X:/one/daftplate');
  const b = repoKey('X:/two/daftplate');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('daftplate-'), a);
  assert.equal(repoKey('X:/one/daftplate'), a, 'the key is stable for one path');
});

test('the runs root and the worktree path sit under the injected runs dir', () => {
  const io = runsFor();
  const root = runsRoot('X:/one/daftplate', io);
  assert.ok(containedIn(io.runsDir, root), root);
  assert.ok(containedIn(root, worktreePath('X:/one/daftplate', 'fixer-1', io)));
});

test('createWorktree produces a real checkout on a new branch, and records its base', () => {
  const repo = repoWithCommit();
  const io = runsFor();
  const made = createWorktree({ repoRoot: repo, runId: 'fixer-1', branch: 'fix/1-a' }, io);
  assert.equal(made.ok, true, made.message);
  assert.ok(existsSync(join(made.path, 'README.md')));
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], made.path).trim(), 'fix/1-a');
  assert.equal(made.baseCommit, git(['rev-parse', 'HEAD'], repo).trim());
});

test('createWorktree refuses a path that already exists rather than reusing it', () => {
  const repo = repoWithCommit();
  const io = runsFor();
  mkdirSync(worktreePath(repo, 'fixer-1', io), { recursive: true });
  const made = createWorktree({ repoRoot: repo, runId: 'fixer-1', branch: 'fix/1-a' }, io);
  assert.equal(made.ok, false);
  assert.equal(made.reason, 'worktree-exists');
});

test('the happy path: a reported run still at its base commit is reaped', () => {
  const repo = repoWithCommit();
  const io = runsFor();
  const made = createWorktree({ repoRoot: repo, runId: 'run-ok', branch: 'fix/1-ok' }, io);
  const reaped = reapWorktree(made.path, { state: OUTCOME_REPORTED }, io);
  assert.equal(reaped.ok, true, JSON.stringify(reaped));
  assert.equal(existsSync(made.path), false);
  assert.equal(ownedWorktrees().some((r) => r.path === made.path), false,
    'a reaped worktree leaves the ownership record, or a stale record authorizes a second removal');
});

test('the happy path: a published run at the published commit is reaped', () => {
  const repo = repoWithCommit();
  const io = runsFor();
  const made = createWorktree({ repoRoot: repo, runId: 'run-pub', branch: 'fix/2-pub' }, io);
  const head = commitInto(made.path, 'fix.txt');
  const reaped = reapWorktree(made.path, { state: OUTCOME_PUBLISHED, commit: head }, io);
  assert.equal(reaped.ok, true, JSON.stringify(reaped));
  assert.equal(existsSync(made.path), false);
});

// --- the four negative cases the plan names -------------------------------

test('negative 1 — a worktree it did not create is refused', () => {
  const repo = repoWithCommit();
  const io = runsFor();
  const path = worktreePath(repo, 'run-foreign', io);
  git(['worktree', 'add', '-b', 'fix/9-foreign', path, 'HEAD'], repo);
  // Made by git at exactly the path the runner would have used, and never
  // recorded. A prefix or a scan of the runs root would call this ours.
  const reaped = reapWorktree(path, { state: OUTCOME_REPORTED }, io);
  assert.equal(reaped.ok, false);
  assert.equal(reaped.reason, REAP_REFUSALS.NOT_OURS);
  assert.equal(existsSync(path), true, 'the refused worktree was removed anyway');
});

test('negative 2 — a dirty worktree is refused, untracked content included', () => {
  const repo = repoWithCommit();
  const io = runsFor();
  const made = createWorktree({ repoRoot: repo, runId: 'run-dirty', branch: 'fix/3-dirty' }, io);
  writeFileSync(join(made.path, 'scratch.txt'), 'work that exists nowhere else\n');
  const reaped = reapWorktree(made.path, { state: OUTCOME_REPORTED }, io);
  assert.equal(reaped.ok, false);
  assert.equal(reaped.reason, REAP_REFUSALS.DIRTY);
  assert.equal(existsSync(join(made.path, 'scratch.txt')), true);
});

test('negative 3 — an interrupted run is refused: no terminal outcome, no reap', () => {
  const repo = repoWithCommit();
  const io = runsFor();
  const made = createWorktree({ repoRoot: repo, runId: 'run-int', branch: 'fix/4-int' }, io);
  for (const outcome of [undefined, null, {}, { state: 'running' }, { state: 'stopped' }]) {
    const reaped = reapWorktree(made.path, outcome, io);
    assert.equal(reaped.ok, false, `${JSON.stringify(outcome)} was reaped`);
    assert.equal(reaped.reason, REAP_REFUSALS.NOT_TERMINAL);
  }
  assert.equal(existsSync(made.path), true);
});

test('negative 4 — a run whose PR never opened keeps its commits', () => {
  const repo = repoWithCommit();
  const io = runsFor();
  const made = createWorktree({ repoRoot: repo, runId: 'run-nopr', branch: 'fix/5-nopr' }, io);
  const head = commitInto(made.path, 'attempt.txt');
  // It reported. It published nothing. The commit exists in this worktree and
  // nowhere else, so the tree being clean is not enough.
  const reaped = reapWorktree(made.path, { state: OUTCOME_REPORTED }, io);
  assert.equal(reaped.ok, false);
  assert.equal(reaped.reason, REAP_REFUSALS.UNPUBLISHED_COMMITS);
  assert.equal(reaped.head, head);
  assert.equal(existsSync(made.path), true);
});

// --- the gates around them -------------------------------------------------

test('a published run holding commits beyond what was published is refused', () => {
  const repo = repoWithCommit();
  const io = runsFor();
  const made = createWorktree({ repoRoot: repo, runId: 'run-ahead', branch: 'fix/6-ahead' }, io);
  const published = commitInto(made.path, 'one.txt');
  commitInto(made.path, 'two.txt');
  const reaped = reapWorktree(made.path, { state: OUTCOME_PUBLISHED, commit: published }, io);
  assert.equal(reaped.ok, false);
  assert.equal(reaped.reason, REAP_REFUSALS.UNPUBLISHED_COMMITS);
  assert.equal(existsSync(made.path), true);
});

test('losing the in-process record is losing the authority to remove', () => {
  // The crashed-run case as the module actually experiences it: a later process
  // finds the worktree on disk with no record of having made it. Nothing about
  // the directory changes here — only what this process can vouch for.
  const repo = repoWithCommit();
  const io = runsFor();
  const made = createWorktree({ repoRoot: repo, runId: 'run-crash', branch: 'fix/7-crash' }, io);
  forgetOwnedWorktrees();
  const reaped = reapWorktree(made.path, { state: OUTCOME_REPORTED }, io);
  assert.equal(reaped.reason, REAP_REFUSALS.NOT_OURS);
  assert.equal(existsSync(made.path), true);
});

test('a directory replaced at the same name since creation is refused', (t) => {
  const repo = repoWithCommit();
  const io = runsFor();
  const made = createWorktree({ repoRoot: repo, runId: 'run-swap', branch: 'fix/8-swap' }, io);
  const record = ownedWorktrees().find((r) => r.path === made.path);
  if (record.ino === 0) {
    // Identity is unavailable on this filesystem rather than mismatched, and the
    // module says so; a skip here is honest where a pass would not be.
    t.skip('this filesystem reports ino 0, so directory identity cannot be measured');
    return;
  }
  // Recreate the directory at the same path: same name, different object.
  execFileSync('git', ['worktree', 'remove', '--force', made.path], { cwd: repo });
  mkdirSync(made.path, { recursive: true });
  const reaped = reapWorktree(made.path, { state: OUTCOME_REPORTED }, io);
  assert.equal(reaped.ok, false);
  assert.equal(reaped.reason, REAP_REFUSALS.REPLACED);
});

test('a removal git refuses is reported, never forced, and stays reapable', () => {
  // The Windows case: a directory with an open handle. Injected rather than
  // staged, because a test that really held a handle open would be racing the
  // platform for its own assertion.
  const repo = repoWithCommit();
  const io = runsFor();
  const made = createWorktree({ repoRoot: repo, runId: 'run-locked', branch: 'fix/10-locked' }, io);
  const calls = [];
  const refusingGit = (args, cwd) => {
    calls.push(args);
    if (args.includes('remove')) {
      return { status: 1, stdout: '', stderr: 'fatal: failed to delete: Permission denied' };
    }
    return { status: 0, stdout: execFileSync('git', args.slice(2), { cwd: args[1], encoding: 'utf8' }), stderr: '' };
  };
  const reaped = reapWorktree(made.path, { state: OUTCOME_REPORTED }, { ...io, git: refusingGit });
  assert.equal(reaped.ok, false);
  assert.equal(reaped.reason, REAP_REFUSALS.REMOVAL_REFUSED);
  assert.match(reaped.message, /Permission denied/);
  assert.equal(calls.some((a) => a.includes('--force')), false, 'a refused removal was retried with --force');
  assert.equal(existsSync(made.path), true);
  assert.equal(ownedWorktrees().some((r) => r.path === made.path), true,
    'a refused removal dropped the record, so the retry would be refused as not-ours');
});

test('containedIn is boundary-aware, so a sibling root is not a child', () => {
  assert.equal(containedIn('X:/runs', join('X:/runs', 'a')), true);
  assert.equal(containedIn('X:/runs', 'X:/runs-other/a'), false);
  assert.equal(containedIn('X:/runs', 'X:/runs'), false);
});

test('a reap leaves the branch behind, and createWorktree says so by name', () => {
  // The defect a pre-landing review found and this reproduces: `git worktree
  // remove` removes the checkout and leaves `refs/heads/<branch>` standing, so the
  // second run on one issue meets its own leftover. Measured, not reasoned about.
  const repo = repoWithCommit();
  const io = runsFor();
  const made = createWorktree({ repoRoot: repo, runId: 'run-a', branch: 'fix/193-a' }, io);
  assert.equal(reapWorktree(made.path, { state: OUTCOME_REPORTED }, io).ok, true);
  assert.equal(existsSync(made.path), false, 'the worktree survived the reap');
  assert.equal(branchExists(repo, 'fix/193-a'), true, 'the reap deleted the branch — it must not');

  const again = createWorktree({ repoRoot: repo, runId: 'run-b', branch: 'fix/193-a' }, io);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'branch-exists',
    'the branch collision is reported as add-failed, which a caller cannot tell from a real failure');
  assert.equal(again.branch, 'fix/193-a');
});

test('branchExists answers about refs, not about worktrees', () => {
  const repo = repoWithCommit();
  assert.equal(branchExists(repo, 'fix/1-nothing'), false);
  assert.equal(branchExists(repo, 'main'), true);
  // A ref name that does not exist must not be confused with one that does by
  // prefix: `rev-parse --verify` is exact, and this pins that it stays exact.
  assert.equal(branchExists(repo, 'mai'), false);
});

// ---------------------------------------------------------------------------
// The run-id charset — `#214 (FORGE-274)` S1b
// ---------------------------------------------------------------------------

test('assertRunIdAgent refuses a run id carrying a path separator', () => {
  // Every run-scoped path family joins the run id straight onto a directory —
  // `join(agentRoot(repoRoot, opts), 'worktrees', runId)` here, and the same
  // shape in `recordPath`, `stopPath`, `settingsPath`, `reproductionPath` and
  // `bodyPath`. `join` resolves `..`, so an id of `../../x` does not name a run
  // inside the runs root; it names a directory outside it. This guard is the one
  // place every one of those families already passes through, so it is where the
  // refusal belongs — once, rather than six times.
  //
  // The charset is `^[A-Za-z0-9][A-Za-z0-9-]*$`, not the lowercase-only class a
  // first draft proposed. `newRunId` mints
  // `fixer-193-20260828T200000Z` — uppercase `T`, trailing `Z` — so
  // `^[a-z0-9-]+$` would refuse every id the minter produces.
  //
  // A dot is refused deliberately even though `.` alone traverses nowhere: `..`
  // is the payload, and a class that admits one admits the other.
  const io = { runsDir: 'X:/runs', agent: 'fixer' };
  const refused = [
    '../../x',            // the payload, as a whole id
    String.raw`..\x`,     // the same on Windows, where `\` is also a separator
    'a/b',                // a separator without a traversal is still two segments
    String.raw`a\b`,
    '.',                  // traverses nowhere alone, refused so `..` cannot arrive
    '..',
    '',                   // an empty segment collapses into its parent
    '-lead',              // a leading `-` is an argv option to anything shelled out
    'a b',                // whitespace
    'a.b',                // the dot, wherever it sits
    'a\u0000b',           // a NUL truncates the path in the syscall layer
  ];
  for (const bad of refused) {
    assert.throws(() => assertRunIdAgent(bad, io), /run id/,
      `\`${bad}\` was accepted as a run id`);
  }

  // The guard must not become the naming-convention enforcement it was
  // deliberately narrowed away from: an id naming no agent contradicts nothing
  // and must still resolve.
  for (const good of ['fixer-193-20260828T200000Z', 'fixer-1', 'run-iso', 'run-a', 'anything', 'a', '0']) {
    assert.doesNotThrow(() => assertRunIdAgent(good, io), `\`${good}\` was refused`);
  }
  assert.doesNotThrow(
    () => assertRunIdAgent('hunter-193-20260828T200000Z', { runsDir: 'X:/runs', agent: 'hunter' }),
  );

  // A non-string never reaches `join` as a segment either — `String(runId)` of
  // `undefined` is the literal `undefined`, a directory nobody meant to make.
  for (const bad of [undefined, null, 5, {}, ['fixer-1']]) {
    assert.throws(() => assertRunIdAgent(bad, io), /run id/);
  }
});

test('RUN_ID_CHARSET is exported, so the segment refusal builds on it rather than beside it', () => {
  // `plan-agents` P5 adds a traversal-SEGMENT refusal on top of this charset.
  // Exporting the class is what makes that an addition rather than a second,
  // silently divergent spelling of the same rule.
  assert.equal(RUN_ID_CHARSET instanceof RegExp, true);
  assert.equal(RUN_ID_CHARSET.test('fixer-193-20260828T200000Z'), true);
  assert.equal(RUN_ID_CHARSET.test('../../x'), false);
  assert.equal(RUN_ID_CHARSET.test('-lead'), false);
  assert.equal(RUN_ID_CHARSET.test(''), false);
  // Not sticky and not global: a `lastIndex` carried between calls would make
  // the guard answer differently on the second identical id.
  assert.equal(RUN_ID_CHARSET.global, false);
  assert.equal(RUN_ID_CHARSET.sticky, false);
});
