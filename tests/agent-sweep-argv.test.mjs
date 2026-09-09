// The test `#223 (FORGE-294)` exists for: it runs the argv the sweeper builds.
//
// Every other assertion about a scheduled launch in this suite reads the argv out
// of an injected recorder and stops there. That is why the defect survived a
// month of green runs — `tests/agent-sweep.test.mjs` asserted `--scheduled` was
// present in the argv, and it was, and no CLI accepted it. A recorder can only
// tell you what was going to be said; it cannot tell you the other end
// understood it.
//
// So this file spawns for real. It is the slowest file in the suite by design:
// one process per registry entry, and the cost buys the one property nothing
// else here can check.
process.env.TZ = 'Europe/London';

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import { agentStatePath } from '../scripts/lib/agent-state.mjs';
import { AGENTS } from '../scripts/lib/agent-registry.mjs';
import { EXIT_CODES } from '../scripts/lib/cli.mjs';
import { sweep } from '../scripts/agent-sweep.mjs';

const CHECKOUT_ROOT = fileURLToPath(new URL('..', import.meta.url));

// 2026-08-28 is a Friday, and 03:00 is inside it.
const WINDOW = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '02:00', to: '05:00' };
const INSIDE = new Date(2026, 7, 28, 3, 0, 0, 0);

/** The permitted authority, injected. `tests/agent-sweep.test.mjs`'s fixture and
 *  its reasoning: the permitted case is unreachable on this machine — ADR 0008's
 *  second condition is open and closing it is an owner's act — so without the
 *  seam a test could only reach it by mutating module state across a file, which
 *  is how a suite starts depending on its own execution order. */
const PERMITTED = [{
  condition: 'stood in for by these tests, which are about the argv, not the gate',
  closed: true,
  evidence: 'tests/agent-authorization.test.mjs holds the real authority coverage',
}];

/**
 * Drive a real sweep with one agent switched on, and hand back both halves of
 * what it did: the outcome it reported and the call it made, if it made one.
 *
 * `enabled: true` is written into a **fixture** home directory, never a real one.
 * Nothing here enables an agent on this machine, and nothing here can: `homeDir`
 * is a throwaway and the sweeper resolves every path under it. `permitted` is an
 * injected authority, not a switch on anything real — see `PERMITTED`.
 */
function sweepFor(id, { permitted = true, enabled = true } = {}) {
  // A boolean rather than a `conditions` passthrough: a default parameter fires
  // on `undefined`, so `{ conditions: undefined }` would silently take the
  // permissive default and the caller asking for the real authority would get the
  // injected one. Measured — the first draft of the test below passed for that
  // reason and asserted the opposite of its own name.
  const repoRoot = makeRepo({});
  const homeDir = emptyDir();
  mkdirSync(join(homeDir, '.daftplate', 'agents'), { recursive: true });
  writeFileSync(agentStatePath(id, { homeDir }), JSON.stringify({
    kind: 'daftplate.agent.enablement/1', agent: id, enabled, window: WINDOW,
  }));

  const calls = [];
  const outcomes = sweep({ repoRoot, now: INSIDE, homeDir }, {
    conditions: permitted ? PERMITTED : undefined,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { pid: 4242, unref() {} };
    },
  });
  return { repoRoot, outcome: outcomes.find((o) => o.agent === id), call: calls[0] ?? null };
}

test('the argv the sweeper builds is one the agent CLI understands', () => {
  // The acceptance criterion for `#223 (FORGE-294)` defect 1. Red before the fix
  // with `unknown option --scheduled` on both entries: the flag the sweeper had
  // been passing since Phase 5 was parsed by neither CLI, every scheduled launch
  // died on its usage line, and the window stamp was written anyway — so the
  // instance was consumed and the sweep reported `started: true`.
  for (const entry of AGENTS) {
    const { repoRoot, call } = sweepFor(entry.id);

    // Every entry is checked, including the ones the sweeper refuses to start.
    // The refusal is a property of the sweep; whether the CLI understands its own
    // declared unattended argv is a property of the CLI, and flipping a driver
    // must not silently take an entry out of this loop's coverage.
    const args = call
      ? call.args
      : [join(CHECKOUT_ROOT, entry.script), repoRoot, ...entry.unattended.args];
    const command = call ? call.command : process.execPath;

    const child = spawnSync(command, args, { encoding: 'utf8' });
    assert.equal(child.error, undefined, `${entry.id}: the composed argv did not launch`);
    assert.notEqual(child.status, EXIT_CODES.USAGE,
      `${entry.id} exited on its usage line for the argv the sweeper composes:\n${child.stderr}`);
    assert.doesNotMatch(child.stderr ?? '', /unknown option/,
      `${entry.id} did not recognise a flag the sweeper passes it`);
  }
});

