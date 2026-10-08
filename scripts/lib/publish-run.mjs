// The publisher step of the delegated-fix loop: the one part of a run that holds
// a GitHub credential, and the one part that runs after the agent process has
// exited.
//
// Phase 4 of docs/designs/2026-08-27-plan-delegated-fix-loop.md, for
// #193 (FORGE-259). It pushes one branch and opens one pull request. It does not
// enable the feature — ADR 0008's Consequences gate enablement on an owner-held
// act, and nothing here performs one.
//
// **This file is small on purpose, and the smallness is the D1 decision made
// concrete.** The spec's *The publication boundary* adopted a construction whose
// whole content is that the process that writes code is not the process that
// publishes it. The publisher is what makes that true of the processes rather
// than only of the prose, and it does so by holding three inputs — the worktree
// path, the branch name, the issue number — and making **no judgement about the
// diff**. It does not review, does not lint, does not decide whether the fix is
// good. A publisher that judged would be a second agent, and the boundary would
// be back where it started.
//
// Two things it does judge, and both are decided elsewhere rather than here.
//
// **Whether a pull request is opened at all.** The spec (*The failure cases,
// decided*) settles it: a draft PR is opened **if and only if** the run produced
// a reproduction — a test that fails on the base commit for the reason the issue
// describes. No reproduction, no PR, a comment instead. That predicate is
// measured over the run's own artifacts — the test files the run committed,
// replayed against the commit its worktree was cut from — and never read off
// anything the run said about itself. A self-report is the agent's opinion of its
// own work, and the whole construction exists because that opinion is not the
// thing that should decide publication.
//
// **Whether the strings it assembles are clean.** Every body goes out through
// `--body-file`, and the attribution hook reads `tool_input.command` only, so a
// body file walks straight past it. `assertNoAttribution` is the replacement gate
// and it runs before any outbound call, on every body, without exception.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { linearBoard, SHORT_NAME } from '../check-roadmap.mjs';
import { join, resolve, dirname } from 'node:path';
import {
  runsRoot, agentRoot, assertRunIdAgent, OUTCOME_PUBLISHED, OUTCOME_REPORTED,
} from './worktree.mjs';
import {
  INVOKE_REFUSALS, writeIsolation, isolatedEnv, verifyIsolation,
} from './agent-invoke.mjs';

/**
 * `type/N-slug`, the literal pattern `setup-repo.mjs`'s pre-push hook enforces.
 *
 * Held here rather than imported because the hook is a POSIX `sh` string built
 * for `grep -E` and is not a JavaScript regex; a test asserts the two are the
 * same pattern, so the guard and the gate cannot drift apart. Checked before the
 * push rather than left to the hook for a reason the plan names: a run whose
 * branch the hook refuses has done all of its work and cannot publish any of it,
 * and a refusal that arrives at push time is a refusal that arrives too late to
 * say anything useful.
 */
export const BRANCH_PATTERN = new RegExp('^[a-z]+/[1-9][0-9]*-[a-z0-9]+(-[a-z0-9]+)*$');

/**
 * The pull request is **always** a draft.
 *
 * Not a parameter, for `agent-invoke.mjs`'s reason about the permission mode: a
 * flag a caller can choose is a flag a caller can choose wrong. The spec decided
 * the rule as *draft iff reproduction*, so the only thing left to decide is
 * whether a PR is opened, and that is `assessReproduction`'s answer. Marking one
 * ready for review is a human's act on a run nobody watched.
 */
export const DRAFT_FLAG = '--draft';

/** Refusal reasons, exported so a caller branches on one rather than on prose. */
export const PUBLISH_REFUSALS = {
  RUN_REFUSED: 'run-refused',
  NO_BRANCH: 'no-branch',
  BAD_BRANCH: 'branch-not-type-n-slug',
  BRANCH_NAMES_OTHER_ISSUE: 'branch-names-another-issue',
  NO_REPRODUCTION: 'no-reproduction',
  PUSH_REFUSED: 'push-refused',
  PR_REFUSED: 'pr-refused',
};

/** Why a run produced no reproduction. Six answers rather than one, because a
 *  human reading the comment wants to know which of them happened. */
export const REPRODUCTION_REFUSALS = {
  NO_BASE: 'no-base-commit',
  BASE_NOT_ANCESTOR: 'base-not-ancestor',
  DIFF_UNREADABLE: 'diff-unreadable',
  NO_TEST: 'no-test-in-the-diff',
  PASSES_ON_BASE: 'test-passes-on-the-base-commit',
  DID_NOT_LOAD: 'test-did-not-load-on-the-base-commit',
  NOT_MEASURED: 'reproduction-not-measured',
};

/**
 * The tells of an attribution footer, a trailer or a session URL.
 *
 * They appear in this file only here, as the needles of a refusal, so a grep for
 * one over the repository finds the gate rather than an instance — the shape
 * `agent-invoke.mjs` uses for the forbidden flags, and a test pins it.
 *
 * The gate exists because the harness setting cannot reach this path. Typing the
 * same text into a body file walks past a hook that reads `tool_input.command`,
 * and the publisher assembles every one of its bodies that way.
 */
export const ATTRIBUTION_TELLS = [
  'co-authored-by',
  'generated with',
  'claude.com/claude-code',
  'claude.ai/code',
  'signed-off-by',
  '🤖',
];

