// The publisher step, exercised where it can be exercised for real and asserted
// over argv where it cannot.
//
// Phase 4 of #193 (FORGE-259). Two halves, and the split is deliberate.
//
// **The push is real.** It goes to a bare repository this file creates in a
// throwaway directory, so `git push` runs with genuine push semantics — the
// pre-push hook included, which is the one refusal that would otherwise arrive
// only in production and only after a run had done all of its work.
//
// **`gh pr create` is asserted, not executed.** A pull request opened against a
// real remote cannot be withdrawn without a residue, and `delete_repo` was
// removed from this machine's token on 2026-08-27 (ADR 0008 row 7), so a
// throwaway GitHub repository created here could not afterwards be deleted. The
// evidence is therefore the exact argv and the exact body, observed at the seam
// the publisher hands them to. The one act this file does not perform — opening
// a pull request the publisher assembled, against a real remote — is what closes
// this phase at `wired`, and it is left for a human.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { emptyDir, makeRepo } from './helpers/make-repo.mjs';
import { installBranchNameHook, BRANCH_BYPASS_ENV } from '../scripts/setup-repo.mjs';
import { createWorktree, OUTCOME_PUBLISHED, OUTCOME_REPORTED } from '../scripts/lib/worktree.mjs';
import {
  BRANCH_PATTERN, DRAFT_FLAG, PUBLISH_REFUSALS, REPRODUCTION_REFUSALS, ATTRIBUTION_TELLS,
  REFUSED_GIT_FLAGS, ALLOWED_GH_COMMANDS,
  assertNoAttribution, assertBranchName, assertGitArgvSafe, assertGhArgvSafe,
  isTestPath, isRunnableTest, classifyReproductionRun, assessReproduction, LOAD_FAILURE,
  issueReference, pullRequestTitle, formatPullRequestBody, formatNoReproductionComment,
  buildPushArgs, buildPrCreateArgs, buildIssueCommentArgs, bodyPath, reproductionPath,
  replayEnv, publishRun,
} from '../scripts/lib/publish-run.mjs';
import {
  DEFENCE_IN_DEPTH_UNSET, INVOKE_REFUSALS, isolationPaths, isolatedEnv,
} from '../scripts/lib/agent-invoke.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PUBLISH_SRC = join(REPO, 'scripts/lib/publish-run.mjs');

// stderr is dropped: git narrates CRLF conversion on every add in these fixtures,
// and that noise would bury a real failure in the suite's output.
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const FAILING_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('the delegated bug', () => { assert.equal(1, 2, 'the thing is broken'); });",
  '',
].join('\n');

const PASSING_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('the delegated bug', () => { assert.equal(1, 1); });",
  '',
].join('\n');

/** A module that exists only in the fix, so a test importing it cannot load at
 *  the base commit. Named in a constant rather than written inline for a real
 *  reason: `tests/publish.test.mjs`'s dangling-import guard is a lexical scan for
 *  `from '…'` over the text of every exported `.mjs`, and inline it would read
 *  this fixture's deliberately-missing import as this file's own. Interpolating
 *  the specifier keeps the fixture honest and leaves that guard at full strength. */
const ONLY_IN_THE_FIX = '../src/only-in-the-fix.mjs';

/** The CommonJS counterpart, for the same reason and by the same rule: the
 *  specifier is named here and interpolated below rather than written inline,
 *  so the dangling-import guard never mistakes this fixture's deliberately-
 *  missing `require` for one this file itself makes. */
const ONLY_IN_THE_FIX_CJS = './only-in-the-fix.cjs';

const UNLOADABLE_TEST = [
  "import test from 'node:test';",
  `import { fixed } from '${ONLY_IN_THE_FIX}';`,
  "test('the delegated bug', () => { fixed(); });",
  '',
].join('\n');

/** A test file that does not parse at all — the other shape a load can fail in,
 *  distinct from a missing module. */
const UNPARSEABLE_TEST = [
  "import test from 'node:test';",
  "test('does not parse', () => {",
  '  const x = ;',
  '});',
  '',
].join('\n');

/** A test that LOADS, RUNS and FAILS honestly while its own assertion quotes a
 *  parser's error — the shape #277 (FORGE-338) misclassifies as did-not-load,
 *  because the classifier's regex is tested against the whole combined output
 *  rather than against whether the runtime ever loaded the file. */
