// Phase 5 of `#204 (FORGE-265)`: the sweeper, and the one Scheduled Task that
// wakes it.
//
// **The sweeper evaluates the window; the schedule does not encode it.** One task
// at a fixed tick, and the decision about whether now is inside an agent's window
// is made here, from a file a human can read. The alternative puts the schedule in
// Windows and in the repository at once, and `status` then either shells out per
// row or prints a copy that can disagree with the machine.
//
// The timezone is pinned before any Date exists in this file. Every window is a
// local wall-clock range, so a test left on the machine's own zone would pass or
// fail depending on where it ran — and the DST cases below need a zone whose
// transitions are known.
process.env.TZ = 'Europe/London';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import { agentStatePath, sweepStatePath } from '../scripts/agent-menu.mjs';
import { agentLogPath } from '../scripts/lib/agent-state.mjs';
import { agentById } from '../scripts/lib/agent-registry.mjs';
import {
  windowInstanceKey, shouldStart, sweep, buildRegisterArgs, registerSweep, unregisterSweep,
  SWEEP_TASK_NAME, TICK_MINUTES, defaultSpawn,
} from '../scripts/agent-sweep.mjs';

const WEEKDAYS = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '02:00', to: '05:00' };

/**
 * Every ADR 0008 enablement condition closed, injected into the sweeps below.
 *
 * `#194 (FORGE-260)` Phase 3 made `sweep()` consult `runAuthorization`, and on
 * this machine one condition is open — so without this seam every test here
 * asserting a spawn would go red, and the phase would look like it had broken the
 * sweeper rather than gated it.
 *
 * **The seam is the honest option, not the convenient one.** These tests are about
 * spawn mechanics: the argv the sweeper composes, the window it stamps, the
 * descriptor it closes, the child it unrefs. None of them is about whether an
 * agent is permitted to run, and rewriting them to assert a held reason would
 * delete the only coverage those mechanics have. The permitted case is asserted
 * where it belongs, in `tests/agent-authorization.test.mjs`, and the held case is
 * asserted there too.
 */
const PERMITTED = [{
  condition: 'stood in for by these tests, which are about spawn mechanics',
  closed: true,
  evidence: 'tests/agent-authorization.test.mjs holds the real authority coverage',
}];

// 2026-08-28 is a Friday; 2026-08-29 a Saturday.
const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm, 0, 0);

// ---------------------------------------------------------------------------
// Which window instance a moment belongs to
// ---------------------------------------------------------------------------

test('a moment inside the window names the instance it belongs to', () => {
  assert.equal(windowInstanceKey(WEEKDAYS, at(2026, 8, 28, 3, 0)), '2026-08-28T02:00');
});

test('a moment outside the window belongs to no instance', () => {
  assert.equal(windowInstanceKey(WEEKDAYS, at(2026, 8, 28, 1, 59)), null);
  assert.equal(windowInstanceKey(WEEKDAYS, at(2026, 8, 28, 5, 0)), null, 'the end is exclusive');
});

test('a day the window does not name belongs to no instance', () => {
  assert.equal(windowInstanceKey(WEEKDAYS, at(2026, 8, 29, 3, 0)), null, 'Saturday is not in the day set');
});

// ---------------------------------------------------------------------------
// Malformed input — none of this may throw, and none of it may match
// ---------------------------------------------------------------------------

test('a window with no days, empty days, or missing times belongs to no instance', () => {
  const now = at(2026, 8, 28, 3, 0);
  assert.equal(windowInstanceKey({ from: '02:00', to: '05:00' }, now), null, 'no days key');
  assert.equal(windowInstanceKey({ days: [], from: '02:00', to: '05:00' }, now), null, 'empty days');
  assert.equal(windowInstanceKey({ days: ['fri'], to: '05:00' }, now), null, 'no from');
  assert.equal(windowInstanceKey({ days: ['fri'], from: '02:00' }, now), null, 'no to');
});

test('a malformed time string is refused, not misread', () => {
  const now = at(2026, 8, 28, 3, 0);
  assert.equal(windowInstanceKey({ days: ['fri'], from: 'abc', to: '05:00' }, now), null, 'garbage from');
  assert.equal(windowInstanceKey({ days: ['fri'], from: '02:00', to: '05:60' }, now), null, 'minute out of range');
  assert.equal(windowInstanceKey({ days: ['fri'], from: '02:00', to: '25:00' }, now), null, 'hour out of range');
  assert.equal(windowInstanceKey({ days: ['fri'], from: '2:00', to: '05:00' }, now), null, 'unpadded hour');
});

test('a malformed `to` does not leave the window unbounded after `from`', () => {
  // Before the fix, a non-numeric `to` produced NaN, `from < NaN` is false, and
  // the crossing-midnight branch's `at >= from` alone has no upper bound — every
  // moment after `from`, on every day, matched. This is the regression test.
  const window = { days: ['fri'], from: '02:00', to: 'garbage' };
  assert.equal(windowInstanceKey(window, at(2026, 8, 28, 3, 0)), null);
  assert.equal(windowInstanceKey(window, at(2026, 8, 28, 23, 59)), null, 'must not match hours later, unbounded');
});

