// Phase 4 of `#204 (FORGE-265)`: the last two of the menu's five functions, and
// the owner-held enablement act ADR 0008 reserves.
//
// The act is the point of the phase. ADR 0008's *Consequences* gate enabling
// either agent on two conditions and reserve the decision to the owner — and
// until now the repository gave that owner nothing to decide WITH. The menu's on
// switch is the gesture, and it shows both conditions and their standing at the
// moment of the toggle. A menu that enabled without showing them enables blind,
// which is the one thing that ADR was written to prevent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import { ENABLEMENT_CONDITIONS } from '../scripts/lib/enablement.mjs';
import { openRunRecord } from '../scripts/lib/run-record.mjs';
import { sweepStatePath, SWEEP_KIND } from '../scripts/lib/agent-state.mjs';
import { parseAgentRunArgs } from '../scripts/agent-fixer.mjs';
import { parseArgs } from '../scripts/agent-hunter.mjs';
import {
  inspect, rows, render, planEdits, applyEdits, parseEdits, renderOutcomes, agentStatePath, ENABLEMENT_KIND,
} from '../scripts/agent-menu.mjs';

const LINEAR_LINE = 'Board: issues are created in GitHub and managed in Linear (ADR 0006) — the\n'
  + '[daftplate](https://linear.app/x) project, team `FORGE`. GitHub is canonical for\n'
  + 'whether an issue exists; Linear is canonical for its state.';

const checkout = () => makeRepo({
  'scripts/agent-fixer.mjs': '// stand-in\n',
  'scripts/agent-hunter.mjs': '// stand-in\n',
  'skills/agent-fixer/SKILL.md': '---\nname: agent-fixer\n---\n',
});

/**
 * A synthetic condition set with one row open, for the tests that are about being
 * HELD rather than about this machine's standing.
 *
 * Both real conditions closed on 2026-09-04 — ADR 0011, and
 * `results-2026-09-04-ambient-narrowing.md` — so an agent switched on *over* an
 * open condition is no longer reachable through `ENABLEMENT_CONDITIONS`. The
 * behaviour is not gone and still has to hold: it is what an owner meets the moment
 * any future ADR opens a condition, and `acknowledgedOpen` is the record ADR 0008
 * asks for when they enable anyway.
 *
 * Injected through the seam `inspect` and `planAgent` declare, which is the inverse
 * of why `runAuthorization` grew its own: that one made the *permitted* case
 * reachable while a condition stood open. Mutating the exported constant instead is
 * how a suite starts depending on its own execution order.
 */
const ONE_OPEN = [
  { condition: 'a condition this file holds closed', closed: true, evidence: 'tests/agent-menu-edits.test.mjs' },
  { condition: 'a condition this file holds open', closed: false, act: 'an owner does the outstanding thing' },
];

function ctxFor({ conditions } = {}) {
  return {
    repoRoot: makeRepo({ 'ROADMAP.md': `# ROADMAP\n\n${LINEAR_LINE}\n\n## Now\n` }),
    checkoutRoot: checkout(),
    homeDir: emptyDir(),
    ...(conditions ? { conditions } : {}),
  };
}

/** The row index of an agent's on/off row, resolved the way a human reads it off
 *  the screen rather than assumed to be a constant. */
const agentRow = (state, id) => rows(state).find((r) => r.ref === `agent:${id}`).index;
const windowRow = (state, id) => rows(state).find((r) => r.ref === `window:${id}`).index;

// ---------------------------------------------------------------------------
// planEdits is pure, and refuses rather than guessing
// ---------------------------------------------------------------------------

test('planEdits writes nothing at all', () => {
  // The property that makes --plan and --apply incapable of disagreeing: apply
  // calls plan and executes only what came back as `apply`.
  const ctx = ctxFor();
  const state = inspect(ctx);
  const before = readdirSync(ctx.homeDir);
  planEdits(state, [{ index: agentRow(state, 'fixer'), action: 'on' }], ctx);
  assert.deepEqual(readdirSync(ctx.homeDir), before);
  assert.equal(existsSync(agentStatePath('fixer', ctx)), false);
});

test('an index that is not on the screen is refused, never guessed at', () => {
  const ctx = ctxFor();
  const state = inspect(ctx);
  const [outcome] = planEdits(state, [{ index: 999, action: 'on' }], ctx);
  assert.equal(outcome.verdict, 'refuse');
  assert.match(outcome.reason, /no row 999|re-render/);
});

test('an action the row kind does not take is refused, and the refusal names what it does take', () => {
  const ctx = ctxFor();
  const state = inspect(ctx);
  const [outcome] = planEdits(state, [{ index: agentRow(state, 'fixer'), action: 'set' }], ctx);
  assert.equal(outcome.verdict, 'refuse');
  assert.match(outcome.reason, /on \| off|takes/);
});

