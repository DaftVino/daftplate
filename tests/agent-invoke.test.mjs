import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { emptyDir, makeRepo } from './helpers/make-repo.mjs';
import {
  PERMISSION_MODE, FORBIDDEN_FLAGS, FORBIDDEN_MODES, DEFENCE_IN_DEPTH_UNSET, INVOKE_REFUSALS,
  assertInvocationSafe, buildInvocation, spawnAgent,
  isolationPaths, writeIsolation, isolatedEnv, classifyLiveCall, verifyIsolation,
  extractCriteria, namedDocuments, sourceAcceptanceCriteria,
  formatUnderspecifiedReport, runGeneration,
} from '../scripts/lib/agent-invoke.mjs';
import { createWorktree, OUTCOME_REPORTED } from '../scripts/lib/worktree.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const INVOKE_SRC = join(REPO, 'scripts/lib/agent-invoke.mjs');

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

/** A recording spawn seam. It returns what a caller asks for and, crucially,
 *  keeps the argv it was really handed — which is the surface AC 6 is asserted
 *  over, rather than the code that builds it. */
function recorder(result = { status: 0, stdout: '', stderr: '' }) {
  const calls = [];
  return {
    calls,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return result;
    },
  };
}

// ===========================================================================
// AC 6 — no invocation carries the bypass, asserted over the argv spawned
// ===========================================================================

test('AC 6 — the argv actually spawned carries acceptEdits, no bypass and no --add-dir', () => {
  // ADR 0008 row 1 is a rule with an audit trail behind it and not a mechanism —
  // the ADR says so — so this is what makes a violation legible rather than
  // deniable. Asserted over what reached the spawn, not over buildInvocation's
  // return value: an invocation object is a plain object and anything may edit it
  // between the two.
  const rec = recorder();
  const worktree = emptyDir();
  const invocation = buildInvocation({ worktree, prompt: 'fix the bug', env: { PATH: 'x' } });
  spawnAgent(invocation, { spawn: rec.spawn });

  assert.equal(rec.calls.length, 1);
  const { command, args, options } = rec.calls[0];
  assert.equal(command, 'claude');
  const flat = args.join('\u0000').toLowerCase();
  for (const needle of [...FORBIDDEN_FLAGS, ...FORBIDDEN_MODES]) {
    assert.equal(flat.includes(needle.toLowerCase()), false, `the spawned argv carried ${needle}`);
  }
  // The positive halves of rows 1 and 2. "No bypass flag" is satisfied by an argv
  // with no permission mode at all, which is why the mode itself is pinned — and
  // pinned to the literal ADR 0008 row 1 names, not to the module's own constant.
  // Compared against the import, a mutation of the constant moves both sides of
  // the assertion at once and the test agrees with whatever the module now says.
  assert.equal(args.filter((a) => a === '--permission-mode').length, 1);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(PERMISSION_MODE, 'acceptEdits');
  assert.equal(args.includes('--add-dir'), false);
  assert.equal(args.some((a) => a.startsWith('--add-dir=')), false);
  // Row 2 and row 10: the worktree is the boundary, and it is set by cwd.
  assert.equal(options.cwd, worktree);
});

test('AC 6 — an argv carrying the bypass is refused, and nothing is spawned', () => {
  // The flag strings appear here as the needle of a refusal, which is the only
  // place the plan's constraint permits them: nothing passes them anywhere.
  const worktree = emptyDir();
  for (const forbidden of [...FORBIDDEN_FLAGS, ...FORBIDDEN_MODES]) {
    const rec = recorder();
    assert.throws(
      () => buildInvocation({ worktree, prompt: 'x', extraArgs: [forbidden] }),
      /ADR 0008 row 1|--permission-mode must be/,
      `${forbidden} was accepted by buildInvocation`,
    );
    // Past buildInvocation too: the guard runs again at the spawn, so an
    // invocation edited after it was built is still refused.
    assert.throws(
      () => spawnAgent({
        command: 'claude',
        args: ['--print', '--permission-mode', PERMISSION_MODE, forbidden, 'x'],
        options: { cwd: worktree },
      }, { spawn: rec.spawn }),
      /ADR 0008 row 1/,
      `${forbidden} was accepted by spawnAgent`,
    );
    assert.equal(rec.calls.length, 0, `${forbidden} reached a spawn`);
  }
});

test('AC 6 — the refusal is not fooled by an equals sign, casing, or a prompt', () => {
  const worktree = emptyDir();
  const mode = FORBIDDEN_MODES[0];
  const cases = [
    ['--permission-mode', mode],                       // as a mode value
    [`--permission-mode=${mode}`],                     // joined
    [`--permission-mode=${mode.toUpperCase()}`],       // recased
    ['--add-dir', 'X:/somewhere-else'],                // ADR 0008 row 2
    ['--add-dir=X:/somewhere-else'],
  ];
  for (const extraArgs of cases) {
    assert.throws(() => buildInvocation({ worktree, prompt: 'x', extraArgs }), JSON.stringify(extraArgs));
  }
  // The prompt is an argv element like any other. A prompt naming the flag is a
  // run asking the agent to pass it — which under acceptEdits, where Bash is
  // auto-accepted, it can. Refusing it is the safe direction and is pinned rather
  // than left to be discovered.
  assert.throws(
    () => buildInvocation({ worktree, prompt: `run claude with ${FORBIDDEN_FLAGS[0]}` }),
    /ADR 0008 row 1/,
  );
  // And an argv with no permission mode at all does not pass by carrying no flag.
  assert.throws(() => assertInvocationSafe(['--print', 'do a thing']), /exactly one --permission-mode/);
  assert.throws(() => assertInvocationSafe(['--permission-mode', 'dontAsk', 'x']), /must be acceptEdits/);
});

