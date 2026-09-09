#!/usr/bin/env node
// `/daft-agent` — one screen for every agent in this repository, and the only
// place any of them is triggered, scheduled or switched on.
//
// Phase 3 of docs/designs/2026-08-28-plan-daft-agent.md, for `#204 (FORGE-265)`.
// It renders; it edits nothing. `planEdits` and `applyEdits` are Phase 4 and the
// enablement act arrives with them, because that act is ADR 0008's owner-held one
// and it deserves a review of its own rather than the end of a long menu diff.
//
// **The shape is `scripts/config-menu.mjs`'s and is deliberately not a second
// menu system.** `inspect` measures, `rows` produces ONE ordering, `render` turns
// state into lines and prints nothing. Where that file's comments already give a
// reason — chiefly `config-menu.mjs:313` on why two orderings is the bug — the
// anchor is cited rather than the argument repeated.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { runCli } from './lib/cli.mjs';
import { writeAtomically } from './lib/atomic-write.mjs';
import { conditionsSnapshot, runAuthorization } from './lib/enablement.mjs';
import { installedSkillDir } from './install-skills.mjs';
import {
  ENABLEMENT_KIND, agentStatePath, sweepStatePath,
  readJournalTail, journalSummary, JOURNAL_EVENTS,
} from './lib/agent-state.mjs';
import {
  registerSweep, unregisterSweep, verifySweep, SWEEP_TASK_NAME, SWEEP_VERIFY, TICK_MINUTES,
} from './agent-sweep.mjs';
import { AGENTS, PRECONDITION_TESTS, validateRegistry, agentSkillPresent } from './lib/agent-registry.mjs';
import { readBoard } from './agent-fixer.mjs';
import { listRunRecords, RUN_STATES } from './lib/run-record.mjs';

// Moved to `lib/agent-state.mjs` in Phase 5: the sweeper needs them too, and
// having it import them from here while this file imports its registration
// functions is a cycle. Re-exported so a reader of the menu still finds where its
// state lives without a second hop.
export { ENABLEMENT_KIND, agentStatePath, sweepStatePath };

/** Read one JSON surface, keeping the three outcomes apart: absent, present and
 *  readable, present and not. `config-menu.mjs`'s `readJsonSurface` does the same
 *  for the same reason — "absent" and "unparseable" are different facts and a
 *  menu that merged them would report a broken file as a clean default. */
