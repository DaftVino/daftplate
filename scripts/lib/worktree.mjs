// The worktree lifecycle for an unattended run: where a run's throwaway checkout
// lives, who is allowed to remove it, and — mostly — who is not.
//
// Phase 2 of docs/designs/2026-08-27-plan-delegated-fix-loop.md, for #193 (FORGE-259).
// It creates and reaps; it invokes no agent and publishes nothing.
//
// CLAUDE.md #5 is the whole design here: nothing deletes what it did not create.
// A worktree holds a full checkout plus whatever the run wrote into it, so a
// mistaken removal destroys work that exists nowhere else. The authority for a
// removal is therefore the in-process creation record below and nothing else —
// never a path prefix, never a scan of the runs root, never the claim file. That
// is the rule tests/helpers/make-repo.mjs arrived at for the same reason, and it
// is reused deliberately rather than re-argued: another process's run can share
// our runs root, and a scan cannot tell its directories from ours.
//
// The consequence is intended: a worktree left behind by a run that crashed is
// reported and never reaped, because the process that could vouch for it is gone.
import { spawnSync } from 'node:child_process';
import { lstatSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { AGENTS } from './agent-registry.mjs';

/** The ids a run id may lead with. Read from the registry so a third agent needs
 *  no edit here. */
const AGENT_IDS = AGENTS.map((a) => a.id);

/** The two run outcomes that authorize a reap, and the only two.
 *
 *  `published` — the branch is pushed and the PR is open (plan Phase 4). The
 *  `commit` field names what was published, so the reaper can check the worktree
 *  holds nothing beyond it.
 *
 *  `reported` — a report was filed and nothing was published. Nothing published
 *  means any commit above the base is unpublished work, so the reaper requires
 *  HEAD to still be the base commit.
 *
 *  Every other state — a run still going, a run stopped at its budget, a run that
 *  threw — is non-terminal and reaps nothing. */
export const OUTCOME_PUBLISHED = 'published';
export const OUTCOME_REPORTED = 'reported';

/** Refusal reasons, exported so a caller can branch on one without matching prose. */
export const REAP_REFUSALS = {
  NOT_OURS: 'not-ours',
  REPLACED: 'replaced',
  NOT_TERMINAL: 'not-terminal',
  DIRTY: 'dirty',
  UNPUBLISHED_COMMITS: 'unpublished-commits',
  REMOVAL_REFUSED: 'removal-refused',
};

// Every worktree this process created, with the two facts a removal needs: the
// path, and the filesystem identity measured immediately after creation. Module
// scope, so it dies with the process — which is the point.
const created = [];

/** The default git runner. Injected in tests as `opts.git`, the way
 *  atomic-write.mjs takes `opts.rename`, so a code path that cannot be reached on
 *  demand — a removal git refuses because Windows holds a handle open — is still
 *  testable without pretending it was reached. */
function defaultGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

const gitOf = (opts) => opts.git ?? defaultGit;

/**
 * A filesystem-safe, collision-free directory name for a repository.
 *
 * The basename alone is not enough: two checkouts of the same repository, or two
 * repositories of the same name under different parents, would share a runs root
 * and therefore a claim ledger, so a claim on one would silently block the other.
 * The digest of the absolute path is what separates them; the basename is carried
 * only so a human reading the runs root can tell which is which.
 */
export function repoKey(repoRoot) {
  const abs = resolve(repoRoot);
  return `${basename(abs)}-${createHash('sha256').update(abs).digest('hex').slice(0, 8)}`;
}

/**
 * Where this repository's runs live: worktrees, and the claim ledger beside them.
 *
 * Outside the repository and outside every worktree, because ADR 0008 row 9 needs
 * a record that survives the worktree it describes, and because a run directory
 * inside the checkout is a directory the run itself can commit by accident.
 */
export function runsRoot(repoRoot, opts = {}) {
  const base = opts.runsDir ?? join(homedir(), '.daftplate', 'runs');
  return join(base, repoKey(repoRoot));
}

/** The message every agent-less path build fails with. Exported so a test can
 *  match it without pinning the whole sentence. */
export const MISSING_AGENT = 'a run-scoped path needs the agent that owns it'
  + ' — omitting it would write to the flat pre-Phase-2 layout that two agents shared';

/**
 * Where one agent's runs live, inside this repository's runs root.
 *
 * **The segment exists because `claimPath` keyed on the issue number alone**, so
 * the hunter reading `#193` took the claim the fixer was holding. That is
 * structural rather than hypothetical: one ledger, one file per issue, two
 * agents.
 *
 * It **throws** rather than defaulting. A missing agent is not a caller asking
 * for the repository-wide root; it is a caller that forgot, and the value it
 * would silently get back is the exact path both agents used to share. Refusing
 * is the only answer that cannot reintroduce the collision by omission.
 */
export function agentRoot(repoRoot, opts = {}) {
  if (!opts.agent) throw new Error(MISSING_AGENT);
  return join(runsRoot(repoRoot, opts), opts.agent);
}

/**
 * The known agent id `runId` leads with, or `null` if it names none.
 *
 * Exported so a caller doing *discovery* — resolving a run by id before it knows
 * which agent produced it, the case `agent-fixer.mjs --stop <run id>` is in —
 * can find the right directory without re-deriving this parsing, and without
 * going through `assertRunIdAgent`, which is a write-time guard and throws on
 * exactly the disagreement a lookup needs to resolve rather than refuse.
 */
export function agentForRunId(runId) {
  if (typeof runId !== 'string') return null;
  return AGENT_IDS.find((id) => runId.startsWith(`${id}-`)) ?? null;
}

/**
 * The characters a run id may be built from.
 *
 * A run id is not a label; it is a **path segment**. Every run-scoped family
 * joins it straight onto a directory — `join(agentRoot(…), 'worktrees', runId)`,
 * and the same shape in `recordPath`, `stopPath`, `settingsPath`,
 * `reproductionPath` and `bodyPath`. `join` resolves `..`, so `../../x` in that
 * position does not name a run inside the runs root; it names a directory
 * outside it, and every one of those families would then read and write there.
 *
 * The class is `^[A-Za-z0-9][A-Za-z0-9-]*$`, and it is measured against the
 * minter rather than chosen. `newRunId` (`scripts/agent-fixer.mjs`) produces
 * `` `${agent}-${issue}-${at.toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z` ``
 * — `fixer-193-20260828T200000Z`, with an uppercase `T` and a trailing `Z`. The
 * lowercase-only `^[a-z0-9-]+$` a first draft proposed refuses every id the
 * minter produces, and every fixture id in the suite with it.
 *
 * What it refuses is deliberate on each count: both separators, whitespace, the
 * empty string, and a leading `-` (which is an argv option to anything the id is
 * shelled out to). **The dot is refused although `.` alone traverses nowhere** —
 * `..` is the payload, and a class that admits one admits the other.
 *
 * Exported so a narrower rule is built *on* it rather than beside it. Two
 * spellings of the same refusal in two files is how one of them silently stops
 * agreeing with the other.
 */
export const RUN_ID_CHARSET = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * Guard for the families that take a run id as well as an agent.
 *
 * Two checks, in order, and they answer different questions.
 *
 * **The shape** — is this id usable as a path segment at all? See
 * `RUN_ID_CHARSET`. It is checked first because a malformed id is malformed
 * whichever agent asked for it.
 *
 * **The agreement** — a run id leads with the agent that produced it, so the two
 * arguments can disagree, and a caller threading the wrong `opts` writes agent
 * A's record into agent B's directory, which is the collision from the other
 * side. Checked rather than trusted, because both values are usually correct and
 * the bug is silent when they are not.
 */
export function assertRunIdAgent(runId, opts = {}) {
  const agent = opts.agent;
  if (!agent) throw new Error(MISSING_AGENT);
  // The shape check. A non-string is refused before the class is applied: it
  // would otherwise reach `join` through a `String(runId)` and make a directory
  // literally named `undefined`.
  if (typeof runId !== 'string' || !RUN_ID_CHARSET.test(runId)) {
    throw new Error(`run id \`${String(runId)}\` is not ${RUN_ID_CHARSET.source}`
      + ' — a run id becomes a path segment, so a separator or a dot in it names'
      + ' a directory outside the runs root rather than a run inside it');
  }
  // Only a run id that names a DIFFERENT known agent is a disagreement. An id
  // that names no agent at all — a fixture's `run-iso`, a caller's own scheme —
  // contradicts nothing, and rejecting it would be enforcing a naming convention
  // rather than catching the bug. The bug is narrow and specific: agent A's
  // record written into agent B's directory because the wrong opts were threaded.
  const named = agentForRunId(runId);
  if (named && named !== agent) {
    throw new Error(`run id \`${runId}\` names agent \`${named}\`, but the path was asked for under \`${agent}\``);
  }
  return agent;
}

/** Where a run's worktree goes. Exported so the claim ledger can name a path it
 *  does not create, which is the one direction that dependency may run. */
export function worktreePath(repoRoot, runId, opts = {}) {
  assertRunIdAgent(runId, opts);
  return join(agentRoot(repoRoot, opts), 'worktrees', runId);
}

/**
 * True when `branch` is already a local ref in `repoRoot`.
 *
 * Exported because the runner has to choose a name nothing holds, and the only
 * other way to learn that is to attempt the add and read git's English out of a
 * failure — a refusal message is not an API.
 */
export function branchExists(repoRoot, branch, opts = {}) {
  const git = gitOf(opts);
  const ref = git(['-C', resolve(repoRoot), 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return ref.status === 0;
}

/**
 * Create the run's worktree on a fresh branch cut from `base`.
 *
 * `git worktree add` refuses an existing non-empty directory and refuses a branch
 * that already exists; both refusals are kept rather than worked around. A run id
 * colliding with a live worktree is a runner bug, and creating the second one
 * anyway is how two runs come to share a checkout.
 *
 * The branch refusal is given its own reason rather than left inside `add-failed`,
 * because it is the one a correct runner meets on a correct path. Reaping a
 * worktree removes the checkout and **leaves the branch** — deliberately: the
 * branch may hold the commits a pull request was opened from, and deleting it
 * would be deleting work (CLAUDE.md #5). So the second run on one issue meets its
 * own leftover, and the caller needs to tell that apart from a real failure.
 */
export function createWorktree({ repoRoot, runId, branch, base = 'HEAD' }, opts = {}) {
  const git = gitOf(opts);
  const path = worktreePath(repoRoot, runId, opts);
  if (existsSync(path)) return { ok: false, reason: 'worktree-exists', path };
  if (branchExists(repoRoot, branch, opts)) {
    return { ok: false, reason: 'branch-exists', path, branch };
  }

  const add = git(['-C', resolve(repoRoot), 'worktree', 'add', '-b', branch, path, base]);
  if (add.status !== 0) {
    return { ok: false, reason: 'add-failed', path, message: (add.stderr || add.stdout).trim() };
  }

  // Measured now rather than at reap time: it is what proves the directory removed
  // later is the same object created here and not a replacement at the same name.
  const { ino, dev } = lstatSync(path);
  const head = git(['-C', path, 'rev-parse', 'HEAD']);
  const baseCommit = head.status === 0 ? head.stdout.trim() : null;
  const record = { path, repoRoot: resolve(repoRoot), runId, branch, baseCommit, ino, dev };
  created.push(record);
  return { ok: true, ...record };
}

/** The worktrees this process created, newest last. A copy: a caller that mutated
 *  the live record would be granting itself removal authority. */
export function ownedWorktrees() {
  return created.map((r) => ({ ...r }));
}

/** Test seam. Clears the in-process record without touching a single file, so a
 *  test can prove a worktree this process really did create is refused once the
 *  record is gone — the interrupted-run case measured rather than reasoned about. */
export function forgetOwnedWorktrees() {
  created.length = 0;
}

function identityMatches(record) {
  let stat;
  try {
    stat = lstatSync(record.path);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;
  // ino is 0 on some Windows filesystems, where identity is unavailable rather
  // than mismatched; the creation record still holds. make-repo.mjs's caveat.
  if (record.ino === 0) return true;
  return stat.ino === record.ino && stat.dev === record.dev;
}

/**
 * Remove a worktree this process created, if every gate holds.
 *
 * `outcome` is `{ state, commit }`. The gates, in order, and each is a case the
 * plan names:
 *
 *  1. `not-ours` — no creation record for this path. Covers a worktree left by
 *     another process, a directory passed in by hand, and the developer's own
 *     checkout.
 *  2. `replaced` — the record exists, but the directory at that path is no longer
 *     the object we made.
 *  3. `not-terminal` — the run has not reached `published` or `reported`. An
 *     interrupted run lands here, and so does one stopped at its budget.
 *  4. `dirty` — the worktree holds uncommitted or untracked content.
 *  5. `unpublished-commits` — HEAD is not what was published, or, with nothing
 *     published, is no longer the base commit. This is the run whose PR never
 *     opened: it reported, it holds commits, and those commits exist nowhere else.
 *  6. `removal-refused` — git would not remove it. On Windows an open handle is
 *     enough, so this is a real path rather than a theoretical one. It is
 *     reported and never forced: `--force` here discards exactly the work gates 4
 *     and 5 exist to protect.
 */
export function reapWorktree(path, outcome, opts = {}) {
  const git = gitOf(opts);
  const record = created.find((r) => r.path === path);
  if (!record) return { ok: false, reason: REAP_REFUSALS.NOT_OURS, path };
  if (!identityMatches(record)) return { ok: false, reason: REAP_REFUSALS.REPLACED, path };

  const state = outcome?.state;
  if (state !== OUTCOME_PUBLISHED && state !== OUTCOME_REPORTED) {
    return { ok: false, reason: REAP_REFUSALS.NOT_TERMINAL, path, state: state ?? null };
  }

  const status = git(['-C', path, 'status', '--porcelain']);
  if (status.status !== 0) {
    return { ok: false, reason: REAP_REFUSALS.DIRTY, path, message: 'the worktree state could not be read' };
  }
  if (status.stdout.trim() !== '') {
    return { ok: false, reason: REAP_REFUSALS.DIRTY, path, message: status.stdout.trim() };
  }

  // What HEAD is allowed to be: the published commit, or — with nothing published
  // — the commit the worktree started from.
  const expected = state === OUTCOME_PUBLISHED ? outcome.commit : record.baseCommit;
  const head = git(['-C', path, 'rev-parse', 'HEAD']);
  const at = head.status === 0 ? head.stdout.trim() : null;
  if (!expected || !at || at !== expected) {
    return {
      ok: false, reason: REAP_REFUSALS.UNPUBLISHED_COMMITS, path, head: at, expected: expected ?? null,
    };
  }

  const removed = git(['-C', record.repoRoot, 'worktree', 'remove', path]);
  if (removed.status !== 0) {
    return {
      ok: false,
      reason: REAP_REFUSALS.REMOVAL_REFUSED,
      path,
      message: (removed.stderr || removed.stdout).trim(),
    };
  }
  created.splice(created.indexOf(record), 1);
  return { ok: true, path };
}

/** True when `path` sits inside `root`. Boundary-aware, so a sibling `…/runs-other`
 *  cannot masquerade as a child of `…/runs`. make-repo.mjs's containment gate. */
export function containedIn(root, path) {
  return resolve(path).startsWith(resolve(root) + sep);
}