test('a non-string time does not crash the sweep', () => {
  // `state.window.from` comes from a JSON file a human can hand-edit; a number,
  // an object, or `null` must be refused, not thrown on `.split`.
  const now = at(2026, 8, 28, 3, 0);
  assert.doesNotThrow(() => windowInstanceKey({ days: ['fri'], from: 200, to: '05:00' }, now));
  assert.equal(windowInstanceKey({ days: ['fri'], from: 200, to: '05:00' }, now), null);
  assert.equal(windowInstanceKey({ days: ['fri'], from: null, to: '05:00' }, now), null);
});

test('a `now` that is not a valid Date belongs to no instance, and does not throw', () => {
  assert.doesNotThrow(() => windowInstanceKey(WEEKDAYS, '2026-08-28T03:00'));
  assert.equal(windowInstanceKey(WEEKDAYS, '2026-08-28T03:00'), null, 'a string is not a Date');
  assert.equal(windowInstanceKey(WEEKDAYS, new Date('not a date')), null, 'an Invalid Date');
  assert.equal(windowInstanceKey(WEEKDAYS, null), null);
  assert.equal(windowInstanceKey(WEEKDAYS, undefined), null);
});

// ---------------------------------------------------------------------------
// from === to
// ---------------------------------------------------------------------------

test('from === to is a zero-width window: it matches no instant, ever', () => {
  const allDays = { days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], from: '05:00', to: '05:00' };
  assert.equal(windowInstanceKey(allDays, at(2026, 8, 28, 5, 0)), null, 'exactly the instant itself');
  assert.equal(windowInstanceKey(allDays, at(2026, 8, 28, 5, 1)), null);
  assert.equal(windowInstanceKey(allDays, at(2026, 8, 28, 4, 59)), null);
  assert.equal(windowInstanceKey(allDays, at(2026, 8, 28, 0, 0)), null, 'midnight, not just around from');
  assert.equal(windowInstanceKey(allDays, at(2026, 8, 28, 23, 59)), null, 'end of day, not just around from');
});

// ---------------------------------------------------------------------------
// Exact boundaries, including on the crossing-midnight branch
// ---------------------------------------------------------------------------

test('a crossing window is inclusive at exactly `from` and exclusive at exactly `to`', () => {
  const nightly = { days: ['fri'], from: '23:00', to: '02:00' };
  assert.equal(windowInstanceKey(nightly, at(2026, 8, 28, 23, 0)), '2026-08-28T23:00', 'from is inclusive');
  assert.equal(windowInstanceKey(nightly, at(2026, 8, 28, 22, 59)), null, 'one minute before from');
  assert.equal(windowInstanceKey(nightly, at(2026, 8, 29, 2, 0)), null, 'to is exclusive');
  assert.equal(windowInstanceKey(nightly, at(2026, 8, 29, 1, 59)), '2026-08-28T23:00', 'one minute before to');
});

test('00:00 and 23:59 are read literally, including the excluded last minute of the day', () => {
  const almostAllDay = { days: ['fri'], from: '00:00', to: '23:59' };
  assert.equal(windowInstanceKey(almostAllDay, at(2026, 8, 28, 0, 0)), '2026-08-28T00:00', '00:00 is inclusive');
  assert.equal(windowInstanceKey(almostAllDay, at(2026, 8, 28, 23, 58)), '2026-08-28T00:00');
  assert.equal(windowInstanceKey(almostAllDay, at(2026, 8, 28, 23, 59)), null, '23:59 itself is excluded — the end is exclusive by design');
});

test('startDay carries a crossing window correctly over a year boundary', () => {
  // 2026-01-01 is a Thursday; the window is named 'thu' so it must be read on
  // 2026-01-01, even though `now` falls on 2026-01-02.
  const nightly = { days: ['thu'], from: '23:00', to: '02:00' };
  assert.equal(windowInstanceKey(nightly, at(2026, 1, 2, 1, 0)), '2026-01-01T23:00');
});

test('every tick inside one window names the SAME instance', () => {
  // Not an edge case: at a 15-minute tick over a 3-hour window this happens twelve
  // times, and it is the same mechanism that carries DST below.
  const keys = new Set();
  for (let h = 2; h < 5; h += 1) {
    for (const m of [0, 15, 30, 45]) keys.add(windowInstanceKey(WEEKDAYS, at(2026, 8, 28, h, m)));
  }
  assert.equal(keys.size, 1, `twelve ticks produced ${keys.size} instances`);
});

test('a window that crosses midnight keeps both halves in one instance', () => {
  const nightly = { days: ['fri'], from: '23:00', to: '02:00' };
  const before = windowInstanceKey(nightly, at(2026, 8, 28, 23, 30));
  const after = windowInstanceKey(nightly, at(2026, 8, 29, 1, 30));
  assert.equal(before, '2026-08-28T23:00');
  assert.equal(after, before, 'the small hours belong to the evening that started them');
});