function readState(path) {
  if (!existsSync(path)) return { present: false, readable: true, data: null };
  try {
    return { present: true, readable: true, data: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { present: true, readable: false, data: null, error: error.message };
  }
}

/** Whether this agent's skill is installed where ADR 0002 installs skills —
 *  either shape. Since the 2026-09-02 amendment that is one plugin tree at
 *  `~/.claude/skills/daftplate/`, but the loose per-skill directory survives
 *  until the owner removes it, and this screen must not report an agent as
 *  uninstalled on either side of that. */
function skillInstalled(id, homeDir) {
  return installedSkillDir(join(homeDir, '.claude', 'skills'), `agent-${id}`) !== null;
}

/**
 * The whole screen's state: every registry entry measured against reality.
 *
 * Pure. It stats and reads; it creates nothing, not even the directory its own
 * state files live in. A menu that wrote while rendering would make `--render` a
 * mutation and leave `--plan` unable to claim purity in Phase 4.
 */
export function inspect({
  repoRoot, checkoutRoot = repoRoot, homeDir = homedir(), now = new Date(), schtasks = undefined,
  conditions = undefined,
} = {}) {
  // The tick history, read once for the whole screen rather than once per agent:
  // two reads of a file the sweeper appends to could disagree with each other.
  const journal = readJournalTail({ homeDir, at: now });
  // Read once, not once per precondition: two evaluators asking the filesystem
  // the same question could get two answers on a repo being edited underneath.
  const board = readBoard(repoRoot);
  // `runsDir` is threaded from the injected `homeDir`, not left to
  // `worktree.mjs`'s own default of `homedir()`. Without it this is the one read
  // in `inspect()` that ignores the `homeDir` a caller supplied — every other
  // surface (`agentStatePath`, `sweepStatePath`, `skillInstalled`) resolves under
  // it, so a test pointing `homeDir` at a fixture would still have this one
  // silently reach the real machine's `~/.daftplate/runs/`, which is exactly the
  // hazard `config-menu.mjs`'s `inspect()` is written against (G5).
  const records = listRunRecords(repoRoot, { runsDir: join(homeDir, '.daftplate', 'runs') });

  const agents = AGENTS.map((entry) => {
    const surface = readState(agentStatePath(entry.id, { homeDir }));
    const data = surface.data ?? {};
    const mine = records.filter((r) => r.agent === entry.id);

    const preconditions = entry.trigger.preconditions.map((pre) => {
      const evaluate = PRECONDITION_TESTS[pre.test];
      // A precondition naming an evaluator that does not exist is a registry
      // fault, already reported by validateRegistry. Here it renders as unmet
      // rather than throwing, because one bad entry must not blank the screen.
      const result = evaluate ? evaluate({ board, repoRoot, homeDir }) : { met: false, detail: `no evaluator \`${pre.test}\`` };
      return { ...pre, met: result.met, detail: result.detail };
    });

    return {
      id: entry.id,
      summary: entry.summary,
      script: entry.script,
      skill: entry.skill,
      gate: entry.gate,
      unattended: entry.unattended,
      scriptPresent: existsSync(join(checkoutRoot, entry.script)),
      skillPresent: agentSkillPresent(entry, checkoutRoot),
      skillInstalled: skillInstalled(entry.id, homeDir),
      readable: surface.readable,
      ...(surface.error ? { error: surface.error } : {}),
      enabled: surface.readable ? data.enabled === true : false,
      enablement: surface.readable && surface.present ? data : null,
      acknowledgedOpen: surface.readable ? (data.acknowledgedOpen ?? 0) : 0,
      // Asked rather than re-derived. The screen used to compute `ON` from
      // `enabled` alone and disagreed with what both runners would actually do.
      //
      // `conditions` is threaded for the reason `runAuthorization` declares its own
      // seam, with the case inverted. That seam existed so the *permitted* case was
      // reachable while ADR 0008's second condition stood open. Both conditions are
      // closed as of 2026-09-04, so the unreachable case is now `HELD` — an agent
      // switched on over an open condition — and the state cell, the acknowledgement
      // count and the plan text for it would otherwise be asserted by nothing.
      // Undefined here means the real constant — `runAuthorization` defaults on
      // `undefined`, so omitting the option cannot soften the gate.
      //
      // **No test distinguishes that from a permissive default today, and it is an
      // equivalent mutant rather than a gap.** With both conditions closed, an empty
      // set and the real constant give the same `mayRun` for every input, so
      // substituting one for the other kills nothing. It stops being equivalent the
      // day any condition reopens, which is the day this line starts carrying
      // weight — measured 2026-09-04 rather than assumed.
      mayRun: runAuthorization({ agentId: entry.id, homeDir }, { conditions }).mayRun,
      journal: journalSummary(journal, entry.id),
      window: surface.readable ? (data.window ?? null) : null,
      trigger: { kind: entry.trigger.kind, preconditions },
      triggerReady: preconditions.every((p) => p.met),
      runs: {
        total: mine.length,
        live: mine.filter((r) => r.state === RUN_STATES.RUNNING).length,
      },
    };
  });

  const sweep = readState(sweepStatePath({ homeDir }));
  const declared = sweep.data?.registered === true;
  // Asked, not deferred. `#275 (FORGE-336)`: this used to be a hard-coded
  // `verified: null` pointing at a phase that had already shipped without adding
  // the query. Only asked when the state file claims a task — a query with no
  // record behind it reports on something this machine never created, which is
  // the object `unregisterSweep` refuses to touch for CLAUDE.md #5's reason.
  const verified = declared ? verifySweep({ homeDir }, { schtasks }) : null;
  return {
    repoRoot,
    // Carried so `planRun` and `planLiveRun` can compose absolute paths. The
    // commands they hand back name a script in the CHECKOUT and a repository to
    // work on, and those are two different directories the moment anyone runs
    // the menu from anywhere but the checkout root.
    checkoutRoot,
    board: board.ok ? { variant: board.variant, team: board.team } : { variant: null, reason: board.reason },
    agents,
    sweep: { declared, verified, readable: sweep.readable },
    journal: { entries: journal.length, lastTick: journal.at(-1)?.at ?? null },
    registryViolations: validateRegistry(AGENTS, { repoRoot: checkoutRoot }),
    liveRuns: records.filter((r) => r.state === RUN_STATES.RUNNING),
  };
}

// --- rows -------------------------------------------------------------------

/**
 * Every actionable row, in screen order, numbered from 1.
 *
 * ONE ordering, consumed by both `render()` and — in Phase 4 — `planEdits()`.
 * `config-menu.mjs:313` records why numbering inside render() and resolving edits
 * separately is the bug, and that reasoning is cited rather than restated.
 */
export function rows(state) {
  const out = [];
  const push = (ref, row) => out.push({ index: out.length + 1, ref, ...row });

  for (const agent of state.agents) {
    push(`agent:${agent.id}`, { kind: 'agent', name: agent.id, agent });
    push(`window:${agent.id}`, { kind: 'window', name: agent.id, agent });
    push(`run:${agent.id}`, { kind: 'run', name: agent.id, agent });
  }
  push('sweep', { kind: 'sweep', name: 'sweep', sweep: state.sweep });
  for (const run of state.liveRuns) {
    push(`live-run:${run.runId}`, { kind: 'live-run', name: run.runId, run });
  }
  return out;
}

// --- render -----------------------------------------------------------------

// A value at or past its column's width still gets a trailing space, never a
// bare `padEnd` that leaves it flush against the next cell. `NAME_W`'s own
// comment records the failure this guards: a width that fits its longest value
// with no gap is a width that produces `sweep tasknot registered` — and a
// column whose value simply has no fixed bound (a live run's id, an owner act
// sentence) hits the same collision the moment it is long enough, not just when
// it is exactly as long as the header's worst case.
const pad = (text, width) => {
  const value = String(text);
  return value.length >= width ? `${value} ` : value.padEnd(width);
};

/**
 * One place for the column geometry, for `config-menu.mjs`'s reason: the ad-hoc
 * spacing the first draft used drifted the moment a value got longer.
 *
 * `NAME_W` is 12 rather than 10 because "sweep task" is exactly 10 and ran
 * straight into the column after it — a width that fits its longest value with no
 * gap is a width that produces `sweep tasknot registered`.
 */
const GUTTER = '      '; // the width of "  NN  ", so continuation lines hang correctly
const NAME_W = 12;
const STATE_W = 13;
const KIND_W = 13;
const SKILL_W = 15;

// The LIVE RUNS section's own two columns. Not `head()`'s [STATE_W, KIND_W,
// SKILL_W] — those are sized for short enum-like values ("off", "board-poll"),
// and a run id (`fixer-205-20260829T002300Z`) is neither short nor bounded by
// any of them. Named here so the header and the row that must line up under it
// share one value instead of two literals that can drift apart, which is
// exactly how `LIVE RUNS (1)AGENT` happened: the header went through `head()`
// at `NAME_W`, the row was hand-spaced at a width nothing else on the screen
// used, and nothing forced the two to agree.
const RUN_ID_W = 28;
const RUN_AGENT_W = 10;

/** A header whose columns land on the same characters the data does. Built from
 *  the same widths rather than from spaces counted by eye, which is what let the
 *  first version print headers that named the wrong columns. */
const head = (label, columns = []) => {
  // The label occupies NAME_W, so the COLUMN widths start after it. Indexing this
  // array from zero for the first column was an off-by-one that put every header
  // after STATE one character left of the data it named — invisible by eye,
  // caught by asserting positions rather than spellings.
  const widths = [STATE_W, KIND_W, SKILL_W];
  const cells = columns.map((c, i) => pad(c, widths[i] ?? 0));
  return `${GUTTER}${pad(label, NAME_W)}${cells.join('')}`.trimEnd();
};

/** How an agent's trigger stands, in one column.
 *
 *  **`blocked` is not `off`, and keeping them apart is this phase's whole job.**
 *  An agent that is off can be switched on and will then run. One whose trigger
 *  cannot fire will do nothing when switched on, because the thing it waits for
 *  does not exist on this board — and a screen that showed both as `off` would be
 *  telling an owner to try a toggle that changes nothing. */
function triggerCell(agent) {
  if (!agent.triggerReady) return 'CANNOT FIRE';
  // **`HELD` is not `ON`, and that is `#194 (FORGE-260)` Phase 3's whole job on
  // this screen.** An agent an owner has switched on, over a still-open ADR 0008
  // condition, will not run: the sweeper refuses it and the runtime refuses it.
  // Rendering that as `ON` told the owner the opposite of what the machine would
  // do, and it was the only one of the three surfaces they actually look at.
  if (agent.enabled && !agent.mayRun) return 'HELD';
  return agent.enabled ? 'ON ' : 'off';
}

/** How the one sweep task stands, in one cell.
 *
 *  Four answers, not two. A machine that never registered one and a machine
 *  whose task somebody deleted by hand are different situations with different
 *  next actions, and so is a machine that cannot be asked at all. */
function sweepCell(sweep) {
  if (!sweep.declared) return 'not registered';
  switch (sweep.verified?.state) {
    case SWEEP_VERIFY.REGISTERED: return 'registered';
    case SWEEP_VERIFY.ABSENT: return 'DECLARED, GONE';
    case SWEEP_VERIFY.MISMATCH: return 'DISAGREES';
    default: return 'declared, unverified';
  }
}

/** What the cell above could not fit. A disagreement is only actionable if the
 *  operator can see both sides of it, and "we could not ask" is only honest if
 *  it says why not. */
function sweepDetail(sweep) {
  const v = sweep.verified;
  if (!sweep.declared || !v) return [];
  switch (v.state) {
    case SWEEP_VERIFY.REGISTERED:
      return [`Windows holds \`${v.taskName}\` and it runs what this checkout declares`];
    case SWEEP_VERIFY.ABSENT:
      return [`this machine recorded registering \`${v.taskName}\`, and Windows does not have it — ${v.message}`,
        '  it was removed outside this menu; re-register it here rather than by hand'];
    case SWEEP_VERIFY.MISMATCH:
      return [`\`${v.taskName}\` exists and runs something else`,
        `  Windows:  ${v.found}`, `  declared: ${v.declared}`];
    default:
      return [`could not ask Windows — ${v.message}`];
  }
}

export function render(state) {
  const lines = [];
  const numbers = new Map(rows(state).map((row) => [row.ref, row.index]));
  const num = (ref) => String(numbers.get(ref)).padStart(2);

  const board = state.board.variant ?? `unknown (${state.board.reason})`;
  lines.push(`/daft-agent${' '.repeat(30)}board: ${board}`);
  lines.push('');

  lines.push(head('AGENTS', ['STATE', 'TRIGGER', 'SKILL', 'RUNS']));
  for (const agent of state.agents) {
    const skill = agent.skillPresent ? (agent.skillInstalled ? 'yes' : 'not installed') : 'no skill yet';
    const runs = agent.runs.live ? `${agent.runs.live} live` : `${agent.runs.total}`;
    lines.push(`  ${num(`agent:${agent.id}`)}  ${pad(agent.id, NAME_W)}${pad(triggerCell(agent), STATE_W)}${pad(agent.trigger.kind, KIND_W)}${pad(skill, SKILL_W)}${runs}`);
    lines.push(`${GUTTER}${pad('', NAME_W)}${agent.summary}`);

    if (!agent.readable) {
      // Named, not swallowed. An unreadable state file is the one thing here the
      // menu cannot act on, and rendering it as `off` would tell an owner their
      // agent is safely disabled when nothing actually knows that.
      lines.push(`${GUTTER}! state file could not be parsed — ${agent.error}`);
    }
    if (agent.acknowledgedOpen > 0) {
      lines.push(`${GUTTER}enabled over ${agent.acknowledgedOpen} open enablement condition(s)`);
    }
    for (const pre of agent.trigger.preconditions.filter((p) => !p.met)) {
      lines.push(`${GUTTER}unmet: ${pre.unmetMessage}`);
      lines.push(`${GUTTER}  to close it — ${pre.ownerAct}`);
    }

    const window = agent.window
      ? `${agent.window.days.join(',')} ${agent.window.from}–${agent.window.to}`
      : 'none — run-now only';
    lines.push(`  ${num(`window:${agent.id}`)}  ${pad('window', NAME_W)}${window}`);
    lines.push(`  ${num(`run:${agent.id}`)}  ${pad('run now', NAME_W)}attached to this terminal`);
    lines.push('');
  }

  lines.push(head('SCHEDULE', ['STATE']));
  // The state file says what this machine recorded doing; `verifySweep` says what
  // Windows actually holds. Both are printed, because the interesting case is
  // where they disagree — and neither substitutes for the other. `#275
  // (FORGE-336)`: this line used to name a phase as the future source of the
  // second half, and that phase had already shipped without it.
  lines.push(`  ${num('sweep')}  ${pad('sweep task', NAME_W)}${sweepCell(state.sweep)}`);
  for (const detail of sweepDetail(state.sweep)) lines.push(`${GUTTER}${detail}`);

  if (state.liveRuns.length) {
    lines.push('');
    // Built from RUN_ID_W / RUN_AGENT_W directly rather than through `head()`,
    // which would size these columns off STATE_W/KIND_W — widths chosen for
    // "off" and "board-poll", not for a run id.
    lines.push(`${GUTTER}${pad(`LIVE RUNS (${state.liveRuns.length})`, RUN_ID_W)}${pad('AGENT', RUN_AGENT_W)}ISSUE`);
    for (const run of state.liveRuns) {
      lines.push(`  ${num(`live-run:${run.runId}`)}  ${pad(run.runId, RUN_ID_W)}${pad(run.agent, RUN_AGENT_W)}#${run.issue?.number ?? '?'}`);
    }
  }

  // --- LAST SWEEP -----------------------------------------------------------
  //
  // `#194 (FORGE-260)` Phase 4. Until this block, the sweeper printed its outcomes
  // to a console Task Scheduler discards, so a month of ticks that started nothing
  // looked exactly like a month nobody ran — and a *skipped* agent left no trace
  // on disk at all. This is the screen that reads what the tick wrote.
  lines.push('');
  lines.push(head('LAST SWEEP', ['WHEN', 'OUTCOME']));
  if (!state.journal.lastTick) {
    lines.push(`${GUTTER}no tick recorded — the sweeper has not run on this machine this month`);
  } else {
    lines.push(`${GUTTER}last tick ${state.journal.lastTick} · ${state.journal.entries} line(s) read`);
    for (const agent of state.agents) {
      const j = agent.journal;
      if (!j.last) {
        lines.push(`${GUTTER}${pad(agent.id, NAME_W)}no tick recorded for this agent`);
        continue;
      }
      // The un-terminated case gets its own words rather than being rendered as
      // whatever the last event happened to be. "started, no outcome recorded" is
      // the honest description of a run the sweeper launched and nothing ever
      // reported on — a SIGKILL looks exactly like this and nothing else does.
      const outcome = j.startedWithNoOutcome
        ? 'started, no outcome recorded'
        : j.last.event === JOURNAL_EVENTS.ENDED
          ? (j.last.code === 0 ? 'ended, exit 0' : `ended, failed (exit ${j.last.code})`)
          : j.last.event === JOURNAL_EVENTS.SPAWN_FAILED
            ? `did not launch — ${j.last.reason}`
            : `skipped — ${j.last.reason ?? 'no reason recorded'}`;
      lines.push(`${GUTTER}${pad(agent.id, NAME_W)}${pad(j.last.at, 26)}${outcome}`);
      if (j.consecutiveFailures > 0) {
        lines.push(`${GUTTER}${pad('', NAME_W)}${j.consecutiveFailures} consecutive failure(s)`);
      }
    }
  }

  if (state.registryViolations.length) {
    lines.push('');
    for (const v of state.registryViolations) {
      lines.push(`  ! ${v.rule}: ${v.path} — ${v.message}`);
    }
  }

  return lines;
}

// --- plan and apply ---------------------------------------------------------

/**
 * What each row kind takes.
 *
 * `sweep` lists its verbs so they can be **refused with a reason** rather than
 * routed to the generic "not editable here" branch, which names neither the phase
 * that builds them nor why they are absent. `config-menu.mjs:466` records the
 * same choice, and the measurement behind it: leaving a verb off the list made
 * the refusal come from a branch that had never been reached.
 */
const ACTIONS_BY_KIND = {
  agent: ['on', 'off'],
  window: ['set', 'clear'],
  run: ['now'],
  sweep: ['register', 'unregister'],
  'live-run': ['stop', 'release'],
};

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const outcome = (edit, verdict, reason, extra = {}) => ({ ...edit, verdict, reason, ...extra });

/**
 * What each edit would do, and why. Pure — writes nothing, ever, which is what
 * makes `--plan` and `--apply` incapable of disagreeing: apply calls this and
 * executes only what came back as `apply`.
 *
 * A refusal never aborts the rest of the set. One bad index in a batch of six is
 * a fact about that index, and discarding the other five would make the menu
 * punish a typo.
 */
export function planEdits(state, edits, ctx = {}) {
  const byIndex = new Map(rows(state).map((row) => [row.index, row]));

  return edits.map((edit) => {
    const row = byIndex.get(edit.index);
    // Never guessed. An index off the screen usually means a stale screen, and
    // acting on the nearest row would act on something the user never saw.
    if (!row) {
      return outcome(edit, 'refuse', `no row ${edit.index} on the current screen — re-render before editing`);
    }

    const allowed = ACTIONS_BY_KIND[row.kind] ?? [];
    if (!allowed.includes(edit.action)) {
      return outcome(edit, 'refuse',
        `row ${edit.index} is a ${row.kind}; it takes ${allowed.join(' | ') || 'nothing'}, not "${edit.action}"`,
        { target: row.ref });
    }

    switch (row.kind) {
      case 'agent': return planAgent(row, edit, ctx.conditions);
      case 'window': return planWindow(row, edit);
      case 'run': return planRun(state, row, edit);
      case 'sweep': return planSweep(state, row, edit);
      case 'live-run': return planLiveRun(state, row, edit);
      default: return outcome(edit, 'refuse', `row ${edit.index} is not editable here`, { target: row.ref });
    }
  });
}

/**
 * The enablement act, planned.
 *
 * **The conditions travel with the plan.** `--plan` has to show an owner exactly
 * what `--apply` would make them acknowledge, or the acknowledgement is of
 * something they never saw — which is the blind enablement ADR 0008 was written
 * to prevent. They are carried as a snapshot rather than a reference, so the plan
 * and the record it becomes describe the same moment.
 */
function planAgent(row, edit, conditions = undefined) {
  const { agent } = row;
  if (!agent.readable) {
    // Refused rather than overwritten. That file is the record of a decision an
    // owner made, and a menu that helpfully replaced an unparseable one would be
    // destroying the audit trail it exists to keep.
    return outcome(edit, 'refuse',
      `${agent.id}'s state file could not be parsed, and overwriting it would discard`
      + ` an owner's own record — repair or remove it deliberately (${agent.error})`,
      { target: row.ref });
  }

  const turningOn = edit.action === 'on';
  if (agent.enabled === turningOn) {
    return outcome(edit, 'noop', `${agent.id} is already ${turningOn ? 'on' : 'off'}`, { target: row.ref });
  }

  if (!turningOn) {
    // Switching off is not the gated act, and requiring the ceremony to STOP
    // something is how a person gives up and edits the file by hand.
    return outcome(edit, 'apply', `switch ${agent.id} off`, { target: row.ref, conditions: [] });
  }

  const shown = conditionsSnapshot(conditions);
  const open = shown.filter((c) => !c.closed).length;
  return outcome(edit, 'apply',
    `switch ${agent.id} on — ADR 0008 sets ${shown.length} condition(s) on this,`
    + ` ${open} still open; enabling acknowledges them`,
    { target: row.ref, conditions: shown, acknowledgedOpen: open });
}

function planWindow(row, edit) {
  const { agent } = row;
  if (!agent.readable) {
    return outcome(edit, 'refuse', `${agent.id}'s state file could not be parsed`, { target: row.ref });
  }
  if (edit.action === 'clear') {
    return agent.window
      ? outcome(edit, 'apply', `clear ${agent.id}'s window — run-now only`, { target: row.ref })
      : outcome(edit, 'noop', `${agent.id} has no window`, { target: row.ref });
  }

  // A window on an agent with no unattended driver is a schedule that can never
  // start anything: the sweeper refuses it every tick, for the same reason and in
  // the same words. Refused where the owner asks for it, because a window that is
  // accepted and then silently does nothing is worse than one that is declined —
  // the owner walks away believing the agent is scheduled.
  //
  // `clear` is deliberately still allowed above this. Refusing that too would
  // strand an owner who set a window before this refused one, with no way to
  // remove it through the screen that let them create it.
  if (agent.unattended?.driver === 'none') {
    return outcome(edit, 'refuse',
      `${agent.id} has no unattended driver — a run is invoked by a session, so a window`
      + ' would never start one',
      { target: row.ref });
  }

  const days = Array.isArray(edit.days) ? edit.days : [];
  if (!days.length) return outcome(edit, 'refuse', 'a window needs at least one day', { target: row.ref });
  const unknown = days.filter((d) => !DAYS.includes(d));
  if (unknown.length) {
    return outcome(edit, 'refuse', `unknown day(s) ${unknown.join(', ')} — use ${DAYS.join(', ')}`, { target: row.ref });
  }
  for (const [name, value] of [['from', edit.from], ['to', edit.to]]) {
    if (!TIME.test(String(value ?? ''))) {
      return outcome(edit, 'refuse', `${name} must be a 24-hour time as HH:MM, not "${value}"`, { target: row.ref });
    }
  }
  return outcome(edit, 'apply',
    `set ${agent.id}'s window to ${days.join(',')} ${edit.from}–${edit.to}`,
    { target: row.ref, window: { days, from: edit.from, to: edit.to } });
}

/**
 * Run now — planned as an invocation, never spawned from here.
 *
 * `scripts/agent-hunter.mjs` and `scripts/lib/lenses.mjs` already settled this
 * shape and the reason is theirs: a module that spawned would put the argv safety
 * properties behind a process boundary the suite cannot see, whereas a plan is a
 * value a test can assert over. So the menu hands back the exact command and the
 * human or the skill runs it, in their own terminal — which is what
 * "terminal-attached" means anyway.
 */
function planRun(state, row, edit) {
  const { agent } = row;
  if (!agent.triggerReady) {
    const unmet = agent.trigger.preconditions.filter((p) => !p.met);
    return outcome(edit, 'refuse',
      `${agent.id} cannot run: ${unmet.map((p) => p.unmetMessage).join('; ')}`,
      { target: row.ref, ownerActs: unmet.map((p) => p.ownerAct) });
  }
  return outcome(edit, 'apply', `run ${agent.id} now, attached to this terminal`, {
    target: row.ref,
    // **Two absolute paths, and `.` is neither of them.** This used to be
    // `['node', agent.script, '.']`, which is correct only when the cwd is
    // simultaneously the checkout holding the script and the repository being
    // worked on. Both runners take the repository as a positional and ADR 0008
    // row 2 makes it the security-relevant choice, so handing over a `.` that
    // resolves to wherever the operator is standing is the one mistake this
    // argument must not make. D9.
    command: ['node', join(state.checkoutRoot, agent.script), state.repoRoot],
  });
}

/**
 * Registering and removing the one sweep task.
 *
 * **Registering is refused while no agent has a window**, because the task would
 * then wake every fifteen minutes to decide nothing. That is not a safety
 * property, it is honesty: a machine doing scheduled work with nothing scheduled
 * is a thing an operator should be told about rather than left to discover.
 */
function planSweep(state, row, edit) {
  const scheduled = state.agents.filter((a) => a.window);
  if (edit.action === 'register') {
    if (state.sweep.declared) {
      return outcome(edit, 'noop', `${SWEEP_TASK_NAME} is already registered by this machine`, { target: row.ref });
    }
    if (!scheduled.length) {
      return outcome(edit, 'refuse',
        `no agent has a window, so a ${TICK_MINUTES}-minute task would wake to decide nothing`
        + ' — set a window first',
        { target: row.ref });
    }
    return outcome(edit, 'apply',
      `register ${SWEEP_TASK_NAME}, waking every ${TICK_MINUTES} minutes for`
      + ` ${scheduled.map((a) => a.id).join(', ')}`,
      { target: row.ref, note: 'a task registered without /RU runs while you are logged on; running while logged off was never measured' });
  }

  // CLAUDE.md #5: the state file is the authority, so a task this machine has no
  // record of creating is reported rather than removed.
  if (!state.sweep.declared) {
    return outcome(edit, 'refuse',
      'this machine has no record of registering a sweep task, so there is nothing here it may remove',
      { target: row.ref });
  }
  return outcome(edit, 'apply', `remove ${SWEEP_TASK_NAME}`, { target: row.ref });
}

/**
 * Stopping or releasing a run, as a command the operator runs themselves.
 *
 * **One runs CLI for every agent, and it is the fixer's script.** `--stop`
 * resolves a run of *any* agent from the run id — `resolveRun` calls
 * `listRunRecords` with no agent forced — which is ADR 0008 row 8's "by a human
 * who did not start it, without knowing which agent" property, already built. The
 * per-agent script switch this used to carry sent a hunt to
 * `agent-hunter.mjs --stop=…`, whose parser has no such option and throws on it.
 * A neutral `agent-runs.mjs` is the right long-term name and is a rename across
 * skills, docs, the publish denylist and `verify-templates`; it is the named
 * follow-up, not this. D9.
 *
 * **The command is an argv, not a sentence.** It used to live only inside the
 * prose, which meant the only thing a test could assert was a spelling — and a
 * spelling assertion passed all three of this line's faults at once. Handed back
 * as an array, it is fed to the parser of the script it names
 * (`tests/agent-menu-edits.test.mjs`), so the assertion is that the command runs
 * rather than that it reads correctly.
 *
 * **`--release` is not the same shape as `--stop` and the fallback was wrong in
 * kind.** `--release` takes an issue number (`/^[1-9][0-9]*$/`) because releasing
 * is releasing a *claim*, and a hunt claims nothing — its `issue.number` is null,
 * which is exactly when the old `?? runId` fallback fired. It composed
 * `--release=<run id>`, a command the CLI it named refuses.
 * `#276 (FORGE-337)`. There is no such command for a hunt, so the menu says so
 * instead of composing one.
 */
function planLiveRun(state, row, edit) {
  const { run } = row;
  const cli = join(state.checkoutRoot, 'scripts', 'agent-fixer.mjs');
  const why = ' — the menu does not hold a handle on a run it did not start,'
    + " and agent-fixer.mjs is the runs CLI for every agent: it resolves a run from its id"
    + ' without being told which agent produced it';

  if (edit.action === 'release') {
    if (run.issue?.number === undefined || run.issue?.number === null) {
      return outcome(edit, 'refuse',
        `${run.runId} claims no issue, so there is nothing to release — \`--release\` takes an issue`
        + ' number, and a run without one is ended by stopping it',
        { target: row.ref });
    }
    return outcome(edit, 'refuse',
      `releasing the claim on #${run.issue.number} is the command below${why}`,
      { target: row.ref, command: ['node', cli, state.repoRoot, `--release=${run.issue.number}`] });
  }

  // The run id, never the issue number, although `--stop` accepts both. A run id
  // names one run; an issue number names every run ever opened against it, and
  // `resolveRun` refuses rather than guesses when more than one is live — so the
  // identifier the screen is looking at is the one it hands over.
  return outcome(edit, 'refuse',
    `stopping ${run.runId} is the command below${why}`,
    { target: row.ref, command: ['node', cli, state.repoRoot, `--stop=${run.runId}`] });
}

/**
 * Execute only what `planEdits` returned as `apply`.
 *
 * A failure is reported, not thrown. One edit failing is not a reason to abandon
 * the ones after it, and the caller needs to know which one failed.
 */
export function applyEdits(state, edits, ctx = {}) {
  const planned = planEdits(state, edits, ctx);
  const byRef = new Map(rows(state).map((row) => [row.ref, row]));

  return planned.map((entry) => {
    if (entry.verdict !== 'apply') return entry;
    const row = byRef.get(entry.target);
    try {
      switch (row.kind) {
        case 'agent': return runAgent(entry, row, ctx);
        case 'window': return runWindow(entry, row, ctx);
        // A run is a command handed back, not a process started here.
        case 'run': return { ...entry, verdict: 'applied' };
        case 'sweep': return runSweepEdit(entry, ctx);
        default: return outcome(entry, 'refuse', `nothing applies a ${row.kind}`, { target: entry.target });
      }
    } catch (err) {
      return outcome(entry, 'refuse', `${entry.reason} failed: ${err.message}`, { target: entry.target });
    }
  });
}

/** Merge into whatever the agent's file already holds, so switching an agent off
 *  does not discard the record of when it was switched on. */
function writeAgentState(id, patch, ctx) {
  const path = agentStatePath(id, ctx);
  const held = readState(path);
  const next = { kind: ENABLEMENT_KIND, agent: id, ...(held.data ?? {}), ...patch };
  mkdirSync(dirname(path), { recursive: true });
  const refusal = writeAtomically(path, `${JSON.stringify(next, null, 2)}\n`, { replace: true });
  return refusal ?? null;
}

function runAgent(entry, row, ctx) {
  const turningOn = entry.action === 'on';
  const patch = turningOn
    ? {
      enabled: true,
      enabledAt: new Date().toISOString(),
      conditionsShown: entry.conditions,
      acknowledgedOpen: entry.acknowledgedOpen,
    }
    : { enabled: false, disabledAt: new Date().toISOString() };
  const refusal = writeAgentState(row.agent.id, patch, ctx);
  return refusal
    ? outcome(entry, 'refuse', refusal, { target: entry.target })
    : { ...entry, verdict: 'applied' };
}

/**
 * The words a sweep refusal is printed with: its message if it has any, its
 * reason if not, and never nothing.
 *
 * The shape this replaces was `result.message ?? result.reason`, and `??` falls
 * back on `null` and `undefined` only. Both producers build their message the
 * same way — `(result.stderr || result.stdout || '').trim()` in
 * `registerSweep`'s `register-failed` and `unregisterSweep`'s `delete-failed` —
 * so a `schtasks` that fails with nothing on either stream, which is what an
 * absent `schtasks` looks like, hands over the empty string. `??` passes it
 * through and the screen names nothing, with the reason sitting in the object it
 * was handed. `#327 (FORGE-367)` removed this from `scripts/agent-fixer.mjs`;
 * this was the one site outside that file with it, and nothing else in this file
 * matches the shape. `#332 (FORGE-368)`.
 *
 * **Whitespace is nothing**, and that is a property of this function rather than
 * of the callers. Both producers trim today, so a message of blanks cannot arrive
 * from either — which is exactly why the guarantee belongs here: a producer that
 * stopped trimming would otherwise restore the empty line at a site nobody looked
 * at again.
 *
 * **Deliberately not shared with `agent-fixer.mjs`'s `refusalWords`**, which is
 * module-private there. The issue leaves the choice open and either answer is
 * acceptable; this one keeps them separate because the alternative cannot be
 * reached from inside this issue's scope. `#332 (FORGE-368)`'s *Out of scope*
 * forbids touching `scripts/agent-fixer.mjs`, so lifting the rule into
 * `scripts/lib/` would ship a shared module with exactly one consumer — which is
 * the shape `#307 (FORGE-351)` has just deleted from `scripts/lib/enablement.mjs`
 * for going unused. The duplication is two small functions with the same name and
 * the same rule; the coupling would be a module nobody imports.
 */
function refusalWords(refusal) {
  const said = typeof refusal?.message === 'string' ? refusal.message.trim() : '';
  const named = typeof refusal?.reason === 'string' ? refusal.reason.trim() : '';
  // A refusal carrying neither is a bug in its producer, and printing nothing for
  // it would report that bug as silence — the failure this function is about.
  return said || named || 'refused without naming a reason';
}

/**
 * Register or remove the scheduled sweep, and render whatever it refuses with.
 *
 * The two producers are injectable for the reason `agent-fixer.mjs` injects
 * `runLoop`: `refusalWords`' whitespace guarantee belongs to this function rather
 * than to its callers, and both producers build their message as
 * `(stderr || stdout || '').trim()` — so through them a message of blanks arrives
 * already empty and the guarantee is unreachable. Without the seam the only test
 * for it would be one that passes with the `trim()` removed, which is the shape
 * of assertion this issue exists to remove rather than add.
 */
function runSweepEdit(entry, ctx) {
  const register = ctx.registerSweep ?? registerSweep;
  const unregister = ctx.unregisterSweep ?? unregisterSweep;
  const result = entry.action === 'register'
    ? register({ repoRoot: ctx.repoRoot, homeDir: ctx.homeDir }, ctx)
    : unregister({ homeDir: ctx.homeDir }, ctx);
  return result.ok
    ? { ...entry, verdict: 'applied' }
    : outcome(entry, 'refuse', refusalWords(result), { target: entry.target });
}

function runWindow(entry, row, ctx) {
  const refusal = writeAgentState(row.agent.id, {
    window: entry.action === 'clear' ? null : entry.window,
  }, ctx);
  return refusal
    ? outcome(entry, 'refuse', refusal, { target: entry.target })
    : { ...entry, verdict: 'applied' };
}

/** `--plan '[{"index":4,"action":"on"}]'`. The edit list is an argument rather
 *  than a staging file, for `config-menu.mjs`'s reason (D2 there): a file goes
 *  stale against a checkout edited mid-menu. */
export function parseEdits(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`the edit list is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('the edit list must be a JSON array of {index, action}');
  return parsed.map((edit, at) => {
    if (typeof edit?.action !== 'string') throw new Error(`edit ${at + 1} needs a string "action"`);
    if (!Number.isInteger(edit?.index)) throw new Error(`edit ${at + 1} needs an integer "index"`);
    return {
      index: edit.index,
      action: edit.action,
      ...(edit.days === undefined ? {} : { days: edit.days }),
      ...(edit.from === undefined ? {} : { from: edit.from }),
      ...(edit.to === undefined ? {} : { to: edit.to }),
    };
  });
}

export function renderOutcomes(outcomes) {
  const mark = {
    apply: 'would ', applied: 'did   ', refuse: 'REFUSE', noop: 'skip  ',
  };
  const lines = [];
  for (const o of outcomes) {
    lines.push(`  ${String(o.index).padStart(2)}  ${mark[o.verdict] ?? o.verdict}  ${o.reason}`);
    // The conditions are printed under the edit that carries them, every time,
    // because this IS the enablement act — an owner who never saw them has
    // acknowledged nothing.
    for (const row of o.conditions ?? []) {
      lines.push(`        [${row.closed ? 'closed' : ' open '}] ${row.condition}`);
      lines.push(`                 ${row.closed ? row.evidence : row.act}`);
    }
    for (const act of o.ownerActs ?? []) lines.push(`        to close it — ${act}`);
    // A limit that travels with an offer but never reaches the screen is a limit
    // nobody was told. Printed here for the same reason the enablement conditions
    // are: the outcome object holding it proves nothing about what a human saw.
    if (o.note) lines.push(`        note: ${o.note}`);
    if (o.command) lines.push(`        run: ${o.command.join(' ')}`);
  }
  return lines;
}

function main(argv) {
  const args = argv.slice(2);
  const flagValue = (name) => {
    const at = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
    if (at === -1) return null;
    return args[at].includes('=') ? args[at].split('=').slice(1).join('=') : args[at + 1] ?? '';
  };
  const mode = ['--render', '--plan', '--apply'].find((m) => args.some((a) => a === m || a.startsWith(`${m}=`)));
  if (!mode) {
    console.error('usage: node scripts/agent-menu.mjs --render [--json] | --plan <edits> | --apply <edits>');
    return 2;
  }

  const ctx = { repoRoot: process.cwd(), checkoutRoot: process.cwd(), homeDir: homedir() };
  const state = inspect(ctx);

  if (mode === '--render') {
    console.log(args.includes('--json') ? JSON.stringify(state, null, 2) : render(state).join('\n'));
    return 0;
  }

  let edits;
  try {
    edits = parseEdits(flagValue(mode) ?? '');
  } catch (err) {
    console.error(err.message);
    return 2;
  }

  const outcomes = mode === '--plan' ? planEdits(state, edits, ctx) : applyEdits(state, edits, ctx);
  console.log(renderOutcomes(outcomes).join('\n'));
  return outcomes.some((o) => o.verdict === 'refuse') ? 1 : 0;
}

export { main };
runCli(import.meta.url, main);
