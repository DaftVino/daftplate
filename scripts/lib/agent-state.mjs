// Where an agent's machine-local state lives, and what stamps it.
//
// **Its own module because both the menu and the sweeper need it**, and having
// the sweeper import it from the menu while the menu imports the sweeper's
// registration functions is a cycle. Same reasoning as Phase 4's move of
// `ENABLEMENT_CONDITIONS`: shared machinery does not live in one participant's
// file.
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';

/** The kind stamped into an agent's state file, versioned like every other
 *  on-disk shape in this feature. */
export const ENABLEMENT_KIND = 'daftplate.agent.enablement/1';

/** The kind stamped into the sweep's own settings. */
export const SWEEP_KIND = 'daftplate.agent.sweep/1';

/**
 * One file per agent, under `~/.daftplate/agents/`.
 *
 * **Machine state, not repository state**, which is why it sits beside the
 * session toggles `config-menu.mjs` already keeps in `~/.daftplate/` rather than
 * in the checkout. Enabling an agent is a decision about this workstation — ADR
 * 0008 reserves it to the owner of this machine's credential — and a decision
 * committed to a repository would travel to every clone of it.
 *
 * It holds the enablement record, the schedule window and the last window the
 * sweeper acted on. One file, because the sweeper reads one file per agent and
 * two would let them disagree about whether an agent that is scheduled is on.
 */
export function agentStatePath(id, { homeDir = homedir() } = {}) {
  return join(homeDir, '.daftplate', 'agents', `${id}.json`);
}

/**
 * Where a scheduled run's stdout and stderr go, one file per window instance.
 *
 * **A scheduled run has no terminal, so without this it has no output at all.**
 * `stdio: 'ignore'` is what made `#223 (FORGE-294)` defect 1 invisible for a month:
 * every launch died on its usage line and the message went to a closed
 * descriptor. A file is the cheapest thing that is still readable afterwards.
 *
 * **The colon is stripped out of the window key, and that is not cosmetic.** A
 * key is `2026-08-28T02:00`, and on NTFS a colon in a filename opens an
 * *alternate data stream*: `hunter-2026-08-28T02:00.log` writes into a stream
 * named `00.log` hanging off a file named `hunter-2026-08-28T02`. Measured on
 * this box — the write succeeds, `existsSync` and `readFileSync` on the full name
 * both agree it is there, and `readdirSync` shows only `hunter-2026-08-28T02`.
 * So an operator sent to look in this directory finds a file with no content,
 * most copy tools drop the stream silently, and no archive carries it. It looks
 * exactly like a working log until somebody needs it.
 *
 * Nothing here ever removes one of these. CLAUDE.md #5 binds them absolutely:
 * they are created and never pruned, never rotated by deletion. A log naming the
 * run that wrote it is evidence, and the one moment it is wanted is after
 * something went wrong.
 */
export function agentLogPath(id, windowKey, { homeDir = homedir() } = {}) {
  const safeKey = String(windowKey).replace(/[^0-9A-Za-z._-]/g, '-');
  return join(homeDir, '.daftplate', 'agents', 'logs', `${id}-${safeKey}.log`);
}

/** Where the sweep's own settings live: whether this machine registered a task,
 *  and under which name. It is the authority `unregisterSweep` consults, so it is
 *  the reason a task nobody here created is left standing. */
export function sweepStatePath({ homeDir = homedir() } = {}) {
  return join(homeDir, '.daftplate', 'agents', 'sweep.json');
}

/** The kind stamped into every journal line, versioned like every other on-disk
 *  shape in this feature. */
export const JOURNAL_KIND = 'daftplate.agent.journal/1';

/** The four things a tick can record about one agent. `ended` is written by the
 *  run itself, not by the sweeper, because the sweeper detaches and never learns
 *  the exit status. */
export const JOURNAL_EVENTS = Object.freeze({
  SKIPPED: 'skipped',
  SPAWNED: 'spawned',
  SPAWN_FAILED: 'spawn-failed',
  ENDED: 'ended',
});

/**
 * How many lines from the end of the current month's journal `/daft-agent` reads.
 *
 * **Measured, not guessed** — the plan asks for "N named as a constant with its
 * reason" and names no N. On this box, 2026-09-03, over a synthetic month at the
 * shipped 15-minute tick with both agents ticking:
 *
 *   - a month is **5,952 lines, 1.17 MB**
 *   - read + slice + parse of the last 2,000 lines: **6.2 ms median** (5.7 min,
 *     7.2 max over 12 runs)
 *   - the same file never rolled, at a year: 71,424 lines, 13.7 MB, **54 ms**
 *
 * So 2,000 covers about ten days at the shipped tick — comfortably more than the
 * screen needs for a failure streak to mean something — and the monthly roll is
 * what keeps the read at single-digit milliseconds rather than tens. Both numbers
 * are why this is a bound rather than a whole-file read: a screen that took 54 ms
 * to render a status line would be the slowest thing in the menu.
 */
export const JOURNAL_TAIL_LINES = 2000;