/** Flags this publisher never passes to `git`. Exact matches, not substrings: a
 *  pull request title legitimately containing the word *force* is not a forced
 *  push, and a guard that could not tell them apart would be turned off. */
export const REFUSED_GIT_FLAGS = [
  '--no-verify', '--force', '-f', '--force-with-lease', '--delete', '--mirror', '--prune',
];

/** The only two `gh` commands the publisher may run. An allowlist rather than a
 *  denylist, because ADR 0008 row 6 forbids a merge and row 6's cost of being
 *  wrong is unrecoverable — `gh pr merge` cannot be un-run. Anything not named
 *  here is refused whether or not anybody thought of it. */
export const ALLOWED_GH_COMMANDS = [['pr', 'create'], ['issue', 'comment']];

// ---------------------------------------------------------------------------
// The guards
// ---------------------------------------------------------------------------

/**
 * Refuse a body that carries an attribution footer, a trailer or a session URL,
 * or that does not end at its last substantive line.
 *
 * Throws rather than returning a verdict. A body that fails this is a bug in the
 * formatter that built it, not a decision a caller is entitled to make, and
 * crashing before the outbound call is the safe direction.
 */
export function assertNoAttribution(body, what = 'body') {
  const text = String(body ?? '');
  const lower = text.toLowerCase();
  for (const tell of ATTRIBUTION_TELLS) {
    if (lower.includes(tell.toLowerCase())) {
      throw new Error(`refused: the ${what} carries an attribution tell (${JSON.stringify(tell)})`);
    }
  }
  if (text.trimEnd() === '') throw new Error(`refused: the ${what} is empty`);
  // Exactly one trailing newline. Trailing blank lines are where an appended
  // block lands, and a body that already ends in whitespace hides one.
  if (text !== `${text.trimEnd()}\n`) {
    throw new Error(`refused: the ${what} does not end at its last substantive line`);
  }
  return text;
}

/** Refuse a branch that is not `type/N-slug`, or that is `type/N-slug` for some
 *  other issue than the one being published. The second half matters more than it
 *  looks: the branch number is the one place the GitHub number is unambiguous
 *  (repo-standards §4), so a mismatch there mislabels the work permanently. */
export function assertBranchName(branch, issue) {
  const name = String(branch ?? '');
  if (!name) return { ok: false, reason: PUBLISH_REFUSALS.NO_BRANCH, branch: null };
  if (!BRANCH_PATTERN.test(name)) return { ok: false, reason: PUBLISH_REFUSALS.BAD_BRANCH, branch: name };
  const numbered = Number(name.split('/')[1].split('-')[0]);
  if (Number(issue) !== numbered) {
    return { ok: false, reason: PUBLISH_REFUSALS.BRANCH_NAMES_OTHER_ISSUE, branch: name, names: numbered };
  }
  return { ok: true, branch: name, type: name.split('/')[0] };
}

export function assertGitArgvSafe(argv) {
  const args = [...argv].map(String);
  for (const arg of args) {
    if (REFUSED_GIT_FLAGS.includes(arg)) {
      throw new Error(`refused: the publisher never passes ${arg} to git`);
    }
  }
  return args;
}

export function assertGhArgvSafe(argv) {
  const args = [...argv].map(String);
  const allowed = ALLOWED_GH_COMMANDS.some(([a, b]) => args[0] === a && args[1] === b);
  if (!allowed) {
    throw new Error(
      `refused: the publisher may run only ${ALLOWED_GH_COMMANDS.map((c) => `gh ${c.join(' ')}`).join(' and ')}`
      + ` — not ${JSON.stringify(args.slice(0, 2).join(' '))} (ADR 0008 row 6)`,
    );
  }
  return args;
}

// ---------------------------------------------------------------------------
// The reproduction predicate, measured over the run's own artifacts
// ---------------------------------------------------------------------------

/** A path under a `test`/`tests` directory, or a file named like a test. The
 *  directory half carries helpers and fixtures, which a reproduction test may
 *  import and which must therefore be replayed with it. */
export function isTestPath(path) {
  return /(^|\/)tests?\//i.test(path) || isRunnableTest(path);
}

/** A file the test runner will actually execute. `tests/helpers/make-repo.mjs` is
 *  a test path and is not one of these; replaying it alone would measure nothing. */
export function isRunnableTest(path) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path);
}

function gitOf(opts) {
  return opts.git ?? ((args, cwd) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  });
}

/**
 * How a replay at the base commit reads.
 *
 * Ordered so a test that could not *load* is never counted as a test that
 * *failed*, which is the specific way this predicate could quietly certify
 * nothing. A reproduction test importing a module the fix introduces does not
 * exist at the base commit, so the replay exits non-zero for a reason that says
 * nothing about the issue. Node reports that as a module resolution error and it
 * is distinguishable; where it is not, the answer is `inconclusive` and the run
 * files a comment. The safe direction here is *no pull request*, and it is chosen
 * deliberately over the reverse — the same shape as `classifyLiveCall`'s refusal
 * to read a dead network as an authentication refusal.
 *
 * The phrases matched below are necessary but not sufficient: a test that runs
 * and fails while asserting on a parser's or a resolver's message can quote any
 * of them, so `didNotLoad`, below, also requires the runtime's own fatal report
 * rather than trusting a substring of the combined output.
 *
 * **Every alternative here is load-bearing, and that is asserted rather than
 * assumed.** `err_module_not_found` used to sit between the first and the third
 * and was removed by `#294 (FORGE-345)`: measured against `node --test` on Node
 * v24.16.0, every real output carrying that code also carries *Cannot find
 * module* or *Cannot find package*, because that is the text of the message the
 * code labels. No genuine fixture could isolate it, so removing it killed no
 * test and it was decoration in a predicate whose failure direction is
 * publishing a pull request that proved nothing. The three that remain each have
 * a real fixture no other alternative matches — a CommonJS `require` for the
 * first, a directory import for the second, an unparseable file for the third —
 * and `tests/publish-run.test.mjs` pins that this list and those fixtures stay in
 * step, so a fourth alternative added without one fails the suite.
 *
 * Exported for that test alone, and it is the whole point of exporting it: the
 * alternation cannot be checked for decoration from outside without being
 * readable from outside. */