test('the day set of a crossing window is read on the day it STARTS', () => {
  // Saturday 01:30 belongs to Friday's instance. Reading the day set on the clock
  // date instead would refuse it, and the window would silently end at midnight.
  const nightly = { days: ['fri'], from: '23:00', to: '02:00' };
  assert.ok(windowInstanceKey(nightly, at(2026, 8, 29, 1, 30)));
  assert.equal(windowInstanceKey(nightly, at(2026, 8, 29, 23, 30)), null, 'Saturday evening is not Friday');
});

// ---------------------------------------------------------------------------
// DST, carried by idempotence rather than by arithmetic
// ---------------------------------------------------------------------------

test('the repeated hour on the autumn transition is ONE instance, not two', () => {
  // Europe/London, 2026-10-25: the clock goes 02:00 → 01:00, so 01:30 happens
  // twice — two distinct instants, one hour apart, same wall clock. A sweeper
  // comparing timestamps would start a second run in what a human calls one
  // window. The key is local date plus `from`, so both ticks name one instance.
  const sunday = { days: ['sun'], from: '01:00', to: '02:00' };
  const first = new Date('2026-10-25T00:30:00Z');
  const second = new Date('2026-10-25T01:30:00Z');

  assert.notEqual(first.getTime(), second.getTime(), 'this test is vacuous without two instants');
  assert.equal(first.getHours(), second.getHours(), 'this zone did not repeat the hour — the test is not testing DST');
  assert.equal(windowInstanceKey(sunday, first), windowInstanceKey(sunday, second));
});

test('a run already started in the repeated hour does not start again', () => {
  const sunday = { days: ['sun'], from: '01:00', to: '02:00' };
  const first = new Date('2026-10-25T00:30:00Z');
  const second = new Date('2026-10-25T01:30:00Z');
  const key = windowInstanceKey(sunday, first);

  assert.equal(shouldStart({ enabled: true, window: sunday, lastWindowKey: null }, first).start, true);
  assert.equal(shouldStart({ enabled: true, window: sunday, lastWindowKey: key }, second).start, false);
});

test('a window inside the spring gap simply never occurs, and nothing starts', () => {
  // Europe/London, 2026-03-29: 01:00 jumps to 02:00, so 01:30 does not exist.
  // Reported by never producing an instance, rather than by inventing one.
  const sunday = { days: ['sun'], from: '01:15', to: '01:45' };
  for (let minutes = 0; minutes < 24 * 60; minutes += TICK_MINUTES) {
    const tick = new Date(Date.UTC(2026, 2, 29, 0, 0) + minutes * 60_000);
    const key = windowInstanceKey(sunday, tick);
    if (key) {
      // If the zone did place a tick inside it, that is a legitimate instance and
      // the test has nothing to complain about — but it must be one, not many.
      assert.equal(key, '2026-03-29T01:15');
    }
  }
});

// ---------------------------------------------------------------------------
// shouldStart
// ---------------------------------------------------------------------------

test('shouldStart answers about the window and is indifferent to whether the agent is on', () => {
  // **Restated by `#194 (FORGE-260)` Phase 3, not deleted.** This asserted that
  // `shouldStart` refuses an agent that is off — which made it a SECOND authority
  // on whether a run may happen, beside the ADR gate the runtime enforced, and the
  // two disagreed. Permission now lives in `runAuthorization` alone.
  //
  // So the property worth pinning inverted: this function must give the same
  // answer either way, because the moment is a fact about the clock and not about
  // the owner's switch. An agent that is off and inside its window still gets
  // `start: true` here and is refused in `sweep()`, where the authority is asked.
  const at3am = at(2026, 8, 28, 3, 0);
  const off = shouldStart({ enabled: false, window: WEEKDAYS, lastWindowKey: null }, at3am);
  const on = shouldStart({ enabled: true, window: WEEKDAYS, lastWindowKey: null }, at3am);
  assert.deepEqual(off, on, 'shouldStart is deciding permission again');
  assert.equal(off.start, true, 'the moment is inside the window whatever the switch says');
});

test('an agent that is off never starts, whatever its window says', () => {
  // The property the test above used to carry, asserted where it now lives: the
  // sweeper, which is the thing that would actually spawn.
  const repoRoot = makeRepo({ 'ROADMAP.md': '# ROADMAP\n\n## Now\n' });
  const homeDir = homeWith({ fixer: { enabled: false, window: WEEKDAYS, lastWindowKey: null } });
  const calls = [];
  const outcomes = sweep({ repoRoot, now: at(2026, 8, 28, 3, 0), homeDir }, {
    conditions: PERMITTED,
    spawn: (...a) => { calls.push(a); return { pid: 1, unref() {} }; },
  });
  const fixer = outcomes.find((o) => o.agent === 'fixer');
  assert.equal(fixer.started, false);
  assert.match(fixer.reason, /off/i);
  assert.equal(calls.length, 0, 'the sweeper spawned an agent nobody switched on');
});