test('the forbidden strings live in this module only as the needles of a refusal', () => {
  // scripts/agent-fixer.mjs is checked by an absence grep because it must never
  // contain them. This module must, or it could not refuse them — so the property
  // pinned is narrower: every occurrence sits inside the exported constants.
  const source = readFileSync(INVOKE_SRC, 'utf8');
  const declarations = source.match(/export const FORBIDDEN_FLAGS[\s\S]*?export const FORBIDDEN_MODES[^\n]*\n/);
  assert.ok(declarations, 'the forbidden constants are no longer declared together');
  const rest = source.replace(declarations[0], '');
  for (const needle of [...FORBIDDEN_FLAGS, ...FORBIDDEN_MODES]) {
    assert.equal(rest.includes(needle), false,
      `${needle} appears in scripts/lib/agent-invoke.mjs outside the forbidden constants`);
  }
});

// ===========================================================================
// AC 4 — a live authenticated call from the run's own configuration is refused
// ===========================================================================

test('the isolated configuration is a git and gh configuration, not a scrubbed environment', () => {
  const repo = repoWithCommit({ 'README.md': '# r\n' });
  const io = runsFor();
  const paths = writeIsolation({ repoRoot: repo, runId: 'run-iso' }, io);
  const env = isolatedEnv(paths, { PATH: 'p', GH_TOKEN: 'ghp_x', GITHUB_TOKEN: 'ghp_y', GIT_ASKPASS: 'a' });

  // The two lines that are the boundary (probe P2-iso-b and P3b).
  assert.equal(env.GIT_CONFIG_GLOBAL, paths.gitconfig);
  assert.equal(env.GIT_CONFIG_SYSTEM, paths.empty);
  assert.equal(env.GH_CONFIG_DIR, paths.ghConfigDir);
  assert.equal(readFileSync(paths.empty, 'utf8'), '');

  // The isolated global config carries an identity and no credential helper. The
  // identity is copied because D1 adopted a construction with no separate
  // identity, and because a global config with no user.* makes every commit in
  // the worktree fail — which reads as the fixer being broken, not isolated.
  const config = readFileSync(paths.gitconfig, 'utf8');
  assert.match(config, /\[user\]/);
  assert.match(config, /name = Test/);
  assert.match(config, /email = test@example\.invalid/);
  assert.equal(/gh\.exe|git-credential|helper = \S/.test(config), false, config);

  // The environment edits are defence in depth and are declared as such. They are
  // asserted so a regression is visible, never as evidence of isolation.
  for (const key of DEFENCE_IN_DEPTH_UNSET) assert.equal(key in env, false, key);

  // Isolation lives beside the worktree, never inside one: acceptEdits writes
  // freely within cwd, so a config file in there is one the agent can edit and
  // then commit.
  assert.ok(paths.dir.startsWith(io.runsDir), paths.dir);
  assert.deepEqual(isolationPaths(repo, 'run-iso', io).gitconfig, paths.gitconfig);
});