export const LOAD_FAILURE = /cannot find (module|package)|err_unsupported_dir_import|syntaxerror/i;

/** The interpreter's own epitaph, printed at column 0 on the uncaught-exception
 *  path and by nothing else. `node --test` forwards a crashed child's output
 *  verbatim, so this line is present exactly when a file died before the runner
 *  could report anything about it — which is what *did not load* means, and it is
 *  a fact about the process rather than a phrase a test chose to print.
 *
 *  Measured on Node v24.16.0, this repo's supported engine: a missing ESM import,
 *  a file that does not parse, `ERR_UNSUPPORTED_DIR_IMPORT` and a CJS `require`
 *  of a missing file all print it; a test that runs and fails while quoting
 *  `SyntaxError` or `Cannot find module` in its assertion output does not. The
 *  streams do not separate the two — under `--test` the crash report arrives on
 *  **stdout**, not stderr — so the stream `#277 (FORGE-338)` proposed is not
 *  available and this is what stands in for it. */
const RUNTIME_FATAL = /^Node\.js v\d+\./m;

/** `did-not-load` needs both: the words, and evidence the runtime rather than a
 *  test said them. The words alone suppressed the publication of any reproduction
 *  that asserts on a parser's or a resolver's message — the test ran, it failed
 *  honestly, and its result was discarded as if the module never loaded
 *  (`#277 (FORGE-338)`). Where a replay of several files carries both a crash and
 *  an honest failure this still answers `did-not-load`, which is the safe
 *  direction the classifier was ordered for in the first place. */
function didNotLoad(text) {
  return LOAD_FAILURE.test(text) && RUNTIME_FATAL.test(text);
}

/** The replay's output reaches a published pull request body, so the reporter's
 *  colour codes are removed here rather than left for a reader to squint past. */
const ANSI = new RegExp('\u001b\[[0-9;]*[A-Za-z]', 'g');

/** Node's own process warnings, which arrive on stderr ahead of everything the
 *  replay actually said. Left in, they are the first thing a reader of the pull
 *  request sees and they push the assertion out of the excerpt entirely. */