test('an agent with no window never starts on a schedule', () => {
  const decision = shouldStart({ enabled: true, window: null, lastWindowKey: null }, at(2026, 8, 28, 3, 0));
  assert.equal(decision.start, false);
  assert.match(decision.reason, /window|run-now/i);
});

test('an enabled agent OUTSIDE its window does not start', () => {
  // The unit-level half of M3. Without it the mutation is caught only by the
  // sweep-level test, and a single kill on a design constraint this load-bearing
  // is one accident away from no kill at all.
  const state = { enabled: true, window: WEEKDAYS, lastWindowKey: null };
  const decision = shouldStart(state, at(2026, 8, 28, 12, 0));
  assert.equal(decision.start, false);
  assert.match(decision.reason, /outside/i);
  assert.equal(decision.key, null, 'a moment outside every window must name no instance');
});

test('an enabled agent inside an unvisited window starts', () => {
  const decision = shouldStart({ enabled: true, window: WEEKDAYS, lastWindowKey: null }, at(2026, 8, 28, 3, 0));
  assert.equal(decision.start, true);
  assert.equal(decision.key, '2026-08-28T02:00');
});

test('the next window is a new instance, so the agent starts again', () => {
  const state = { enabled: true, window: WEEKDAYS, lastWindowKey: '2026-08-28T02:00' };
  assert.equal(shouldStart(state, at(2026, 8, 28, 4, 0)).start, false);
  assert.equal(shouldStart(state, at(2026, 8, 31, 3, 0)).start, true, 'Monday is a new instance');
});

// ---------------------------------------------------------------------------
// The sweep — M3 lives here
// ---------------------------------------------------------------------------

function homeWith(states) {
  const home = emptyDir();
  mkdirSync(join(home, '.daftplate', 'agents'), { recursive: true });
  for (const [id, state] of Object.entries(states)) {
    writeFileSync(agentStatePath(id, { homeDir: home }), JSON.stringify({
      kind: 'daftplate.agent.enablement/1', agent: id, ...state,
    }));
  }
  return home;
}

// The seam returns what `spawn()` returns, not what `spawnSync()` returned: a
// ChildProcess-shaped object with a `pid` and an `unref`. A seam whose shape does
// not match the real call is a seam that can only test the code it does not
// exercise — and `unref` in particular is production behaviour with no other
// witness, so the recorder records that it was called.
const spawnRecorder = () => {
  const calls = [];
  return {
    calls,
    spawn: (command, args, options) => {
      const call = { command, args, options, unrefed: false };
      calls.push(call);
      return { pid: 4242, unref() { call.unrefed = true; } };
    },
  };
};

test('a sweep outside every window starts nothing', () => {
  // M3. A sweeper that trusted the tick — because the schedule was assumed to
  // encode the window — would start everything on every tick, and this is the
  // test that says so. It asserts NOTHING was spawned, so a mutation that moves
  // the check out cannot pass by starting the right thing at the wrong time.
  const repoRoot = makeRepo({});
  const homeDir = homeWith({ hunter: { enabled: true, window: WEEKDAYS } });
  const rec = spawnRecorder();
  const outcomes = sweep({ repoRoot, now: at(2026, 8, 28, 12, 0), homeDir }, { spawn: rec.spawn, conditions: PERMITTED });

  assert.deepEqual(rec.calls, [], 'the sweeper started something outside its window');
  assert.ok(outcomes.every((o) => !o.started));
});

// The startable agent in these tests is the fixer, not the hunter, and the change
// is `#223 (FORGE-294)`: the hunter declares `unattended.driver: 'none'`, so a
// sweep refuses to start it however open its window is. Aiming a "starts the
// right agent" test at an agent the sweeper declines to start would assert
// nothing about starting.
test('a sweep inside the window starts exactly the agent whose window it is', () => {
  const repoRoot = makeRepo({});
  const homeDir = homeWith({
    fixer: { enabled: true, window: WEEKDAYS },
    hunter: { enabled: true, window: null },
  });
  const rec = spawnRecorder();
  sweep({ repoRoot, now: at(2026, 8, 28, 3, 0), homeDir }, { spawn: rec.spawn, conditions: PERMITTED });

  assert.equal(rec.calls.length, 1);
  assert.match(rec.calls[0].args.join(' '), /agent-fixer\.mjs/);
});

