// Phase 3 of `#204 (FORGE-265)`: the first three of the menu's five functions.
//
// The shape is `config-menu.mjs`'s and the reasoning behind it is cited there
// rather than re-argued here — one ordering for both the screen and the edit
// grammar, a pure `inspect`, a `render` that returns lines instead of printing.
//
// The two renderings this phase exists to get right are the ones that are easy to
// conflate with "switched off": the fixer's Linear precondition, which is unmet on
// this board and cannot be fixed by toggling anything, and the hunter's SKILL.md,
// which has not been written yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import { buildRegisterArgs } from '../scripts/agent-sweep.mjs';
import { AGENTS } from '../scripts/lib/agent-registry.mjs';
import { openRunRecord } from '../scripts/lib/run-record.mjs';
import { inspect, rows, render, agentStatePath, sweepStatePath } from '../scripts/agent-menu.mjs';

const LINEAR_LINE = 'Board: issues are created in GitHub and managed in Linear (ADR 0006) — the\n'
  + '[daftplate](https://linear.app/x) project, team `FORGE`. GitHub is canonical for\n'
  + 'whether an issue exists; Linear is canonical for its state.';
const PROJECTS_LINE = 'Board: the GitHub Project for this repository. The issue is canonical and the\n'
  + 'project is a view of it; where the two disagree, the issue wins.';

const repoOn = (boardLine) => makeRepo({ 'ROADMAP.md': `# ROADMAP\n\n${boardLine}\n\n## Now\n` });

/** A fake home with no agent state written: every agent is off and unscheduled. */
const freshHome = () => emptyDir();

/**
 * A checkout where the fixer's skill exists and the hunter's does not, which is
 * this repository's real state today.
 *
 * **A fixture rather than `process.cwd()`, and that is an export-safety fix.**
 * The daftplate export withholds `skills/` (ADR 0002), so a test asserting
 * `fixer.skillPresent === true` against the live checkout passes here and fails
 * in the exported suite `/publish` runs — the same hazard Phase 1 hit. Measuring
 * a fixture tests the measurement rather than this repo's current contents, and
 * works in both.
 */
const checkoutWithFixerSkillOnly = () => makeRepo({
  'scripts/agent-fixer.mjs': '// stand-in\n',
  'scripts/agent-hunter.mjs': '// stand-in\n',
  'skills/agent-fixer/SKILL.md': '---\nname: agent-fixer\n---\n',
});

/** A ROADMAP with no `Board:` declaration at all — the remaining unmet case for the
 *  board precondition now that both declared variants are pollable. */
const NO_BOARD_LINE = 'This repository declares no board here.';

const ctxFor = (boardLine = LINEAR_LINE, homeDir = freshHome()) => ({
  repoRoot: repoOn(boardLine),
  checkoutRoot: checkoutWithFixerSkillOnly(),
  homeDir,
});

// ---------------------------------------------------------------------------
// inspect — a pure read that measures the registry against reality
// ---------------------------------------------------------------------------

test('inspect reports one entry per registry agent, in registry order', () => {
  const state = inspect(ctxFor());
  assert.deepEqual(state.agents.map((a) => a.id), AGENTS.map((a) => a.id));
});

test('inspect measures which agents have had their doctrine written', () => {
  // Phase 1 established this and Phase 3 has to SHOW it: `skills/agent-hunter/`
  // does not exist, because it is Phase 6's deliverable.
  const state = inspect(ctxFor());
  const byId = Object.fromEntries(state.agents.map((a) => [a.id, a]));
  assert.equal(byId.fixer.skillPresent, true);
  assert.equal(byId.hunter.skillPresent, false);
});

test('inspect writes nothing', () => {
  // Same contract as config-menu.mjs:197. A menu that wrote while rendering would
  // make `--render` a mutation, and `--plan` could no longer claim to be pure.
  const home = freshHome();
  const ctx = ctxFor(LINEAR_LINE, home);
  const before = readdirSync(home);
  inspect(ctx);
  assert.deepEqual(readdirSync(home), before);
});

test('an agent with no state file is off, unscheduled, and says so without inventing a record', () => {
  const state = inspect(ctxFor());
  for (const agent of state.agents) {
    assert.equal(agent.enabled, false);
    assert.equal(agent.window, null);
    assert.equal(agent.enablement, null);
  }
});