test('one refusal in a batch does not discard the rest', () => {
  // config-menu.mjs's rule: a bad index is a fact about that index, and dropping
  // the other five would make the menu punish a typo.
  const ctx = ctxFor();
  const state = inspect(ctx);
  const planned = planEdits(state, [
    { index: 999, action: 'on' },
    { index: agentRow(state, 'fixer'), action: 'on' },
  ], ctx);
  assert.equal(planned.length, 2);
  assert.equal(planned[0].verdict, 'refuse');
  assert.equal(planned[1].verdict, 'apply');
});

const sweepRow = (state) => rows(state).find((r) => r.kind === 'sweep').index;

test('registering a sweep with no agent scheduled is refused, not quietly done', () => {
  // A 15-minute task that wakes to decide nothing is not a safety problem, it is
  // a machine doing scheduled work with nothing scheduled — which an operator
  // should be told about rather than left to discover.
  const ctx = ctxFor();
  const state = inspect(ctx);
  const [outcome] = planEdits(state, [{ index: sweepRow(state), action: 'register' }], ctx);
  assert.equal(outcome.verdict, 'refuse');
  assert.match(outcome.reason, /no agent has a window/i);
});

test('registering once an agent has a window is planned, and says what it does not do', () => {
  const ctx = ctxFor();
  let state = inspect(ctx);
  applyEdits(state, [{
    index: windowRow(state, 'fixer'), action: 'set', days: ['mon'], from: '02:00', to: '05:00',
  }], ctx);
  state = inspect(ctx);
  const planned = planEdits(state, [{ index: sweepRow(state), action: 'register' }], ctx);
  assert.equal(planned[0].verdict, 'apply');
  // Asserted through renderOutcomes, not on `outcome.note`.
  //
  // The first version checked the data, which proves the limit is in the object
  // and nothing about whether it reaches a screen — and it did not: the note was
  // carried and never printed, found by rendering the screen and reading it. Same
  // failure as the enablement conditions in Phase 4. A limit nobody was told is a
  // limit that does not exist.
  const text = renderOutcomes(planned).join('\n');
  assert.match(text, /logged on/i, 'the registration never tells anyone what it does not do');
});

test('removing a sweep this machine never registered is refused', () => {
  // CLAUDE.md #5 applied to a machine-wide object: a task at that name we have no
  // record of creating is somebody else's.
  const ctx = ctxFor();
  const state = inspect(ctx);
  const [outcome] = planEdits(state, [{ index: sweepRow(state), action: 'unregister' }], ctx);
  assert.equal(outcome.verdict, 'refuse');
  assert.match(outcome.reason, /no record/i);
});

test('turning on an agent that is already on is a noop, not a rewrite', () => {
  const ctx = ctxFor();
  let state = inspect(ctx);
  applyEdits(state, [{ index: agentRow(state, 'fixer'), action: 'on' }], ctx);
  state = inspect(ctx);
  const [outcome] = planEdits(state, [{ index: agentRow(state, 'fixer'), action: 'on' }], ctx);
  assert.equal(outcome.verdict, 'noop');
});

// ---------------------------------------------------------------------------
// The enablement act — ADR 0008's owner-held gesture
// ---------------------------------------------------------------------------

test('planning an enablement carries every condition and its standing', () => {
  // M2. The conditions travel with the PLAN, so `--plan` shows an owner exactly
  // what `--apply` would make them acknowledge. A mutant that stops emitting them
  // makes this fail by count, which is why the count is asserted and not just
  // presence — one condition quietly dropped is the failure that reads as fine.
  const ctx = ctxFor();
  const state = inspect(ctx);
  const [outcome] = planEdits(state, [{ index: agentRow(state, 'fixer'), action: 'on' }], ctx);

  assert.equal(outcome.verdict, 'apply');
  assert.equal(outcome.conditions.length, ENABLEMENT_CONDITIONS.length);
  assert.deepEqual(
    outcome.conditions.map((c) => c.condition),
    ENABLEMENT_CONDITIONS.map((c) => c.condition),
  );
  for (const row of outcome.conditions) {
    assert.equal(typeof row.closed, 'boolean', 'a condition with no standing is not a condition');
  }
});

test('the rendered plan shows both conditions to the person about to enable', () => {
  // Asserted through renderOutcomes — the function that actually produces what an
  // owner reads — and NOT by re-formatting the data by hand.
  //
  // Reformatting is the Phase 3 mistake in a new place: it proves the conditions
  // are in the outcome object, and says nothing about whether they ever reach a
  // screen. M2 can be applied in two places, dropping them from the plan or
  // dropping them from the print, and a test built on the data catches only the
  // first. This is the enablement act, so what matters is what gets shown.
  const ctx = ctxFor();
  const state = inspect(ctx);
  const planned = planEdits(state, [{ index: agentRow(state, 'fixer'), action: 'on' }], ctx);
  const text = renderOutcomes(planned).join('\n');

  for (const condition of ENABLEMENT_CONDITIONS) {
    assert.ok(text.includes(condition.condition), `the printed plan never shows: ${condition.condition}`);
  }
  // Both closed since 2026-09-04, so this is the standing an owner is shown today
  // and the evidence is what stands where the act used to.
  assert.match(text, /\[closed\]/, 'a closed condition must be visibly closed');
  assert.doesNotMatch(text, /\[ open \]/, 'nothing is open, so nothing may render as open');
  for (const closed of ENABLEMENT_CONDITIONS.filter((c) => c.closed)) {
    assert.ok(text.includes(closed.evidence), 'a closed condition shows no evidence for having closed');
  }
});