test('what the sweeper spawns is an argv a test can read', () => {
  // The runner's own seam discipline: the argv is a value, not something hidden
  // behind a process boundary the suite cannot see.
  const repoRoot = makeRepo({});
  const homeDir = homeWith({ fixer: { enabled: true, window: WEEKDAYS } });
  const rec = spawnRecorder();
  sweep({ repoRoot, now: at(2026, 8, 28, 3, 0), homeDir }, { spawn: rec.spawn, conditions: PERMITTED });

  const { args } = rec.calls[0];
  assert.ok(args.some((a) => a.endsWith('agent-fixer.mjs')));
  assert.ok(args.includes(repoRoot), 'the repository root is passed as an argument');
  // Read out of the registry, never spelled here. This assertion used to be
  // `args.includes('--scheduled')` — a literal, and a literal is precisely how
  // `#223 (FORGE-294)` defect 1 was pinned in place for a month: it agreed with the
  // sweeper and neither of them agreed with the CLI. Whether the flag is one the
  // CLI understands is `tests/agent-sweep-argv.test.mjs`, which runs it.
  for (const flag of agentById('fixer').unattended.args) {
    assert.ok(args.includes(flag), `the sweeper dropped its declared ${flag}`);
  }
});

test('no spawned argv widens the permission mode', () => {
  // ADR 0008 row 1, asserted over what is actually spawned rather than over the
  // code that builds it. Substrings, because one form arrives glued to its flag.
  const repoRoot = makeRepo({});
  const homeDir = homeWith({ hunter: { enabled: true, window: WEEKDAYS } });
  const rec = spawnRecorder();
  sweep({ repoRoot, now: at(2026, 8, 28, 3, 0), homeDir }, { spawn: rec.spawn, conditions: PERMITTED });

  const flat = rec.calls.flatMap((c) => [c.command, ...c.args]).join(' ');
  for (const forbidden of ['dangerously-skip-permissions', 'bypassPermissions']) {
    assert.ok(!flat.includes(forbidden), `the sweeper spawned ${forbidden}`);
  }
});

test('starting an agent records the instance, so the next tick does not start it again', () => {
  const repoRoot = makeRepo({});
  const homeDir = homeWith({ fixer: { enabled: true, window: WEEKDAYS } });
  const rec = spawnRecorder();

  sweep({ repoRoot, now: at(2026, 8, 28, 3, 0), homeDir }, { spawn: rec.spawn, conditions: PERMITTED });
  sweep({ repoRoot, now: at(2026, 8, 28, 3, 15), homeDir }, { spawn: rec.spawn, conditions: PERMITTED });

  assert.equal(rec.calls.length, 1, 'the second tick in one window started a second run');
  const record = JSON.parse(readFileSync(agentStatePath('fixer', { homeDir }), 'utf8'));
  assert.equal(record.lastWindowKey, '2026-08-28T02:00');
  assert.ok(record.lastStartedAt);
});

test('an agent with no state file at all is skipped, not crashed on', () => {
  // `AGENTS` names both `fixer` and `hunter`; only `hunter` gets a state file
  // here, so `fixer`'s `agentStatePath` does not exist on disk at all — the
  // `readJson` "absent" branch, not merely "present but disabled".
  const repoRoot = makeRepo({});
  const homeDir = homeWith({ hunter: { enabled: true, window: WEEKDAYS } });
  const rec = spawnRecorder();
  const outcomes = sweep({ repoRoot, now: at(2026, 8, 28, 3, 0), homeDir }, { spawn: rec.spawn, conditions: PERMITTED });

  const fixerOutcome = outcomes.find((o) => o.agent === 'fixer');
  assert.ok(fixerOutcome, 'an agent with no state file must still appear in the outcomes');
  assert.equal(fixerOutcome.started, false);
  assert.ok(!rec.calls.some((c) => c.args.some((a) => a.includes('agent-fixer'))));
});

test('one agent whose spawn throws does not stop the rest of the sweep, and leaves its own state untouched', () => {
  const repoRoot = makeRepo({});
  const homeDir = homeWith({
    fixer: { enabled: true, window: WEEKDAYS },
    hunter: { enabled: true, window: WEEKDAYS },
  });
  const calls = [];
  const spawn = (command, args) => {
    if (args.some((a) => a.includes('agent-fixer'))) throw new Error('ENOENT: no such executable');
    calls.push(args);
    return { status: 0 };
  };

  const outcomes = sweep({ repoRoot, now: at(2026, 8, 28, 3, 0), homeDir }, { spawn, conditions: PERMITTED });

  // The fixer is `AGENTS[0]`, so it is reached first and it is the one that
  // throws. That ordering is what makes the hunter's outcome existing at all the
  // proof this test is after: an exception left to unwind the loop would have
  // ended the sweep before any later agent was considered, and there would be one
  // outcome here rather than two.
  //
  // The hunter is no longer spawned — `#223 (FORGE-294)` gave it
  // `unattended.driver: 'none'` — so what "the rest of the sweep continues" means
  // here is that the rest of the sweep was still *evaluated* and still reported.
  assert.deepEqual(calls, [], 'the only spawnable agent in this fixture is the one that threw');
  assert.equal(outcomes.length, 2, 'a thrown spawn ended the loop instead of costing one agent');

  const fixerOutcome = outcomes.find((o) => o.agent === 'fixer');
  assert.equal(fixerOutcome.started, false);
  assert.match(fixerOutcome.reason, /threw|throw/i);

  const hunterOutcome = outcomes.find((o) => o.agent === 'hunter');
  assert.ok(hunterOutcome, 'an earlier agent throwing must not cost a later one its outcome');
  assert.match(hunterOutcome.reason, /no unattended driver/);

  const fixerState = JSON.parse(readFileSync(agentStatePath('fixer', { homeDir }), 'utf8'));
  assert.equal(fixerState.lastWindowKey, undefined, 'a thrown spawn must not be recorded as a started instance');
});