const NODE_NOISE = /^\((node:\d+|Use `node)/;

export function classifyReproductionRun({ status, stdout = '', stderr = '', error = null }) {
  const text = `${stderr}\n${stdout}`
    .replace(ANSI, '')
    .split(/\r?\n/)
    .filter((line) => !NODE_NOISE.test(line))
    .join('\n');
  if (error || status === null || status === undefined) {
    return { verdict: 'not-measured', detail: String(error ?? 'the replay produced no exit status').slice(0, 400) };
  }
  if (status === 0) return { verdict: 'passed' };
  if (didNotLoad(text)) return { verdict: 'did-not-load', detail: text.trim().slice(0, 800) };
  return { verdict: 'failed', detail: text.trim().slice(0, 1200) };
}

/** Where a replay checkout goes: beside the run's worktree under the runs root,
 *  never inside either the repository or the worktree.
 *
 *  The id is joined on bare. `assertRunIdAgent` has already refused every
 *  non-string and the empty string against `RUN_ID_CHARSET`, so the
 *  `String(runId ?? 'run')` this used to carry could not fire — and a fallback
 *  that cannot fire is a directory name nothing would ever produce, sitting where
 *  a reader would take it for a real default. */
export function reproductionPath(repoRoot, runId, opts = {}) {
  assertRunIdAgent(runId, opts);
  return join(agentRoot(repoRoot, opts), 'reproductions', runId);
}

/**
 * Replay the run's test files against the base commit and report what happened.
 *
 * A detached worktree at the base commit, with the run's test files copied in and
 * nothing else — so what runs is the run's test against unfixed source, which is
 * the spec's definition of a reproduction and not a paraphrase of it.
 *
 * It removes the checkout it made, with `--force`, and the force is legitimate
 * here for a reason worth stating because `reapWorktree` refuses to force in what
 * looks like the same situation. Nothing in this directory exists only in it: it
 * is a detached checkout of an already-committed base plus copies of files whose
 * originals are in the run's worktree. `reapWorktree` guards a directory that may
 * hold the only copy of a run's work, which is the opposite case.
 */
/**
 * The environment a replayed `node --test` child is given.
 *
 * **Exported and pure so the strip is assertable.** It was inline, and nothing
 * tested it: every replay test injects `measure`, so the real spawn path — the
 * only place the strip happens — was never exercised, and a mutant restoring
 * `NODE_TEST_CONTEXT` would have gone green. `#204 (FORGE-265)` AC 11 requires
 * the opposite, and the requirement was unmet until this was lifted out.
 *
 * `NODE_TEST_CONTEXT` is removed, and its removal is load-bearing rather than
 * tidy. A `node --test` that inherits it believes it is a child of a running test
 * runner, reports to that parent instead of to its own exit code, and **exits 0
 * on a failing test**. Measured: the replay of a test that genuinely fails on the
 * base commit came back `passed`, so the predicate said *no reproduction* for
 * every run — the publisher's central gate silently answering no to everything.
 * Anything that spawns this publisher from inside a suite reproduces it.
 *
 * **`isolation` is required, and the refusal is the fix for `#214 (FORGE-274)`.**
 * This function used to default to `process.env` and strip two variables, so the
 * replayed child — code the unattended run wrote — inherited the publisher's
 * credential helper and `gh` configuration and ran as this user. The environment
 * is now built by `agent-invoke.mjs`'s own `isolatedEnv` over the paths
 * `writeIsolation` wrote for this run, which is the construction the generation
 * step is verified against rather than a second one spelled the same way. A
 * signature that could still produce an unisolated environment on a caller's
 * omission is the signature this defect arrived through, so there is no default:
 * the omission throws.
 *
 * Scrubbing the environment is **not** what does the work, and this file must not
 * be read as claiming it is. `agent-invoke.mjs:11-31` records the re-measurement —
 * with every GitHub variable removed and nothing else changed, `git ls-remote
 * origin` still listed refs. `DEFENCE_IN_DEPTH_UNSET` is defence in depth and
 * never the boundary; `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` and `GH_CONFIG_DIR`
 * are.
 */
export function replayEnv(source = process.env, isolation = null) {
  if (!isolation?.gitconfig || !isolation?.empty || !isolation?.ghConfigDir) {
    throw new Error('replayEnv needs the run\'s isolation paths — an environment with no'
      + ' GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM and GH_CONFIG_DIR of its own carries this'
      + ' user\'s credential helper into a child running code the run wrote (#214)');
  }
  const { NODE_TEST_CONTEXT, FORCE_COLOR, ...env } = source ?? process.env;
  return { ...isolatedEnv(isolation, env), NO_COLOR: '1' };
}

/** How the replay's isolation reads on the result, and in the body a human is
 *  handed. Flattened out of `verifyIsolation`'s record deliberately: the two live
 *  calls it made carry whatever the remote said back, and a publisher does not
 *  put a remote's prose into a pull request body. */
function isolationVerdict(verified) {
  return {
    ok: verified.ok === true,
    reason: verified.reason ?? (verified.ok ? 'isolation-verified' : 'isolation-unverified'),
    verdict: verified.isolated_call?.verdict ?? null,
    visibility: verified.visibility ?? null,
  };
}

function defaultMeasure({ repoRoot, worktree, baseCommit, runId, tests, runnable }, opts = {}) {
  const git = gitOf(opts);
  const dir = reproductionPath(repoRoot, runId, opts);
  if (existsSync(dir)) {
    return { status: null, error: `a replay checkout already exists at ${dir}`, stdout: '', stderr: '' };
  }
  const add = git(['-C', resolve(repoRoot), 'worktree', 'add', '--detach', dir, baseCommit]);
  if (add.status !== 0) {
    return { status: null, error: (add.stderr || add.stdout || '').trim(), stdout: '', stderr: '' };
  }
  try {
    for (const rel of tests) {
      const from = join(worktree, rel);
      if (!existsSync(from)) continue;
      const to = join(dir, rel);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
    // The run's own isolation, rewritten idempotently at the path the generation
    // step wrote it to, and then **verified live** rather than trusted. This is
    // the whole of `#214 (FORGE-274)`: what is about to execute is code the
    // unattended agent committed, and until this landed it executed inside the
    // one process ADR 0008 designates as credentialed.
    const isolation = opts.isolation ?? writeIsolation({ repoRoot, runId }, opts);
    const env = replayEnv(process.env, isolation);
    const verified = verifyIsolation({ cwd: dir, env }, opts);
    const isolated = isolationVerdict(verified);

    // A refusal is what the boundary looks like working. `inconclusive` and
    // `anonymous-remote` proceed with the verdict recorded, because a machine
    // with no route to GitHub — or a remote readable without any credential —
    // cannot tell isolation from a broken network, and a publisher that refused
    // every run there would be a publisher that never publishes.
    //
    // `authenticated` against a **private** remote is the one case that is
    // evidence of failure rather than of ambiguity: the credential is present and
    // the isolation did not remove it. Nothing of the run's is executed.
    // `authenticated` with the remote's visibility unknown is left in the
    // proceed-and-record column on purpose — `gh repo view` answers `unknown` for
    // every remote that is not a GitHub repository, a local path included, so
    // refusing on it would refuse every fixture and every non-GitHub remote while
    // proving nothing about a credential.
    if (verified.reason === INVOKE_REFUSALS.NOT_ISOLATED && verified.visibility === 'private') {
      return {
        status: null, stdout: '', stderr: '', isolation: isolated,
        error: 'the replay isolation was refused: the run\'s configuration still'
          + ' authenticates against this remote, so its test files were not executed',
      };
    }

    // `NODE_TEST_CONTEXT` is removed, and its removal is load-bearing rather than
    // tidy. A `node --test` that inherits it believes it is a child of a running
    // test runner, reports to that parent instead of to its own exit code, and
    // **exits 0 on a failing test**. Measured here: the replay of a test that
    // genuinely fails on the base commit came back `passed`, so the predicate
    // said *no reproduction* for every run — the publisher's central gate
    // silently answering no to everything. Anything that spawns this publisher
    // from inside a suite reproduces it.
    //
    // The seam is `opts.replaySpawn` rather than `opts.spawn`: `opts.spawn` is
    // already the *agent's* spawn (`agent-invoke.mjs`), and one loop threads one
    // opts through both steps. Two seams under one name would let a test observing
    // the agent silently observe the replay as well.
    const spawn = opts.replaySpawn ?? spawnSync;
    const r = spawn(process.execPath, ['--test', ...runnable], {
      cwd: dir, encoding: 'utf8', timeout: 600_000, windowsHide: true, env,
    });
    return {
      status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '',
      error: r.error ? String(r.error.message) : null,
      isolation: isolated,
    };
  } finally {
    git(['-C', resolve(repoRoot), 'worktree', 'remove', '--force', dir]);
  }
}

/**
 * Did this run produce a reproduction?
 *
 * The predicate the spec decided, computed from git and from a replay, and from
 * nothing the run reported about itself. `baseCommit` is a fact Phase 2's
 * `createWorktree` measured at creation, and it is verified rather than trusted:
 * a base that is not an ancestor of HEAD is not the commit this worktree was cut
 * from, and every answer below it would be about the wrong pair of trees.
 */
export function assessReproduction({ repoRoot, worktree, baseCommit, runId = null }, opts = {}) {
  const git = gitOf(opts);
  if (!baseCommit) return { ok: false, reason: REPRODUCTION_REFUSALS.NO_BASE, tests: [] };

  const ancestry = git(['-C', worktree, 'merge-base', '--is-ancestor', baseCommit, 'HEAD']);
  if (ancestry.status !== 0) {
    return { ok: false, reason: REPRODUCTION_REFUSALS.BASE_NOT_ANCESTOR, tests: [], baseCommit };
  }

  const diff = git(['-C', worktree, 'diff', '--name-only', '--diff-filter=ACMR', `${baseCommit}..HEAD`]);
  if (diff.status !== 0) {
    return { ok: false, reason: REPRODUCTION_REFUSALS.DIFF_UNREADABLE, tests: [], baseCommit };
  }
  const changed = diff.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tests = changed.filter(isTestPath);
  const runnable = tests.filter(isRunnableTest);
  if (runnable.length === 0) {
    // **"Committed nothing" and "did nothing" are different facts.** A run that wrote
    // a complete fix and never committed it lands here identically to one that never
    // started, and the report used to say the same words about both — so a human
    // closes the issue while a verified fix sits in the worktree. `#316 (FORGE-354)`.
    //
    // Asked only on this path: everywhere else there is a committed diff to reason
    // about, and a dirty tree alongside it is a different question this refusal is
    // not the place to answer.
    const dirty = git(['-C', worktree, 'status', '--porcelain']);
    const uncommitted = dirty.status === 0
      ? dirty.stdout.split(/\r?\n/).map((l) => l.slice(3).trim()).filter(Boolean)
      : [];
    return { ok: false, reason: REPRODUCTION_REFUSALS.NO_TEST, tests, changed, baseCommit, uncommitted };
  }

  const measure = opts.measure ?? defaultMeasure;
  const replay = measure({ repoRoot, worktree, baseCommit, runId, tests, runnable }, opts);
  const verdict = classifyReproductionRun(replay);
  const common = {
    tests, runnable, changed, baseCommit,
    replay: { verdict: verdict.verdict, detail: verdict.detail ?? null },
    // Which of `verifyIsolation`'s three answers the replay ran under, carried so
    // an operator reading the comment or the pull request can see it rather than
    // inferring it from a verdict. `null` only when a caller injected `measure`.
    isolation: replay.isolation ?? null,
  };
  if (verdict.verdict === 'failed') return { ok: true, ...common };
  if (verdict.verdict === 'passed') return { ok: false, reason: REPRODUCTION_REFUSALS.PASSES_ON_BASE, ...common };
  if (verdict.verdict === 'did-not-load') return { ok: false, reason: REPRODUCTION_REFUSALS.DID_NOT_LOAD, ...common };
  return { ok: false, reason: REPRODUCTION_REFUSALS.NOT_MEASURED, ...common };
}

// ---------------------------------------------------------------------------
// The bodies
// ---------------------------------------------------------------------------

const WHY_NO_REPRODUCTION = {
  [REPRODUCTION_REFUSALS.NO_BASE]: 'the run recorded no base commit, so there is nothing to replay against',
  [REPRODUCTION_REFUSALS.BASE_NOT_ANCESTOR]:
    'the recorded base commit is not an ancestor of the worktree\'s HEAD, so it is not the commit this run was cut from',
  [REPRODUCTION_REFUSALS.DIFF_UNREADABLE]: 'the worktree\'s diff against the base commit could not be read',
  [REPRODUCTION_REFUSALS.NO_TEST]: 'the run committed no runnable test file, so it wrote down no reproduction',
  [REPRODUCTION_REFUSALS.PASSES_ON_BASE]:
    'the run\'s tests pass on the base commit, so they do not fail for the reason the issue describes',
  [REPRODUCTION_REFUSALS.DID_NOT_LOAD]:
    'the run\'s tests could not load on the base commit, so their failure there says nothing about the issue',
  [REPRODUCTION_REFUSALS.NOT_MEASURED]: 'the replay against the base commit could not be run at all',
};

/** `<short>-<N>` on a Linear-variant repo, `#N` on any other (§6.5.1, ADR 0014).
 *
 *  **The Linear key never appears.** It was rendered here as `#N (FORGE-M)` until
 *  ADR 0014 took it out of prose. The written form is built from the GitHub
 *  number alone, and neither number is ever computed from the other. */
export function issueReference(issue, shortName = null) {
  return shortName ? `${shortName}-${issue}` : `#${issue}`;
}

/** The repo's short name: its ROADMAP.md `Board:` line's project link text, when
 *  that line names Linear and the text is a slug. Null on any other repo, which is
 *  what keeps a GitHub-Projects repo's generated prose exactly as it was. The parse
 *  is check-roadmap.mjs's, which the parity test already pins. */
export function repoShortName(repoRoot) {
  const path = join(String(repoRoot ?? ''), 'ROADMAP.md');
  if (!repoRoot || !existsSync(path)) return null;
  const board = linearBoard(readFileSync(path, 'utf8'));
  return board?.shortName && SHORT_NAME.test(board.shortName) ? board.shortName : null;
}

/**
 * The pull request title.
 *
 * Issue references are stripped rather than carried: §4.1 bans them from a commit
 * summary line, and a squash merge makes this title exactly that. The branch
 * carries the number, the footer carries the link, and neither needs the summary.
 */
export function pullRequestTitle(branch, issueTitle, shortName = null) {
  const type = String(branch ?? '').split('/')[0] || 'fix';
  // The ADR 0014 form is an issue reference too, so §4.1 bans it from the summary
  // line as firmly as `#N`. The short name is a slug, so it needs no escaping. The
  // trailing guard is the validator's: `daftplate-1.10.0` is a release, not issue 1.
  const own = shortName ? new RegExp(`\\b${shortName}-\\d+(?![\\w-]|\\.\\d)`, 'g') : null;
  const summary = String(issueTitle ?? '')
    .replace(own ?? /(?!)/g, '')
    .replace(/\(?\b[A-Z]{2,}-\d+\b\)?/g, '')
    .replace(/#\d+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim()
    .replace(/^[-–—:]\s*/, '');
  return `${type}: ${summary || 'fix the delegated issue'}`.slice(0, 72).trimEnd();
}

/** The replay's failure, excerpted for a reader rather than dumped at one. The
 *  runner's own tally lines and its frames inside `node:internal` say nothing
 *  about the issue and would push the assertion out of the excerpt. */
const EXCERPT_NOISE = /^\s*(ℹ|at (Test|async|process|node:)|at .*node:internal)/;

function fence(text, lines = 16) {
  const body = String(text ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !EXCERPT_NOISE.test(l))
    .slice(0, lines)
    .join('\n');
  return ['```', body || '(no output)', '```'].join('\n');
}

/**
 * The pull request body.
 *
 * `Fixes #N` is the last line and is the bare GitHub number: the footer is
 * machine-parsed, and §6.5.1 keeps it out of the identifier rule explicitly. The
 * `<short>-<N>` form is in the prose above it, where a human reads it.
 *
 * It ends there, and `assertNoAttribution` is what holds it to that.
 */
export function formatPullRequestBody({
  issue, shortName = null, branch, baseCommit, headCommit = null, runId = null,
  criteria = [], reproduction, agentStatus = null,
}) {
  const ref = issueReference(issue, shortName);
  const short = (sha) => (sha ? String(sha).slice(0, 8) : 'unknown');
  const lines = [
    `Delegated fix for \`${ref}\`, pushed and opened by the runner's publisher`,
    'step. No human stood between the delegation and this pull request, which is',
    'why it is a draft: the review that would have preceded it happens on it.',
    '',
    '## The reproduction, measured on the base commit',
    '',
    `${(reproduction?.runnable ?? []).map((t) => `\`${t}\``).join(', ') || '(none)'} fails at \`${short(baseCommit)}\`,`,
    'the commit this run\'s worktree was cut from, replayed there against unfixed',
    'source:',
    '',
    fence(reproduction?.replay?.detail ?? ''),
    '',
    'That measurement is what opened this pull request. A run that produced no test',
    'failing on the base commit files a comment and pushes nothing — the rule is the',
    'spec\'s (*The failure cases, decided*) and is measured over the run\'s own',
    'artifacts rather than read off anything the run said about itself.',
    '',
    '## Acceptance criteria, as the run sourced them',
    '',
    ...(criteria.length ? criteria.map((c) => `- ${c}`) : ['- (none recorded)']),
    '',
    '## What the publisher did, and what it did not',
    '',
    `It pushed \`${branch}\` and opened this pull request. It made no judgement`,
    'about the diff, ran no merge, and closed nothing: an issue closes only as the',
    'consequence of the footer below on a pull request a human merged (ADR 0008',
    'row 6).',
    '',
    `- run: \`${runId ?? 'unrecorded'}\``,
    `- replay isolation: \`${reproduction?.isolation?.reason ?? 'unrecorded'}\``,
    `- base commit: \`${short(baseCommit)}\``,
    `- head commit: \`${short(headCommit)}\``,
    `- agent exit status: \`${agentStatus === null || agentStatus === undefined ? 'unrecorded' : agentStatus}\``,
    '',
    `Fixes #${issue}`,
  ];
  return assertNoAttribution(`${lines.join('\n')}\n`, 'pull request body');
}

/**
 * The comment a run with no reproduction files instead of opening a pull request.
 *
 * It names the worktree, because the worktree is not reaped: a run that reported
 * rather than published leaves its checkout for inspection, and a comment that
 * did not say where it is would be reporting a dead end.
 */
export function formatNoReproductionComment({
  issue, shortName = null, reason, reproduction = {}, runId = null, worktree = null,
}) {
  const ref = issueReference(issue, shortName);
  const tests = reproduction.tests ?? [];
  const lines = [
    `This run produced no reproduction for \`${ref}\`, so it pushed no branch and`,
    'opened no pull request.',
    '',
    `- refusal: \`${reason}\``,
    `- because: ${WHY_NO_REPRODUCTION[reason] ?? reason}`,
    `- test files in the run's diff: ${tests.length ? tests.map((t) => `\`${t}\``).join(', ') : 'none'}`,
    // Named, not counted. "3 files" sends a reader to the worktree to find out what;
    // the paths let them decide whether it is worth going at all.
    //
    // **A bullet, and the prose that explains it goes below the list.** The first
    // version put the paragraph here, between the bullets, so `- base commit`,
    // `- run` and `- worktree` rendered after it and the list broke in two. That
    // shipped — and for a body whose entire justification is that a human reads it,
    // how it reads is not a detail.
    ...((reproduction.uncommitted ?? []).length
      ? [`- **left uncommitted in the worktree**: ${reproduction.uncommitted.map((f) => `\`${f}\``).join(', ')}`]
      : []),
    ...(reproduction.baseCommit ? [`- base commit: \`${String(reproduction.baseCommit).slice(0, 8)}\``] : []),
    ...(reproduction.isolation ? [`- replay isolation: \`${reproduction.isolation.reason}\``] : []),
    ...(runId ? [`- run: \`${runId}\``] : []),
    ...(worktree ? [`- worktree, left for inspection: \`${worktree}\``] : []),
    '',
    ...((reproduction.uncommitted ?? []).length
      ? ['This run changed files and did not commit them. The publisher replays committed',
        'tests and reads nothing else, so that work was not considered — but it is still',
        'there, and it may be complete. Look before re-delegating.',
        '']
      : []),
    'A draft pull request is opened if and only if the run produced a reproduction —',
    'a test that fails on the base commit for the reason the issue describes. The',
    'predicate is measured by replaying the run\'s own committed test files against',
    'the commit its worktree was cut from; it is not read off the run\'s account of',
    'itself, because that account is the thing the publication boundary exists to',
    'stop deciding this.',
    '',
    'The worktree is left where it is. Nothing removes a checkout it cannot vouch',
    'for, and a run that reported rather than published is exactly the case where a',
    'human wants to look at what it wrote.',
  ];
  return assertNoAttribution(`${lines.join('\n')}\n`, 'comment body');
}