test('an open condition renders as open, and names the act that would close it', () => {
  // The other half of the screen above, kept alive through the seam now that both
  // real conditions are closed. Deleting it with the standing that made it
  // reachable would leave `[ open ]` and the act line asserted by nothing — and
  // they are the two things an owner needs most on the day a condition reopens.
  //
  // Mutation killed: dropping `row.act` from the print at `agent-menu.mjs:764`,
  // which no other test in the suite catches.
  const ctx = ctxFor({ conditions: ONE_OPEN });
  const state = inspect(ctx);
  const planned = planEdits(state, [{ index: agentRow(state, 'fixer'), action: 'on' }], ctx);
  const text = renderOutcomes(planned).join('\n');

  assert.match(text, /\[ open \]/, 'an open condition must be visibly open on the screen');
  assert.match(text, /\[closed\]/, 'a closed condition must be visibly closed');
  for (const open of ONE_OPEN.filter((c) => !c.closed)) {
    assert.ok(text.includes(open.condition), `the printed plan never shows: ${open.condition}`);
    // The act, so the owner is not left with a fact and no move to make.
    assert.ok(text.includes(open.act), 'the open condition names no act that would close it');
  }
});

test('applying the enablement also shows the conditions, not only planning it', () => {
  // `--apply` is the act. An owner who ran apply without plan must still see them.
  const ctx = ctxFor();
  const state = inspect(ctx);
  const text = renderOutcomes(applyEdits(state, [{ index: agentRow(state, 'fixer'), action: 'on' }], ctx)).join('\n');
  for (const condition of ENABLEMENT_CONDITIONS) {
    assert.ok(text.includes(condition.condition), `apply never showed: ${condition.condition}`);
  }
});

test('enabling writes a record naming the conditions as they stood at that moment', () => {
  const ctx = ctxFor();
  const state = inspect(ctx);
  const [outcome] = applyEdits(state, [{ index: agentRow(state, 'fixer'), action: 'on' }], ctx);
  assert.equal(outcome.verdict, 'applied');

  const record = JSON.parse(readFileSync(agentStatePath('fixer', ctx), 'utf8'));
  assert.equal(record.kind, ENABLEMENT_KIND);
  assert.equal(record.agent, 'fixer');
  assert.equal(record.enabled, true);
  assert.ok(record.enabledAt, 'the act is undated');
  // A COPY, not a pointer. If a condition later closes, the record must still say
  // what the owner was looking at when they decided — the only thing an audit
  // trail can honestly claim.
  assert.equal(record.conditionsShown.length, ENABLEMENT_CONDITIONS.length);
  assert.deepEqual(
    record.conditionsShown.map((c) => c.closed),
    ENABLEMENT_CONDITIONS.map((c) => c.closed),
  );
});

test('enabling over an open condition is permitted and counted, not refused', () => {
  // The ADR gates the FEATURE on the conditions. It does not give a menu the
  // authority to overrule an owner who has read them, and a menu that refused
  // would be deciding an owner-held act on their behalf.
  const ctx = ctxFor({ conditions: ONE_OPEN });
  const state = inspect(ctx);
  applyEdits(state, [{ index: agentRow(state, 'fixer'), action: 'on' }], ctx);
  const record = JSON.parse(readFileSync(agentStatePath('fixer', ctx), 'utf8'));
  const open = ONE_OPEN.filter((c) => !c.closed).length;
  assert.equal(record.acknowledgedOpen, open);
  assert.ok(open >= 1, 'this test is vacuous if every condition is closed');
});

test('an agent enabled over an open condition renders differently from one enabled cleanly', () => {
  // The name says "renders", so the assertion has to be on what render() prints,
  // not on the inspect() data structure behind it — the same mistake this file's
  // own Phase 4 comment already names for the enablement conditions: an object
  // holding a fact proves nothing about whether a human ever sees it.
  const ctx = ctxFor({ conditions: ONE_OPEN });
  const state = inspect(ctx);
  applyEdits(state, [{ index: agentRow(state, 'fixer'), action: 'on' }], ctx);
  const after = inspect(ctx);
  const fixer = after.agents.find((a) => a.id === 'fixer');
  assert.equal(fixer.enabled, true);
  assert.ok(fixer.acknowledgedOpen >= 1, 'this test is vacuous if nothing was open to acknowledge');

  const screen = render(after).join('\n');
  assert.match(screen, new RegExp(`enabled over ${fixer.acknowledgedOpen} open enablement condition\\(s\\)`));
});