test('inspect reads the enablement record an owner wrote', () => {
  const home = freshHome();
  mkdirSync(join(home, '.daftplate', 'agents'), { recursive: true });
  writeFileSync(agentStatePath('fixer', { homeDir: home }), JSON.stringify({
    kind: 'daftplate.agent.enablement/1',
    agent: 'fixer',
    enabled: true,
    enabledAt: '2026-08-28T20:00:00Z',
    conditionsShown: [{ condition: 'a', closed: true }, { condition: 'b', closed: false }],
    acknowledgedOpen: 1,
  }));
  const byId = Object.fromEntries(inspect(ctxFor(LINEAR_LINE, home)).agents.map((a) => [a.id, a]));
  assert.equal(byId.fixer.enabled, true);
  assert.equal(byId.fixer.acknowledgedOpen, 1);
  assert.equal(byId.hunter.enabled, false);
});

test('a state file that will not parse is reported, not treated as off', () => {
  // "Off" and "unreadable" are different facts. Reporting the second as the first
  // tells an owner their agent is safely disabled when nothing actually knows.
  const home = freshHome();
  mkdirSync(join(home, '.daftplate', 'agents'), { recursive: true });
  writeFileSync(agentStatePath('fixer', { homeDir: home }), '{ not json');
  const state = inspect(ctxFor(LINEAR_LINE, home));
  const byId = Object.fromEntries(state.agents.map((a) => [a.id, a]));
  assert.equal(byId.fixer.readable, false);
  assert.ok(byId.fixer.error);

  // The fact inspect() measured is not the fact an owner sees unless render()
  // actually prints it — checked on the same fixture, not on a re-derived one.
  // `planEdits`'s refusal for an unreadable file (agent-menu-edits.test.mjs) is a
  // different code path and proves nothing about this one.
  const screen = render(state).join('\n');
  assert.match(screen, /! state file could not be parsed — .*/);
  assert.match(screen, new RegExp(byId.fixer.error.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// ---------------------------------------------------------------------------
// Preconditions — the fixer's trigger cannot fire on this board
// ---------------------------------------------------------------------------

test('the board precondition is unmet when no board is declared, and names the act', () => {
  // **This asserted the Linear variant until 2026-09-04**, when a measured finding
  // retired that refusal: a label applied in Linear reaches the GitHub issue through
  // the issues sync, so both variants poll one path. The unmet case that remains is
  // a repository declaring no single board at all, which is the one an owner can
  // actually act on — the old `ownerAct` named an act that could not close it.
  const byId = Object.fromEntries(inspect(ctxFor(NO_BOARD_LINE)).agents.map((a) => [a.id, a]));
  const [pre] = byId.fixer.trigger.preconditions;
  assert.equal(pre.met, false);
  assert.equal(byId.fixer.triggerReady, false);
  assert.match(pre.ownerAct, /ROADMAP\.md/);
});

test('the precondition is met on both declared board variants', () => {
  // The precondition is about a board being declared, not about which one. If it
  // reported unmet on either it would be a constant dressed as a check — and the
  // Linear half is the regression that would say the refusal had come back.
  for (const line of [PROJECTS_LINE, LINEAR_LINE]) {
    const byId = Object.fromEntries(inspect(ctxFor(line)).agents.map((a) => [a.id, a]));
    assert.equal(byId.fixer.trigger.preconditions[0].met, true, `unmet on ${line.slice(0, 30)}…`);
    assert.equal(byId.fixer.triggerReady, true);
  }
});

test('an agent with no preconditions is trigger-ready', () => {
  const byId = Object.fromEntries(inspect(ctxFor()).agents.map((a) => [a.id, a]));
  assert.deepEqual(byId.hunter.trigger.preconditions, []);
  assert.equal(byId.hunter.triggerReady, true);
});

// ---------------------------------------------------------------------------
// rows — ONE ordering, which render() resolves against too
// ---------------------------------------------------------------------------

test('rows are numbered from 1 with no gaps', () => {
  const list = rows(inspect(ctxFor()));
  assert.deepEqual(list.map((r) => r.index), list.map((_, i) => i + 1));
});

test('every row carries a kind the action table knows', () => {
  const kinds = new Set(['agent', 'window', 'run', 'sweep', 'live-run']);
  for (const row of rows(inspect(ctxFor()))) {
    assert.ok(kinds.has(row.kind), `unknown row kind ${row.kind}`);
  }
});

test('every row ref is unique, because an edit addresses one', () => {
  const refs = rows(inspect(ctxFor())).map((r) => r.ref);
  assert.equal(new Set(refs).size, refs.length);
});

test('render numbers each row exactly as rows() does', () => {
  // config-menu.mjs:313 records why: two orderings agree until someone reorders a
  // section, and then `6 off` acts on a different row than the one printed as 6.
  const state = inspect(ctxFor());
  const lines = render(state).join('\n');
  for (const row of rows(state)) {
    const shown = String(row.index).padStart(2);
    assert.ok(lines.includes(`${shown}  `), `row ${row.index} (${row.ref}) is not on the screen`);
  }
});

// ---------------------------------------------------------------------------
// render — the two facts that must not read as "switched off"
// ---------------------------------------------------------------------------

test('render returns lines and prints nothing', () => {
  const lines = render(inspect(ctxFor()));
  assert.ok(Array.isArray(lines));
  assert.ok(lines.every((l) => typeof l === 'string'));
});

/** The STATE cell of an agent's own row, by column position rather than by
 *  guessing at its spelling. */
function stateCell(lines, id) {
  const header = lines.find((l) => l.includes('STATE') && l.includes('TRIGGER'));
  const row = lines.find((l) => new RegExp(`^\\s+\\d+\\s+${id}\\s`).test(l));
  return row.slice(header.indexOf('STATE'), header.indexOf('TRIGGER')).trim();
}

test('an agent whose trigger cannot fire has a different STATE cell from one merely switched off', () => {
  // Asserted on the STATE CELL, not on the whole screen.
  //
  // The first version of this test compared the two rendered screens and asserted
  // they differed. It passed with the distinction deleted — the screens still
  // differ, because the `unmet:` detail lines survive — so the mutant that
  // collapses `CANNOT FIRE` into `off` walked straight through the one test
  // written to catch it, and was caught incidentally by an alignment assertion.
  // A test that a mutation survives is decorative.
  const blocked = render(inspect(ctxFor(NO_BOARD_LINE)));
  const ready = render(inspect(ctxFor(PROJECTS_LINE)));

  // Both are switched off. The ONLY difference is whether the trigger can fire.
  assert.equal(stateCell(ready, 'fixer'), 'off');
  assert.notEqual(stateCell(blocked, 'fixer'), 'off');
  assert.notEqual(stateCell(blocked, 'fixer'), stateCell(ready, 'fixer'));
});

test('the blocked state says so in words an owner can act on', () => {
  const blocked = render(inspect(ctxFor(NO_BOARD_LINE)));
  assert.match(stateCell(blocked, 'fixer'), /cannot fire/i);
});

test('the screen names the owner act for every unmet precondition', () => {
  // The act, not just the fact. An owner told only `CANNOT FIRE` learns nothing
  // about what to do next — and until 2026-09-04 the act this screen printed was
  // one that could not close the precondition it was attached to, which is worse
  // than silence because it gets followed.
  const screen = render(inspect(ctxFor(NO_BOARD_LINE))).join('\n');
  assert.match(screen, /ROADMAP\.md/);
  assert.match(screen, /agent:delegated/);
});

test('the screen says the hunter has no doctrine written yet', () => {
  const screen = render(inspect(ctxFor())).join('\n');
  const hunterLine = screen.split('\n').find((l) => l.includes('hunter'));
  assert.ok(hunterLine, 'the hunter is not on the screen at all');
  assert.match(screen, /no skill|not written|skill: no/i);
});

test('the screen reports an undeclared sweep as not registered, and asks Windows nothing', () => {
  // A query with no record behind it reports on a task this machine never
  // created — the object `unregisterSweep` refuses to touch, for CLAUDE.md #5's
  // reason. The seam counts calls so "did not ask" is asserted rather than
  // assumed.
  const asked = [];
  const screen = render(inspect({
    ...ctxFor(),
    schtasks: (args) => { asked.push(args); return { status: 0, stdout: '', stderr: '', error: null }; },
  })).join('\n');
  assert.match(screen, /sweep/i);
  assert.match(screen, /\bnot registered\b/i);
  assert.deepEqual(asked, [], 'the screen queried Windows about a task nothing declared');
});

/** A declared sweep in a fixture home, with `schtasks` replaced by a stub.
 *
 *  **Never the real `schtasks`.** `tests/agent-sweep-schtasks.test.mjs` is in
 *  `#231 (FORGE-301)`'s flaky class precisely because it measures the
 *  machine-global task namespace, and `#275 (FORGE-336)` AC 3 says anything added
 *  here must not join it. The seam is what keeps this file deterministic on
 *  Windows and on Linux CI alike. */
const declaredSweep = (schtasks) => {
  const home = freshHome();
  mkdirSync(join(home, '.daftplate', 'agents'), { recursive: true });
  writeFileSync(sweepStatePath({ homeDir: home }), JSON.stringify({
    kind: 'daftplate.agent.sweep/1', registered: true, taskName: 'daftplate\\sweep',
    repoRoot: 'X:\\repo',
  }));
  const state = inspect({ ...ctxFor(LINEAR_LINE, home), schtasks });
  assert.equal(state.sweep.declared, true, 'the fixture did not actually declare the sweep');
  return state;
};

test('a declared sweep Windows really holds renders as registered, naming no phase', () => {
  // `#275 (FORGE-336)`. This line used to read "declared, not verified — Phase 5
  // verifies against Windows". Phase 5 shipped without adding the query, so the
  // screen deferred a fact to a phase that had already landed.
  //
  // MUTANT: return `verified: null` unconditionally from `inspect`. This test
  // and the two below all go red; the undeclared one above stays green, which is
  // why it is not the assertion that matters here.
  // The `/TR` string a real `/Query /FO LIST /V` returns is the one `/Create` was
  // given, byte for byte — measured on this box 2026-09-03. Built here through
  // `buildRegisterArgs` rather than typed out, because a literal would encode
  // this machine's node path and this checkout's location into an assertion
  // about agreement.
  const declaredArgs = buildRegisterArgs({
    repoRoot: 'X:\\repo',
    script: fileURLToPath(new URL('../scripts/agent-sweep.mjs', import.meta.url)),
  });
  const tr = declaredArgs[declaredArgs.indexOf('/TR') + 1];
  const state = declaredSweep((args) => {
    assert.equal(args[0], '/Query', 'the screen ran some other schtasks verb while rendering');
    return {
      status: 0, stderr: '', error: null,
      stdout: `TaskName:  \\daftplate\\sweep\r\nTask To Run:  ${tr}\r\n`,
    };
  });
  const screen = render(state).join('\n');

  assert.doesNotMatch(screen, /phase 5/i, 'the screen still names a phase as the future source of a fact');
  assert.doesNotMatch(screen, /\bnot registered\b/i, 'a declared sweep must not also read as unregistered');
  assert.match(screen, /sweep task\s+registered/i);
});

test('a task the state file claims and Windows does not have renders as gone, not as registered', () => {
  // Measured 2026-09-03: an absent task name exits 1 with `ERROR: The system
  // cannot find the file specified.` A boolean `verified` cannot tell this from
  // "we could not ask", which is the next test.
  const state = declaredSweep(() => ({
    status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.', error: null,
  }));
  const screen = render(state).join('\n');
  assert.match(screen, /DECLARED, GONE/);
  assert.match(screen, /re-register it here rather than by hand/);
});

test('a machine that cannot run schtasks renders as unverified rather than as absent', () => {
  // Linux CI is this case, every run. Reporting it as "gone" would tell a reader
  // their Windows task had been deleted by something that never looked.
  const state = declaredSweep(() => ({
    status: null, stdout: '', stderr: '', error: new Error('spawnSync schtasks ENOENT'),
  }));
  const screen = render(state).join('\n');
  assert.match(screen, /declared, unverified/i);
  assert.match(screen, /could not ask Windows — .*ENOENT/);
  assert.doesNotMatch(screen, /DECLARED, GONE/, 'a machine that could not ask reported the task absent');
});

test('a task that exists but runs something else renders the disagreement, with both sides', () => {
  // The state a boolean cannot express, and the one a moved checkout produces.
  const state = declaredSweep(() => ({
    status: 0, stderr: '', error: null,
    stdout: 'Task To Run:  "node" "Y:\\old-checkout\\scripts\\agent-sweep.mjs" "Y:\\old-checkout"\r\n',
  }));
  const screen = render(state).join('\n');
  assert.match(screen, /DISAGREES/);
  assert.match(screen, /Windows:\s+"node" "Y:\\old-checkout/, 'the screen hid what Windows actually holds');
  assert.match(screen, /declared:\s+".*agent-sweep\.mjs"/, 'the screen hid what this checkout declares');
});

test('every column header lands on the column it names', () => {
  // Found by looking at the screen rather than by a test: the first version
  // printed `STATE TRIGGER SKILL` at positions that matched no data column, and
  // `sweep tasknot registered` ran together because the name width was exactly
  // the width of its longest value. Both passed every assertion in this file.
  const lines = render(inspect(ctxFor(NO_BOARD_LINE)));
  const header = lines.find((l) => l.includes('STATE') && l.includes('TRIGGER'));
  const fixerRow = lines.find((l) => /^\s+\d+\s+fixer\s/.test(l));
  assert.ok(header && fixerRow);

  // The state cell starts where the STATE header starts, and the trigger kind
  // starts where TRIGGER starts. Positions, not spellings.
  assert.equal(fixerRow.indexOf('CANNOT FIRE'), header.indexOf('STATE'));
  assert.equal(fixerRow.indexOf('board-poll'), header.indexOf('TRIGGER'));
});

test('no rendered cell runs into the one after it', () => {
  // The `sweep tasknot registered` failure: a column width equal to its longest
  // value leaves no gap at all.
  for (const line of render(inspect(ctxFor()))) {
    assert.doesNotMatch(line, /[a-z]{2}(not registered|attached|none —)/,
      `two cells have collided: ${line}`);
  }
});

test('render is deterministic for one state', () => {
  const state = inspect(ctxFor());
  assert.deepEqual(render(state), render(state));
});

test('a registry that does not validate is reported on the screen', () => {
  // The menu is the only place a human sees the registry. A broken entry that
  // rendered as a normal row would be a row whose actions all fail later.
  const state = inspect(ctxFor());
  assert.ok(Array.isArray(state.registryViolations));
  assert.deepEqual(state.registryViolations, [], 'the real registry should validate');
});

test('a registry violation actually reaches the printed screen, not just the state object', () => {
  // The test above only ever exercises the real, valid registry — it asserts
  // `registryViolations` is empty and never calls render() at all, so a render()
  // that silently dropped the violations block would still pass it. Fabricating
  // one here is the only way to see the block on screen at all.
  const state = inspect(ctxFor());
  state.registryViolations = [{
    rule: 'agent-unqualified', path: 'agent:probe', message: 'a fabricated violation for this test',
  }];
  const screen = render(state).join('\n');
  assert.match(screen, /agent-unqualified/);
  assert.match(screen, /agent:probe/);
  assert.match(screen, /a fabricated violation for this test/);
});

// ---------------------------------------------------------------------------
// Live runs — inspect() has to find them through the homeDir it was given,
// and render() has to show them without a column collision
// ---------------------------------------------------------------------------

/** Where `openRunRecord` (and `inspect()`, once fixed) look for run records
 *  under a fixture home, mirroring `worktree.mjs`'s own default of
 *  `~/.daftplate/runs` with `homeDir` standing in for the real machine home. */
const runsDirFor = (home) => join(home, '.daftplate', 'runs');

test('inspect finds a live run through the homeDir it was given', () => {
  // `listRunRecords` defaults to the real machine's `~/.daftplate/runs` when no
  // `runsDir` is supplied. `inspect()` accepts a `homeDir` precisely so a test
  // can point every surface at a fixture and never reach the developer's real
  // `$HOME` — the same G5 guarantee `config-menu.mjs`'s `inspect()` documents —
  // and a run-record read that ignored it would be the one surface that broke
  // that guarantee silently, since a fixture repoRoot's unique key means the
  // real `~/.daftplate/runs/` simply has nothing to find rather than erroring.
  const home = freshHome();
  const ctx = ctxFor(LINEAR_LINE, home);
  const opened = openRunRecord(
    { repoRoot: ctx.repoRoot, runId: 'fixer-1-20260828T200000Z', issue: 1 },
    { runsDir: runsDirFor(home), agent: 'fixer' },
  );
  assert.equal(opened.ok, true, opened.message);

  const state = inspect(ctx);
  assert.equal(state.liveRuns.length, 1);
  const fixer = state.agents.find((a) => a.id === 'fixer');
  assert.equal(fixer.runs.live, 1);
});

test('a live run is a row on the screen, and its AGENT column lands where the header says', () => {
  // Found by rendering the screen and reading it, the same way the alignment
  // bugs this file's other tests guard against were found: the first version
  // printed `LIVE RUNS (1)AGENT` because the header went through `head()` at
  // `NAME_W` while the row below it was hand-spaced at an unrelated width, and
  // nothing forced the two to agree.
  const home = freshHome();
  const ctx = ctxFor(LINEAR_LINE, home);
  openRunRecord(
    { repoRoot: ctx.repoRoot, runId: 'fixer-1-20260828T200000Z', issue: 1 },
    { runsDir: runsDirFor(home), agent: 'fixer' },
  );

  const state = inspect(ctx);
  const runRow = rows(state).find((r) => r.kind === 'live-run');
  assert.ok(runRow, 'the live run is not a row at all');

  const lines = render(state);
  const header = lines.find((l) => l.includes('LIVE RUNS') && l.includes('AGENT'));
  const dataLine = lines.find((l) => l.includes(runRow.run.runId));
  assert.ok(header && dataLine, 'the live run never reaches the screen');

  assert.doesNotMatch(header, /\)AGENT/, 'the section header ran into its own AGENT column');
  // Position, not spelling, per this file's own convention: the AGENT value
  // starts at the same column the header's AGENT label does.
  const at = header.indexOf('AGENT');
  assert.equal(dataLine.slice(at, at + 'fixer'.length), 'fixer');
  assert.equal(dataLine.indexOf('#1'), header.indexOf('ISSUE'));
});

test('a run id longer than the column width still leaves a gap before AGENT', () => {
  // The general form of the same bug: any value that reaches or passes its
  // column's width, not only the one length that was measured by hand.
  const home = freshHome();
  const ctx = ctxFor(LINEAR_LINE, home);
  const longRunId = 'fixer-999999999999999999-20260828T200000Z';
  openRunRecord(
    { repoRoot: ctx.repoRoot, runId: longRunId, issue: 1 },
    { runsDir: runsDirFor(home), agent: 'fixer' },
  );

  const dataLine = render(inspect(ctx)).find((l) => l.includes(longRunId));
  assert.ok(dataLine, 'the long-id run never reaches the screen');
  assert.ok(dataLine.includes(`${longRunId} `), 'the run id ran straight into the AGENT column with no gap');
});

// --- the plugin install, and the machine still mid-migration ----------------

test('an agent skill installed inside the plugin tree reads as installed', () => {
  // ADR 0002 as amended 2026-09-02: daftplate installs one tree at
  // ~/.claude/skills/daftplate/ instead of 22 sibling directories. A screen that
  // only knew the old shape would report every agent's skill missing the moment
  // the owner finished migrating, and the fix for that reads as "reinstall",
  // which would not help.
  const home = emptyDir();
  mkdirSync(join(home, '.claude', 'skills', 'daftplate', 'skills', 'agent-fixer'), { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'daftplate', 'skills', 'agent-fixer', 'SKILL.md'),
    '---\nname: agent-fixer\n---\n', 'utf8');

  const byId = Object.fromEntries(inspect(ctxFor(LINEAR_LINE, home)).agents.map((a) => [a.id, a]));
  assert.equal(byId.fixer.skillInstalled, true);
});

test('the loose copy still reads as installed while the migration is half-done', () => {
  // The installer never deletes, so the loose directory survives until the owner
  // removes it. Both shapes are live on real machines and both must answer yes.
  const home = emptyDir();
  mkdirSync(join(home, '.claude', 'skills', 'agent-fixer'), { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'agent-fixer', 'SKILL.md'), '---\nname: agent-fixer\n---\n', 'utf8');

  const byId = Object.fromEntries(inspect(ctxFor(LINEAR_LINE, home)).agents.map((a) => [a.id, a]));
  assert.equal(byId.fixer.skillInstalled, true);
});

test('a directory with no SKILL.md in it is not an installed skill', () => {
  // The old check was a bare existsSync on the directory, so an empty leftover
  // reported the skill as installed.
  const home = emptyDir();
  mkdirSync(join(home, '.claude', 'skills', 'agent-fixer'), { recursive: true });

  const byId = Object.fromEntries(inspect(ctxFor(LINEAR_LINE, home)).agents.map((a) => [a.id, a]));
  assert.equal(byId.fixer.skillInstalled, false);
});