// ---------------------------------------------------------------------------
// The two outbound calls
// ---------------------------------------------------------------------------

export function buildPushArgs({ remote = 'origin', branch }) {
  return assertGitArgvSafe(['push', '--set-upstream', remote, branch]);
}

export function buildPrCreateArgs({ branch, base = 'main', title, bodyFile }) {
  return assertGhArgvSafe([
    'pr', 'create',
    '--head', branch,
    '--base', base,
    '--title', title,
    '--body-file', bodyFile,
    DRAFT_FLAG,
  ]);
}

export function buildIssueCommentArgs({ issue, bodyFile }) {
  return assertGhArgvSafe(['issue', 'comment', String(issue), '--body-file', bodyFile]);
}

/** Where a body file goes: under the runs root, never inside the worktree. A file
 *  written into the worktree is untracked content, which makes Phase 2's reaper
 *  refuse the checkout as dirty — and is content the run could have committed.
 *
 *  The id is joined on bare, for `reproductionPath`'s reason. */
export function bodyPath(repoRoot, runId, kind, opts = {}) {
  assertRunIdAgent(runId, opts);
  return join(agentRoot(repoRoot, opts), 'bodies', `${runId}-${kind}.md`);
}

function writeBody(repoRoot, runId, kind, body, opts = {}) {
  const path = bodyPath(repoRoot, runId, kind, opts);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, assertNoAttribution(body, `${kind} body`), 'utf8');
  return path;
}