test('both agents gate on ADR 0008, because its Consequences name both issues', () => {
  // Phase 1 gave the hunter only a per-lens FILING gate. That is a different and
  // additional gate: ADR 0008's *Consequences* say neither `#193 (FORGE-259)` nor
  // `#194 (FORGE-260)` may be enabled until the same two conditions are met, so
  // the running gate is shared.
  const ctx = ctxFor();
  const state = inspect(ctx);
  for (const id of ['fixer', 'hunter']) {
    const [outcome] = planEdits(state, [{ index: agentRow(state, id), action: 'on' }], ctx);
    assert.equal(outcome.conditions.length, ENABLEMENT_CONDITIONS.length, `${id} does not gate on ADR 0008`);
  }
});

test('turning an agent off needs no conditions and keeps the record', () => {
  // Switching off is not the gated act. Requiring the ceremony to stop something
  // is how a person gives up and edits the file by hand.
  const ctx = ctxFor();
  let state = inspect(ctx);
  applyEdits(state, [{ index: agentRow(state, 'fixer'), action: 'on' }], ctx);
  state = inspect(ctx);
  const [off] = applyEdits(state, [{ index: agentRow(state, 'fixer'), action: 'off' }], ctx);
  assert.equal(off.verdict, 'applied');
  const record = JSON.parse(readFileSync(agentStatePath('fixer', ctx), 'utf8'));
  assert.equal(record.enabled, false);
  assert.ok(record.enabledAt, 'the history of the act was discarded');
});

// ---------------------------------------------------------------------------
// applyEdits executes only what planEdits blessed
// ---------------------------------------------------------------------------

test('applyEdits performs nothing that planEdits refused', () => {
  const ctx = ctxFor();
  const state = inspect(ctx);
  const outcomes = applyEdits(state, [
    { index: 999, action: 'on' },
    { index: agentRow(state, 'fixer'), action: 'set' },
  ], ctx);
  assert.ok(outcomes.every((o) => o.verdict === 'refuse'));
  assert.equal(existsSync(agentStatePath('fixer', ctx)), false);
});

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

// Every window test below is aimed at the fixer rather than the hunter, and the
// swap is the point rather than a detail: `#223 (FORGE-294)` established that the
// hunter has no unattended driver, so a window on it is a schedule that can never
// start anything and the screen now refuses one. A suite that went on setting
// hunter windows would have been asserting over a gesture the product declines.
test('a window is stored on the agent it was set for', () => {
  const ctx = ctxFor();
  const state = inspect(ctx);
  applyEdits(state, [{
    index: windowRow(state, 'fixer'), action: 'set',
    days: ['mon', 'wed'], from: '02:00', to: '05:00',
  }], ctx);
  const record = JSON.parse(readFileSync(agentStatePath('fixer', ctx), 'utf8'));
  assert.deepEqual(record.window, { days: ['mon', 'wed'], from: '02:00', to: '05:00' });
  assert.equal(existsSync(agentStatePath('hunter', ctx)), false,
    'setting one agent\'s window wrote a state file for the other');
});

test('a window on an agent with no unattended driver is refused, and says why', () => {
  // `#223 (FORGE-294)`. The sweeper declines to start this entry every tick, so a
  // window accepted here would be a schedule that silently does nothing — and the
  // owner would walk away believing the agent was scheduled.
  const ctx = ctxFor();
  const state = inspect(ctx);
  const [outcome] = planEdits(state, [{
    index: windowRow(state, 'hunter'), action: 'set', days: ['mon'], from: '02:00', to: '05:00',
  }], ctx);
  assert.equal(outcome.verdict, 'refuse');
  assert.match(outcome.reason, /no unattended driver/);
  assert.equal(existsSync(agentStatePath('hunter', ctx)), false, 'a refused window was written anyway');
});

test('clearing a window is still offered to an agent with no unattended driver', () => {
  // Refusing `clear` as well would strand an owner who set a hunter window before
  // this refusal existed: the screen that created it would be the one screen that
  // could not remove it.
  const ctx = ctxFor();
  mkdirSync(join(ctx.homeDir, '.daftplate', 'agents'), { recursive: true });
  writeFileSync(agentStatePath('hunter', ctx), JSON.stringify({
    kind: 'daftplate.agent.enablement/1', agent: 'hunter', enabled: false,
    window: { days: ['mon'], from: '02:00', to: '05:00' },
  }));
  const state = inspect(ctx);
  applyEdits(state, [{ index: windowRow(state, 'hunter'), action: 'clear' }], ctx);
  const record = JSON.parse(readFileSync(agentStatePath('hunter', ctx), 'utf8'));
  assert.equal(record.window, null);
});

test('a window with a malformed time is refused before anything is written', () => {
  const ctx = ctxFor();
  const state = inspect(ctx);
  const [outcome] = planEdits(state, [{
    index: windowRow(state, 'fixer'), action: 'set', days: ['mon'], from: '2am', to: '05:00',
  }], ctx);
  assert.equal(outcome.verdict, 'refuse');
  assert.match(outcome.reason, /HH:MM|time/i);
});

