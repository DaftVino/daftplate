#!/usr/bin/env node
// The sweeper: what one Windows Scheduled Task wakes, and the only thing that
// decides whether an agent's window is open right now.
//
// Phase 5 of docs/designs/2026-08-28-plan-daft-agent.md, for `#204 (FORGE-265)`.
//
// **The schedule does not encode the window.** One task at a fixed tick, and the
// decision is made here from a file a human can read. The alternative — a task per
// agent carrying its own trigger — puts the schedule in Windows AND in the
// repository, and `status` then either shells out per row or prints a copy that
// can disagree with the machine. One readable file holding the truth is the
// property being bought; the price is that window granularity is capped by the
// tick.
//
// **Scheduled implies detached.** A time window that dies when the terminal closes
// is a footgun, so scheduling goes through Task Scheduler and run-now — which is
// attached — goes through the menu instead. What a task registered without `/RU`
// does NOT do is run while the user is logged off; that was never measured and is
// not claimed anywhere this feature speaks.
import { readFileSync, existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, violation, reportViolations, EXIT_CODES } from './lib/cli.mjs';
import { writeAtomically } from './lib/atomic-write.mjs';
import { AGENTS } from './lib/agent-registry.mjs';
import {
  agentStatePath, agentLogPath, sweepStatePath, ENABLEMENT_KIND, SWEEP_KIND,
  appendJournal, JOURNAL_EVENTS,
} from './lib/agent-state.mjs';
import { runAuthorization } from './lib/enablement.mjs';

/** The one task. Named in one place so registration, removal and the screen
 *  cannot drift into meaning different tasks. */
export const SWEEP_TASK_NAME = 'daftplate\\sweep';

/**
 * How often Windows wakes the sweeper, in minutes.
 *
 * Fine enough that an hour-long window cannot be missed, coarse enough that a
 * machine wakes four times an hour rather than sixty. Reasoned, not measured —
 * nothing here establishes what a sweep costs, and the first measurement belongs
 * in this phase's record rather than in this constant's comment.
 */
export const TICK_MINUTES = 15;

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const pad2 = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Strict `HH:MM`, zero-padded, 00-23 / 00-59 — the shape every `pad2` caller in
 *  this file produces. Anything else is malformed input, not a time. */
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `null` for anything that is not exactly `HH:MM`, including a non-string —
 *  `hhmm.split` on a number or object throws, and a throw here would crash the
 *  whole sweep for every agent rather than just refusing this one window. */