test('every entry declares an unattended argv, and the sweeper composes from it', () => {
  // Read from the registry rather than spelled as a literal. A literal here is
  // exactly how the defect was pinned in place: the old assertion said
  // `args.includes('--scheduled')` and would have gone on passing after the flag
  // was renamed on one side only.
  //
  // **The skip is declared, not inferred — and the guard it replaces had already
  // fired.** This loop used to read `if (!call) continue;`, believed correct
  // because the only entry the sweeper declines is the driverless hunter. That
  // stopped being true at `1dfda7e`, when Phase 3 put `runAuthorization` in front
  // of every spawn: ADR 0008's second condition is open, so the FIXER is held
  // too, and from that commit this loop skipped both entries and asserted
  // nothing at all while staying green. Measured while converting it.
  //
  // The fix is in two parts. The authority is injected as permitted (`sweepFor`'s
  // default), because this test is about the argv and not about the gate — the
  // gate has its own file. And the expected-skip set is computed from the
  // registry property that causes the remaining skip, so an entry that stops
  // being spawned for any OTHER reason fails here instead of quietly vanishing
  // from the loop's coverage.
  const expectedSkip = new Set(AGENTS.filter((a) => a.unattended.driver === 'none').map((a) => a.id));
  const skipped = new Set();

  for (const entry of AGENTS) {
    assert.ok(Array.isArray(entry.unattended?.args), `${entry.id} declares no unattended argv`);
    const { call } = sweepFor(entry.id);
    if (!call) {
      assert.ok(expectedSkip.has(entry.id),
        `${entry.id} was not spawned and nothing about its registry entry says it should be skipped`);
      skipped.add(entry.id);
      continue;
    }
    for (const flag of entry.unattended.args) {
      assert.ok(call.args.includes(flag), `${entry.id}: the sweeper dropped its declared ${flag}`);
    }
  }

  // The other direction, which is the one a suppressed assertion hides: an entry
  // the registry says has no driver, that the sweeper spawned anyway.
  assert.deepEqual([...skipped].sort(), [...expectedSkip].sort(),
    'the set of entries the sweeper declined is not the set the registry says it should decline');
});

test('under the real authority the sweeper starts nothing at all, and says which reason', () => {
  // The regime the test above deliberately injects its way out of, asserted here
  // rather than lost. It is also the assertion that would have caught the vacuum:
  // if this file's other loop ever silently stops spawning, this one says why.
  //
  // **Rewritten 2026-09-04, and the change is the point.** Both ADR 0008 conditions
  // are now closed, so "every entry with a driver is held by an open condition" is
  // no longer what this machine does. The remaining protection is the owner's own
  // switch — and this fixture writes `enabled: true`, so under the real authority a
  // driverless entry is still refused a layer earlier, and one WITH a driver now
  // genuinely spawns.
  //
  // That is correct and it is why the assertion is split rather than relaxed: a
  // driverless agent must never spawn whatever the gate says, and a driven one must
  // spawn only once an owner has switched it on. Asserting `call === null` for both
  // would now pass for the wrong reason on the hunter and fail honestly on the
  // fixer, which is what it just did.
  for (const entry of AGENTS) {
    const { outcome, call } = sweepFor(entry.id, { permitted: false });
    if (entry.unattended.driver === 'none') {
      assert.equal(call, null, `${entry.id} has no driver and was spawned anyway`);
      assert.equal(outcome.started, false);
      assert.match(outcome.reason, /no unattended driver/);
      continue;
    }
    // Enabled by the fixture and no condition open, so this is the permitted path.
    assert.notEqual(call, null, `${entry.id} is enabled with every condition closed and did not start`);
    assert.equal(outcome.started, true);
  }
});