/**
 * Keep the run's own account of itself, beside the bodies and outside the worktree.
 *
 * **Evidence, never a verdict.** ADR 0008 is emphatic that a run's account of itself
 * is the thing the publication boundary exists to stop deciding publication, and
 * nothing here softens that: `assessReproduction` replays committed tests and reads
 * this file never. Retaining it so a human can read it afterwards is a different act
 * from trusting it, and writing it through a separate function rather than into the
 * publisher's decision path is how that stays legible.
 *
 * Three consecutive real runs left work uncommitted and none could be diagnosed,
 * because the only artefact that would have said why was discarded each time.
 *
 * It skips `assertNoAttribution`, which every published body passes through: this
 * file is never published, and refusing to record what a run actually said because
 * of what it said would defeat the point of recording it.
 */
export function writeRunAccount(repoRoot, runId, agent, opts = {}) {
  const path = bodyPath(repoRoot, runId, 'account', opts);
  mkdirSync(dirname(path), { recursive: true });
  const body = [
    `# What run \`${runId}\` said it did`,
    '',
    'Kept for a human to read. Nothing decides publication from this file — the',
    'publisher replays the tests in the commits a run made, and reads nothing else.',
    '',
    `- exit status: \`${agent?.status ?? 'unknown'}\``,
    '',
    '## stdout',
    '',
    (agent?.stdout ?? '').trimEnd() || '_(nothing)_',
    '',
    '## stderr',
    '',
    (agent?.stderr ?? '').trimEnd() || '_(nothing)_',
    '',
  ].join('\n');
  writeFileSync(path, body, 'utf8');
  return path;
}