const minutesOf = (hhmm) => {
  if (typeof hhmm !== 'string') return null;
  const m = TIME_RE.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

/**
 * Which instance of `window` the moment `now` falls in, or `null` for none.
 *
 * The key is **local date plus the window's start time** — deliberately not an
 * instant, and that is what carries DST without any arithmetic about it. On the
 * autumn transition a wall-clock time occurs twice: two instants an hour apart
 * that a human calls one window. Comparing timestamps would start a second run in
 * it. Comparing this key does not, because both ticks render the same local date
 * and the same `from`.
 *
 * This is not an edge case bolted on for two days a year. At a 15-minute tick over
 * a 3-hour window, twelve ticks land inside one instance, and they are held apart
 * from a genuinely new window by exactly the same comparison.
 *
 * A window that crosses midnight belongs to the day it **started**. Reading the
 * day set against the clock date instead would refuse the small hours and the
 * window would silently end at midnight.
 */
export function windowInstanceKey(window, now) {
  if (!window?.days?.length || !window.from || !window.to) return null;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return null;
  const from = minutesOf(window.from);
  const to = minutesOf(window.to);
  if (from === null || to === null) return null;
  const at = now.getHours() * 60 + now.getMinutes();

  // The end is exclusive, so two adjacent windows cannot both claim one minute.
  //
  // Split on `<=`/`>`, not `<`/`>=`: `from === to` must fall into the SAME
  // formula as the ordinary non-crossing case (`at >= from && at < to`), where
  // it is vacuously false for every `at` — a zero-width window matches no
  // instant. Splitting on `<`/`>=` instead sent `from === to` into the
  // crossing-midnight formula, where `at >= from` alone is unbounded: a window
  // with `from === to` matched EVERY moment of every day it named, forever.
  const startedToday = from <= to ? (at >= from && at < to) : at >= from;
  const startedYesterday = from > to && at < to;
  if (!startedToday && !startedYesterday) return null;

  const startDay = new Date(now);
  if (startedYesterday) startDay.setDate(startDay.getDate() - 1);
  if (!window.days.includes(DAY_NAMES[startDay.getDay()])) return null;

  return `${localDate(startDay)}T${window.from}`;
}

/**
 * Whether this agent should be started now, and why not when it should not.
 *
 * Two questions, not one: is the moment inside the window, **and** has a run
 * already started in this instance of it. The second is what makes a repeated tick
 * — and the repeated hour on the autumn transition — harmless.
 */
export function shouldStart(state, now) {
  // **This answers "is this the moment", never "is this permitted".**
  // `#194 (FORGE-260)` Phase 3: it used to short-circuit on `state.enabled`, which
  // made it a second authority on whether a run may happen — and a second
  // authority is the defect, not a convenience. Permission is `runAuthorization`'s
  // alone and is asked in `sweep()`. Keeping this function pure over
  // `(state, now)` is what lets the whole window algebra stay testable without a
  // home directory, a state file or an ADR.
  if (!state?.window) return { start: false, reason: 'no window — run-now only', key: null };

  const key = windowInstanceKey(state.window, now);
  if (!key) return { start: false, reason: 'outside every window', key: null };
  if (state.lastWindowKey === key) {
    return { start: false, reason: `already started in this window (${key})`, key };
  }
  return { start: true, reason: `inside ${key}`, key };
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  return writeAtomically(path, `${JSON.stringify(data, null, 2)}\n`, { replace: true });
}

/**
 * The real launch: asynchronous, so the sweeper starts a run and does not hold it.
 *
 * **It was `spawnSync`, and that made `detached: true` a decoration.** `spawnSync`
 * blocks until the child exits, so the sweeper held the entire run — the one thing
 * the file header's "scheduled implies detached" claims it does not do — and every
 * consequence in `#223 (FORGE-294)` defect 2 followed from the wait.
 *
 * **The `'error'` listener is not defensive, it is required.** Measured on this
 * box: async `spawn` of a non-existent executable does NOT populate `child.error`
 * the way `spawnSync` did. It returns a `ChildProcess` with `pid: undefined` and
 * emits `'error'` on a later tick — and an `'error'` event with no listener is
 * thrown as an unhandled error that takes the process down. So a single agent
 * whose launch fails would kill the whole tick, silently, some milliseconds after
 * this function had already returned successfully. The listener is what makes the
 * failure a value instead of an exit.
 */
export const defaultSpawn = (command, args, options) => {
  const child = spawnChild(command, args, options);
  child.on('error', () => {
    // Deliberately empty. The launch failure is detected synchronously by the
    // absent `pid` and reported as an outcome; this listener exists so the event
    // has somewhere to land rather than to handle it twice.
  });
  return child;
};

/**
 * One tick: ask every agent whether now is inside its window, and start the ones
 * that say yes.
 *
 * **It never enables anything.** A sweeper that could switch an agent on would be
 * performing ADR 0008's owner-held act on a timer, which is the opposite of what
 * that ADR reserves. It reads `enabled` and it writes only `lastWindowKey` and
 * `lastStartedAt`.
 *
 * `opts.spawn` is an injected seam, like the runner's `opts.git` and `opts.gh`.
 * A test asserts over the argv actually passed rather than over the code that
 * builds it, which is the only form in which ADR 0008 row 1 is checkable.
 */
/**
 * The two outcome shapes that also leave a journal line.
 *
 * `#194 (FORGE-260)` Phase 4. Before this, a skipped or refused agent wrote
 * nothing at all: `main()` printed its outcomes to a console Task Scheduler
 * discards, and a month of a sweeper declining to start anything was indis-
 * tinguishable, on disk, from a month nobody looked at. `8a67225` gave a *started*
 * run a log file; this gives every other outcome a line.
 *
 * Written inside `sweep()` rather than by the caller so a second entry point
 * cannot get an un-journalled sweep, and after the outcome is decided rather than
 * before, so the line records what happened rather than what was about to.
 */
function makeRecorders(homeDir, now) {
  const skipped = (agent, reason) => {
    appendJournal({ agent, event: JOURNAL_EVENTS.SKIPPED, reason }, { homeDir, at: now });
    return { agent, started: false, reason };
  };
  const launchFailed = (agent, reason, windowKey, log) => {
    appendJournal({ agent, event: JOURNAL_EVENTS.SPAWN_FAILED, reason, windowKey, log }, { homeDir, at: now });
    return { agent, started: false, reason, log };
  };
  return { skipped, launchFailed };
}

export function sweep({ repoRoot, now = new Date(), homeDir = homedir() } = {}, opts = {}) {
  const spawn = opts.spawn ?? defaultSpawn;
  // Injected so the permitted case is reachable in a test. It is unreachable on
  // this machine today -- ADR 0008's second condition is open and closing it is an
  // owner's act -- and without this seam a test could only reach it by mutating
  // exported module state, which is how a suite starts depending on its own order.
  const conditions = opts.conditions;
  const { skipped, launchFailed } = makeRecorders(homeDir, now);
  const checkoutRoot = opts.checkoutRoot ?? fileURLToPath(new URL('..', import.meta.url));
  const outcomes = [];

  for (const entry of AGENTS) {
    const path = agentStatePath(entry.id, { homeDir });
    const state = readJson(path);
    const decision = shouldStart(state, now);
    if (!decision.start) {
      outcomes.push(skipped(entry.id, decision.reason));
      continue;
    }

    // Asked before anything is spawned, and before the window is stamped. An
    // agent with no unattended driver cannot be started by a timer at all, so a
    // tick that spawned it would start a process whose only possible outcome is a
    // refusal — and then stamp the window anyway, consuming the instance and
    // reporting `started: true`. That is `#223 (FORGE-294)` defect 1 exactly.
    // Nothing is written here, so the state file is untouched and the reason
    // reaches the operator instead.
    if (entry.unattended.driver === 'none') {
      outcomes.push(skipped(entry.id, 'no unattended driver — a run is invoked by a session'));
      continue;
    }

    // **May this agent run at all?** One authority, asked here rather than
    // re-derived — `#194 (FORGE-260)` Phase 3. Asked AFTER the driver check so a
    // driverless agent still reports the reason specific to it: "you cannot
    // schedule this" is more actionable than "it is not switched on", and the two
    // refusals are about different things.
    //
    // Before the stamp and before the spawn, so a refused agent leaves the state
    // file untouched and the next tick inside the window retries.
    const auth = runAuthorization({ agentId: entry.id, homeDir }, { conditions });
    if (!auth.mayRun) {
      outcomes.push(skipped(entry.id, auth.reason));
      continue;
    }

    // Composed from the entry's own declaration, never spelled here. The flag the
    // sweeper passed and the flags the CLI parsed were two independent facts, and
    // they disagreed from the day this function was written; reading one of them
    // out of the registry is what stops them being two facts.
    const args = [join(checkoutRoot, entry.script), resolve(repoRoot), ...entry.unattended.args];

    // Where the run's output goes, because a scheduled run has no terminal and
    // `stdio: 'ignore'` sent it nowhere at all. One file per window instance,
    // appended to, and never removed by anything here (CLAUDE.md #5).
    const logPath = agentLogPath(entry.id, decision.key, { homeDir });
    let child;
    let logFd = null;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      logFd = openSync(logPath, 'a');
      child = spawn(process.execPath, args, {
        detached: true,
        // Both streams into one file, in the order the run produced them. stdin is
        // ignored: there is nobody to answer a prompt, and a run that blocked
        // waiting for one would hold its window open until the next tick.
        stdio: ['ignore', logFd, logFd],
      });
    } catch (err) {
      // A spawn that THROWS is caught here rather than left to unwind the whole
      // loop: one agent's broken launch must not cost every later agent this tick.
      // Nothing is written for this agent, so this instance is untouched and the
      // next tick retries it exactly as if this one had never run.
      outcomes.push(launchFailed(entry.id, `spawn threw: ${err.message}`, decision.key, logPath));
      continue;
    } finally {
      // The child holds its own duplicate of the descriptor, so the parent's copy
      // is dead weight the moment `spawn` returns — and a sweeper that leaked one
      // per agent per tick would run out of descriptors on a long-lived process.
      if (logFd !== null) closeSync(logFd);
    }

    // **The launch check, which did not exist.** `spawnSync` reported a failed
    // launch through `result.error` and nothing read it, so a child that never
    // started was reported `started: true` with a null status. Async `spawn`
    // reports it differently again — measured on this box, `child.error` is
    // undefined and `child.pid` is undefined — so the absent pid is the real
    // signal and `child.error` is kept for the injected seam's sake.
    if (child?.error || !child?.pid) {
      // Deliberately before the stamp. The window is not consumed by a run that
      // never began, so the next tick inside it retries rather than reporting
      // "already started in this window" about a process that does not exist.
      outcomes.push(launchFailed(
        entry.id,
        `the run did not launch (${child?.error?.message ?? 'no pid'})`,
        decision.key,
        logPath,
      ));
      continue;
    }

    // Detached in the parent's reference count as well as in its process group.
    // Without this the tick cannot exit until the run it started does, which is
    // the same wait `spawnSync` imposed, arriving one line later.
    child.unref();

    // **Re-read, then merge only the three fields this function owns.** `state`
    // was read before the spawn, and between that read and this write an owner
    // can have reached the file through the menu — `#223 (FORGE-294)` defect 2's
    // serious half. Writing `{ ...state }` back restores whatever they changed,
    // and what they most plausibly changed is `enabled: false`. That is ADR
    // 0008's owner-held act reversed on a timer, by write-back rather than by
    // intent, in a function whose own doc comment promises it never enables
    // anything.
    //
    // The stamp itself is still unconditional on the run's fate, and still for
    // the reason it always was: it records that this instance has been acted on,
    // not that the run succeeded. A stamp written only on success would restart a
    // failing agent every tick for the rest of its window.
    const current = readJson(path) ?? state;
    writeJson(path, {
      ...current,
      kind: current.kind ?? ENABLEMENT_KIND,
      lastWindowKey: decision.key,
      lastStartedAt: now.toISOString(),
    });
    appendJournal({
      agent: entry.id, event: JOURNAL_EVENTS.SPAWNED, pid: child.pid, windowKey: decision.key, log: logPath,
    }, { homeDir, at: now });
    outcomes.push({ agent: entry.id, started: true, key: decision.key, pid: child.pid, log: logPath, args });
  }

  return outcomes;
}