test('a sweep never enables anything, whatever it finds', () => {
  const repoRoot = makeRepo({});
  const homeDir = homeWith({ hunter: { enabled: false, window: WEEKDAYS } });
  const rec = spawnRecorder();
  sweep({ repoRoot, now: at(2026, 8, 28, 3, 0), homeDir }, { spawn: rec.spawn, conditions: PERMITTED });

  const record = JSON.parse(readFileSync(agentStatePath('hunter', { homeDir }), 'utf8'));
  assert.equal(record.enabled, false, 'the sweeper switched an agent on');
  assert.deepEqual(rec.calls, []);
});

// ---------------------------------------------------------------------------
// A tick starts a run and does not wait for it — `#223 (FORGE-294)` defect 2
// ---------------------------------------------------------------------------

test('a spawn that never launches leaves the window untouched', () => {
  // Before this, `defaultSpawn` was `spawnSync` and `result.error` was never
  // read: a launch that failed to start reported `started: true` with a null
  // status, and the window stamp was written, so the instance was consumed by a
  // run that did not exist.
  //
  // The seam returns `{ pid: undefined }` rather than the `{ error }` the plan
  // named, and the difference is measured rather than stylistic: async `spawn()`
  // does NOT set `.error` on the returned object — it emits an `'error'` event on
  // a later tick — so `{ error }` is a shape only a test can produce. A seam that
  // only produced it would leave the branch that actually fires in production
  // untested. Both are asserted below; this is the real one.
  const repoRoot = makeRepo({});
  const homeDir = homeWith({ fixer: { enabled: true, window: WEEKDAYS } });
  const path = agentStatePath('fixer', { homeDir });
  const before = readFileSync(path);

  for (const failed of [{ pid: undefined }, { error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }]) {
    const outcomes = sweep({ repoRoot, now: at(2026, 8, 28, 3, 0), homeDir }, {
      spawn: () => ({ ...failed, unref() {} }),
      conditions: PERMITTED,
    });
    const outcome = outcomes.find((o) => o.agent === 'fixer');
    assert.equal(outcome.started, false, `${JSON.stringify(Object.keys(failed))} was reported as started`);
    assert.match(outcome.reason, /did not launch|ENOENT/);
    // Byte-identical, not merely "still enabled". The window is the thing a
    // failed launch must not consume, and a stamp written here would make the
    // next tick in the same window decline to retry.
    assert.deepEqual(readFileSync(path), before, 'a failed launch wrote to the state file');
  }
});

test('the real spawn reports a launch that cannot happen instead of dying of it', async () => {
  // `defaultSpawn` itself, not through the seam — the seam cannot exercise this,
  // because `sweep()` always launches `process.execPath`, which exists.
  //
  // Measured on this box before any of Phase 2 was written: async `spawn` of a
  // non-existent executable returns a `ChildProcess` with `pid: undefined` and
  // `error` still undefined, then emits `'error'` on a later tick. An `'error'`
  // event with no listener is rethrown as an unhandled error that terminates the
  // process. So a sweeper that read the absent pid correctly but attached no
  // listener would report the outcome and then be killed by it milliseconds
  // later, after `sweep()` had already returned — every remaining agent in the
  // tick lost, with nothing anywhere saying why.
  //
  // The `await` is the assertion. Remove the listener from `defaultSpawn` and
  // this test does not fail, it takes the runner down.
  const child = defaultSpawn(join(emptyDir(), 'no-such-executable.exe'), [], {
    detached: true, stdio: 'ignore',
  });
  assert.equal(child.pid, undefined, 'a launch that cannot happen must not report a pid');
  assert.equal(child.error, undefined,
    'async spawn does not populate `error`; if this ever changes, the launch check can be simplified');
  await new Promise((resolve) => { setTimeout(resolve, 100); });
});

test('the sweeper does not wait for the run it starts', () => {
  // `spawnSync` blocked for the whole duration of the run, which made
  // `detached: true` inert — the sweeper held the run it was supposed to have
  // detached from. Measured by wall clock against a child that outlives the
  // assertion by a wide margin.
  const repoRoot = makeRepo({});
  const homeDir = homeWith({ fixer: { enabled: true, window: WEEKDAYS } });
  const checkoutRoot = makeRepo({
    'scripts/agent-fixer.mjs': 'process.stdout.write("child up\\n");'
      + ' setTimeout(() => process.stdout.write("child done\\n"), 4000);\n',
  });

  const started = Date.now();
  const outcomes = sweep({ repoRoot, now: at(2026, 8, 28, 3, 0), homeDir }, { checkoutRoot, conditions: PERMITTED });
  const elapsed = Date.now() - started;

  assert.equal(outcomes.find((o) => o.agent === 'fixer').started, true);
  // Generous by an order of magnitude against the child's 4s, so this fails on a
  // sweeper that waits and not on a slow machine.
  assert.ok(elapsed < 2000, `sweep() took ${elapsed}ms, so it waited for the run`);
});

