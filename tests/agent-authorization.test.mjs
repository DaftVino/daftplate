// One authority for "may this agent run now" — `#194 (FORGE-260)`, plan-agents
// Phase 3, defect 11.
//
// Three surfaces answered that question independently and disagreed. The menu said
// `ON` on `state.enabled` alone; the sweeper started the agent on `state.enabled`
// alone; the fixer's runtime refused on the ADR conditions alone and never read
// the state file at all. One machine, three answers, and the two that said yes
// were the two an owner acts on.
//
// **The plan's own prescribed cross-check could not catch this.** It asserted
// `enablementRefusal({agentId, homeDir}).ok === auth.mayRun` over a fixture with
// `enabled: true` and one open condition. `enablementRefusal()` ignored its
// arguments and always returned `ok: false`; the fixture makes `mayRun` false; so
// the line passed before a byte was written and neither of the phase's mutants
// could reach it. The fixer could have been left entirely untouched and the phase
// would have looked delivered. That is `#225 (FORGE-296)`'s central finding
// reproduced inside the phase it was warning about.
//
// So the fixture that matters here is the OTHER one: `enabled: false` with **zero**
// open conditions. That is the case the fixer genuinely cannot answer today, and
// it is the live half of the defect.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyDir, makeRepo } from './helpers/make-repo.mjs';
import * as enablement from '../scripts/lib/enablement.mjs';
import { runAuthorization } from '../scripts/lib/enablement.mjs';
import { agentStatePath, ENABLEMENT_KIND } from '../scripts/lib/agent-state.mjs';
import { sweep } from '../scripts/agent-sweep.mjs';
import { enablementRefusal } from '../scripts/agent-fixer.mjs';
import { inspect, render } from '../scripts/agent-menu.mjs';

/** The board declaration the fixer's Linear precondition looks for. Without it
 *  the fixer's trigger cannot fire and its STATE cell is `CANNOT FIRE`, which
 *  would make the held-cell assertion below pass for the wrong reason. */
const LINEAR_LINE = [
  'Board: issues are created in GitHub and managed in Linear (ADR 0006) -- the',
  '[daftplate](https://linear.app/x) project, team `FORGE`. GitHub is canonical for',
  'whether an issue exists; Linear is canonical for its state.',
].join('\n');
const boardRepo = () => makeRepo({
  'ROADMAP.md': ['# ROADMAP', '', LINEAR_LINE, '', '## Now', ''].join('\n'),
});

const ALL_CLOSED = [{ condition: 'a closed one', closed: true, evidence: 'measured' }];
const ONE_OPEN = [
  { condition: 'a closed one', closed: true, evidence: 'measured' },
  { condition: 'an open one', closed: false, act: 'an owner does the thing' },
];

const WINDOW = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '02:00', to: '05:00' };
// **Local time, not a UTC literal.** A window is wall-clock -- `windowInstanceKey`
// reads `getHours()` -- so `new Date('...T03:00:00Z')` lands inside the window only
// on a machine at UTC. On this one it is 23:00 the previous day, and the first
// draft of these tests failed for that reason rather than for the defect.
const INSIDE = new Date(2026, 7, 28, 3, 0);   // Friday 28 Aug 2026, 03:00 local

function homeWith(states) {
  const home = emptyDir();
  mkdirSync(join(home, '.daftplate', 'agents'), { recursive: true });
  for (const [id, state] of Object.entries(states)) {
    writeFileSync(agentStatePath(id, { homeDir: home }), JSON.stringify({
      kind: ENABLEMENT_KIND, agent: id, ...state,
    }));
  }
  return home;
}

// ---------------------------------------------------------------------------
// The authority itself
// ---------------------------------------------------------------------------