// ---------------------------------------------------------------------------
// The task itself
// ---------------------------------------------------------------------------

/**
 * The exact `schtasks /Create` argv.
 *
 * **The repository root is an argument, not a working directory.** `schtasks
 * /Create` in this form sets none, and a task whose correctness depended on an
 * inherited `cwd` would break the first time the checkout moved.
 *
 * No `/RU`, no `/RP`, no `/RL`. Measured 2026-08-28 at Medium integrity with
 * `BUILTIN\Administrators` deny-only: `/Create` succeeds unelevated without them.
 * `/RL HIGHEST` would need elevation and `/RU` with `/RP` would need a stored
 * credential, and this design needs neither — so anything that adds one is a real
 * change in what this feature asks of a machine, not a detail.
 */
export function buildRegisterArgs({ repoRoot, node = process.execPath, script }) {
  const command = `"${node}" "${script}" "${resolve(repoRoot)}"`;
  return [
    '/Create',
    '/TN', SWEEP_TASK_NAME,
    '/TR', command,
    '/SC', 'MINUTE',
    '/MO', String(TICK_MINUTES),
    '/F',
  ];
}

const defaultSchtasks = (args) => {
  const r = spawnSync('schtasks', args, { encoding: 'utf8' });
  // `error` is carried rather than dropped. `schtasks` does not exist off
  // Windows, and CI is Linux: without this, a failure to launch arrives as
  // `status: null` and reads as "the task is not there", which is a confident
  // answer to a question that was never asked. `verifySweep` needs the three
  // outcomes apart.
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null };
};