test('the real authority still refuses a driven agent that nobody switched on', () => {
  // The protection that is now load-bearing, and it had no test of its own while an
  // open condition was doing the work. `enabled` is the whole of what stands between
  // a scheduled tick and a run on this machine — measured 2026-09-04: no file exists
  // under `~/.daftplate/agents/`, so this is the real machine's state, not a fixture
  // convenience.
  const driven = AGENTS.filter((a) => a.unattended.driver !== 'none');
  assert.ok(driven.length, 'this test asserts nothing unless some entry has a driver');

  for (const entry of driven) {
    const { outcome, call } = sweepFor(entry.id, { permitted: false, enabled: false });
    assert.equal(call, null, `${entry.id} was spawned with nobody having switched it on`);
    assert.equal(outcome.started, false);
    assert.match(outcome.reason, /off|not switched|enabled/i,
      `${entry.id} was declined without saying the agent is off`);
  }
});

test('an agent with no unattended driver is not started, and the sweep says why', () => {
  // Defect 1's other half. The hunter plans invocations for a session to run; it
  // cannot run itself, so a scheduled tick that spawned it would start a process
  // whose only possible outcome is a refusal. It is refused here instead, where
  // the reason reaches an operator.
  const driverless = AGENTS.filter((a) => a.unattended.driver === 'none');
  assert.ok(driverless.length, 'this test asserts nothing unless some entry has no driver');

  for (const entry of driverless) {
    const { outcome, call } = sweepFor(entry.id);
    assert.equal(call, null, `${entry.id} was spawned despite having no unattended driver`);
    assert.equal(outcome.started, false);
    assert.match(outcome.reason, /no unattended driver/);
  }
});

test('a driverless agent asked to run unattended anyway refuses with its own code', () => {
  for (const entry of AGENTS.filter((a) => a.unattended.driver === 'none')) {
    const repoRoot = makeRepo({});
    const child = spawnSync(process.execPath,
      [join(CHECKOUT_ROOT, entry.script), repoRoot, ...entry.unattended.args],
      { encoding: 'utf8' });
    assert.equal(child.status, EXIT_CODES.NO_DRIVER);
    assert.match(child.stderr, /invoked by a session/);
  }
});

test('a gated agent asked to run unattended refuses on the gate, without polling anything', () => {
  for (const entry of AGENTS.filter((a) => a.unattended.driver === 'gated')) {
    const repoRoot = makeRepo({});
    // **The child is given an empty home, not this machine's.** It resolves the
    // agent state file through `homedir()`, so without this the test asserted
    // `GATED` only while nobody had switched the fixer on — and inverted the day
    // somebody did, reporting a wired feature as a broken refusal. `USERPROFILE`
    // and `HOME` are both set because `homedir()` reads a different one per
    // platform and this suite runs on two.
    const home = emptyDir();
    const child = spawnSync(process.execPath,
      [join(CHECKOUT_ROOT, entry.script), repoRoot, ...entry.unattended.args],
      { encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HOME: home } });
    assert.equal(child.status, EXIT_CODES.GATED, `${entry.id}: ${child.stdout}${child.stderr}`);
    // The scheduled path must reach the gate and stop. The default `plan` path
    // shells out to `gh`, and a tick quietly polling GitHub every window is a
    // side effect nobody asked for — so the refusal has to arrive before it.
    assert.doesNotMatch(`${child.stdout}${child.stderr}`, /gh: |gh\.exe|Delegated/);
  }
});

test('the unattended exit codes are distinct, and none of them is clean', () => {
  const codes = Object.values(EXIT_CODES);
  assert.equal(new Set(codes).size, codes.length, 'two refusals share an exit code');
  for (const code of codes) assert.notEqual(code, 0);
  // 1 is `reportViolations`. A refusal that reused it would be indistinguishable
  // from a run that did happen and found something.
  for (const code of codes) assert.notEqual(code, 1);
});