/**
 * One journal file per calendar month, under `~/.daftplate/agents/journal/`.
 *
 * **Monthly rather than one file forever**, and the reason is the measurement
 * above: an unrolled file reaches 13.7 MB in a year and the tail read goes with
 * it. Monthly also means the oldest data ages out of the read naturally without
 * anything ever deleting a line — CLAUDE.md #5 binds here exactly as it binds the
 * run logs beside it. Nothing in this feature removes a journal file.
 */
export function journalPath({ homeDir = homedir(), at = new Date() } = {}) {
  const month = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;
  return join(homeDir, '.daftplate', 'agents', 'journal', `${month}.jsonl`);
}

/**
 * Append one line to the journal. Append-only, one JSON object per line.
 *
 * **`appendFileSync`, never a read-modify-write.** A replace would mean a partial
 * write could truncate lines that were already good, and this file's whole job is
 * to survive the run that was writing it — including a run that was killed. An
 * append that is cut short damages its own line and nothing before it, which is
 * why the reader below tolerates a malformed last line rather than refusing the
 * file.
 */
export function appendJournal(entry, { homeDir = homedir(), at = new Date() } = {}) {
  const path = journalPath({ homeDir, at });
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ kind: JOURNAL_KIND, at: at.toISOString(), ...entry })}\n`);
  return path;
}

/**
 * Record this run's own end when the process exits, whatever it exits for.
 *
 * **The sweeper cannot write this line and must not try.** It spawns `detached`,
 * `unref()`s and returns, so it never learns the exit status — that is the whole
 * point of `8a67225`, and a sweeper that waited to find out would be the defect
 * that phase removed. So the only thing that can honestly record an ending is the
 * run itself.
 *
 * On `'exit'` rather than at the end of `main()`, so a throw still leaves a line:
 * Node emits `'exit'` after an uncaught exception, and a run that died is exactly
 * the run whose ending somebody wants to read about. Guarded against writing
 * twice, and its own failure is swallowed — a journal that could crash the run it
 * is describing would be worse than no journal.
 */
export function recordEndOnExit(agent, { homeDir = homedir() } = {}) {
  let written = false;
  process.on('exit', (code) => {
    if (written) return;
    written = true;
    try {
      appendJournal({ agent, event: JOURNAL_EVENTS.ENDED, code }, { homeDir });
    } catch {
      // Deliberately silent. See above.
    }
  });
}

/**
 * The last `limit` journal entries for the month `at` falls in, oldest first.
 *
 * A line that does not parse is skipped rather than throwing: a killed run can
 * leave a half-written last line, and a screen that refused to render because of
 * it would fail exactly when the journal is most wanted.
 */
export function readJournalTail({ homeDir = homedir(), at = new Date(), limit = JOURNAL_TAIL_LINES } = {}) {
  const path = journalPath({ homeDir, at });
  if (!existsSync(path)) return [];
  // Blank lines are dropped BEFORE the slice, not after. A file always ends in a
  // newline, so slicing first spends one of the `limit` on the empty tail and
  // silently returns one fewer entry than asked for — the kind of off-by-one that
  // never fails loudly and quietly shortens a history somebody is counting on.
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-limit)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e !== null && e.kind === JOURNAL_KIND);
}

/**
 * What the journal says about one agent, reduced to what a screen can show.
 *
 * `#194 (FORGE-260)` Phase 4. Reads the bounded tail rather than the file, for
 * the cost measured at `JOURNAL_TAIL_LINES`.
 *
 * **`consecutiveFailures` counts backwards from the newest and stops at the first
 * success**, so it is a streak rather than a total: a total would keep an agent
 * looking broken forever after one bad week, and the number an operator needs is
 * "is it failing now".
 *
 * **`startedWithNoOutcome` is the honest representation of a `SIGKILL`** — the
 * sweeper saw a run start and nothing ever recorded its end. It is fixture-only on
 * a machine where ADR 0008's gate is closed, and that is stated in the phase's
 * tests rather than left for somebody to infer from a green suite.
 */
export function journalSummary(entries, agentId) {
  const mine = entries.filter((e) => e.agent === agentId);
  const last = mine.at(-1) ?? null;

  let consecutiveFailures = 0;
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const e = mine[i];
    if (e.event === JOURNAL_EVENTS.ENDED) {
      if (e.code === 0) break;
      consecutiveFailures += 1;
    } else if (e.event === JOURNAL_EVENTS.SPAWN_FAILED) {
      consecutiveFailures += 1;
    }
  }

  const lastSpawn = [...mine].reverse().find((e) => e.event === JOURNAL_EVENTS.SPAWNED) ?? null;
  const endedAfter = lastSpawn
    ? mine.some((e) => e.event === JOURNAL_EVENTS.ENDED && e.at >= lastSpawn.at)
    : false;

  return {
    ticks: mine.length,
    last,
    lastEvent: last?.event ?? null,
    consecutiveFailures,
    startedWithNoOutcome: Boolean(lastSpawn) && !endedAfter,
  };
}