/**
 * What `verifySweep` found, as an enum rather than a boolean.
 *
 * `#275 (FORGE-336)`. The screen carried `verified: null` with the comment "only
 * Phase 5 can ask Windows whether a task exists", and told the operator
 * *"declared, not verified — Phase 5 verifies against Windows"*. Phase 5 shipped
 * and added no query; nothing anywhere called `schtasks /Query`. So the screen
 * deferred a fact to a phase that had already landed without it, which is a
 * forward reference to nothing — the `#229 (FORGE-300)` defect class, on a
 * screen rather than in a file.
 *
 * Four outcomes and not two, because "not registered" and "we could not ask" are
 * different facts and merging them is what makes a Linux CI run report a Windows
 * task as absent. `MISMATCH` is the fourth: a task exists at that name and runs
 * something other than what this checkout declares, which is what a moved
 * checkout looks like and is the one state a boolean cannot express.
 */
export const SWEEP_VERIFY = Object.freeze({
  REGISTERED: 'registered',
  ABSENT: 'absent',
  MISMATCH: 'mismatch',
  UNKNOWN: 'unknown',
});

/** The `Task To Run:` value out of `schtasks /Query /FO LIST /V`. Measured on
 *  this box 2026-09-03: the field reproduces the `/TR` string byte for byte,
 *  quotes included, so the comparison is over the whole line rather than over
 *  paths picked out of it. */