test('a window with an unknown day is refused', () => {
  const ctx = ctxFor();
  const state = inspect(ctx);
  const [outcome] = planEdits(state, [{
    index: windowRow(state, 'fixer'), action: 'set', days: ['funday'], from: '02:00', to: '05:00',
  }], ctx);
  assert.equal(outcome.verdict, 'refuse');
  assert.match(outcome.reason, /day/i);
});

test('clearing a window leaves the agent enabled and run-now only', () => {
  const ctx = ctxFor();
  let state = inspect(ctx);
  applyEdits(state, [{
    index: windowRow(state, 'fixer'), action: 'set', days: ['mon'], from: '02:00', to: '05:00',
  }], ctx);
  state = inspect(ctx);
  applyEdits(state, [{ index: windowRow(state, 'fixer'), action: 'clear' }], ctx);
  const record = JSON.parse(readFileSync(agentStatePath('fixer', ctx), 'utf8'));
  assert.equal(record.window, null);
});

// ---------------------------------------------------------------------------
// The edit grammar
// ---------------------------------------------------------------------------

test('parseEdits refuses a list that is not an array of edits', () => {
  assert.throws(() => parseEdits('not json'), /JSON/);
  assert.throws(() => parseEdits('{"index":1}'), /array/);
  assert.throws(() => parseEdits('[{"index":1}]'), /action/);
  assert.throws(() => parseEdits('[{"action":"on"}]'), /index/);
});

test('parseEdits carries the window fields through', () => {
  const [edit] = parseEdits('[{"index":2,"action":"set","days":["mon"],"from":"02:00","to":"05:00"}]');
  assert.deepEqual(edit, { index: 2, action: 'set', days: ['mon'], from: '02:00', to: '05:00' });
});

test('a state file that will not parse refuses the edit rather than overwriting it', () => {
  // Overwriting is how an owner's own record — the audit trail of a decision they
  // made — gets destroyed by a menu trying to be helpful.
  const ctx = ctxFor();
  mkdirSync(join(ctx.homeDir, '.daftplate', 'agents'), { recursive: true });
  writeFileSync(agentStatePath('fixer', ctx), '{ not json');
  const state = inspect(ctx);
  const [outcome] = planEdits(state, [{ index: agentRow(state, 'fixer'), action: 'on' }], ctx);
  assert.equal(outcome.verdict, 'refuse');
  assert.match(outcome.reason, /parse|readable/i);
  assert.equal(readFileSync(agentStatePath('fixer', ctx), 'utf8'), '{ not json');
});

// ---------------------------------------------------------------------------
// Live runs — rows() numbering and planLiveRun()'s per-agent refusal
// ---------------------------------------------------------------------------

/** Open a real run record for `agent`, under the same `runsDir` `inspect()`
 *  derives from `ctx.homeDir` (agent-menu.mjs's own fix for the isolation gap:
 *  `runsDir: join(homeDir, '.daftplate', 'runs')`), so this fixture is seen
 *  exactly the way a live run from a real invocation would be. */
const openLiveRun = (ctx, agent, runId, issue) => {
  const opened = openRunRecord(
    { repoRoot: ctx.repoRoot, runId, issue },
    { runsDir: join(ctx.homeDir, '.daftplate', 'runs'), agent },
  );
  assert.equal(opened.ok, true, opened.message);
};

test('rows() numbers a live run after every fixed row, and render() prints it at that number', () => {
  // Nothing previously checked the live-run row's INDEX specifically — only that
  // a row of kind `live-run` existed somewhere. A mutant that pushed it before
  // the sweep row, or renumbered it, would have gone undetected.
  const ctx = ctxFor();
  openLiveRun(ctx, 'fixer', 'fixer-1-20260828T200000Z', 1);
  const state = inspect(ctx);

  const fixed = rows(state).filter((r) => r.kind !== 'live-run');
  const runRow = rows(state).find((r) => r.kind === 'live-run');
  assert.ok(runRow, 'the live run produced no row at all');
  // One row per agent field (agent/window/run) times two agents, plus the one
  // sweep row — the live run comes after every one of them, never spliced in
  // among the fixed rows.
  assert.equal(runRow.index, fixed.length + 1);
  assert.deepEqual(fixed.map((r) => r.index), fixed.map((_, i) => i + 1));

  const lines = render(state);
  const dataLine = lines.find((l) => l.includes(runRow.run.runId));
  assert.ok(dataLine, 'the live run never reaches the screen');
  assert.ok(dataLine.trimStart().startsWith(String(runRow.index)),
    `render() printed the live run under a different number than rows() gave it: ${dataLine}`);
});

/** The command an outcome hands back, taken off the SCREEN rather than off the
 *  object.
 *
 *  `#194 (FORGE-260)` Phase 7's own constraint, and the precedent is this
 *  feature's: nine assertions across it read a field that never reached a
 *  rendering, and every one of them passed while its mutant survived —
 *  `planSweep`'s `note` was in the object and on no screen. `renderOutcomes`
 *  prints `run: <argv joined>`, so this parses that line back into an argv and
 *  everything below asserts over what an operator can actually copy. */
