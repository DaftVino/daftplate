// `#204 (FORGE-265)` AC 11: `NODE_TEST_CONTEXT` is stripped from any `node --test`
// child, and a mutant restoring it goes red.
//
// **The requirement was unmet when this file was written**, and the way it was
// unmet is the interesting part. The strip existed in `publish-run.mjs` with a
// long comment explaining exactly why it mattered — and no test touched it, because
// every replay test injects `measure` and so never reaches the real spawn. A
// correction carried forward as a constraint, documented in prose, and unprotected
// by anything executable.
//
// Two tests here, doing different jobs. The first pins the env construction. The
// second is the one that would actually have caught the original bug: it spawns a
// genuinely failing `node --test` from inside this suite and asserts the exit code
// is non-zero — which is false if the child inherits `NODE_TEST_CONTEXT`.
//
// `#214 (FORGE-274)` then made the run's isolation a required argument of
// `replayEnv`, and these tests pass one. The strip and the isolation are two
// different jobs and this file still only claims the first: what the isolation
// itself is asserted to be lives in `tests/publish-run.test.mjs`, over the
// environment the spawn really received.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyDir } from './helpers/make-repo.mjs';
import { replayEnv } from '../scripts/lib/publish-run.mjs';
import { writeIsolation } from '../scripts/lib/agent-invoke.mjs';

/** The run's isolation, built by the generation step's own `writeIsolation` —
 *  `#214 (FORGE-274)` made it a required argument of `replayEnv`, because a
 *  replay environment that is not isolated is the defect that issue reports. */
const isolation = () => writeIsolation(
  { repoRoot: emptyDir(), runId: 'run-replay-env' }, { runsDir: emptyDir(), agent: 'fixer' },
);

test('the replay environment carries no NODE_TEST_CONTEXT', () => {
  const env = replayEnv({ PATH: '/usr/bin', NODE_TEST_CONTEXT: 'child-v8', FORCE_COLOR: '1' }, isolation());
  assert.equal('NODE_TEST_CONTEXT' in env, false);
  assert.equal('FORCE_COLOR' in env, false, 'colour codes would corrupt the captured output');
  assert.equal(env.PATH, '/usr/bin', 'the rest of the environment must survive');
  assert.equal(env.NO_COLOR, '1');
});

test('this suite really is running with NODE_TEST_CONTEXT set', () => {
  // Without this the test below is vacuous: it would pass on a runner that never
  // sets the variable, proving nothing about the strip.
  assert.ok(process.env.NODE_TEST_CONTEXT, 'the premise of the next test does not hold here');
});

test('a failing node --test child exits non-zero under the replay environment', () => {
  // The end-to-end form, and the one that matches how the bug was found: a replay
  // of a test that genuinely fails came back `passed`, so the reproduction
  // predicate answered "no" for every run and the publisher never opened anything.
  const dir = emptyDir();
  writeFileSync(join(dir, 'fails.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "test('this one fails on purpose', () => { assert.equal(1, 2); });\n");

  const child = spawnSync(process.execPath, ['--test', 'fails.test.mjs'], {
    cwd: dir, encoding: 'utf8', env: replayEnv(process.env, isolation()), timeout: 60_000,
  });

  assert.notEqual(child.status, 0,
    `a failing test reported success — the child believed it was reporting to a parent runner.\n${child.stdout}`);
});

test('the same child DOES exit 0 when NODE_TEST_CONTEXT is left in place', () => {
  // The control, and what makes the test above evidence rather than a green tick.
  // If this ever stops exiting 0, node has changed the behaviour the strip exists
  // for, and the strip's justification should be re-measured rather than trusted.
  const dir = emptyDir();
  writeFileSync(join(dir, 'fails.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "test('this one fails on purpose', () => { assert.equal(1, 2); });\n");

  const leaky = { ...replayEnv(process.env, isolation()), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT };
  const child = spawnSync(process.execPath, ['--test', 'fails.test.mjs'], {
    cwd: dir, encoding: 'utf8', env: leaky, timeout: 60_000,
  });

  assert.equal(child.status, 0,
    'node no longer swallows the failure — re-measure whether the strip is still needed');
});