function taskToRun(stdout) {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('Task To Run:'));
  return line ? line.slice('Task To Run:'.length).trim() : null;
}

/**
 * Ask Windows whether the task this machine recorded registering is really there.
 *
 * **The state file names the task and Windows answers for it.** Neither alone is
 * enough: the file is this machine's own record and can outlive a task somebody
 * deleted by hand, and a query with no record behind it would report on a task
 * this machine never created — which is the thing `unregisterSweep` refuses to
 * touch, for CLAUDE.md #5's reason.
 *
 * Read-only. It creates, deletes and modifies nothing, so the screen may call it
 * while rendering without `--render` becoming a mutation.
 */
export function verifySweep({ homeDir = homedir() } = {}, opts = {}) {
  const schtasks = opts.schtasks ?? defaultSchtasks;
  const held = readJson(sweepStatePath({ homeDir }));
  if (!held?.registered) {
    return { state: SWEEP_VERIFY.ABSENT, taskName: null, message: 'this machine has no record of registering one' };
  }
  const taskName = held.taskName ?? SWEEP_TASK_NAME;
  const result = schtasks(['/Query', '/TN', taskName, '/FO', 'LIST', '/V']);
  if (result.error || result.status === null) {
    return {
      state: SWEEP_VERIFY.UNKNOWN,
      taskName,
      message: `schtasks could not be run — ${result.error?.message ?? 'it returned no exit status'}`,
    };
  }
  // Measured 2026-09-03: a name that is not registered exits 1 with
  // `ERROR: The system cannot find the file specified.` on stderr.
  if (result.status !== 0) {
    return { state: SWEEP_VERIFY.ABSENT, taskName, message: (result.stderr || result.stdout || '').trim() };
  }

  const found = taskToRun(result.stdout);
  // Read out of `buildRegisterArgs`'s own output rather than recomposed here.
  // The `/TR` string is that function's to spell, and a second spelling of it in
  // the verifier would report a mismatch every time the registrar's quoting
  // changed — a disagreement between two copies of this file, reported as a
  // disagreement with Windows.
  const declaredArgs = buildRegisterArgs({
    repoRoot: held.repoRoot ?? process.cwd(),
    script: opts.script ?? fileURLToPath(import.meta.url),
  });
  const declared = declaredArgs[declaredArgs.indexOf('/TR') + 1];
  if (found !== null && found !== declared) {
    return {
      state: SWEEP_VERIFY.MISMATCH, taskName, found, declared,
      message: 'a task exists at that name and runs something else',
    };
  }
  return { state: SWEEP_VERIFY.REGISTERED, taskName, found };
}