function commandOnScreen(outcome) {
  const line = renderOutcomes([outcome]).find((l) => l.trimStart().startsWith('run: '));
  if (!line) return null;
  // The screen is what is asserted; the argv is what is parsed. Splitting the
  // rendered line back on spaces would be lossy the first time a checkout lives
  // under `C:\Program Files`, so the two are tied together instead: the line must
  // carry the argv verbatim, and callers then parse the argv it carried.
  assert.equal(line.trimStart(), `run: ${outcome.command.join(' ')}`,
    'the command on the screen is not the command in the outcome');
  return outcome.command;
}

test('the stop command the menu composes parses under the parser of the script it names', () => {
  // The acceptance criterion `#276 (FORGE-337)` AC 3 asks for, and the reason it
  // asks: a string comparison passed all three of this line's faults at once.
  // Fed to the real parser, a wrong script name, an absent `<repo>` positional
  // and an unparseable `--release` are each a thrown error rather than a
  // spelling difference nobody notices.
  //
  // MUTANT (M10): restore the per-agent script switch — `row.run.agent ===
  // 'hunter' ? 'scripts/agent-hunter.mjs' : …`. The hunter half then parses
  // under `parseArgs`, which throws `hunt: unknown option --stop=…`.
  const ctx = ctxFor();
  openLiveRun(ctx, 'fixer', 'fixer-1-20260828T200000Z', 1);
  openLiveRun(ctx, 'hunter', 'hunter-20260828T200000Z', null);
  const state = inspect(ctx);

  for (const agent of ['fixer', 'hunter']) {
    const row = rows(state).find((r) => r.kind === 'live-run' && r.run.agent === agent);
    assert.ok(row, `no live-run row for ${agent}`);
    const [outcome] = planEdits(state, [{ index: row.index, action: 'stop' }], ctx);
    const command = commandOnScreen(outcome);
    assert.ok(command, `${agent}: the stop command never reached the screen`);

    // Every agent's stop goes to the fixer's script, because that is the runs CLI
    // for all of them — `resolveRun` finds a run of any agent from its id (D9).
    assert.match(command[1], /agent-fixer\.mjs$/, `${agent}: the menu named some other script`);
    assert.equal(isAbsolute(command[1]), true, `${agent}: the script path is relative to nothing in particular`);

    const parsed = parseAgentRunArgs(command);
    assert.equal(parsed.command, 'stop');
    assert.equal(parsed.target, row.run.runId, `${agent}: the command stops some other run`);
    // The `<repo>` positional, absent before this phase. Without it the CLI
    // defaults to `process.cwd()` — whatever directory the operator pasted the
    // command into, which is the choice ADR 0008 row 2 makes security-relevant.
    assert.equal(parsed.repoRoot, state.repoRoot, `${agent}: the command names the wrong repository`);
  }
});

test('a hunt has no release command, and the menu says so instead of composing one', () => {
  // `#276 (FORGE-337)`. `--release` takes an issue number and a hunt claims no
  // issue, so `?? runId` produced `--release=hunter-…`, which
  // `parseAgentRunArgs` refuses with "--release needs an issue number". The
  // fallback was wrong in kind, not in formatting.
  //
  // MUTANT: restore `row.run.issue?.number ?? row.run.runId`. The `throws`
  // assertion below becomes a pass, and the "no command on the screen" one goes
  // red.
  const ctx = ctxFor();
  openLiveRun(ctx, 'hunter', 'hunter-20260828T200000Z', null);
  const state = inspect(ctx);
  const row = rows(state).find((r) => r.kind === 'live-run');

  const [released] = planEdits(state, [{ index: row.index, action: 'release' }], ctx);
  assert.equal(released.verdict, 'refuse');
  assert.equal(commandOnScreen(released), null, 'the menu composed a release command for a run with no claim');
  assert.match(released.reason, /claims no issue/);

  // And the shape the old fallback produced is genuinely refused by the CLI, so
  // this is a fact about the parser rather than an opinion about the menu.
  assert.throws(() => parseAgentRunArgs(['node', 'agent-fixer.mjs', '.', `--release=${row.run.runId}`]),
    /--release needs an issue number/);
});

test('planLiveRun names the action actually requested, and never confuses stop with release', () => {
  // MUTANT: swap `stop` and `release`, or hardcode one of them. Asserted through
  // the parser rather than over the message: `parsed.command` is what the CLI
  // would actually do.
  const ctx = ctxFor();
  openLiveRun(ctx, 'fixer', 'fixer-3-20260828T200000Z', 3);
  const state = inspect(ctx);
  const runRow = rows(state).find((r) => r.kind === 'live-run');

  const [stopped] = planEdits(state, [{ index: runRow.index, action: 'stop' }], ctx);
  const [released] = planEdits(state, [{ index: runRow.index, action: 'release' }], ctx);

  const stopCommand = parseAgentRunArgs(commandOnScreen(stopped));
  assert.equal(stopCommand.command, 'stop');
  assert.equal(stopCommand.target, 'fixer-3-20260828T200000Z');

  // The claim is keyed on the issue, so releasing names the issue — the one
  // place the two identifiers legitimately differ.
  const releaseCommand = parseAgentRunArgs(commandOnScreen(released));
  assert.equal(releaseCommand.command, 'release');
  assert.equal(releaseCommand.issue, 3);
});