test('a live call is classified so a dead network is never read as a refusal', () => {
  // The ordering that keeps AC 4 honest. On a machine with no route to GitHub
  // every call fails, and counting that as isolation would pass this suite's
  // central assertion on a disconnected laptop.
  assert.equal(classifyLiveCall({ status: 0, stdout: 'abc\trefs/heads/main' }).verdict, 'authenticated');
  assert.equal(
    classifyLiveCall({ status: 128, stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" }).verdict,
    'refused',
  );
  assert.equal(classifyLiveCall({ status: 1, stderr: 'You are not logged into any GitHub hosts' }).verdict, 'refused');
  assert.equal(
    classifyLiveCall({ status: 128, stderr: "fatal: unable to access 'https://github.com/x': Could not resolve host: github.com" }).verdict,
    'inconclusive',
  );
  assert.equal(classifyLiveCall({ status: 128, stderr: 'fatal: something else entirely' }).verdict, 'inconclusive');
});

/**
 * Seams for the halves a test is not about.
 *
 * `verifyIsolation` runs both halves on every call, so a test aimed at one of
 * them has to pin the other or it shells out for real — which is how a unit test
 * starts depending on whether this machine happens to be logged in. `GH_ISOLATED`
 * and `GIT_ISOLATED` are the pinned-good halves; both authenticate for the
 * ambient control and are refused under anything else, which is the shape the
 * live calls have when the isolation holds.
 */
const authenticatedThenRefused = (refusal) => (useEnv) => (useEnv === process.env
  ? { status: 0, stdout: 'ok\n' }
  : { status: 1, stderr: refusal });
const GH_ISOLATED = authenticatedThenRefused('You are not logged into any GitHub hosts. To log in, run: gh auth login');
const GIT_ISOLATED = authenticatedThenRefused(
  "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
);

test('verifyIsolation refuses to certify anything when its control does not authenticate', () => {
  // Without this, "the isolated call failed" is the whole test, and the whole test
  // passes on a machine with no credential and no network.
  const dead = () => ({ status: 128, stderr: 'fatal: could not resolve host: github.com' });
  const verdict = verifyIsolation({ cwd: 'X:/w', env: {} }, { lsRemote: dead, ghAuth: GH_ISOLATED });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, INVOKE_REFUSALS.ISOLATION_INCONCLUSIVE);
  assert.equal(verdict.half, 'git');
  assert.match(verdict.message, /control/);

  // And a run whose isolated call succeeds against a private remote is refused,
  // loudly. This is the shape Phase 1 measured: environment scrubbed, credential
  // still arriving through git configuration.
  const stillAuthenticated = () => ({ status: 0, stdout: 'abc\trefs/heads/main\n' });
  const leaky = verifyIsolation({ cwd: 'X:/w', env: {} }, {
    lsRemote: stillAuthenticated, ghAuth: GH_ISOLATED, remoteVisibility: () => 'private',
  });
  assert.equal(leaky.ok, false);
  assert.equal(leaky.reason, INVOKE_REFUSALS.NOT_ISOLATED);
  assert.equal(leaky.half, 'git');
});

test('a remote that answers anonymously settles nothing, and is not read either way', () => {
  // The second way this check could quietly prove nothing, and the one Phase 1 did
  // not meet because it measured a private repository. Against a public remote —
  // which the daftplate export itself is — `ls-remote` succeeds for every process
  // on earth: its success is not a leak, and its refusal would not be isolation.
  const authenticated = () => ({ status: 0, stdout: 'abc\trefs/heads/main\n' });
  const anonymous = verifyIsolation({ cwd: 'X:/w', env: {} }, {
    lsRemote: authenticated, ghAuth: GH_ISOLATED, remoteVisibility: () => 'public',
  });
  assert.equal(anonymous.ok, false, 'a public remote was certified as isolation');
  assert.equal(anonymous.reason, INVOKE_REFUSALS.ANONYMOUS_REMOTE);
  assert.match(anonymous.message, /without a credential/);

  // And the `gh` half is still asked, and still answered, on the checkout where
  // `ls-remote` settles nothing. That is the whole reason both halves run rather
  // than the `git` half short-circuiting: the daftplate export's own remote is
  // public, so a short circuit would refuse there having never asked the half
  // that reaches `gh gist create`.
  assert.equal(anonymous.gh.standing, 'isolated');
  assert.equal(anonymous.gh.control.verdict, 'authenticated');

  // An unanswerable visibility is treated as the alarm, not as the excuse. Failing
  // closed is the only direction a safety gate may guess in.
  const unknown = verifyIsolation({ cwd: 'X:/w', env: {} }, {
    lsRemote: authenticated, ghAuth: GH_ISOLATED, remoteVisibility: () => 'unknown',
  });
  assert.equal(unknown.reason, INVOKE_REFUSALS.NOT_ISOLATED);
});

test('#304 (FORGE-350) — the `gh` half is verified live, and a leak there is its own refusal', () => {
  // The half nothing asked until now. `git ls-remote` exercises
  // GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM; only `gh auth status` exercises
  // GH_CONFIG_DIR, and `gh` is the half reaching the outbound publication
  // capability — `gh gist create <path>` publishes a file with no branch, no push
  // and no pull request.
  const ghLeaking = () => ({ status: 0, stdout: 'github.com\n  Logged in to github.com account DaftVino\n' });
  const leak = verifyIsolation({ cwd: 'X:/w', env: {} }, { lsRemote: GIT_ISOLATED, ghAuth: ghLeaking });
  assert.equal(leak.ok, false, 'a run whose gh is logged in was certified as isolated');
  assert.equal(leak.reason, INVOKE_REFUSALS.GH_NOT_ISOLATED);
  assert.equal(leak.half, 'gh', 'the refusal does not name which half of the isolation failed');
  assert.match(leak.message, /GH_CONFIG_DIR/);
  // The git half is not discarded because the gh half failed: it is reported too,
  // and it stood.
  assert.equal(leak.git.standing, 'isolated');

  // A `gh` that answers nothing — no `gh` on PATH is the case that matters — is
  // inconclusive, never a pass. A refusal on a machine with no `gh` is not
  // evidence that a redirect anybody applied is working.
  const noGh = () => ({ status: null, stdout: '', stderr: '' });
  const absent = verifyIsolation({ cwd: 'X:/w', env: {} }, { lsRemote: GIT_ISOLATED, ghAuth: noGh });
  assert.equal(absent.ok, false, 'a machine with no gh was certified as isolated');
  assert.equal(absent.reason, INVOKE_REFUSALS.GH_INCONCLUSIVE);
  assert.equal(absent.half, 'gh');
  assert.match(absent.message, /control/);

  // Both halves standing is the only pass, and it is reachable.
  const both = verifyIsolation({ cwd: 'X:/w', env: {} }, { lsRemote: GIT_ISOLATED, ghAuth: GH_ISOLATED });
  assert.equal(both.ok, true, JSON.stringify(both, null, 2));
  assert.equal(both.git.standing, 'isolated');
  assert.equal(both.gh.standing, 'isolated');
});

test('#304 (FORGE-350) — when both halves leak, the publication half is the one named', () => {
  // Severity, not call order. Between two alarms the `gh` half is reported,
  // because it is the one reaching publication — and both standings are returned
  // either way, so naming one loses nothing.
  const authenticated = () => ({ status: 0, stdout: 'logged in\n' });
  const both = verifyIsolation({ cwd: 'X:/w', env: {} }, {
    lsRemote: authenticated, ghAuth: authenticated, remoteVisibility: () => 'private',
  });
  assert.equal(both.reason, INVOKE_REFUSALS.GH_NOT_ISOLATED);
  assert.equal(both.half, 'gh');
  assert.equal(both.git.standing, 'leaking', 'the git leak was dropped rather than reported');

  // And an alarm on either half outranks a question on the other, so a run that
  // leaks is never reported as merely unverifiable.
  const dead = () => ({ status: 128, stderr: 'fatal: could not resolve host: github.com' });
  const leakUnderDeadGit = verifyIsolation({ cwd: 'X:/w', env: {} }, { lsRemote: dead, ghAuth: authenticated });
  assert.equal(leakUnderDeadGit.reason, INVOKE_REFUSALS.GH_NOT_ISOLATED);
});

test('AC 4 — a live authenticated call from the run\'s own configuration is refused', (t) => {
  // The assertion the plan says may not be softened, and the one it says may not
  // be written over the child process environment: the credential reaches a child
  // through git configuration — a URL-scoped helper shelling out to gh, and the
  // system config's credential manager — so an environment assertion passes while
  // the run can still push main.
  //
  // Re-measured on this machine 2026-08-27: with every GitHub variable removed
  // from the environment and no configuration change, `git ls-remote origin`
  // listed refs. Environment scrubbing is not the answer; it is the part that
  // looks like it.
  const io = runsFor();
  const paths = writeIsolation({ repoRoot: REPO, runId: 'run-ac4' }, io);
  const env = isolatedEnv(paths, process.env);

  const verdict = verifyIsolation({ cwd: REPO, env, timeout: 60_000 });
  if (verdict.reason === INVOKE_REFUSALS.ISOLATION_INCONCLUSIVE && verdict.control?.verdict !== 'authenticated') {
    // Honest rather than green: with no authenticated control this machine cannot
    // tell isolation from a broken network, and a pass here would mean nothing.
    t.skip(`no authenticated control on this machine: ${verdict.control?.detail ?? ''}`);
    return;
  }
  if (verdict.reason === INVOKE_REFUSALS.ANONYMOUS_REMOTE) {
    // This file ships in the daftplate export, whose own remote is public, and a
    // remote that answers without a credential cannot demonstrate a credential
    // refusal. Skipped with the reason rather than asserted into a false green.
    t.skip('this checkout\'s remote is readable anonymously, so ls-remote settles nothing here');
    return;
  }
  if (verdict.reason === INVOKE_REFUSALS.NOT_ISOLATED && verdict.git?.visibility === 'unknown') {
    // The same shape as the skip above, arriving under a different name because
    // the visibility could not be read at all. `verifyGitHalf` treats an
    // unanswerable visibility as the alarm rather than the excuse — a deliberate
    // ruling, recorded and asserted in `a remote that answers anonymously settles
    // nothing`, and not one this test may quietly reverse by being made green.
    //
    // But the alarm is not evidence *here*. This file ships in the daftplate
    // export, whose remote is public and whose CI has no `gh` login, so
    // `gh repo view` exits non-zero and the visibility is `unknown` while the
    // anonymous `ls-remote` succeeds. Measured on the export's own CI 2026-09-08:
    // this test failed there while the other 1506 passed.
    //
    // The skip is deliberately narrow, because a skip that widens is how a suite
    // starts proving nothing. It requires the isolated call to have SUCCEEDED —
    // the ambiguous case, indistinguishable from an anonymous read. A refusal, or
    // a known-private remote, still lands on the assertions below.
    assert.equal(verdict.git.call?.verdict, 'authenticated',
      'the skip is for an ambiguous success; this refusal is a real result and must be asserted');
    t.skip('the remote answered and its visibility could not be read, so this settles nothing here');
    return;
  }
  if (verdict.reason === INVOKE_REFUSALS.GH_INCONCLUSIVE) {
    // Both halves run now, so this test can be stopped by the other one. It is
    // about `git ls-remote`; the `gh` half has its own live test below with its
    // own skips, and reporting this one as a failure would name the wrong half.
    t.skip(`the gh half is unverifiable here: ${verdict.gh?.control?.detail ?? ''}`);
    return;
  }
  assert.equal(verdict.ok, true, JSON.stringify(verdict, null, 2));
  assert.equal(verdict.isolated, true);
  assert.equal(verdict.control.verdict, 'authenticated', 'the control did not authenticate');
  assert.equal(verdict.isolated_call.verdict, 'refused');
  assert.match(
    verdict.isolated_call.detail,
    /could not read Username|Authentication failed|terminal prompts disabled/i,
    'the refusal was not an authentication refusal',
  );
});

test('#304 (FORGE-350) — a live `gh` call from the run\'s own configuration is unauthenticated', (t) => {
  // The assertion `#304 (FORGE-350)` exists for, and the one that gives
  // GH_CONFIG_DIR a test: with the redirect removed or misspelled, `gh auth
  // status` under the run's environment finds the ambient login and this fails.
  // Before this test nothing anywhere read that variable at runtime, so the
  // mutant killed nothing and the `gh` half of the isolation rested on a
  // measurement taken once on 2026-08-27.
  //
  // Measured on this machine 2026-09-05: ambient `gh auth status` exits 0 with
  // `Logged in to github.com account DaftVino (keyring)`; the same call with
  // GH_CONFIG_DIR pointed at an empty directory exits 1 with `You are not logged
  // into any GitHub hosts`. The credential is in the keyring, not the
  // environment, which is why unsetting GH_TOKEN is declared defence in depth and
  // never the boundary.
  //
  // The `git` half is pinned with a seam rather than run live. This test is about
  // the `gh` half; leaving `ls-remote` live would make it skip on a public
  // checkout for a reason that has nothing to do with what it asserts.
  const io = runsFor();
  const paths = writeIsolation({ repoRoot: REPO, runId: 'run-gh-iso' }, io);
  const env = isolatedEnv(paths, process.env);

  const verdict = verifyIsolation({ cwd: REPO, env, timeout: 60_000 }, { lsRemote: GIT_ISOLATED });
  if (verdict.reason === INVOKE_REFUSALS.GH_INCONCLUSIVE && verdict.gh?.control?.verdict !== 'authenticated') {
    // Honest rather than green, for the control's whole reason: with no `gh` on
    // PATH, or one that is not logged in ambiently, a refusal under the run's
    // environment is not evidence that any redirect is working. CI is this case.
    t.skip(`gh does not authenticate ambiently here: ${verdict.gh?.control?.detail ?? ''}`);
    return;
  }
  assert.equal(verdict.ok, true, JSON.stringify(verdict, null, 2));
  assert.equal(verdict.gh.standing, 'isolated');
  assert.equal(verdict.gh.control.verdict, 'authenticated', 'the gh control did not authenticate');
  assert.equal(verdict.gh.call.verdict, 'refused');
  assert.match(
    verdict.gh.call.detail,
    /not logged into any github|gh auth login/i,
    'the gh refusal was not an authentication refusal',
  );

  // AC 4's last line, asserted rather than assumed. `gh auth token` is never
  // called and `gh auth status` masks what it prints, so the only way a token
  // reaches a verdict is a future `gh` printing more — which `redactTokens`
  // catches at the one place output is captured.
  assert.doesNotMatch(
    JSON.stringify(verdict),
    /gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}/,
    'a token reached the verdict',
  );
});

