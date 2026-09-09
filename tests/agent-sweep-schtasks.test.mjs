// The one test in Phase 5 that talks to Windows.
//
// Everything else about registration is asserted over an argv, which is the right
// level for almost all of it. This is the part an argv cannot establish: that the
// argv the spec settled is one `schtasks` actually accepts, unelevated, on this
// machine. The elevation probe in the spec measured that by hand on 2026-08-28;
// this keeps it measured.
//
// **It uses a probe name and removes only that.** `daftplate\sweep` is the real
// task and a test must never touch it — a suite that deleted the operator's live
// schedule would be doing exactly what CLAUDE.md #5 forbids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { emptyDir } from './helpers/make-repo.mjs';
import { sweepStatePath } from '../scripts/lib/agent-state.mjs';
import { registerSweep, unregisterSweep, SWEEP_TASK_NAME } from '../scripts/agent-sweep.mjs';

// Unique to this process -- #231 (FORGE-301), second instance. `schtasks` names
// are a namespace shared with every other process on the machine, so a fixed
// probe name is the temp-root defect in a different spelling: two concurrent
// runs collide, and the `t.after(forceDelete)` of the one that finishes first
// removes the other's probe. That reads as `it removed a task it never created`
// -- a correct implementation accused of the exact fault the test exists to
// catch. Observed once during a concurrent full-suite run on this box.
//
// The pid alone would settle concurrency; the random half settles the stale case
// too, where a killed run leaves a probe behind at a name a recycled pid claims.
const PROBE = `daftplate\\sweep-test-probe-${process.pid}-${randomBytes(4).toString('hex')}`;

const schtasks = (args) => {
  const r = spawnSync('schtasks', args, { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
};

const available = () => process.platform === 'win32' && !schtasks(['/Query', '/?']).error;

/** Belt and braces: whatever the test does, this name does not survive it. */
const forceDelete = () => { schtasks(['/Delete', '/TN', PROBE, '/F']); };

test('the settled argv is one schtasks accepts, unelevated', { skip: !available() && 'schtasks is not available here' }, (t) => {
  t.after(forceDelete);
  assert.notEqual(PROBE, SWEEP_TASK_NAME, 'the probe must never be the real task');

  const homeDir = emptyDir();
  const reg = registerSweep({ repoRoot: process.cwd(), homeDir, taskName: PROBE }, { schtasks });
  assert.equal(reg.ok, true, `registration failed: ${reg.message}`);

  // Asked of Windows, not of our own state file — the state file is what we
  // believe, and this test exists to check what is true.
  const query = schtasks(['/Query', '/TN', PROBE]);
  assert.equal(query.status, 0, `Windows does not have the task: ${query.stderr}`);
  assert.match(query.stdout, /sweep-test-probe/);

  const un = unregisterSweep({ homeDir }, { schtasks });
  assert.equal(un.ok, true, `removal failed: ${un.message}`);
  assert.notEqual(schtasks(['/Query', '/TN', PROBE]).status, 0, 'the task survived removal');
  assert.equal(JSON.parse(readFileSync(sweepStatePath({ homeDir }), 'utf8')).registered, false);
});

test('a task this machine did not register is left standing', { skip: !available() && 'schtasks is not available here' }, (t) => {
  t.after(forceDelete);
  // Registered behind the module's back, so nothing wrote a state file for it.
  // This is the shape of the real hazard: a task somebody else created at a name
  // we recognise.
  const made = schtasks(['/Create', '/TN', PROBE, '/TR', 'cmd.exe /c exit', '/SC', 'ONCE', '/ST', '23:57', '/F']);
  assert.equal(made.status, 0, `could not create the probe: ${made.stderr}`);

  const result = unregisterSweep({ homeDir: emptyDir() }, { schtasks });
  assert.equal(result.ok, false);
  assert.equal(schtasks(['/Query', '/TN', PROBE]).status, 0, 'it removed a task it never created');
});