test('a scheduled run writes to a log file that survives it, and the file is really there', () => {
  // A scheduled run has no terminal. Under `stdio: 'ignore'` its output went
  // nowhere at all, which is the whole reason defect 1 stayed invisible.
  const repoRoot = makeRepo({});
  const homeDir = homeWith({ fixer: { enabled: true, window: WEEKDAYS } });
  const checkoutRoot = makeRepo({
    'scripts/agent-fixer.mjs': 'process.stdout.write("hello from the child\\n");'
      + ' process.stderr.write("and from its stderr\\n");\n',
  });

  const outcomes = sweep({ repoRoot, now: at(2026, 8, 28, 3, 0), homeDir }, { checkoutRoot, conditions: PERMITTED });
  const outcome = outcomes.find((o) => o.agent === 'fixer');
  const log = agentLogPath('fixer', outcome.key, { homeDir });
  assert.equal(outcome.log, log, 'the outcome must name the log, or nobody can find it');

  // Read through a DIRECTORY LISTING, never `existsSync` on the full path. On
  // NTFS a colon in a filename opens an alternate data stream, and `existsSync`,
  // `readFileSync` and the write itself all succeed against the full name while
  // the directory holds only the part before the colon. Measured on this box.
  // Listing the directory is the only assertion that tells the two apart, which
  // is why `agentLogPath` strips the colon and why this test reads it this way.
  const dir = join(homeDir, '.daftplate', 'agents', 'logs');
  const deadline = Date.now() + 10000;
  let listed = [];
  let text = '';
  while (Date.now() < deadline) {
    listed = existsSync(dir) ? readdirSync(dir) : [];
    text = listed.includes(basename(log)) ? readFileSync(log, 'utf8') : '';
    if (text.includes('and from its stderr')) break;
  }

  assert.ok(listed.includes(basename(log)),
    `the log is not a file in ${dir}; the directory holds ${JSON.stringify(listed)}`);
  assert.match(text, /hello from the child/);
  assert.match(text, /and from its stderr/, 'stderr must land in the same log');
});

test('an owner switching an agent off mid-tick stays off', () => {
  // The serious half of defect 2, and the reason `sweep()`'s own doc comment was
  // false. `state` was read before the spawn, `spawnSync` then blocked for the
  // whole run, and `{ ...state, ... }` was written back afterwards — so an owner
  // who switched the agent off while a run was in progress had `enabled: true`
  // silently restored by the sweeper. That is ADR 0008's owner-held act performed
  // in reverse, on a timer, by write-back rather than by intent.
  const repoRoot = makeRepo({});
  const homeDir = homeWith({ fixer: { enabled: true, window: WEEKDAYS } });
  const path = agentStatePath('fixer', { homeDir });

  const outcomes = sweep({ repoRoot, now: at(2026, 8, 28, 3, 0), homeDir }, {
    spawn: () => {
      // The owner, mid-tick, through the menu — reaching the file between the
      // read and the stamp, which is the whole window the defect lived in.
      const owned = JSON.parse(readFileSync(path, 'utf8'));
      writeFileSync(path, JSON.stringify({ ...owned, enabled: false, acknowledgedOpen: 7 }));
      return { pid: 4242, unref() {} };
    },
    conditions: PERMITTED,
  });

  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.enabled, false, 'the sweeper switched an agent back on that its owner had switched off');
  assert.equal(after.acknowledgedOpen, 7, 'the sweeper discarded an owner edit it had no business touching');
  // And it still did its own job: the instance is stamped, so the next tick in
  // this window does not start a second run. A stamp dropped for safety would
  // trade one defect for another.
  assert.equal(after.lastWindowKey, outcomes.find((o) => o.agent === 'fixer').key);
  assert.ok(after.lastStartedAt);
});

test('the sweeper unrefs the child, so a tick is not held open by the run it started', () => {
  // `detached: true` without `unref()` leaves the child in the parent's reference
  // count: `sweep()` returns, and the process still does not exit. Measured on
  // this box before any of this was written — parent out in 23ms, child still
  // writing to its log two and a half seconds later.
  const repoRoot = makeRepo({});
  const homeDir = homeWith({ fixer: { enabled: true, window: WEEKDAYS } });
  const rec = spawnRecorder();
  sweep({ repoRoot, now: at(2026, 8, 28, 3, 0), homeDir }, { spawn: rec.spawn, conditions: PERMITTED });

  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].unrefed, true, 'the child was never unref()ed');
  assert.equal(rec.calls[0].options.detached, true);
});

// ---------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------