test('an agent that is off may not run, however many conditions are closed', () => {
  // The live half of the defect: today the fixer's runtime cannot express this,
  // because it never reads the state file.
  const homeDir = homeWith({ fixer: { enabled: false } });
  const auth = runAuthorization({ agentId: 'fixer', homeDir }, { conditions: ALL_CLOSED });
  assert.equal(auth.mayRun, false);
  assert.equal(auth.enabled, false);
  assert.deepEqual(auth.open, []);
  assert.match(auth.reason, /off/);
});

test('an agent that is on may not run while a condition is open', () => {
  const homeDir = homeWith({ fixer: { enabled: true } });
  const auth = runAuthorization({ agentId: 'fixer', homeDir }, { conditions: ONE_OPEN });
  assert.equal(auth.mayRun, false);
  assert.equal(auth.enabled, true);
  assert.equal(auth.open.length, 1);
  assert.match(auth.reason, /condition/);
});

test('an agent that is on with every condition closed may run', () => {
  // The only combination that permits a run, and it is unreachable on this machine
  // today -- which is exactly why the conditions are an injected seam rather than
  // a module constant read directly. Without the seam this state could only be
  // reached by mutating exported module state across a test file.
  const homeDir = homeWith({ fixer: { enabled: true } });
  const auth = runAuthorization({ agentId: 'fixer', homeDir }, { conditions: ALL_CLOSED });
  assert.equal(auth.mayRun, true);
  assert.match(auth.reason, /may run/);
});

test('an agent with no state file at all is off, not permitted', () => {
  // Fail closed. An absent file is the state of a machine nobody has switched
  // anything on, and reading it as permission would be the worst direction to be
  // wrong in.
  const auth = runAuthorization({ agentId: 'fixer', homeDir: emptyDir() }, { conditions: ALL_CLOSED });
  assert.equal(auth.mayRun, false);
  assert.equal(auth.enabled, false);
});

test('an unparseable state file is off, and says so rather than throwing', () => {
  const home = emptyDir();
  mkdirSync(join(home, '.daftplate', 'agents'), { recursive: true });
  writeFileSync(agentStatePath('fixer', { homeDir: home }), '{ not json');
  const auth = runAuthorization({ agentId: 'fixer', homeDir: home }, { conditions: ALL_CLOSED });
  assert.equal(auth.mayRun, false);
  assert.equal(auth.readable, false);
});

test('acknowledging an open condition does not make a run permitted', () => {
  // The menu lets an owner enable over an open condition and records that they
  // acknowledged it. Acknowledgement is a record of what they saw, never a
  // substitute for the condition closing -- D4's note is that acknowledge-and-run
  // would need a superseding ADR, and this phase does not do that.
  const homeDir = homeWith({ fixer: { enabled: true, acknowledgedOpen: 1 } });
  const auth = runAuthorization({ agentId: 'fixer', homeDir }, { conditions: ONE_OPEN });
  assert.equal(auth.acknowledgedOpen, 1);
  assert.equal(auth.mayRun, false);
});

// ---------------------------------------------------------------------------
// The cross-check: three surfaces, one answer
// ---------------------------------------------------------------------------