test('run now hands back an argv the runner parses, naming the checkout and the repository', () => {
  // It used to be `['node', agent.script, '.']` — a relative script path and a
  // `.` that resolves to wherever the operator is standing. Correct only when
  // the cwd is simultaneously the checkout and the target repository, which is
  // the one case a test run from the repo root never distinguishes. Here they
  // are deliberately two different fixtures.
  //
  // MUTANT: put `'.'` back as the positional. `parsed.repoRoot` is then `'.'`
  // and not `state.repoRoot`.
  const ctx = ctxFor();
  const state = inspect(ctx);
  assert.notEqual(state.repoRoot, state.checkoutRoot, 'the fixture cannot tell the two roots apart');

  for (const agent of state.agents) {
    const row = rows(state).find((r) => r.ref === `run:${agent.id}`);
    const [outcome] = planEdits(state, [{ index: row.index, action: 'now' }], ctx);
    if (outcome.verdict !== 'apply') continue; // the fixer's board precondition is unmet on this board
    const command = commandOnScreen(outcome);
    assert.ok(command, `${agent.id}: the run command never reached the screen`);
    assert.equal(isAbsolute(command[1]), true, `${agent.id}: the script path is relative`);
    assert.equal(command[1], join(state.checkoutRoot, agent.script));

    const parse = agent.id === 'hunter' ? parseArgs : parseAgentRunArgs;
    const parsed = parse(command);
    assert.equal(agent.id === 'hunter' ? parsed.dir : parsed.repoRoot, state.repoRoot,
      `${agent.id}: run now points at something other than the repository on the screen`);
  }
});

// ---------------------------------------------------------------------------
// #332 (FORGE-368) — a sweep refusal names its own reason
// ---------------------------------------------------------------------------

/** A `schtasks` that fails saying nothing at all — status non-zero, both streams
 *  empty. This is not a contrived shape: it is what an absent `schtasks` looks
 *  like from `spawnSync`, and both sweep producers build their message as
 *  `(result.stderr || result.stdout || '').trim()`, so both hand back `''`. */
const silentSchtasks = () => ({ status: 1, stdout: '', stderr: '' });

/** A machine that has a record of registering the sweep, so `unregister` reaches
 *  the producer instead of being refused at plan time. */
function registered(ctx) {
  mkdirSync(join(ctx.homeDir, '.daftplate', 'agents'), { recursive: true });
  writeFileSync(sweepStatePath(ctx), `${JSON.stringify({
    kind: SWEEP_KIND, registered: true, taskName: 'daftplate-agent-sweep', repoRoot: ctx.repoRoot,
  }, null, 2)}\n`, 'utf8');
}

/** The same failure with a message of blanks, kept for the producer path: both
 *  producers trim, so this lands as the empty string exactly as `silentSchtasks`
 *  does. The renderer's own guarantee is asserted through the producer seam. */
const blankSchtasks = () => ({ status: 1, stdout: '   ', stderr: '\t\n  ' });

test('#332 (FORGE-368) — a register refusal whose message is empty still names its reason', () => {
  // Asserted through what the menu RENDERS, never through the returned entry.
  // The entry is precisely where this defect is invisible: `reason` is correct on
  // the way past, and `??` drops it only at the point of printing. A test reading
  // `outcome.reason` passes on the broken code.
  const ctx = ctxFor();
  let state = inspect(ctx);
  applyEdits(state, [{
    index: windowRow(state, 'fixer'), action: 'set', days: ['mon'], from: '02:00', to: '05:00',
  }], ctx);
  state = inspect(ctx);

  const applied = applyEdits(state, [{ index: sweepRow(state), action: 'register' }],
    { ...ctx, schtasks: silentSchtasks });
  assert.equal(applied[0].verdict, 'refuse');

  const text = renderOutcomes(applied).join('\n');
  assert.match(text, /register-failed/,
    'the refusal reached the screen naming nothing — the reason was in the object and never printed');
  // And the line is not blank after the verdict marker, which is what the defect
  // actually looked like to an operator.
  const line = renderOutcomes(applied).find((l) => l.includes('REFUSE'));
  assert.notEqual(line.replace(/^\s*\d+\s+REFUSE\s*/, '').trim(), '', 'the refusal printed an empty line');
});