test('the registration argv is the one the spec settled', () => {
  const args = buildRegisterArgs({ repoRoot: 'X:/repo', node: 'C:/node.exe', script: 'X:/repo/scripts/agent-sweep.mjs' });
  assert.equal(args[0], '/Create');
  assert.ok(args.includes(SWEEP_TASK_NAME));
  assert.ok(args.includes('MINUTE'));
  assert.ok(args.includes(String(TICK_MINUTES)));
  const tr = args[args.indexOf('/TR') + 1];
  assert.match(tr, /agent-sweep\.mjs/);
  assert.ok(tr.includes('X:/repo'), 'the repository root must be an argument, not an inherited cwd');
});

test('the /TR command quotes node, script and repo root separately, for paths with spaces', () => {
  // Asserted on the SHAPE — three individually quoted segments — not on one
  // exact string.
  //
  // The first version pinned the whole `/TR` value including the repo root as
  // `"X:\\Projects\\daftplate"`, which is what `resolve()` returns for that input
  // on Windows and nowhere else. `X:/Projects/daftplate` is not an absolute path
  // on POSIX, so on Linux CI `resolve()` prepends the runner's working directory
  // and the assertion failed on a machine the code will never run on. It passed
  // locally, went green through review, and turned CI red after the merge.
  //
  // `buildRegisterArgs` is Windows-only by nature — `schtasks` exists nowhere
  // else — but the SUITE runs on Linux, so a test of it may not assume a Windows
  // path resolver. The property worth pinning is that each path is separately
  // quoted, which is what stops a space in `C:\Program Files` from splitting one
  // argument into two.
  const args = buildRegisterArgs({
    repoRoot: 'X:/Projects/daftplate',
    node: 'C:/Program Files/nodejs/node.exe',
    script: 'X:/Program Files/daftplate/scripts/agent-sweep.mjs',
  });
  const tr = args[args.indexOf('/TR') + 1];

  const quoted = tr.match(/"[^"]*"/g) ?? [];
  assert.equal(quoted.length, 3, `expected three separately quoted paths, got ${tr}`);
  assert.equal(quoted[0], '"C:/Program Files/nodejs/node.exe"');
  assert.equal(quoted[1], '"X:/Program Files/daftplate/scripts/agent-sweep.mjs"');
  assert.match(quoted[2], /daftplate"$/, 'the repo root is the third quoted segment');

  // Nothing outside the quotes but the separating spaces. A value that escaped
  // its quotes is exactly how `C:\Program Files\...` becomes two arguments.
  assert.equal(tr.replace(/"[^"]*"/g, '').trim(), '', `unquoted text in the /TR value: ${tr}`);
});

test('registration asks for no elevation and no stored password', () => {
  // Measured 2026-08-28: /Create succeeds unelevated without these. /RL HIGHEST
  // would need elevation and /RU with /RP would need a stored credential, and the
  // design needs neither — so a regression that adds one is a real change in what
  // this feature asks of a machine.
  const args = buildRegisterArgs({ repoRoot: 'X:/repo', node: 'node', script: 's.mjs' });
  for (const flag of ['/RL', '/RP', '/RU']) {
    assert.ok(!args.includes(flag), `registration asked for ${flag}`);
  }
});

test('unregister refuses a task this machine did not register', () => {
  // CLAUDE.md #5. The sweep state file is the authority, exactly as the worktree
  // reaper's in-process record is: a task at that name we did not create is
  // somebody else's, and it is reported rather than removed.
  const homeDir = emptyDir();
  const calls = [];
  const result = unregisterSweep({ homeDir }, { schtasks: (a) => { calls.push(a); return { status: 0 }; } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not-ours|never-registered/);
  assert.deepEqual(calls, [], 'it ran schtasks against a task it had no record of');
});

test('register then unregister round-trips through the state file', () => {
  const homeDir = emptyDir();
  const schtasks = () => ({ status: 0, stdout: 'SUCCESS', stderr: '' });
  const reg = registerSweep({ repoRoot: 'X:/repo', homeDir }, { schtasks });
  assert.equal(reg.ok, true);
  assert.equal(JSON.parse(readFileSync(sweepStatePath({ homeDir }), 'utf8')).registered, true);

  const un = unregisterSweep({ homeDir }, { schtasks });
  assert.equal(un.ok, true);
  assert.equal(JSON.parse(readFileSync(sweepStatePath({ homeDir }), 'utf8')).registered, false);
});

test('a registration schtasks refuses is reported and not recorded as done', () => {
  const homeDir = emptyDir();
  const schtasks = () => ({ status: 1, stdout: '', stderr: 'ERROR: Access is denied.' });
  const reg = registerSweep({ repoRoot: 'X:/repo', homeDir }, { schtasks });
  assert.equal(reg.ok, false);
  assert.match(reg.message, /Access is denied/);
  assert.equal(existsSync(sweepStatePath({ homeDir })) && JSON.parse(readFileSync(sweepStatePath({ homeDir }), 'utf8')).registered, false);
});