for (const [name, conditions, states, expected] of [
  ['off with every condition closed', ALL_CLOSED, { enabled: false, window: WINDOW }, false],
  ['on with a condition open', ONE_OPEN, { enabled: true, window: WINDOW }, false],
  ['on with every condition closed', ALL_CLOSED, { enabled: true, window: WINDOW }, true],
]) {
  test(`all three surfaces agree: ${name}`, () => {
    const homeDir = homeWith({ fixer: states, hunter: states });
    const repoRoot = boardRepo();
    const auth = runAuthorization({ agentId: 'fixer', homeDir }, { conditions });
    assert.equal(auth.mayRun, expected, 'the authority itself');

    // The runtime. This is the assertion the plan's version could not make.
    assert.equal(
      enablementRefusal({ agentId: 'fixer', homeDir }, { conditions }).ok, expected,
      "the fixer's runtime disagrees with the authority",
    );

    // The sweeper. `shouldStart` stays a pure window predicate -- it answers
    // "is this the moment", not "is this permitted" -- so the authority binds in
    // `sweep()`, and a permitted agent inside its window is the only one started.
    const calls = [];
    const outcomes = sweep({ repoRoot, now: INSIDE, homeDir }, {
      conditions,
      spawn: (...a) => { calls.push(a); return { pid: 4242, unref() {} }; },
    });
    const fixer = outcomes.find((o) => o.agent === 'fixer');
    assert.equal(fixer.started, expected, 'the sweeper disagrees with the authority');
    assert.equal(calls.length, expected ? 1 : 0, 'the sweeper spawned against its own verdict');

    // The screen. `conditions` is threaded here too — without it this surface
    // answered a different question from the other two and passed anyway, because
    // the fixer's board precondition was unmet on every fixture and `CANNOT FIRE`
    // is not `ON` whatever the conditions say. That stopped being true when both
    // board variants became pollable on 2026-09-04, and the assertion started
    // failing honestly rather than agreeing by accident.
    const lines = render(inspect({ repoRoot, checkoutRoot: repoRoot, homeDir, conditions }));
    const header = lines.find((l) => l.includes('STATE') && l.includes('TRIGGER'));
    const row = lines.find((l) => /^\s+\d+\s+fixer\s/.test(l));
    const cell = row.slice(header.indexOf('STATE'), header.indexOf('TRIGGER')).trim();
    if (!expected) {
      assert.notEqual(cell, 'ON', 'the screen says ON for an agent that may not run');
    }
  });
}

test('a held agent has its own STATE cell, distinct from all three others', () => {
  // By column position, and against every other spelling -- the daft-agent plan
  // recorded a test written for exactly this mutant that the mutant survived,
  // because it compared whole screens rather than the one cell.
  //
  // Asserted on the HUNTER, not the fixer. The fixer's board-poll precondition is
  // genuinely unmet on the Linear variant, so its cell is `CANNOT FIRE` whatever
  // its enablement says -- a held-cell assertion there would pass or fail for the
  // wrong reason. The hunter declares no preconditions, so its trigger is always
  // ready and `HELD` is reachable.
  // `conditions: ONE_OPEN` since 2026-09-04. Both real conditions closed with ADR
  // 0011, so an enabled hunter now renders `ON` and `HELD` is unreachable through
  // the module constant. The cell still has to be distinct — it is what an owner
  // sees the moment any future ADR opens a condition — so it is reached through the
  // seam `inspect` declares rather than deleted along with the standing that used
  // to make it free.
  const repoRoot = boardRepo();
  const homeDir = homeWith({ fixer: { enabled: true }, hunter: { enabled: true } });
  const lines = render(inspect({ repoRoot, checkoutRoot: repoRoot, homeDir, conditions: ONE_OPEN }));
  const header = lines.find((l) => l.includes('STATE') && l.includes('TRIGGER'));
  const row = lines.find((l) => /^\s+\d+\s+hunter\s/.test(l));
  const cell = row.slice(header.indexOf('STATE'), header.indexOf('TRIGGER')).trim();

  for (const other of ['ON', 'off', 'CANNOT FIRE']) {
    assert.notEqual(cell, other, `a held agent renders as ${other}`);
  }
  assert.notEqual(cell, '', 'a held agent renders as nothing at all');
});

// ---------------------------------------------------------------------------
// One authority, asserted at the source
// ---------------------------------------------------------------------------