const QUOTES_SYNTAXERROR_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('quotes a parser error and fails honestly', () => {",
  "  let message = '';",
  '  try {',
  "    JSON.parse('{oops');",
  '  } catch (err) {',
  '    message = `${err.name}: ${err.message}`;',
  '  }',
  "  assert.equal(message, 'SyntaxError: the config at line 1 is not valid JSON');",
  '});',
  '',
].join('\n');

/** Same shape, over the phrase the classifier's regex watches for on the module
 *  side rather than the syntax side. */
const QUOTES_MODULE_MISSING_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('quotes cannot find module and fails honestly', () => {",
  "  assert.equal('Cannot find module x-plugin', 'the plugin is not installed');",
  '});',
  '',
].join('\n');

/** A test that PASSES while merely printing both phrases — the control case: if
 *  the classifier were keying on the phrases appearing anywhere in the output at
 *  all, this would misfire too, but nothing about a passing run is at stake here
 *  since the predicate only asks did-not-load-versus-failed of a nonzero exit. */
const PASSING_QUOTES_TEST = [
  "import test from 'node:test';",
  "test('logs load-failure phrases while passing', () => {",
  "  console.log('Cannot find module x / SyntaxError: unexpected token');",
  '});',
  '',
].join('\n');

/** A test file whose module evaluation throws before any load-failure phrase
 *  could appear — the crash half of `didNotLoad`'s predicate on its own, with
 *  no `LOAD_FAILURE` phrase to corroborate it. Proves the phrase half of the
 *  predicate is load-bearing: a mutant that dropped it and kept only
 *  `RUNTIME_FATAL.test(text)` would classify this as `did-not-load`. */
const CRASHES_WITHOUT_LOAD_PHRASE_TEST = [
  "import test from 'node:test';",
  "throw new TypeError('the fixture threw while evaluating');",
  "test('never reached', () => {});",
  '',
].join('\n');

/** CommonJS is the shape whose fatal report prints `MODULE_NOT_FOUND` with no
 *  `ERR_` prefix, unlike the ESM case above, which is why this fixture is not
 *  redundant with `UNLOADABLE_TEST`. */
const UNLOADABLE_CJS_TEST = [
  "const test = require('node:test');",
  `const missing = require('${ONLY_IN_THE_FIX_CJS}');`,
  "test('the delegated bug', () => { missing(); });",
  '',
].join('\n');

/** The only shape that produces `ERR_UNSUPPORTED_DIR_IMPORT`, and the fixture
 *  `#294 (FORGE-345)` exists to add: importing a directory rather than a file.
 *  ESM has no directory resolution, so Node refuses with a code whose message
 *  says nothing about *finding* anything — which is why this is the one
 *  alternative in `LOAD_FAILURE` that no other fixture reaches.
 *
 *  It needs a real directory beside it, planted through `replayOutput`'s
 *  `siblings`. A reproduction that imports a directory is an unusual shape, but
 *  the alternative is in the alternation precisely to catch it, and until this
 *  fixture existed nothing proved it still did. */
/** The directory the fixture imports. Named in a constant and interpolated below
 *  for `ONLY_IN_THE_FIX`'s reason, stated two comments above: the dangling-import
 *  guard in `tests/publish.test.mjs` is a lexical scan over the text of every
 *  exported `.mjs`, and written inline this fixture's deliberately-unresolvable
 *  import would read as one this file itself makes. Measured — it did, and the
 *  guard failed exactly as it is built to. */
const A_DIRECTORY_NOT_A_FILE = './shapes';
const DIR_IMPORT_TEST = [
  "import test from 'node:test';",
  `import shape from '${A_DIRECTORY_NOT_A_FILE}';`,
  "test('the delegated bug', () => { shape(); });",
  '',
].join('\n');
const DIR_IMPORT_SIBLINGS = { 'shapes/index.mjs': 'export default () => 1;\n' };

/** A committed fixture repository, plus the pre-push hook the real push exercises. */
function fixtureRepo(files = { 'README.md': '# r\n' }) {
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

/** A local bare repository standing in for the remote. Deletable precisely
 *  because this process created it — `emptyDir()` tracks it and clears it on an
 *  ordinary success, which is the only authority CLAUDE.md #5 admits. */
function bareRemote(repoRoot, name = 'origin') {
  const bare = emptyDir();
  git(['init', '--bare', bare]);
  git(['remote', 'add', name, bare], repoRoot);
  return bare;
}

// Phase 2: every run-scoped path is per-agent now, and omitting the agent throws
// rather than falling back to the flat layout both agents used to share.
const runsFor = (agent = 'fixer') => ({ runsDir: emptyDir(), agent });

/** A worktree on `branch` holding one committed file. Returns the creation record
 *  — `baseCommit` included, which is the artifact the predicate is measured
 *  against and is measured by Phase 2 rather than reported by the run. */
function worktreeWith(repoRoot, io, { runId, branch, files }) {
  const made = createWorktree({ repoRoot, runId, branch }, io);
  assert.equal(made.ok, true, made.message);
  for (const [rel, contents] of Object.entries(files)) {
    const target = join(made.path, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }
  git(['add', '-A'], made.path);
  git(['commit', '-m', 'the run\'s work'], made.path);
  return made;
}

/** A recording `gh` seam. The publisher's outbound calls are observed here rather
 *  than executed, and the recorder fails loudly if anything reaches it that the
 *  argv guard should already have refused. */
function ghRecorder(result = { status: 0, stdout: 'https://example.invalid/pr/1', stderr: '' }) {
  const calls = [];
  return {
    calls,
    gh: (args, cwd) => {
      calls.push({ args: [...args], cwd });
      return result;
    },
  };
}

/** A real `{ status, stdout, stderr }`, produced by actually spawning the runner
 *  against a fixture — never asserted from a hand-written string standing in for
 *  what a crashed child would have said. Spawned exactly like `defaultMeasure`
 *  spawns the real replay, over a fixture written to its own throwaway directory.
 *
 *  The env strips the same three variables `replayEnv` strips, and for the same
 *  reason: a `node --test` child that inherits `NODE_TEST_CONTEXT` believes it is
 *  a child of this running suite, reports to that parent instead of to its own
 *  exit code, and exits 0 on a failing test — so leaving it in would make every
 *  fixture below read as `passed` regardless of what it actually did. Stripping
 *  colour is what makes the captured text the one the classifier really sees,
 *  rather than text a reader's terminal happened to colourize away.
 *
 *  `filename` is a parameter rather than a constant because a CommonJS
 *  reproduction is a `.cjs` file, not a `.mjs` one, and `isRunnableTest`
 *  accepts one.
 *
 *  `siblings` plants further files beside the fixture, which the directory-import
 *  case needs: `ERR_UNSUPPORTED_DIR_IMPORT` requires a real directory to import,
 *  so it cannot be produced by any single-file fixture. `#294 (FORGE-345)`.
 */
function replayOutput(source, filename = 'thing.test.mjs', siblings = {}) {
  const dir = emptyDir();
  for (const [rel, body] of Object.entries(siblings)) {
    const at = join(dir, rel);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, body, 'utf8');
  }
  writeFileSync(join(dir, filename), source, 'utf8');
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.NODE_TEST_CONTEXT;
  delete env.FORCE_COLOR;
  const r = spawnSync(process.execPath, ['--test', filename], {
    cwd: dir, encoding: 'utf8', timeout: 600_000, windowsHide: true, env,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ===========================================================================
// The branch guard, pinned against the hook that will really refuse it
// ===========================================================================

test('the publisher\'s branch pattern is the pre-push hook\'s own, read off an installed hook', () => {
  // Not compared against a copy in this file: the hook is what refuses the push
  // in production, so the pattern is extracted from the hook Git will actually
  // run. A guard that drifted from the gate would refuse names the gate accepts,
  // or — far worse — accept names it refuses, after all the work was done.
  const repo = fixtureRepo();
  const hook = readFileSync(join(repo, '.git', 'hooks', 'pre-push'), 'utf8');
  const pattern = hook.match(/grep -Eq '([^']+)'/)?.[1];
  assert.ok(pattern, 'the installed hook carries no grep -E pattern');
  // Through `new RegExp` on both sides, so the comparison is between two
  // patterns rather than between a pattern and JavaScript's own escaping of a
  // forward slash — which is the only difference a literal comparison would find.
  assert.equal(BRANCH_PATTERN.source, new RegExp(pattern).source);

  // And the same names on both sides, because two identical strings compiled by
  // two different engines is still an assumption until it is exercised.
  for (const [name, accepted] of [
    ['fix/193-publisher-step', true], ['feat/7-a', true],
    ['wip-nonsense', false], ['fix/0193-slug', false], ['Fix/1-a', false], ['fix/1-a/b', false],
  ]) {
    assert.equal(BRANCH_PATTERN.test(name), accepted, `the guard disagrees about ${name}`);
    const hookSaw = spawnSync('sh', ['-c', `printf %s '${name}' | grep -Eq '${pattern}'`], { encoding: 'utf8' });
    assert.equal(hookSaw.status === 0, accepted, `the hook disagrees about ${name}`);
  }
});

test('a branch that is not this issue\'s type/N-slug is refused before anything is pushed', () => {
  assert.equal(assertBranchName('fix/193-publisher-step', 193).ok, true);
  assert.equal(assertBranchName('', 193).reason, PUBLISH_REFUSALS.NO_BRANCH);
  assert.equal(assertBranchName(null, 193).reason, PUBLISH_REFUSALS.NO_BRANCH);
  assert.equal(assertBranchName('wip-nonsense', 193).reason, PUBLISH_REFUSALS.BAD_BRANCH);
  assert.equal(assertBranchName('Fix/193-Caps', 193).reason, PUBLISH_REFUSALS.BAD_BRANCH);
  assert.equal(assertBranchName('fix/193-', 193).reason, PUBLISH_REFUSALS.BAD_BRANCH);
  assert.equal(assertBranchName('fix/0193-slug', 193).reason, PUBLISH_REFUSALS.BAD_BRANCH);
  // The branch number is the one place the GitHub number is unambiguous
  // (repo-standards §4), so a branch naming a different issue mislabels the work
  // permanently and is refused rather than published under the wrong number.
  const other = assertBranchName('fix/194-publisher-step', 193);
  assert.equal(other.reason, PUBLISH_REFUSALS.BRANCH_NAMES_OTHER_ISSUE);
  assert.equal(other.names, 194);
});

// ===========================================================================
// The tail check — the gate the attribution hook cannot reach
// ===========================================================================

test('assertNoAttribution refuses every tell, and a block appended past the last line', () => {
  // The harness setting suppresses the footer the harness generates. A body file
  // walks past it, because the hook reads tool_input.command only — and every
  // body this module sends goes out through --body-file.
  const clean = 'A real body.\n\nFixes #193\n';
  assert.equal(assertNoAttribution(clean), clean);

  for (const tell of ATTRIBUTION_TELLS) {
    assert.throws(
      () => assertNoAttribution(`${clean.trimEnd()}\n\n${tell}: someone\n`),
      /attribution tell/,
      `${tell} was not refused`,
    );
  }
  // Casing is not a way past it.
  assert.throws(() => assertNoAttribution('body\n\nCO-AUTHORED-BY: x\n'), /attribution tell/);
  // Trailing blank lines are where an appended block lands, so a body that
  // already ends in whitespace hides one and is refused on its own.
  assert.throws(() => assertNoAttribution('body\n\n\n'), /last substantive line/);
  assert.throws(() => assertNoAttribution('body'), /last substantive line/);
  assert.throws(() => assertNoAttribution('   \n'), /empty/);
});

test('the attribution tells live in this module only as the needles of a refusal', () => {
  // A grep for one of these over the repository must find the gate, not an
  // instance. agent-invoke.mjs pins its forbidden flags the same way.
  const source = readFileSync(PUBLISH_SRC, 'utf8').toLowerCase();
  for (const tell of ATTRIBUTION_TELLS) {
    const needle = tell.toLowerCase();
    const count = source.split(needle).length - 1;
    assert.equal(count, 1, `${tell} appears ${count} times in publish-run.mjs, not once`);
  }
});

test('every body the publisher assembles ends at its last substantive line', () => {
  const reproduction = { runnable: ['tests/thing.test.mjs'], tests: ['tests/thing.test.mjs'], replay: { detail: 'AssertionError' } };
  const pr = formatPullRequestBody({
    issue: 193, linearKey: 'FORGE-259', branch: 'fix/193-slug', baseCommit: 'abc1234def',
    headCommit: 'ffff0000', runId: 'fixer-193', criteria: ['the thing works'], reproduction, agentStatus: 0,
  });
  const comment = formatNoReproductionComment({
    issue: 193, linearKey: 'FORGE-259', reason: REPRODUCTION_REFUSALS.NO_TEST,
    reproduction: { tests: [], baseCommit: 'abc1234def' }, runId: 'fixer-193', worktree: 'C:/runs/run-193',
  });

  for (const [what, body] of [['pull request body', pr], ['comment body', comment]]) {
    for (const tell of ATTRIBUTION_TELLS) {
      assert.equal(body.toLowerCase().includes(tell.toLowerCase()), false, `the ${what} carries ${tell}`);
    }
    assert.equal(body, `${body.trimEnd()}\n`, `the ${what} does not end at its last substantive line`);
  }
  assert.equal(pr.trimEnd().split('\n').at(-1), 'Fixes #193');
  assert.match(comment.trimEnd().split('\n').at(-1), /human wants to look at what it wrote\.$/);
});

// ===========================================================================
// The dual identifier, and where it may never go
// ===========================================================================

test('the Fixes footer is the bare GitHub number and the prose carries both identifiers', () => {
  const reproduction = { runnable: ['tests/thing.test.mjs'], replay: { detail: 'AssertionError' } };
  const body = formatPullRequestBody({
    issue: 193, linearKey: 'FORGE-259', branch: 'fix/193-slug', baseCommit: 'abc1234def', reproduction,
  });
  // §6.5.1 exempts the footer explicitly: it is machine-parsed, and
  // `Fixes #193 (FORGE-259)` closes nothing.
  const footer = body.trimEnd().split('\n').at(-1);
  assert.equal(footer, 'Fixes #193');
  assert.equal(/^Fixes #\d+\s+\(/.test(footer), false, 'the dual identifier reached the Fixes footer');
  assert.equal(/Fixes[^\n]*FORGE/.test(body), false, 'a Linear key reached a Fixes line');
  // And the prose above it carries both, where a human reads it.
  assert.match(body, /`#193 \(FORGE-259\)`/);
});

test('the Linear key is never computed from the GitHub number', () => {
  // The two sequences drift, so a derived FORGE-M names somebody else's issue.
  assert.equal(issueReference(193, 'FORGE-259'), '#193 (FORGE-259)');
  assert.equal(issueReference(193), '#193');
  const reproduction = { runnable: ['tests/t.test.mjs'], replay: { detail: 'x' } };
  const body = formatPullRequestBody({ issue: 193, branch: 'fix/193-s', baseCommit: 'abc', reproduction });
  assert.equal(/FORGE-/.test(body), false, 'a Linear key was invented from the GitHub number');
  const comment = formatNoReproductionComment({ issue: 193, reason: REPRODUCTION_REFUSALS.NO_TEST, reproduction: {} });
  assert.equal(/FORGE-/.test(comment), false, 'a Linear key was invented from the GitHub number');
});

test('the pull request title carries no issue reference', () => {
  // §4.1 bans them from a commit summary line, and a squash merge makes this
  // title exactly that. The branch carries the number and the footer the link.
  assert.equal(pullRequestTitle('fix/193-x', 'scaffold writes outside dest'), 'fix: scaffold writes outside dest');
  assert.equal(pullRequestTitle('feat/12-y', 'add the thing (FORGE-259)'), 'feat: add the thing');
  assert.equal(pullRequestTitle('fix/9-z', 'crash in #9 on save'), 'fix: crash in on save');
  assert.equal(pullRequestTitle('fix/9-z', ''), 'fix: fix the delegated issue');
  assert.ok(pullRequestTitle('fix/9-z', 'x'.repeat(200)).length <= 72);
});

// ===========================================================================
// The two outbound calls, and the commands the publisher may never run
// ===========================================================================

test('the publisher may run only gh pr create and gh issue comment', () => {
  // An allowlist, because ADR 0008 row 6 forbids a merge and `gh pr merge`
  // cannot be un-run. Anything not named is refused whether or not anyone
  // thought of it.
  assert.deepEqual(ALLOWED_GH_COMMANDS, [['pr', 'create'], ['issue', 'comment']]);
  assert.doesNotThrow(() => assertGhArgvSafe(['pr', 'create', '--draft']));
  assert.doesNotThrow(() => assertGhArgvSafe(['issue', 'comment', '193']));
  assert.throws(() => assertGhArgvSafe(['pr', 'merge', '--squash', '193']), /ADR 0008 row 6/);
  assert.throws(() => assertGhArgvSafe(['issue', 'close', '193']), /ADR 0008 row 6/);
  assert.throws(() => assertGhArgvSafe(['pr', 'edit', '--add-label', 'x']), /may run only/);
  assert.throws(() => assertGhArgvSafe(['repo', 'delete']), /may run only/);
});

test('no git argv the publisher builds can clear a refusal', () => {
  for (const flag of REFUSED_GIT_FLAGS) {
    assert.throws(() => assertGitArgvSafe(['push', flag, 'origin', 'fix/1-a']), /never passes/);
  }
  // Exact matches, not substrings: a title containing the word "force" is not a
  // forced push, and a guard that could not tell them apart would be turned off.
  assert.doesNotThrow(() => assertGitArgvSafe(['push', '--set-upstream', 'origin', 'fix/1-force-quit-hangs']));
  assert.deepEqual(buildPushArgs({ branch: 'fix/193-a' }), ['push', '--set-upstream', 'origin', 'fix/193-a']);
});

test('every pull request the publisher opens is a draft', () => {
  // Not a parameter. A flag a caller can choose is a flag a caller can choose
  // wrong, and the spec decided the rule as draft-iff-reproduction — so the only
  // open question is whether a PR is opened at all.
  assert.equal(DRAFT_FLAG, '--draft');
  const argv = buildPrCreateArgs({ branch: 'fix/193-a', base: 'main', title: 'fix: a', bodyFile: '/tmp/b.md' });
  assert.deepEqual(argv, [
    'pr', 'create', '--head', 'fix/193-a', '--base', 'main',
    '--title', 'fix: a', '--body-file', '/tmp/b.md', '--draft',
  ]);
  assert.equal(argv.includes('--draft'), true, 'the pull request was not opened as a draft');
  assert.equal(argv.includes('--body'), false, 'the body was passed inline rather than as a file');
  assert.deepEqual(buildIssueCommentArgs({ issue: 193, bodyFile: '/tmp/c.md' }),
    ['issue', 'comment', '193', '--body-file', '/tmp/c.md']);
});

// ===========================================================================
// The reproduction predicate, over artifacts
// ===========================================================================

test('a replay that could not load is never counted as a replay that failed', () => {
  assert.equal(classifyReproductionRun({ status: 1, stderr: 'AssertionError [ERR_ASSERTION]' }).verdict, 'failed');
  assert.equal(classifyReproductionRun({ status: 0 }).verdict, 'passed');
  // The load direction is measured against a real runner below, rather than
  // asserted here over a string a human wrote to stand in for one.
  assert.equal(classifyReproductionRun({ status: null, error: 'spawn ENOENT' }).verdict, 'not-measured');
});

// #277 (FORGE-338): `LOAD_FAILURE` is tested against the whole combined
// `${stderr}\n${stdout}`, so any replay whose output merely *quotes* one of
// those phrases — inside a passing `console.log`, or inside the message of an
// assertion that ran and failed on its own terms — is misclassified
// `did-not-load` and its publication suppressed. Each test below proves its
// fixture is genuinely the shape it claims to be before asserting how the
// classifier read it, so a fixture that stopped containing the trigger phrase
// could not make the test pass for the wrong reason.

test('a replay the runtime never managed to load still reads as did-not-load', () => {
  const missing = replayOutput(UNLOADABLE_TEST);
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stderr}\n${missing.stdout}`, /Cannot find module/);
  assert.equal(classifyReproductionRun(missing).verdict, 'did-not-load');

  const unparseable = replayOutput(UNPARSEABLE_TEST);
  assert.notEqual(unparseable.status, 0);
  assert.match(`${unparseable.stderr}\n${unparseable.stdout}`, /SyntaxError/);
  assert.equal(classifyReproductionRun(unparseable).verdict, 'did-not-load');

  // CommonJS is not the same measurement. Its fatal report prints
  // `MODULE_NOT_FOUND` with no `ERR_` prefix, so the `err_module_not_found`
  // alternative does not catch it and `cannot find (module|package)` is the only
  // one that does — a mutant deleting that alternative survives every ESM
  // fixture above. `isRunnableTest` accepts a `.test.cjs`, so this is a
  // reproduction the publisher can really be handed.
  const cjs = replayOutput(UNLOADABLE_CJS_TEST, 'thing.test.cjs');
  assert.notEqual(cjs.status, 0);
  const cjsText = `${cjs.stderr}\n${cjs.stdout}`;
  assert.match(cjsText, /Cannot find module/);
  assert.doesNotMatch(cjsText, /ERR_MODULE_NOT_FOUND/,
    'the CommonJS report grew an ERR_ prefix, so this fixture no longer pins the alternative it was written for');
  assert.equal(classifyReproductionRun(cjs).verdict, 'did-not-load');

  // A CommonJS reproduction only reaches the classifier at all because
  // `isRunnableTest` accepts a `.test.cjs` file.
  assert.equal(isRunnableTest('tests/thing.test.cjs'), true);

  // #294 (FORGE-345): a replay that imports a DIRECTORY. ESM has no directory
  // resolution, so Node refuses with `ERR_UNSUPPORTED_DIR_IMPORT` — a message
  // that says nothing about finding anything, so no other alternative in
  // `LOAD_FAILURE` catches it. Until this fixture existed nothing anywhere
  // produced that code, and deleting the alternative killed no test.
  const dirImport = replayOutput(DIR_IMPORT_TEST, 'thing.test.mjs', DIR_IMPORT_SIBLINGS);
  assert.notEqual(dirImport.status, 0);
  const dirText = `${dirImport.stderr}\n${dirImport.stdout}`;
  assert.match(dirText, /ERR_UNSUPPORTED_DIR_IMPORT/,
    'the fixture no longer produces the code it was written to produce');
  assert.doesNotMatch(dirText, /Cannot find (module|package)/i,
    'the directory-import report grew a find-shaped message, so this fixture no longer isolates its alternative');
  assert.equal(classifyReproductionRun(dirImport).verdict, 'did-not-load');

  // Measured, not assumed: under `node --test` on this machine, stderr is empty
  // and the interpreter's fatal report for a child that never loaded arrives on
  // stdout instead. The stream a line arrived on is therefore not available as
  // the discriminator, contrary to what #277 (FORGE-338) supposed.
  assert.match(missing.stdout, /Cannot find module/);
});

test('#294 (FORGE-345) — every alternative in LOAD_FAILURE is load-bearing', () => {
  // AC 3 and AC 4 as an assertion rather than as a mutation run somebody has to
  // remember to repeat. An alternative is load-bearing when a real output exists
  // that it alone matches: removing it then changes that replay's verdict from
  // `did-not-load` to `failed`, and `failed` is the verdict that PUBLISHES.
  //
  // Every output below comes from actually spawning the runner. None is a
  // hand-written string standing in for what a crashed child would have said,
  // which is AC 2 and is the reason this can be trusted at all.
  const fixtures = {
    'cannot find (module|package)': replayOutput(UNLOADABLE_CJS_TEST, 'thing.test.cjs'),
    err_unsupported_dir_import: replayOutput(DIR_IMPORT_TEST, 'thing.test.mjs', DIR_IMPORT_SIBLINGS),
    syntaxerror: replayOutput(UNPARSEABLE_TEST),
  };

  // The list here IS the shipped alternation, compared against the regex rather
  // than transcribed beside it. A fourth alternative added to the code without a
  // fixture fails this line — which is the property that stops the decoration
  // this issue is about growing back.
  assert.equal(LOAD_FAILURE.source, Object.keys(fixtures).join('|'),
    'LOAD_FAILURE and the fixtures proving each alternative load-bearing are out of step');

  for (const [alternative, run] of Object.entries(fixtures)) {
    const text = `${run.stderr}\n${run.stdout}`;
    assert.equal(classifyReproductionRun(run).verdict, 'did-not-load', alternative);

    // Uniquely matched: every OTHER alternative misses this output. That is what
    // makes removing this one observable, and it is measured against the real
    // text rather than argued from the message format.
    const others = Object.keys(fixtures).filter((a) => a !== alternative);
    for (const other of others) {
      assert.equal(new RegExp(other, 'i').test(text), false,
        `${other} also matches the ${alternative} fixture, so neither is independently load-bearing`);
    }

    // And with this alternative alone removed, the replay stops reading as
    // did-not-load — the mutant AC 4 names, applied here rather than by hand.
    const without = new RegExp(others.join('|'), 'i');
    assert.equal(without.test(text), false,
      `deleting ${alternative} from LOAD_FAILURE changes no verdict, so it is decoration`);
  }
});

test('a test that ran and failed while quoting SyntaxError is published, not suppressed', () => {
  const quoted = replayOutput(QUOTES_SYNTAXERROR_TEST);
  assert.notEqual(quoted.status, 0);
  // The hazard is real: the fixture's own failing assertion quotes the exact
  // phrase the did-not-load regex watches for.
  assert.match(`${quoted.stderr}\n${quoted.stdout}`, /SyntaxError/);
  const verdict = classifyReproductionRun(quoted);
  assert.equal(verdict.verdict, 'failed',
    'a test that ran and failed honestly was discarded as a module that never loaded');
  assert.match(verdict.detail, /AssertionError/);
});

test('Cannot find module in a test\'s own output does not suppress the result', () => {
  const failing = replayOutput(QUOTES_MODULE_MISSING_TEST);
  assert.notEqual(failing.status, 0);
  assert.match(`${failing.stderr}\n${failing.stdout}`, /Cannot find module/);
  assert.equal(classifyReproductionRun(failing).verdict, 'failed');

  const passing = replayOutput(PASSING_QUOTES_TEST);
  assert.equal(passing.status, 0);
  assert.match(`${passing.stderr}\n${passing.stdout}`, /Cannot find module/);
  assert.match(`${passing.stderr}\n${passing.stdout}`, /SyntaxError/);
  assert.equal(classifyReproductionRun(passing).verdict, 'passed');
});

// `did-not-load` is a claim about *why* a replay ended, not just that it ended
// badly: the fix for #277 (FORGE-338) narrowed `didNotLoad` to require a
// `LOAD_FAILURE` phrase alongside the interpreter's fatal report, precisely so
// a crash that says nothing about module loading would not be swept in. This
// pins that the narrowing did not widen back out in the other direction — a
// mutant that dropped the phrase half and kept only `RUNTIME_FATAL.test(text)`
// would misclassify the fixture below.
test('a replay that crashed for a reason that is not a load failure still reads as failed', () => {
  const crashed = replayOutput(CRASHES_WITHOUT_LOAD_PHRASE_TEST);
  assert.notEqual(crashed.status, 0);
  const combined = `${crashed.stderr}\n${crashed.stdout}`;
  // The fixture really is a crash: the interpreter's fatal-report banner is
  // present.
  assert.match(combined, /^Node\.js v\d+\./m);
  // But none of the four load-failure phrases are — this is what makes the
  // fixture the crash-without-phrase case.
  assert.doesNotMatch(combined, /cannot find (module|package)|err_module_not_found|err_unsupported_dir_import|syntaxerror/i);
  assert.equal(classifyReproductionRun(crashed).verdict, 'failed',
    'a crash that says nothing about module loading was reclassified as did-not-load');
});

test('a test path and a runnable test are not the same question', () => {
  assert.equal(isTestPath('tests/helpers/make-repo.mjs'), true);
  assert.equal(isRunnableTest('tests/helpers/make-repo.mjs'), false, 'a helper is not a reproduction');
  assert.equal(isRunnableTest('tests/thing.test.mjs'), true);
  assert.equal(isTestPath('scripts/lib/thing.mjs'), false);
  assert.equal(isTestPath('src/tests-of-patience.mjs'), false, 'a boundary-blind prefix match');
});

test('a run that committed no runnable test produced no reproduction', () => {
  const repo = fixtureRepo({ 'README.md': '# r\n', 'src/thing.mjs': 'export const n = 1;\n' });
  const io = runsFor();
  const made = worktreeWith(repo, io, {
    runId: 'run-no-test', branch: 'fix/7-no-test', files: { 'src/thing.mjs': 'export const n = 2;\n' },
  });
  const verdict = assessReproduction({ repoRoot: repo, worktree: made.path, baseCommit: made.baseCommit, runId: 'run-no-test' },
    { ...io, measure: () => assert.fail('a replay was run with no runnable test in the diff') });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, REPRODUCTION_REFUSALS.NO_TEST);
});

test('a test that passes on the base commit reproduces nothing', () => {
  const repo = fixtureRepo();
  const io = runsFor();
  const made = worktreeWith(repo, io, {
    runId: 'run-passes', branch: 'fix/7-passes', files: { 'tests/thing.test.mjs': PASSING_TEST },
  });
  // The real replay: a detached checkout of the base commit with the run's test
  // copied in, and node --test run against it.
  const verdict = assessReproduction(
    { repoRoot: repo, worktree: made.path, baseCommit: made.baseCommit, runId: 'run-passes' }, io,
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, REPRODUCTION_REFUSALS.PASSES_ON_BASE);
  assert.equal(verdict.replay.verdict, 'passed');
});

test('a test that fails on the base commit is a reproduction, measured and not reported', () => {
  const repo = fixtureRepo();
  const io = runsFor();
  const made = worktreeWith(repo, io, {
    runId: 'run-repro', branch: 'fix/7-repro', files: { 'tests/thing.test.mjs': FAILING_TEST },
  });
  const verdict = assessReproduction(
    { repoRoot: repo, worktree: made.path, baseCommit: made.baseCommit, runId: 'run-repro' }, io,
  );
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.deepEqual(verdict.runnable, ['tests/thing.test.mjs']);
  assert.equal(verdict.replay.verdict, 'failed');
  assert.match(verdict.replay.detail, /the thing is broken|AssertionError/);
  // The replay checkout is removed by the thing that made it, and nothing else.
  assert.equal(existsSync(join(io.runsDir, 'reproductions')) && existsSync(join(io.runsDir, 'reproductions', 'run-repro')), false);
});

test('a test that cannot load on the base commit is inconclusive rather than a reproduction', () => {
  // A reproduction test importing a module the fix introduces exits non-zero at
  // the base commit for a reason that says nothing about the issue. The safe
  // direction is no pull request, and it is chosen deliberately.
  const repo = fixtureRepo();
  const io = runsFor();
  const made = worktreeWith(repo, io, {
    runId: 'run-load', branch: 'fix/7-load',
    files: { 'tests/thing.test.mjs': UNLOADABLE_TEST, 'src/only-in-the-fix.mjs': 'export const fixed = () => 1;\n' },
  });
  const verdict = assessReproduction(
    { repoRoot: repo, worktree: made.path, baseCommit: made.baseCommit, runId: 'run-load' }, io,
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, REPRODUCTION_REFUSALS.DID_NOT_LOAD);
});

test('a base commit that is not the one this worktree was cut from is refused', () => {
  const repo = fixtureRepo();
  const io = runsFor();
  const made = worktreeWith(repo, io, {
    runId: 'run-base', branch: 'fix/7-base', files: { 'tests/thing.test.mjs': FAILING_TEST },
  });
  // A commit that exists but is not an ancestor: the worktree's own HEAD is one,
  // its parent is not — so the run's own tip, passed as the base, is refused.
  const head = git(['rev-parse', 'HEAD'], made.path).trim();
  const forked = createWorktree({ repoRoot: repo, runId: 'run-other', branch: 'fix/8-other' }, io);
  writeFileSync(join(forked.path, 'other.md'), '# o\n', 'utf8');
  git(['add', '-A'], forked.path);
  git(['commit', '-m', 'elsewhere'], forked.path);
  const elsewhere = git(['rev-parse', 'HEAD'], forked.path).trim();
  assert.notEqual(elsewhere, head);

  const verdict = assessReproduction({ repoRoot: repo, worktree: made.path, baseCommit: elsewhere, runId: 'run-base' },
    { ...io, measure: () => assert.fail('a replay was run against a base the worktree was not cut from') });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, REPRODUCTION_REFUSALS.BASE_NOT_ANCESTOR);
});

test('the predicate is measured over the run\'s artifacts, never over what the run says about itself', () => {
  // A generation result claiming a clean, successful run — status 0, stdout
  // announcing a reproduction — over a worktree whose diff holds no test at all.
  // The publisher opens nothing, because it never reads the claim.
  const repo = fixtureRepo({ 'README.md': '# r\n', 'src/thing.mjs': 'export const n = 1;\n' });
  const io = runsFor();
  const made = worktreeWith(repo, io, {
    runId: 'run-claims', branch: 'fix/7-claims', files: { 'src/thing.mjs': 'export const n = 2;\n' },
  });
  const rec = ghRecorder();
  const result = publishRun({
    repoRoot: repo, worktree: made.path, branch: 'fix/7-claims', issue: 7,
    baseCommit: made.baseCommit, runId: 'run-claims', linearKey: 'FORGE-99',
    generation: {
      ok: true, invoked: true, branch: 'fix/7-claims', published: false,
      agent: { status: 0, stdout: 'I wrote a failing test that reproduces the bug, then fixed it.', stderr: '' },
    },
  }, { ...io, gh: rec.gh, git: (args, cwd) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } });

  assert.equal(result.ok, false);
  assert.equal(result.reason, PUBLISH_REFUSALS.NO_REPRODUCTION);
  assert.equal(result.reproductionReason, REPRODUCTION_REFUSALS.NO_TEST);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].args.slice(0, 2).join(' '), 'issue comment');
});

// ===========================================================================
// The replay's isolation — #214 (FORGE-274)
// ===========================================================================

/** P2's measured outcome, driven from the outside: the ambient environment
 *  authenticates and a call made with the run's own configuration is refused
 *  with the exact refusal `git` produces when prompts are disabled.
 *
 *  Keyed on the boundary variable rather than on call order, deliberately. A
 *  replay handed the ambient environment reads as `authenticated` here — the way
 *  it would against a real private remote — instead of quietly passing because it
 *  happened to be the second call. */
/** The `gh` half of the isolation probe, added by `#304 (FORGE-350)`. Seamed
 *  for `isolationRefused`'s own reason: `verifyIsolation` runs both halves now,
 *  and leaving one live makes every test here turn on whether the machine
 *  running the suite is logged in to `gh`. CI is not. */
const ghIsolationRefused = (useEnv) => (useEnv?.GH_CONFIG_DIR
  ? { status: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' }
  : { status: 0, stdout: 'github.com\n  Logged in to github.com account DaftVino\n', stderr: '' });

const isolationRefused = (useEnv) => (useEnv?.GIT_CONFIG_GLOBAL
  ? { status: 128, stdout: '', stderr: 'fatal: could not read Username for \'https://github.com\': terminal prompts disabled' }
  : { status: 0, stdout: 'aaaa\trefs/heads/main\n', stderr: '' });

/** The marker every seeded value carries, so "the child holds no credential" is
 *  asserted by scanning the values the child really got rather than by naming the
 *  keys we already thought to delete. */
const SEEDED = 'seeded-into-the-ambient-environment';

/**
 * Run `fn` with a GitHub credential — and the two variables the replay must
 * strip — really present in this process's environment.
 *
 * Seeding matters. Every assertion below is over a value that was there and is
 * gone, not over one that happened to be absent on this machine; an absence
 * asserted against an absence is the shape `#204 (FORGE-265)` AC 11 was filed
 * about. The keys come from `DEFENCE_IN_DEPTH_UNSET` itself so the seed cannot
 * drift out of step with the list.
 */
function withSeededAmbient(fn) {
  const seeded = { NODE_TEST_CONTEXT: 'child-v8', FORCE_COLOR: '3' };
  for (const key of DEFENCE_IN_DEPTH_UNSET) seeded[key] = `${SEEDED}-${key}`;
  const before = Object.keys(seeded).map((k) => [k, process.env[k]]);
  Object.assign(process.env, seeded);
  try {
    return fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('the replay child is spawned with the run\'s own isolation and no GitHub credential', () => {
  // AC 1 of #214 (FORGE-274), and it is asserted over the environment the spawn
  // *received* rather than over the code that builds it. The distinction is the
  // whole acceptance criterion: a test over `replayEnv`'s return value alone goes
  // green while `defaultMeasure` passes `process.env` to the child beside it.
  const repo = fixtureRepo();
  const io = runsFor();
  const made = worktreeWith(repo, io, {
    runId: 'run-iso', branch: 'fix/7-iso', files: { 'tests/thing.test.mjs': FAILING_TEST },
  });
  const spawns = [];

  withSeededAmbient(() => {
    const verdict = assessReproduction(
      { repoRoot: repo, worktree: made.path, baseCommit: made.baseCommit, runId: 'run-iso' },
      {
        ...io,
        lsRemote: isolationRefused,
        ghAuth: ghIsolationRefused,
        replaySpawn: (command, args, options) => {
          spawns.push({ command, args, options });
          return { status: 1, stdout: '', stderr: 'AssertionError [ERR_ASSERTION]: the thing is broken' };
        },
      },
    );
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
    assert.equal(spawns.length, 1, 'the replay was not spawned exactly once');

    const { command, args, options } = spawns[0];
    assert.equal(command, process.execPath);
    assert.equal(args[0], '--test');
    assert.deepEqual(args.slice(1), ['tests/thing.test.mjs']);
    assert.equal(options.cwd, reproductionPath(repo, 'run-iso', io));

    const env = options.env;
    const paths = isolationPaths(repo, 'run-iso', io);

    // The two lines that are the boundary, pointed at the run's own files —
    // and the files exist, because a `GIT_CONFIG_GLOBAL` naming nothing is not
    // an isolation, it is a missing file git ignores.
    assert.equal(env.GIT_CONFIG_GLOBAL, paths.gitconfig);
    assert.equal(env.GIT_CONFIG_SYSTEM, paths.empty);
    assert.equal(env.GH_CONFIG_DIR, paths.ghConfigDir);
    assert.equal(existsSync(paths.gitconfig), true, 'the run\'s isolated git configuration was never written');
    assert.equal(existsSync(paths.empty), true, 'the empty system configuration was never written');
    assert.equal(existsSync(paths.ghConfigDir), true, 'the redirected gh configuration directory was never made');

    // Defence in depth, and never the boundary — but it was seeded, so its
    // absence is a measurement rather than a coincidence.
    for (const key of DEFENCE_IN_DEPTH_UNSET) {
      assert.equal(key in env, false, `the replay child inherited ${key}`);
    }
    assert.equal(
      Object.values(env).some((v) => String(v).includes(SEEDED)), false,
      'a seeded credential reached the replay child under some other key',
    );
  });
});

test('the replay runs under the same isolation the generation step is verified against', () => {
  // AC 2. Not "an isolation" — *the* one: the environment the child received is
  // `agent-invoke.mjs`'s own `isolatedEnv` over the paths `writeIsolation` writes
  // for this run id, compared against an independently built expectation. A
  // second, weaker construction in publish-run.mjs fails this even if every key
  // it happens to set is spelled the same.
  const repo = fixtureRepo();
  const io = runsFor();
  const made = worktreeWith(repo, io, {
    runId: 'run-same', branch: 'fix/7-same', files: { 'tests/thing.test.mjs': FAILING_TEST },
  });
  const spawns = [];

  withSeededAmbient(() => {
    assessReproduction(
      { repoRoot: repo, worktree: made.path, baseCommit: made.baseCommit, runId: 'run-same' },
      {
        ...io,
        lsRemote: isolationRefused,
        ghAuth: ghIsolationRefused,
        replaySpawn: (command, args, options) => {
          spawns.push({ command, args, options });
          return { status: 1, stdout: '', stderr: 'AssertionError [ERR_ASSERTION]' };
        },
      },
    );
    assert.equal(spawns.length, 1);
    const paths = isolationPaths(repo, 'run-same', io);
    const { NODE_TEST_CONTEXT, FORCE_COLOR, ...ambient } = process.env;
    assert.deepEqual(
      spawns[0].options.env, { ...isolatedEnv(paths, ambient), NO_COLOR: '1' },
      'the replay environment is not the generation step\'s isolatedEnv over this run\'s paths',
    );
  });

  // And the isolation directory is the generation step's own, beside the
  // worktree under the runs root rather than inside anything the run can write.
  const paths = isolationPaths(repo, 'run-same', io);
  assert.equal(paths.dir.startsWith(made.path), false, 'the run could have edited its own isolation');
  assert.match(readFileSync(paths.gitconfig, 'utf8'), /\[credential\]\r?\n\thelper =/);
});

test('a replay whose isolation still authenticates against a private remote never runs', () => {
  // AC 1.3. The publisher would be executing the run's test files while holding a
  // credential — the defect #214 (FORGE-274) reports — so it executes nothing and
  // the predicate answers `not-measured`, which is already a comment and no PR.
  const repo = fixtureRepo();
  const io = runsFor();
  const made = worktreeWith(repo, io, {
    runId: 'run-leak', branch: 'fix/7-leak', files: { 'tests/thing.test.mjs': FAILING_TEST },
  });
  const verdict = assessReproduction(
    { repoRoot: repo, worktree: made.path, baseCommit: made.baseCommit, runId: 'run-leak' },
    {
      ...io,
      lsRemote: () => ({ status: 0, stdout: 'aaaa\trefs/heads/main\n', stderr: '' }),
      ghAuth: ghIsolationRefused,
      remoteVisibility: () => 'private',
      replaySpawn: () => assert.fail('the publisher executed the run\'s test files though the isolation was refused'),
    },
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, REPRODUCTION_REFUSALS.NOT_MEASURED);
  assert.equal(verdict.isolation.ok, false);
  assert.equal(verdict.isolation.reason, INVOKE_REFUSALS.NOT_ISOLATED);
  assert.equal(verdict.isolation.visibility, 'private');
});

test('an isolation this machine cannot settle still measures, and the verdict travels with the result', () => {
  // AC 1.4. A laptop with no route to GitHub must not become a publisher that
  // refuses every run: `verifyIsolation`'s control call is what tells the two
  // apart, and its verdict is carried onto the result and into the body a human
  // reads rather than swallowed.
  const repo = fixtureRepo();
  const io = runsFor();
  const made = worktreeWith(repo, io, {
    runId: 'run-offline', branch: 'fix/7-offline', files: { 'tests/thing.test.mjs': FAILING_TEST },
  });
  const verdict = assessReproduction(
    { repoRoot: repo, worktree: made.path, baseCommit: made.baseCommit, runId: 'run-offline' },
    {
      ...io,
      lsRemote: () => ({ status: 128, stdout: '', stderr: 'fatal: unable to access: Could not resolve host: github.com' }),
      ghAuth: ghIsolationRefused,
      replaySpawn: () => ({ status: 1, stdout: '', stderr: 'AssertionError [ERR_ASSERTION]: the thing is broken' }),
    },
  );
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(verdict.isolation.ok, false);
  assert.equal(verdict.isolation.reason, INVOKE_REFUSALS.ISOLATION_INCONCLUSIVE);

  const body = formatPullRequestBody({
    issue: 7, linearKey: 'FORGE-274', branch: 'fix/7-offline', baseCommit: made.baseCommit,
    runId: 'run-offline', criteria: ['a'], reproduction: verdict,
  });
  assert.match(body, new RegExp(`replay isolation.*${INVOKE_REFUSALS.ISOLATION_INCONCLUSIVE}`));
});

test('replayEnv cannot build an environment that is not isolated', () => {
  // AC 1.1, and the refusal is the point. A default of "no isolation" is a
  // signature that produces the defect on a caller's omission, which is exactly
  // how the publisher came to hold `replayEnv(process.env)`.
  const paths = { dir: 'd', gitconfig: 'd/gitconfig', ghConfigDir: 'd/gh', empty: 'd/empty' };
  const base = {
    PATH: '/usr/bin', NODE_TEST_CONTEXT: 'child-v8', FORCE_COLOR: '3',
    GH_TOKEN: 'ghp_x', GIT_ASKPASS: '/x/askpass',
  };
  const env = replayEnv(base, paths);
  assert.equal(env.GIT_CONFIG_GLOBAL, 'd/gitconfig');
  assert.equal(env.GIT_CONFIG_SYSTEM, 'd/empty');
  assert.equal(env.GH_CONFIG_DIR, 'd/gh');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GCM_INTERACTIVE, 'never');
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.PATH, '/usr/bin');
  for (const key of [...DEFENCE_IN_DEPTH_UNSET, 'NODE_TEST_CONTEXT', 'FORCE_COLOR']) {
    assert.equal(key in env, false, `replayEnv passed ${key} through`);
  }
  assert.equal(base.GH_TOKEN, 'ghp_x', 'replayEnv mutated the environment it was given');

  assert.throws(() => replayEnv(base), /isolation/);
  assert.throws(() => replayEnv(base, {}), /isolation/);
  assert.throws(() => replayEnv(base, { gitconfig: 'g' }), /isolation/);
});

test('no node --test child the publisher spawns inherits NODE_TEST_CONTEXT', () => {
  // AC 4, pinned on its own because losing it is silent in the worst direction: a
  // child that inherits it reports to the parent runner instead of to its own
  // exit code and **exits 0 on a failing test**, so the reproduction predicate
  // answers no for every run and the publisher opens nothing, forever.
  const repo = fixtureRepo();
  const io = runsFor();
  const made = worktreeWith(repo, io, {
    runId: 'run-ctx', branch: 'fix/7-ctx', files: { 'tests/thing.test.mjs': FAILING_TEST },
  });
  const spawns = [];
  withSeededAmbient(() => {
    assessReproduction(
      { repoRoot: repo, worktree: made.path, baseCommit: made.baseCommit, runId: 'run-ctx' },
      {
        ...io,
        lsRemote: isolationRefused,
        ghAuth: ghIsolationRefused,
        replaySpawn: (command, args, options) => {
          spawns.push(options.env);
          return { status: 1, stdout: '', stderr: 'AssertionError [ERR_ASSERTION]' };
        },
      },
    );
    assert.equal(process.env.NODE_TEST_CONTEXT, 'child-v8', 'the seed did not take');
    assert.equal(spawns.length, 1);
    assert.equal('NODE_TEST_CONTEXT' in spawns[0], false,
      'the replay child inherited NODE_TEST_CONTEXT and will exit 0 on a failing test');
    assert.equal('FORCE_COLOR' in spawns[0], false);
  });
});

// ===========================================================================
// The two outcomes, end to end
// ===========================================================================

test('the no-reproduction case opens nothing and files a comment instead', () => {
  // The negative case, tested as a negative case. `gh pr create` must not appear
  // at the seam at all, and nothing must reach the remote.
  const repo = fixtureRepo();
  const io = runsFor();
  const remote = bareRemote(repo);
  const made = worktreeWith(repo, io, {
    runId: 'run-none', branch: 'fix/7-none', files: { 'tests/thing.test.mjs': PASSING_TEST },
  });
  const rec = ghRecorder();
  const result = publishRun({
    repoRoot: repo, worktree: made.path, branch: 'fix/7-none', issue: 7,
    baseCommit: made.baseCommit, runId: 'run-none', linearKey: 'FORGE-99', issueTitle: 'the thing breaks',
  }, { ...io, gh: rec.gh });

  assert.equal(result.ok, false);
  assert.equal(result.reason, PUBLISH_REFUSALS.NO_REPRODUCTION);
  assert.equal(result.published, false);
  assert.equal(result.outcome, OUTCOME_REPORTED);
  assert.equal(result.pr, null);

  assert.equal(rec.calls.length, 1, 'the publisher made more than one outbound call');
  assert.deepEqual(rec.calls[0].args.slice(0, 3), ['issue', 'comment', '7']);
  assert.equal(rec.calls.some((c) => c.args[1] === 'create'), false, 'a pull request was opened with no reproduction');

  // Nothing reached the remote: the bare repository holds no refs at all.
  assert.equal(git(['for-each-ref', '--format=%(refname)'], remote).trim(), '');

  // The comment says what happened and where the worktree is, and its body file
  // is outside the worktree — a file written inside it is untracked content that
  // makes Phase 2's reaper refuse the checkout as dirty.
  assert.match(result.comment.body, /#7 \(FORGE-99\)/);
  assert.match(result.comment.body, /pushed no branch and\nopened no pull request/);
  assert.match(result.comment.body, /test-passes-on-the-base-commit/);
  assert.equal(result.comment.path, bodyPath(repo, 'run-none', 'comment', io));
  assert.equal(result.comment.path.startsWith(made.path), false);
  assert.equal(git(['status', '--porcelain'], made.path).trim(), '');
});

test('the reproduction case pushes for real and opens a draft pull request', () => {
  // The push half is real, against a bare repository this file created. The
  // `gh pr create` half is asserted at the seam: a pull request opened against a
  // real remote cannot be withdrawn without a residue this machine's token can no
  // longer clear (ADR 0008 row 7).
  const repo = fixtureRepo();
  const io = runsFor();
  const remote = bareRemote(repo);
  const made = worktreeWith(repo, io, {
    runId: 'run-pub', branch: 'fix/7-thing-breaks', files: { 'tests/thing.test.mjs': FAILING_TEST },
  });
  const head = git(['rev-parse', 'HEAD'], made.path).trim();
  const rec = ghRecorder();

  const result = publishRun({
    repoRoot: repo, worktree: made.path, branch: 'fix/7-thing-breaks', issue: 7,
    baseCommit: made.baseCommit, runId: 'run-pub', linearKey: 'FORGE-99',
    issueTitle: 'the thing breaks on save', criteria: ['saving does not break the thing'],
    generation: { ok: true, invoked: true, branch: 'fix/7-thing-breaks', agent: { status: 0 } },
  }, { ...io, gh: rec.gh });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.published, true);
  assert.equal(result.outcome, OUTCOME_PUBLISHED);
  assert.equal(result.commit, head);

  // The push really happened, and the branch is on the remote at the run's tip.
  assert.deepEqual(result.push.argv, ['push', '--set-upstream', 'origin', 'fix/7-thing-breaks']);
  assert.equal(git(['rev-parse', 'refs/heads/fix/7-thing-breaks'], remote).trim(), head);

  // One pull request, drafted, with the body handed over as a file.
  assert.equal(rec.calls.length, 1);
  assert.deepEqual(rec.calls[0].args, [
    'pr', 'create', '--head', 'fix/7-thing-breaks', '--base', 'main',
    '--title', 'fix: the thing breaks on save',
    '--body-file', bodyPath(repo, 'run-pub', 'pr', io), '--draft',
  ]);

  // The body on disk is the body asserted, and it ends where it should.
  const onDisk = readFileSync(result.pr.path, 'utf8');
  assert.equal(onDisk, result.pr.body);
  assert.equal(onDisk.trimEnd().split('\n').at(-1), 'Fixes #7');
  assert.match(onDisk, /`#7 \(FORGE-99\)`/);
  assert.match(onDisk, /saving does not break the thing/);
  assert.match(onDisk, /tests\/thing\.test\.mjs/);
  for (const tell of ATTRIBUTION_TELLS) {
    assert.equal(onDisk.toLowerCase().includes(tell.toLowerCase()), false, `the published body carries ${tell}`);
  }
});

test('a refused generation publishes nothing and files the report it already wrote', () => {
  // Phase 3 returns `branch: null` and `outcome: reported` on every refusal
  // precisely so a later step reading `branch` optimistically has nothing to
  // push. This is that later step, and it checks `ok` first.
  const repo = fixtureRepo();
  const io = runsFor();
  const remote = bareRemote(repo);
  const rec = ghRecorder();
  const result = publishRun({
    repoRoot: repo, worktree: repo, branch: null, issue: 7, runId: 'run-vague',
    generation: {
      ok: false, reason: 'no-acceptance-criteria', invoked: false, branch: null,
      published: false, outcome: OUTCOME_REPORTED,
      report: 'No acceptance criteria could be sourced for #7, so this run implemented\nnothing.\n',
    },
  }, { ...io, gh: rec.gh, git: () => assert.fail('a refused run reached git') });

  assert.equal(result.ok, false);
  assert.equal(result.reason, PUBLISH_REFUSALS.RUN_REFUSED);
  assert.equal(result.generationReason, 'no-acceptance-criteria');
  assert.equal(result.published, false);
  assert.equal(result.pr, null);
  assert.equal(rec.calls.length, 1);
  assert.deepEqual(rec.calls[0].args.slice(0, 2), ['issue', 'comment']);
  assert.equal(git(['for-each-ref', '--format=%(refname)'], remote).trim(), '');
});

// ===========================================================================
// The hook, against a real remote
// ===========================================================================

test('a badly named branch is refused by the pre-push hook against a real remote', () => {
  // The publisher's own guard refuses this name before the push, so this pushes
  // around the publisher deliberately: the claim under test is that the hook
  // really refuses, not that our regex agrees with itself.
  const repo = fixtureRepo();
  const remote = bareRemote(repo);
  const env = { ...process.env, [BRANCH_BYPASS_ENV]: '' };

  const good = spawnSync('git', ['-C', repo, 'push', 'origin', 'main:refs/heads/fix/7-good-name'], { encoding: 'utf8', env });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(git(['rev-parse', 'refs/heads/fix/7-good-name'], remote).trim(),
    git(['rev-parse', 'HEAD'], repo).trim());

  const bad = spawnSync('git', ['-C', repo, 'push', 'origin', 'main:refs/heads/wip-nonsense'], { encoding: 'utf8', env });
  assert.notEqual(bad.status, 0, 'the hook let a non type/N-slug branch through to a real remote');
  assert.match(bad.stderr, /type\/N-slug/);
  assert.equal(spawnSync('git', ['-C', remote, 'rev-parse', '--verify', 'refs/heads/wip-nonsense'], { encoding: 'utf8' }).status !== 0,
    true, 'the refused branch reached the remote anyway');

  // And a direct push to main is refused too, which is the refusal the whole
  // construction is built around.
  const toMain = spawnSync('git', ['-C', repo, 'push', 'origin', 'main'], { encoding: 'utf8', env });
  assert.notEqual(toMain.status, 0);
  assert.match(toMain.stderr, /refusing to push directly to main/);
});

// ===========================================================================
// What this phase does not do
// ===========================================================================

test('the publisher merges nothing and enables nothing', () => {
  // ADR 0008 row 6, asserted over the source, because an absence has no call site
  // to observe. `merge` may appear only inside the allowlist's refusal message.
  const source = readFileSync(PUBLISH_SRC, 'utf8');
  // Quoted literals, because those are what become argv. The prose may name a
  // merge — the allowlist's comment explains why `gh pr merge` is the reason it
  // is an allowlist — and a check that could not tell the two apart would be
  // satisfied by deleting the explanation.
  assert.equal(/['"](merge|--merge|--squash|--rebase|--admin|close|delete)['"]/.test(source), false,
    'publish-run.mjs names a merge or close path in argv');
  assert.equal(source.includes('--dangerously-skip-permissions'), false);
  assert.equal(source.includes('bypassPermissions'), false);
});

test('a run that left work uncommitted reads differently from one that did nothing', () => {
  // **Found by the first real unattended run**, `fixer-312-20260905T021218Z`,
  // 2026-09-05. It produced a correct fix for `#312 (FORGE-353)` — verified by hand:
  // its test fails on the base commit and passes with its own change — and never ran
  // `git commit`. Three files sat modified in the worktree.
  //
  // The publisher was right to refuse: it replays *committed* tests, deliberately,
  // because a run's own account of itself is what the publication boundary exists to
  // stop deciding this. Uncommitted work is unverifiable and must not publish.
  //
  // The refusal was right and its report was wrong. Both cases printed *"the run
  // committed no runnable test file"*, which reads as *the agent did nothing* — so a
  // human closes the issue while a verified fix sits on disk, one `git diff` away.
  const clean = formatNoReproductionComment({
    issue: 312, reason: REPRODUCTION_REFUSALS.NO_TEST,
    reproduction: { tests: [], baseCommit: 'f7c96c48', uncommitted: [] },
    runId: 'fixer-312', worktree: 'C:/runs/fixer-312',
  });
  const dirty = formatNoReproductionComment({
    issue: 312, reason: REPRODUCTION_REFUSALS.NO_TEST,
    reproduction: {
      tests: [], baseCommit: 'f7c96c48',
      uncommitted: ['scripts/agent-fixer.mjs', 'tests/agent-fixer.test.mjs'],
    },
    runId: 'fixer-312', worktree: 'C:/runs/fixer-312',
  });

  // Through the rendered body, which is the thing a human reads. An object holding
  // the fact proves nothing about whether it reaches anybody.
  assert.notEqual(dirty, clean, 'the two cases render identically');
  assert.match(dirty, /uncommitted/i);
  assert.match(dirty, /scripts\/agent-fixer\.mjs/, 'the report names none of the files left behind');
  assert.match(dirty, /tests\/agent-fixer\.test\.mjs/);

  // The clean case is unchanged: this adds a case rather than replacing one.
  assert.match(clean, /committed no runnable test file/);
  assert.equal(/uncommitted/i.test(clean), false, 'a clean worktree was reported as having work left behind');

  // Both still point at the worktree. Nothing removes a checkout it cannot vouch
  // for, and this is exactly the case where a human wants to look.
  for (const body of [clean, dirty]) assert.match(body, /C:\/runs\/fixer-312/);

  // **The bullet list stays a bullet list.** The prose explaining the uncommitted
  // case was first inserted between the bullets, so `- base commit`, `- run` and
  // `- worktree` rendered after a paragraph and the list broke in two. Cosmetic and
  // it shipped, which for a body whose entire justification is that a human reads it
  // is not a small thing.
  const lines = dirty.split('\n');
  const bulletRows = lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith('- ')).map(([, i]) => i);
  const contiguous = bulletRows.every((i, n) => n === 0 || i === bulletRows[n - 1] + 1);
  assert.equal(contiguous, true, `the bullet list is interrupted: rows ${bulletRows.join(', ')}`);
});

test('the assessment names the files a run changed and did not commit', () => {
  // The detector half of `#316 (FORGE-354)`. The formatter test injects
  // `uncommitted` directly, which proves the body renders it and says nothing about
  // whether anything ever puts it there — measured: a mutant stubbing the `git
  // status` call to fail killed no test in the whole suite until this one existed.
  //
  // The shape is the one the first real run left behind: a worktree with a committed
  // history that carries no test, and modified files sitting on top of it.
  const repo = fixtureRepo({ 'README.md': '# r\n', 'src/thing.mjs': 'export const n = 1;\n' });
  const io = runsFor();
  const made = worktreeWith(repo, io, {
    runId: 'run-dirty', branch: 'fix/7-dirty', files: { 'src/thing.mjs': 'export const n = 2;\n' },
  });
  // Left in the tree and never committed — exactly what the run did.
  writeFileSync(join(made.path, 'src/thing.mjs'), 'export const n = 3;\n', 'utf8');
  writeFileSync(join(made.path, 'src/extra.mjs'), 'export const m = 1;\n', 'utf8');

  const verdict = assessReproduction(
    { repoRoot: repo, worktree: made.path, baseCommit: made.baseCommit, runId: 'run-dirty' },
    { ...io, measure: () => assert.fail('a replay was run with no runnable test in the diff') },
  );

  assert.equal(verdict.reason, REPRODUCTION_REFUSALS.NO_TEST);
  assert.deepEqual([...verdict.uncommitted].sort(), ['src/extra.mjs', 'src/thing.mjs']);
});

test('a clean worktree reports nothing left behind, rather than an empty guess', () => {
  // The other side, so `uncommitted` is a measurement rather than a field that is
  // always populated. Without this, the detector could return every path it saw and
  // the test above would still pass.
  const repo = fixtureRepo({ 'README.md': '# r\n', 'src/thing.mjs': 'export const n = 1;\n' });
  const io = runsFor();
  const made = worktreeWith(repo, io, {
    runId: 'run-clean', branch: 'fix/7-clean', files: { 'src/thing.mjs': 'export const n = 2;\n' },
  });

  const verdict = assessReproduction(
    { repoRoot: repo, worktree: made.path, baseCommit: made.baseCommit, runId: 'run-clean' },
    { ...io, measure: () => assert.fail('a replay was run with no runnable test in the diff') },
  );

  assert.equal(verdict.reason, REPRODUCTION_REFUSALS.NO_TEST);
  assert.deepEqual(verdict.uncommitted, []);
});