test('#304 (FORGE-350) — a token in a live call\'s output never reaches the verdict', () => {
  // The guarantee above, made reachable without waiting for either tool to
  // leak one. The isolated calls are what fail, so their text is the text that
  // is kept. Both seams matter: `gh auth status` masks its token today, while
  // `git` includes a credential-bearing remote verbatim in `unable to access`
  // failures. Exercising only the former leaves the symmetric capture site free
  // to retain the credential even though both results have the same verdict
  // shape and the same possible future readers.
  const ghLeaks = (useEnv) => (useEnv === process.env
    ? { status: 0, stdout: 'logged in\n' }
    : { status: 1, stderr: 'gh auth login required; stale token gho_ABCDEF0123456789abcdef was rejected' });
  const ghVerdict = verifyIsolation({ cwd: 'X:/w', env: {} }, { lsRemote: GIT_ISOLATED, ghAuth: ghLeaks });
  assert.equal(ghVerdict.gh.call.verdict, 'refused');
  assert.match(ghVerdict.gh.call.detail, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(ghVerdict), /gho_ABCDEF/, 'a gh token was recorded in the verdict');

  const gitLeaks = (useEnv) => (useEnv === process.env
    ? { status: 0, stdout: 'refs/heads/main\n' }
    : {
        status: 128,
        stderr: "fatal: unable to access 'https://ghp_FEDCBA9876543210abcdef@github.com/o/r/': 403",
      });
  const gitVerdict = verifyIsolation({ cwd: 'X:/w', env: {} }, { lsRemote: gitLeaks, ghAuth: GH_ISOLATED });
  assert.equal(gitVerdict.git.call.verdict, 'inconclusive');
  assert.match(gitVerdict.git.call.detail, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(gitVerdict), /ghp_FEDCBA/, 'a git token was recorded in the verdict');
});