test('nothing but the authority decides a run from state.enabled', () => {
  // The same source-level shape `agent-hunter.mjs` already uses to assert it files
  // nothing. Three call sites may READ the flag to report it; only
  // `runAuthorization` may turn it into permission, and this is what stops a
  // fourth site being added later that quietly re-derives the answer.
  const root = new URL('..', import.meta.url);
  const offenders = [];
  for (const rel of ['scripts/agent-sweep.mjs', 'scripts/agent-fixer.mjs', 'scripts/agent-hunter.mjs']) {
    const src = readFileSync(new URL(rel, root), 'utf8');
    for (const [i, line] of src.split('\n').entries()) {
      // `auth.enabled` is reading the authority's OWN answer, which is the point
      // of having one. Anything else reaching for the raw flag is a second
      // authority, which is the defect.
      const receiverStripped = line.split('auth.enabled').join('');
      if (/\.enabled\b/.test(receiverStripped) && !/^\s*(\/\/|\*)/.test(line)) {
        offenders.push(`${rel}:${i + 1} ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'a runner reads state.enabled directly; the authority is runAuthorization and nothing else may decide from the flag');
});

test('#307 (FORGE-351) — the shared module holds the conditions and renders none of them', () => {
  // `renderConditions()` lived here with no callers anywhere in `scripts/`,
  // `tests/` or `skills/`, and a mutant emptying its act half survived the whole
  // suite: 2095 tests, 2093 passing, 0 failing, unchanged from an unmutated run.
  // Measured 2026-09-05 on a copy held outside the repository, substitution
  // asserted to have matched exactly once and the restore hash-verified.
  //
  // It was not obviously dead, which is what made it worth removing rather than
  // leaving. It was exported, and its docstring called it the operator-facing
  // surface, so the next session to want that surface would reasonably have wired
  // it in — and shipped a screen whose act half no test covers, on the exact
  // surface ADR 0008 row 8 and the enablement gate depend on being legible.
  //
  // **The rule this pins is not "renderConditions is gone".** It is that the
  // shared module holds the conditions and the authority, and the surface doing
  // the printing owns its own rendering. A second renderer added here would be
  // dead the moment it was written, for the same reason the first one was: every
  // surface that prints these already formats them where it prints them.
  //
  // Asserted over the source, the way this file already asserts that no runner
  // decides from `state.enabled` and `agent-invoke.mjs` asserts that it publishes
  // nothing. A property about what must NOT exist has no output to read.
  const src = readFileSync(new URL('../scripts/lib/enablement.mjs', import.meta.url), 'utf8');
  const marker = /\[\$\{[^}]*\?\s*'closed'\s*:\s*' open '/;
  assert.equal(marker.test(src), false,
    'scripts/lib/enablement.mjs renders a condition; the surface that prints one owns its rendering');

  // And nothing is exported that no caller has. The two live renderings read the
  // data — `ENABLEMENT_CONDITIONS` and `conditionsSnapshot` — and format it
  // themselves.
  const exported = Object.keys(enablement);
  assert.equal(exported.includes('renderConditions'), false,
    'renderConditions is exported again; it had no callers and its act half no coverage');
});

test('#307 (FORGE-351) — the surviving rendering of an act is the one a test reads', () => {
  // What the deletion must not cost. `agent-menu.mjs` renders an open condition's
  // act through `renderOutcomes`, and that IS asserted — measured 2026-09-05, the
  // same act-emptying mutant applied there kills `an open condition renders as
  // open, and names the act that would close it`, child exit 1, one failure.
  //
  // This asserts the coupling rather than re-testing the menu: every condition
  // field the menu's renderer reads must be one `conditionsSnapshot` actually
  // produces, so a field renamed here cannot leave the screen rendering
  // `undefined` while every test stays green.
  const open = enablement.conditionsSnapshot([
    { condition: 'a thing an owner must do', closed: false, act: 'do the thing' },
  ]);
  assert.deepEqual(open, [{ condition: 'a thing an owner must do', closed: false, act: 'do the thing' }]);

  const closed = enablement.conditionsSnapshot([
    { condition: 'a thing already done', closed: true, evidence: 'docs/records/it.md' },
  ]);
  assert.deepEqual(closed, [{ condition: 'a thing already done', closed: true, evidence: 'docs/records/it.md' }]);

  // A snapshot of an open condition carries `act` and never `evidence`, and the
  // reverse, because the menu's renderer picks between them on `closed` alone.
  assert.equal('evidence' in open[0], false);
  assert.equal('act' in closed[0], false);
});