test('#332 (FORGE-368) — a message of nothing but whitespace is no message at all', () => {
  // AC 4, and it needs the producer seam to be reachable at all. Both producers
  // build their message as `(stderr || stdout || '').trim()`, so a `schtasks`
  // answering in blanks arrives here already empty — a test driven through them
  // passes with this function's own `trim()` removed, which is an assertion of
  // exactly the kind this issue exists to remove. Measured: with the seam absent
  // and the whitespace case driven through `schtasks`, the trim-removing mutant
  // survives the whole suite.
  //
  // The guarantee belongs to the renderer because a rule kept only where the
  // value is made is a rule the next producer will not know about — which is how
  // the empty-message shape arrived in the first place.
  const ctx = ctxFor();
  registered(ctx);
  const state = inspect(ctx);
  const applied = applyEdits(state, [{ index: sweepRow(state), action: 'unregister' }], {
    ...ctx,
    unregisterSweep: () => ({ ok: false, reason: 'delete-failed', message: '  \n\t ' }),
  });
  assert.equal(applied[0].verdict, 'refuse');
  assert.match(renderOutcomes(applied).join('\n'), /delete-failed/,
    'a message of blanks was printed as though it were words');

  // Both halves, not just the message. Every `reason` in this repository is a
  // kebab-case constant with no whitespace in it, so the reason side of the rule
  // is unreachable through any producer — and a mutant removing its `trim()`
  // survived the file until this assertion existed. Recorded rather than skipped:
  // a guarantee that holds for one half and is untested on the other is the shape
  // the whole issue is about.
  const padded = applyEdits(inspect(ctx), [{ index: sweepRow(inspect(ctx)), action: 'unregister' }], {
    ...ctx,
    unregisterSweep: () => ({ ok: false, reason: '  delete-failed  ', message: '' }),
  });
  const line = renderOutcomes(padded).find((l) => l.includes('REFUSE'));
  assert.match(line, /delete-failed$/, 'the reason reached the screen with its blanks still on it');
});

test('#332 (FORGE-368) — a refusal carrying neither message nor reason still says something', () => {
  // The last fallback, and the only one no producer fix can reach: a refusal
  // object with nothing in it. Printing an empty line for that would be the same
  // silence by another route.
  const ctx = ctxFor();
  let state = inspect(ctx);
  applyEdits(state, [{
    index: windowRow(state, 'fixer'), action: 'set', days: ['mon'], from: '02:00', to: '05:00',
  }], ctx);
  state = inspect(ctx);
  const applied = applyEdits(state, [{ index: sweepRow(state), action: 'register' }], {
    ...ctx,
    registerSweep: () => ({ ok: false }),
  });
  assert.equal(applied[0].verdict, 'refuse');
  assert.match(renderOutcomes(applied).join('\n'), /refused without naming a reason/);
});

test('#332 (FORGE-368) — the unregister producer\'s refusal reaches the screen too', () => {
  // The second of the two real producers. `delete-failed` builds its message from
  // the same two streams as `register-failed`, so a `schtasks` that fails saying
  // nothing hands over the empty string here as well — the same defect at the
  // other action.
  const ctx = ctxFor();
  registered(ctx);
  const state = inspect(ctx);
  const applied = applyEdits(state, [{ index: sweepRow(state), action: 'unregister' }],
    { ...ctx, schtasks: blankSchtasks });
  assert.equal(applied[0].verdict, 'refuse');

  const text = renderOutcomes(applied).join('\n');
  assert.match(text, /delete-failed/, 'the second producer\'s refusal reached the screen naming nothing');
});

test('#332 (FORGE-368) — a producer that names its own failure well is still preferred', () => {
  // The fallback is a rescue, not a replacement. A refusal that says something
  // keeps saying it, so the fix cannot have quietly flattened every sweep refusal
  // to its reason code — which would pass the two tests above and lose every word
  // an operator actually needs.
  const ctx = ctxFor();
  let state = inspect(ctx);
  applyEdits(state, [{
    index: windowRow(state, 'fixer'), action: 'set', days: ['mon'], from: '02:00', to: '05:00',
  }], ctx);
  state = inspect(ctx);

  const applied = applyEdits(state, [{ index: sweepRow(state), action: 'register' }], {
    ...ctx,
    schtasks: () => ({ status: 1, stdout: '', stderr: 'ERROR: Access is denied.' }),
  });
  const text = renderOutcomes(applied).join('\n');
  assert.match(text, /Access is denied/, 'the producer\'s own words were discarded');
});

test('#332 (FORGE-368) — no refusal in this file renders its own words', () => {
  // The source guard `#327 (FORGE-367)` put on `agent-fixer.mjs`, at the one site
  // outside that file that had the shape. Asserted over the source because the
  // property is about sites that do not exist yet: a seventh refusal render added
  // later reaching for `??` is the way this class came back the first time.
  const src = readFileSync(new URL('../scripts/agent-menu.mjs', import.meta.url), 'utf8');
  const offenders = src.split('\n')
    // A comment naming the shape is the record of why the helper exists, and
    // scanning it would make this guard fail on its own documentation.
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter((line) => /\.message\s*\?\?/.test(line));
  assert.deepEqual(offenders, [],
    'a refusal in scripts/agent-menu.mjs renders its own words with ?? instead of asking the helper');
});