export function registerSweep({ repoRoot, homeDir = homedir(), taskName = SWEEP_TASK_NAME } = {}, opts = {}) {
  const schtasks = opts.schtasks ?? defaultSchtasks;
  const script = opts.script ?? fileURLToPath(import.meta.url);
  const args = buildRegisterArgs({ repoRoot, script });
  if (taskName !== SWEEP_TASK_NAME) args[args.indexOf('/TN') + 1] = taskName;

  const result = schtasks(args);
  if (result.status !== 0) {
    // Not recorded as registered. A state file claiming a task that does not exist
    // is worse than one claiming nothing, because `unregister` would then run
    // against a name this machine never created.
    return { ok: false, reason: 'register-failed', message: (result.stderr || result.stdout || '').trim(), args };
  }
  writeJson(sweepStatePath({ homeDir }), {
    kind: SWEEP_KIND,
    registered: true,
    taskName,
    repoRoot: resolve(repoRoot),
    tickMinutes: TICK_MINUTES,
    registeredAt: new Date().toISOString(),
  });
  return { ok: true, taskName, args };
}

/**
 * Remove the task this machine registered, and only that one.
 *
 * CLAUDE.md #5 applied to a machine-wide object. The authority is the sweep state
 * file, exactly as the worktree reaper's authority is its in-process creation
 * record and for the same reason: a task sitting at that name which we have no
 * record of creating is somebody else's, and it is reported rather than removed.
 */
export function unregisterSweep({ homeDir = homedir() } = {}, opts = {}) {
  const schtasks = opts.schtasks ?? defaultSchtasks;
  const path = sweepStatePath({ homeDir });
  const held = readJson(path);
  if (!held?.registered) {
    return {
      ok: false,
      reason: 'never-registered',
      message: 'this machine has no record of registering a sweep task, so there is nothing here'
        + ' it may remove — a task at that name was created by something else',
    };
  }

  const result = schtasks(['/Delete', '/TN', held.taskName, '/F']);
  if (result.status !== 0) {
    return { ok: false, reason: 'delete-failed', message: (result.stderr || result.stdout || '').trim() };
  }
  writeJson(path, { ...held, registered: false, unregisteredAt: new Date().toISOString() });
  return { ok: true, taskName: held.taskName };
}

const USAGE = 'usage: node scripts/agent-sweep.mjs <repo>';

function main(argv) {
  const [repoRoot] = argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!repoRoot) {
    console.error(USAGE);
    return EXIT_CODES.USAGE;
  }
  const outcomes = sweep({ repoRoot });
  for (const o of outcomes) {
    console.log(o.started ? `${o.agent}: started for ${o.key} (pid ${o.pid})` : `${o.agent}: ${o.reason}`);
    // The run itself says nothing here — it is detached and its output went to a
    // file. Naming that file is the difference between a tick an operator can
    // investigate and one they can only re-run.
    if (o.log) console.log(`${o.agent}: log ${o.log}`);
  }
  return reportViolations([]);
}

export { main };
runCli(import.meta.url, main);