test('AC 4 — a run that is not isolated is never invoked', () => {
  // What the verdict is for. An unverified isolation stops the run before the
  // process exists, rather than being recorded next to one that already ran.
  const repo = repoWithCommit({ 'README.md': '# r\n' });
  const io = runsFor();
  const rec = recorder();
  const result = runGeneration({
    repoRoot: repo,
    runId: 'run-leak',
    issue: { number: 5, body: '## Acceptance criteria\n\n- it works\n' },
    worktree: emptyDir(),
    branch: 'fix/5-a',
    prompt: 'go',
  }, {
    ...io,
    spawn: rec.spawn,
    remoteVisibility: () => 'private',
    lsRemote: (env) => (env === process.env
      ? { status: 0, stdout: 'abc\trefs/heads/main\n' }        // control authenticates
      : { status: 0, stdout: 'abc\trefs/heads/main\n' }),      // and so does the run
    ghAuth: GH_ISOLATED,                                       // the gh half holds
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, INVOKE_REFUSALS.NOT_ISOLATED);
  assert.equal(result.invoked, false);
  assert.equal(result.branch, null);
  assert.equal(rec.calls.length, 0, 'an unisolated run was invoked anyway');

  // The report says what was asked, and both halves are now asked. A report
  // naming one live call describes a check that stopped being the whole check.
  assert.match(result.report, /gh auth status/);
});

test('#304 (FORGE-350) — a gh-only leak stops the run before the process exists', () => {
  // The git half holding is not enough, and this is the regression the issue
  // describes: a dropped GH_CONFIG_DIR left `ls-remote` refused by the git config
  // isolation, so every existing test stayed green while the run could reach
  // `gh gist create`.
  const repo = repoWithCommit({ 'README.md': '# r\n' });
  const io = runsFor();
  const rec = recorder();
  const result = runGeneration({
    repoRoot: repo,
    runId: 'run-gh-leak',
    issue: { number: 5, body: '## Acceptance criteria\n\n- it works\n' },
    worktree: emptyDir(),
    branch: 'fix/5-a',
    prompt: 'go',
  }, {
    ...io,
    spawn: rec.spawn,
    lsRemote: GIT_ISOLATED,
    ghAuth: () => ({ status: 0, stdout: 'Logged in to github.com account DaftVino\n' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, INVOKE_REFUSALS.GH_NOT_ISOLATED);
  assert.equal(result.invoked, false);
  assert.equal(rec.calls.length, 0, 'a run holding a gh credential was invoked anyway');
  assert.equal(result.isolation.half, 'gh');
  // The report names the half rather than telling an operator the run holds a
  // credential and leaving them to find out where it arrives from.
  assert.match(result.report, /GH_CONFIG_DIR/);
});

// ===========================================================================
// Step 3 — sourcing the acceptance criteria, and failing closed
// ===========================================================================

test('criteria are read from the issue body under their own heading', () => {
  const body = '## Summary\n\nsomething broke\n\n## Acceptance criteria\n\n'
    + '- the thing stops breaking\n- a test proves it\n\n## Notes\n\n- not a criterion\n';
  assert.deepEqual(extractCriteria(body), ['the thing stops breaking', 'a test proves it']);
  const sourced = sourceAcceptanceCriteria({ number: 1, body });
  assert.equal(sourced.ok, true);
  assert.equal(sourced.source, 'issue-body');
  assert.equal(sourced.criteria.length, 2);
});

test('a criteria list inside a fence is quoted material, not this issue\'s list', () => {
  const body = '## Acceptance criteria\n\n```\n- an example of a list\n```\n';
  assert.deepEqual(extractCriteria(body), []);
  assert.equal(sourceAcceptanceCriteria({ number: 1, body }).ok, false);
});

test('criteria are read from a document the issue names, resolved inside the worktree', () => {
  const worktree = makeRepo({
    'docs/designs/spec.md': '# Spec\n\n## Acceptance criteria\n\n1. it does the thing\n2. and says so\n',
  });
  const body = 'The criteria live in `docs/designs/spec.md`.\n';
  assert.deepEqual(namedDocuments(body), ['docs/designs/spec.md']);
  const sourced = sourceAcceptanceCriteria({ number: 2, body }, { worktree });
  assert.equal(sourced.ok, true);
  assert.equal(sourced.source, 'document');
  assert.equal(sourced.document, 'docs/designs/spec.md');
  assert.deepEqual(sourced.criteria, ['it does the thing', 'and says so']);
});

test('a named document outside the worktree is refused rather than read', () => {
  // worktree.mjs's containedIn is boundary-aware and is reused rather than
  // re-argued. A run under acceptEdits reads freely; the refusal is about what
  // this step is willing to treat as the issue's own criteria.
  const worktree = makeRepo({ 'in.md': '## Acceptance criteria\n\n- yes\n' });
  for (const path of ['../outside.md', '../../etc/notes.md']) {
    const sourced = sourceAcceptanceCriteria({ number: 3, body: `see \`${path}\`` }, { worktree });
    assert.equal(sourced.ok, false, path);
    assert.equal(sourced.reason, INVOKE_REFUSALS.DOCUMENT_OUTSIDE_WORKTREE);
  }
});

test('the three ways sourcing fails are three different refusals', () => {
  const worktree = makeRepo({ 'empty.md': '# Nothing here\n\njust prose\n' });
  assert.equal(sourceAcceptanceCriteria({ number: 4, body: '' }).reason, INVOKE_REFUSALS.NO_ISSUE_BODY);
  assert.equal(
    sourceAcceptanceCriteria({ number: 4, body: 'it is broken, please fix' }, { worktree }).reason,
    INVOKE_REFUSALS.NO_ACCEPTANCE_CRITERIA,
  );
  assert.equal(
    sourceAcceptanceCriteria({ number: 4, body: 'see `gone.md`' }, { worktree }).reason,
    INVOKE_REFUSALS.DOCUMENT_MISSING,
  );
  assert.equal(
    sourceAcceptanceCriteria({ number: 4, body: 'see `empty.md`' }, { worktree }).reason,
    INVOKE_REFUSALS.DOCUMENT_HAS_NO_CRITERIA,
  );
});

// ===========================================================================
// AC 3 — the underspecified issue produces a report and no branch
// ===========================================================================

test('AC 3 — a deliberately underspecified issue produces a report and no branch', () => {
  // The spec's most likely real-world outcome, tested as a negative case rather
  // than assumed. Run against a real worktree, so "no branch" is a fact about the
  // checkout rather than about a returned object.
  const repo = repoWithCommit({ 'README.md': '# r\n' });
  const io = runsFor();
  const made = createWorktree({ repoRoot: repo, runId: 'run-vague', branch: 'fix/9-vague' }, io);
  assert.equal(made.ok, true, made.message);

  const rec = recorder();
  const issue = { number: 9, title: 'it is broken', body: 'Something is wrong when I click the thing. Please fix.\n' };
  const result = runGeneration({
    repoRoot: repo, runId: 'run-vague', issue, worktree: made.path, branch: 'fix/9-vague', prompt: 'go',
  }, { ...io, spawn: rec.spawn, lsRemote: () => assert.fail('isolation was verified before the criteria were sourced') });

  assert.equal(result.ok, false);
  assert.equal(result.reason, INVOKE_REFUSALS.NO_ACCEPTANCE_CRITERIA);
  assert.equal(result.invoked, false);
  assert.equal(rec.calls.length, 0, 'the agent was invoked on an issue with no criteria');

  // No branch: nothing to publish, and nothing named for Phase 4 to publish
  // optimistically off a field it read without checking `ok`.
  assert.equal(result.branch, null);
  assert.equal(result.published, false);

  // And nothing in the worktree to push either — HEAD is still the base commit,
  // which is exactly what Phase 2's reaper requires of a run that reported.
  assert.equal(git(['rev-parse', 'HEAD'], made.path).trim(), made.baseCommit);
  assert.equal(git(['status', '--porcelain'], made.path).trim(), '');
  assert.equal(result.outcome, OUTCOME_REPORTED);

  // A report, and one that says what it looked for.
  assert.match(result.report, /No acceptance criteria could be sourced for #9/);
  assert.match(result.report, /fails closed/);
  assert.match(result.report, /pushed no branch and opened no pull request/);
});

test('the report names the issue in the repo\'s form, and never with a Linear key', () => {
  // ADR 0014: `<short>-<N>` on a Linear-variant repo, `#N` on any other. The key
  // never appears in prose, and is never computed from the GitHub number.
  const linear = formatUnderspecifiedReport({
    issue: 193, shortName: 'daftplate', reason: INVOKE_REFUSALS.NO_ACCEPTANCE_CRITERIA,
  });
  assert.match(linear, /sourced for daftplate-193,/);
  assert.equal(/FORGE-|#193/.test(linear), false, 'the old form survived beside the new one');
  const other = formatUnderspecifiedReport({ issue: 193, reason: INVOKE_REFUSALS.NO_ACCEPTANCE_CRITERIA });
  assert.match(other, /sourced for #193,/);
  assert.equal(/FORGE-|daftplate-/.test(other), false, 'an identifier was invented for a repo with no board');
});

test('the report ends at its last substantive line', () => {
  // Phase 4 assembles bodies for --body-file, which walks straight past the hook
  // that reads tool_input.command, so the property is pinned where the string is
  // built rather than where it is sent.
  const report = formatUnderspecifiedReport({
    issue: 9, reason: INVOKE_REFUSALS.DOCUMENT_MISSING, document: 'docs/spec.md',
    looked: ['the issue body', 'docs/spec.md'], runId: 'fixer-9',
  });
  for (const tell of ['Co-Authored-By', 'Generated with', 'claude.com', 'claude.ai', '\u{1F916}']) {
    assert.equal(report.includes(tell), false, `the report carries ${tell}`);
  }
  const lines = report.trimEnd().split('\n');
  assert.match(lines.at(-1), /delegate it again\.$/);
  assert.match(report, /docs\/spec\.md/);
});

// ===========================================================================
// The happy path, so the refusals above are not the only thing exercised
// ===========================================================================

test('a well-specified issue is invoked, in its worktree, under the isolated env', () => {
  const repo = repoWithCommit({ 'README.md': '# r\n' });
  const io = runsFor();
  const made = createWorktree({ repoRoot: repo, runId: 'run-ok', branch: 'fix/8-ok' }, io);
  const rec = recorder({ status: 0, stdout: 'done', stderr: '' });
  const seen = [];
  const result = runGeneration({
    repoRoot: repo,
    runId: 'run-ok',
    issue: { number: 8, body: '## Acceptance criteria\n\n- the thing works\n' },
    worktree: made.path,
    branch: 'fix/8-ok',
    prompt: 'fix #8',
  }, {
    ...io,
    spawn: rec.spawn,
    baseEnv: { PATH: process.env.PATH, GH_TOKEN: 'ghp_should_not_survive' },
    lsRemote: (env) => {
      seen.push(env);
      return env === process.env
        ? { status: 0, stdout: 'abc\trefs/heads/main\n' }
        : { status: 128, stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" };
    },
    // The `gh` half is seamed for the reason the `git` half is: this test
    // asserts what the run is handed, and a live `gh` call would make it turn
    // on whether the machine running the suite happens to be logged in. CI is
    // not, and every run there would refuse for a reason this is not about.
    ghAuth: GH_ISOLATED,
  });

  assert.equal(result.ok, true, JSON.stringify(result.agent));
  assert.equal(result.invoked, true);
  assert.equal(result.branch, 'fix/8-ok');
  assert.equal(result.published, false, 'the generation step published something');
  assert.deepEqual(result.criteria, ['the thing works']);
  assert.equal(result.criteriaSource, 'issue-body');

  // The isolation was verified before the agent existed, and against the same
  // environment the agent was then handed.
  assert.equal(seen.length, 2);
  const { options } = rec.calls[0];
  assert.equal(options.cwd, made.path);
  assert.equal(seen[1], options.env);
  assert.equal('GH_TOKEN' in options.env, false);
  assert.equal(options.env.GIT_CONFIG_GLOBAL, isolationPaths(repo, 'run-ok', io).gitconfig);
  assert.equal(options.env.GH_CONFIG_DIR, isolationPaths(repo, 'run-ok', io).ghConfigDir);
});

test('a worktree is not optional — an invocation with no cwd is refused', () => {
  // ADR 0008 row 10: a run that cannot get its own worktree does not start.
  assert.throws(() => buildInvocation({ prompt: 'x' }), /ADR 0008 row 10/);
});

test('the generation step publishes nothing in this phase', () => {
  // Asserted over the source, the way Phase 2 asserts its own absence: Phase 4
  // owns every outbound call, and a match here means it arrived early.
  const source = readFileSync(INVOKE_SRC, 'utf8');
  for (const forbidden of ["'push'", "'pr'", 'gh pr create', 'git push']) {
    assert.equal(source.includes(forbidden), false, `agent-invoke.mjs contains ${forbidden}, which is Phase 4's`);
  }
  // The one write it performs is the isolated configuration, and it is outside
  // every worktree by construction.
  const repo = repoWithCommit({ 'README.md': '# r\n' });
  const io = runsFor();
  const paths = writeIsolation({ repoRoot: repo, runId: 'run-w' }, io);
  assert.equal(existsSync(paths.gitconfig), true);
  assert.equal(paths.dir.includes(repo), false, 'the isolated config was written inside the repository');
});

test('writeIsolation does not delete what it did not create', () => {
  // CLAUDE.md #5, at the one place this module touches a directory twice.
  const repo = repoWithCommit({ 'README.md': '# r\n' });
  const io = runsFor();
  const paths = isolationPaths(repo, 'run-keep', io);
  mkdirSync(paths.ghConfigDir, { recursive: true });
  const stranger = join(paths.ghConfigDir, 'hosts.yml');
  writeFileSync(stranger, 'left by somebody else\n');
  writeIsolation({ repoRoot: repo, runId: 'run-keep' }, io);
  assert.equal(readFileSync(stranger, 'utf8'), 'left by somebody else\n');
});

test('a bold heading closes a bold-heading section', () => {
  // #194 (FORGE-260), plan-agents P6 / D7. `HEADING` opens on a `#` heading OR a
  // `**bold**` one; `NEXT_HEADING` closed on `#` only. The asymmetry IS the bug:
  // a criteria list running into `**Out of scope**` handed the out-of-scope
  // bullets straight into an unattended run's instructions.
  const body = '**Acceptance criteria**\n\n- real one\n\n**Out of scope**\n\n- NOT a criterion\n';
  assert.deepEqual(extractCriteria(body), ['real one']);
});

test('a hash heading still closes a bold-heading section', () => {
  // The other half of the asymmetry, so a fix cannot pass by swapping which
  // shape is honoured rather than by honouring both.
  const body = '**Acceptance criteria**\n\n- real one\n\n## Out of scope\n\n- NOT a criterion\n';
  assert.deepEqual(extractCriteria(body), ['real one']);
});

test('a bold heading closes a hash-heading section too', () => {
  const body = '## Acceptance criteria\n\n- real one\n\n**Out of scope**\n\n- NOT a criterion\n';
  assert.deepEqual(extractCriteria(body), ['real one']);
});

test('bold inside a criterion is not a heading, and does not truncate the list', () => {
  // The over-match this rule could plausibly have. A heading is a line that
  // OPENS with the bold marker; a bullet carrying bold is an ordinary item, and
  // a rule that cannot tell them apart would silently shorten every emphatic
  // criteria list -- a quieter failure than the one being fixed.
  const body = '## Acceptance criteria\n\n- **the thing** stops breaking\n- a test proves it\n';
  assert.deepEqual(extractCriteria(body), ['**the thing** stops breaking', 'a test proves it']);
});

test('the foreign items never reach the composed criteria a run is briefed with', () => {
  // A unit test on the extractor does not prove what reaches the brief, and the
  // brief is the destination that matters: these strings become an unattended
  // run's instructions.
  const body = '**Acceptance criteria**\n\n- real one\n\n**Out of scope**\n\n- NOT a criterion\n';
  const sourced = sourceAcceptanceCriteria({ number: 1, body });
  assert.equal(sourced.ok, true);
  assert.deepEqual(sourced.criteria, ['real one']);
});

test('a criterion that wraps across lines reaches the run whole', () => {
  // **Five real runs were briefed on half-sentences and none of them refused**,
  // because from inside the run the list looked complete. `fixer-312-20260905T053522Z`
  // reported it about itself: *"each was cut off mid-sentence, so my wording of the
  // tail of each is inference"*.
  //
  // Measured against `#312 (FORGE-353)`'s own body, criterion 1 arrived as *"A
  // refusal whose `message` is the empty string prints the `reason` rather than a"* —
  // losing `blank line`, which is the entire subject of the issue.
  //
  // This is worse than a formatting slip. Step 1 of the brief is *"State the
  // acceptance criteria before implementing anything"*, and a run that cannot state
  // them is built to refuse. A truncated criterion defeats that in the worst way: the
  // run can state something, so it proceeds, and what it proceeds on is a fragment.
  const body = [
    '## Acceptance criteria',
    '',
    '1. A refusal whose `message` is the empty string prints the `reason` rather than',
    '   a blank line, asserted through what the CLI actually writes.',
    '2. A single-line criterion is unchanged.',
    '3. A criterion may wrap',
    '   more than',
    '   once.',
    '',
  ].join('\n');

  assert.deepEqual(extractCriteria(body), [
    'A refusal whose `message` is the empty string prints the `reason` rather than a blank line,'
      + ' asserted through what the CLI actually writes.',
    'A single-line criterion is unchanged.',
    'A criterion may wrap more than once.',
  ]);
});

test('a wrapped criterion stops at the next item, the next heading and the section end', () => {
  // The three ways a continuation must end. Without all three, "join the following
  // lines" swallows the rest of the document — which is the obvious over-correction
  // and is worse than truncating, because the run is then briefed on prose that is
  // not a criterion at all.
  const body = [
    '## Acceptance criteria',
    '',
    '1. First wraps',
    '   onto here.',
    '2. Second stands alone.',
    '',
    '## Out of scope',
    '',
    'This paragraph belongs to no criterion and must not join one.',
    '',
  ].join('\n');

  assert.deepEqual(extractCriteria(body), ['First wraps onto here.', 'Second stands alone.']);
});

test('an unindented line after a criterion is not treated as its continuation', () => {
  // A continuation is indented under its item. A flush-left paragraph is prose that
  // happens to follow, and joining it would put words in the criterion nobody wrote
  // there — the same failure as truncation, in the other direction.
  const body = [
    '## Acceptance criteria',
    '',
    '1. The criterion.',
    'A flush-left sentence that is not part of it.',
    '',
  ].join('\n');

  assert.deepEqual(extractCriteria(body), ['The criterion.']);
});