function ghOf(opts) {
  return opts.gh ?? ((args, cwd) => {
    const r = spawnSync('gh', args, { cwd, encoding: 'utf8', windowsHide: true });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  });
}

// ---------------------------------------------------------------------------
// The publisher
// ---------------------------------------------------------------------------

/**
 * Push one branch and open one pull request, or file one comment and publish
 * nothing.
 *
 * `generation` is Phase 3's result and is checked for `ok` before anything else.
 * That check is the reason the field exists: a refused generation returns
 * `branch: null` and `outcome: 'reported'` precisely so a later step reading
 * `branch` optimistically has nothing to push, and this is the later step. Its
 * own report is the comment — a run refused at step 3 has already written the
 * only thing there is to say.
 *
 * Nothing here retries a refused push. `--no-verify` would clear the branch-name
 * hook's refusal and `--force` would clear a diverged remote, and both discard
 * exactly what the refusal was protecting. A refused push is reported.
 */
export function publishRun({
  repoRoot, worktree, branch, issue,
  baseCommit = null, headCommit = null, runId = null, shortName = repoShortName(repoRoot),
  issueTitle = '', criteria = [], generation = null,
  remote = 'origin', base = 'main',
}, opts = {}) {
  const git = gitOf(opts);
  const gh = ghOf(opts);

  // 1. A refused run publishes nothing, and says so with the report it already
  //    wrote. Never off `branch` — that field is null here by construction.
  if (generation && generation.ok === false) {
    const body = assertNoAttribution(generation.report ?? '', 'comment body');
    const path = writeBody(repoRoot, runId, 'comment', body, opts);
    const argv = buildIssueCommentArgs({ issue, bodyFile: path });
    const filed = gh(argv, worktree);
    return {
      ok: false, reason: PUBLISH_REFUSALS.RUN_REFUSED, generationReason: generation.reason ?? null,
      published: false, outcome: OUTCOME_REPORTED, pr: null,
      comment: { argv, body, path, status: filed.status },
    };
  }

  // 2. The branch has to be one the hook will take, and has to be this issue's.
  const named = assertBranchName(branch, issue);
  if (!named.ok) {
    return { ok: false, reason: named.reason, published: false, outcome: null, pr: null, comment: null, branch: named.branch };
  }

  // 3. The decided predicate. No reproduction, no pull request, a comment instead.
  const reproduction = assessReproduction({ repoRoot, worktree, baseCommit, runId }, opts);
  if (!reproduction.ok) {
    const body = formatNoReproductionComment({
      issue, shortName, reason: reproduction.reason, reproduction, runId, worktree,
    });
    const path = writeBody(repoRoot, runId, 'comment', body, opts);
    const argv = buildIssueCommentArgs({ issue, bodyFile: path });
    const filed = gh(argv, worktree);
    return {
      ok: false, reason: PUBLISH_REFUSALS.NO_REPRODUCTION, reproductionReason: reproduction.reason,
      published: false, outcome: OUTCOME_REPORTED, pr: null, reproduction,
      comment: { argv, body, path, status: filed.status },
    };
  }

  // 4. Push. The hook runs here for real; a refusal is reported, never retried.
  const pushArgs = buildPushArgs({ remote, branch });
  const pushed = git(['-C', worktree, ...pushArgs]);
  if (pushed.status !== 0) {
    return {
      ok: false, reason: PUBLISH_REFUSALS.PUSH_REFUSED, published: false, outcome: null,
      pr: null, reproduction, push: { argv: pushArgs, status: pushed.status, message: (pushed.stderr || pushed.stdout || '').trim() },
    };
  }

  const head = git(['-C', worktree, 'rev-parse', 'HEAD']);
  const at = head.status === 0 ? head.stdout.trim() : (headCommit ?? null);

  // 5. One pull request, always a draft.
  const body = formatPullRequestBody({
    issue, shortName, branch, baseCommit, headCommit: at, runId, criteria, reproduction,
    agentStatus: generation?.agent?.status ?? null,
  });
  const path = writeBody(repoRoot, runId, 'pr', body, opts);
  const prArgs = buildPrCreateArgs({
    branch, base, title: pullRequestTitle(branch, issueTitle, shortName), bodyFile: path,
  });
  const opened = gh(prArgs, worktree);
  if (opened.status !== 0) {
    return {
      ok: false, reason: PUBLISH_REFUSALS.PR_REFUSED, published: false, outcome: null,
      reproduction, push: { argv: pushArgs, status: 0 },
      pr: { argv: prArgs, body, path, status: opened.status, message: (opened.stderr || opened.stdout || '').trim() },
    };
  }

  return {
    ok: true, published: true, outcome: OUTCOME_PUBLISHED, commit: at, branch,
    reproduction,
    push: { argv: pushArgs, status: 0 },
    pr: { argv: prArgs, body, path, status: 0, url: (opened.stdout ?? '').trim() },
  };
}

export { OUTCOME_PUBLISHED, OUTCOME_REPORTED };
