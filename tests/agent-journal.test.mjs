// The tick journal, and the screen that reads it — `#194 (FORGE-260)`,
// plan-agents Phase 4.
//
// **The phase's prescribed first test cannot be built as written, and this is the
// replacement `#225 (FORGE-296)` specified.** It said: drive two sweeps against
// fixtures, one whose child exits 0 and one whose child exits non-zero, and assert
// `render()` differs. That assumes the sweeper observes the child's exit status.
// It does not, and must not: since `8a67225` it spawns `detached`, `unref()`s and
// returns. The exit status reaches the journal only through the child CLI's own
// `process.on('exit')`. So the two halves are split — a unit test driven from
// hand-written JSONL, and one integration test that spawns the real fixer under
// `--scheduled` and polls for its `ended` line.
//
// **Two things about this journal's real content, stated rather than discovered.**
// While ADR 0008's second condition is open, `mayRun` is false for both agents and
// the hunter is refused earlier still for `driver: 'none'` — so on this machine
// the journal's only production content is `skipped` lines. `spawned`,
// `spawn-failed` and the `started, no outcome recorded` rendering are reachable
// only from fixtures today. They are built anyway, because the un-terminated case
// is the honest representation of a `SIGKILL` and is exactly what nobody could see
// before; but the phase's headline rendering having no production path is worth
// knowing before somebody reads a green suite as proof the fleet is observable.

process.env.TZ = 'Europe/London';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import {
  journalPath, appendJournal, readJournalTail,
  JOURNAL_KIND, JOURNAL_EVENTS, JOURNAL_TAIL_LINES, agentStatePath, ENABLEMENT_KIND,
} from '../scripts/lib/agent-state.mjs';
import { sweep } from '../scripts/agent-sweep.mjs';
import { inspect, render } from '../scripts/agent-menu.mjs';

const SEPT = new Date(2026, 8, 15, 3, 0);
const PERMITTED = [{ condition: 'stood in for', closed: true, evidence: 'authority coverage lives elsewhere' }];
const WEEKDAYS = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '02:00', to: '05:00' };

const boardRepo = () => makeRepo({ 'ROADMAP.md': ['# ROADMAP', '', '## Now', ''].join('\n') });

function homeWith(states = {}) {
  const home = emptyDir();
  mkdirSync(join(home, '.daftplate', 'agents'), { recursive: true });
  for (const [id, state] of Object.entries(states)) {
    writeFileSync(agentStatePath(id, { homeDir: home }), JSON.stringify({
      kind: ENABLEMENT_KIND, agent: id, ...state,
    }));
  }
  return home;
}

/** Write journal lines directly, so a screen can be driven without a sweep. */
function seedJournal(homeDir, entries, at = SEPT) {
  const path = journalPath({ homeDir, at });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${entries.map((e) => JSON.stringify({ kind: JOURNAL_KIND, ...e })).join('\n')}\n`);
  return path;
}

const screen = (homeDir, at = SEPT) => {
  const repoRoot = boardRepo();
  return render(inspect({ repoRoot, checkoutRoot: repoRoot, homeDir, now: at }));
};

// ---------------------------------------------------------------------------
// The file itself
// ---------------------------------------------------------------------------

test('the journal rolls by calendar month', () => {
  const homeDir = emptyDir();
  const sep = journalPath({ homeDir, at: new Date(2026, 8, 30, 23, 59) });
  const oct = journalPath({ homeDir, at: new Date(2026, 9, 1, 0, 0) });
  assert.match(sep, /2026-09\.jsonl$/);
  assert.match(oct, /2026-10\.jsonl$/);
  assert.notEqual(sep, oct);
});

test('appending never truncates a line already written', () => {
  // Append-only is the property, not an implementation note: a read-modify-write
  // could lose good lines to a partial write, and this file exists to survive the
  // run that was writing it.
  const homeDir = emptyDir();
  appendJournal({ agent: 'fixer', event: JOURNAL_EVENTS.SKIPPED, reason: 'first' }, { homeDir, at: SEPT });
  appendJournal({ agent: 'hunter', event: JOURNAL_EVENTS.SKIPPED, reason: 'second' }, { homeDir, at: SEPT });
  const text = readFileSync(journalPath({ homeDir, at: SEPT }), 'utf8');
  assert.equal(text.trim().split('\n').length, 2);
  assert.match(text, /first/);
  assert.match(text, /second/);
});

test('every line carries the kind and a timestamp', () => {
  const homeDir = emptyDir();
  appendJournal({ agent: 'fixer', event: JOURNAL_EVENTS.SPAWNED, pid: 7 }, { homeDir, at: SEPT });
  const [entry] = readJournalTail({ homeDir, at: SEPT });
  assert.equal(entry.kind, JOURNAL_KIND);
  assert.equal(entry.agent, 'fixer');
  assert.equal(entry.pid, 7);
  assert.equal(typeof entry.at, 'string');
});

test('a half-written last line is skipped, not thrown on', () => {
  // A killed run leaves exactly this. A screen that refused to render because of
  // it would fail at the one moment the journal is worth having.
  const homeDir = emptyDir();
  const path = seedJournal(homeDir, [{ agent: 'fixer', event: JOURNAL_EVENTS.SKIPPED, reason: 'good' }]);
  writeFileSync(path, `${readFileSync(path, 'utf8')}{"kind":"daftplate.agent.jour`);
  const entries = readJournalTail({ homeDir, at: SEPT });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reason, 'good');
});

test('a foreign line is not read as a journal entry', () => {
  const homeDir = emptyDir();
  const path = seedJournal(homeDir, [{ agent: 'fixer', event: JOURNAL_EVENTS.SKIPPED }]);
  writeFileSync(path, `${JSON.stringify({ kind: 'something.else/1', agent: 'fixer' })}\n${readFileSync(path, 'utf8')}`);
  assert.equal(readJournalTail({ homeDir, at: SEPT }).length, 1);
});

test('the tail is bounded, and the bound is the newest lines', () => {
  const homeDir = emptyDir();
  const many = Array.from({ length: JOURNAL_TAIL_LINES + 50 }, (_, i) => ({
    agent: 'fixer', event: JOURNAL_EVENTS.SKIPPED, seq: i,
  }));
  seedJournal(homeDir, many);
  const entries = readJournalTail({ homeDir, at: SEPT });
  assert.equal(entries.length, JOURNAL_TAIL_LINES);
  assert.equal(entries.at(-1).seq, many.length - 1, 'the tail kept the oldest lines instead of the newest');
});

// ---------------------------------------------------------------------------
// The screen — the phase's real first test, driven from hand-written lines
// ---------------------------------------------------------------------------

test('a window whose every start failed is not the same screen as one that ran', () => {
  const failed = homeWith();
  seedJournal(failed, [
    { at: new Date(2026, 8, 15, 2, 0).toISOString(), agent: 'fixer', event: JOURNAL_EVENTS.SPAWNED, pid: 11, windowKey: '2026-09-15T02:00' },
    { at: new Date(2026, 8, 15, 2, 1).toISOString(), agent: 'fixer', event: JOURNAL_EVENTS.ENDED, code: 1, windowKey: '2026-09-15T02:00' },
  ]);
  const ran = homeWith();
  seedJournal(ran, [
    { at: new Date(2026, 8, 15, 2, 0).toISOString(), agent: 'fixer', event: JOURNAL_EVENTS.SPAWNED, pid: 11, windowKey: '2026-09-15T02:00' },
    { at: new Date(2026, 8, 15, 2, 1).toISOString(), agent: 'fixer', event: JOURNAL_EVENTS.ENDED, code: 0, windowKey: '2026-09-15T02:00' },
  ]);

  const a = screen(failed).join('\n');
  const b = screen(ran).join('\n');
  assert.notEqual(a, b, 'a month of failures renders identically to a month that worked');
  assert.match(a, /LAST SWEEP/);
  assert.match(a, /failed|exit 1/i, 'the failing screen does not name the failure');
});

test('a spawned run with no outcome renders as started with none recorded', () => {
  // The honest rendering of a SIGKILL: the sweeper saw it start and nothing ever
  // wrote its end. Fixture-only on this machine today -- see the header.
  const homeDir = homeWith();
  seedJournal(homeDir, [
    { at: new Date(2026, 8, 15, 2, 0).toISOString(), agent: 'fixer', event: JOURNAL_EVENTS.SPAWNED, pid: 11, windowKey: '2026-09-15T02:00' },
  ]);
  assert.match(screen(homeDir).join('\n'), /no outcome recorded/);
});

test('consecutive failures are counted and shown', () => {
  const homeDir = homeWith();
  seedJournal(homeDir, [1, 2, 3].flatMap((n) => ([
    { at: new Date(2026, 8, 10 + n, 2, 0).toISOString(), agent: 'fixer', event: JOURNAL_EVENTS.SPAWNED, pid: n, windowKey: `2026-09-1${n}T02:00` },
    { at: new Date(2026, 8, 10 + n, 2, 1).toISOString(), agent: 'fixer', event: JOURNAL_EVENTS.ENDED, code: 1, windowKey: `2026-09-1${n}T02:00` },
  ])));
  const state = inspect({ repoRoot: boardRepo(), checkoutRoot: boardRepo(), homeDir, now: SEPT });
  assert.equal(state.agents.find((a) => a.id === 'fixer').journal.consecutiveFailures, 3);
  assert.match(screen(homeDir).join('\n'), /3 consecutive/);
});

test('a successful run resets the failure streak', () => {
  const homeDir = homeWith();
  seedJournal(homeDir, [
    { at: new Date(2026, 8, 11, 2, 1).toISOString(), agent: 'fixer', event: JOURNAL_EVENTS.ENDED, code: 1, windowKey: 'a' },
    { at: new Date(2026, 8, 12, 2, 1).toISOString(), agent: 'fixer', event: JOURNAL_EVENTS.ENDED, code: 1, windowKey: 'b' },
    { at: new Date(2026, 8, 13, 2, 1).toISOString(), agent: 'fixer', event: JOURNAL_EVENTS.ENDED, code: 0, windowKey: 'c' },
  ]);
  const state = inspect({ repoRoot: boardRepo(), checkoutRoot: boardRepo(), homeDir, now: SEPT });
  assert.equal(state.agents.find((a) => a.id === 'fixer').journal.consecutiveFailures, 0);
});

test('a machine that has never ticked says so rather than rendering an empty block', () => {
  assert.match(screen(homeWith()).join('\n'), /no tick recorded/i);
});

// ---------------------------------------------------------------------------
// The sweeper writes what it did
// ---------------------------------------------------------------------------

test('a skipped agent leaves a line, which is the whole gap this phase closes', () => {
  // Before this, a skipped or refused agent wrote NOTHING. `8a67225` gave a
  // spawned run a log file, so a failing launch is now visible -- but an agent
  // the sweeper declined to start left no trace at all, and no screen read any
  // of it. That is what survives of the phase's motivation.
  const homeDir = homeWith({ fixer: { enabled: false }, hunter: { enabled: false } });
  sweep({ repoRoot: boardRepo(), now: SEPT, homeDir }, { conditions: PERMITTED, spawn: () => ({ pid: 1, unref() {} }) });
  const entries = readJournalTail({ homeDir, at: SEPT });
  const fixer = entries.find((e) => e.agent === 'fixer');
  assert.equal(fixer.event, JOURNAL_EVENTS.SKIPPED);
  assert.match(fixer.reason, /\S/, 'a skip with no reason is the thing this replaces');
});

test('a started run leaves a spawned line carrying its pid and window', () => {
  const homeDir = homeWith({ fixer: { enabled: true, window: WEEKDAYS }, hunter: { enabled: false } });
  sweep({ repoRoot: boardRepo(), now: SEPT, homeDir }, { conditions: PERMITTED, spawn: () => ({ pid: 4242, unref() {} }) });
  const spawned = readJournalTail({ homeDir, at: SEPT }).find((e) => e.event === JOURNAL_EVENTS.SPAWNED);
  assert.equal(spawned.agent, 'fixer');
  assert.equal(spawned.pid, 4242);
  assert.match(spawned.windowKey, /^2026-09-15T02:00$/);
});

test('a launch that never started leaves a spawn-failed line, not a spawned one', () => {
  const homeDir = homeWith({ fixer: { enabled: true, window: WEEKDAYS }, hunter: { enabled: false } });
  sweep({ repoRoot: boardRepo(), now: SEPT, homeDir }, { conditions: PERMITTED, spawn: () => ({ pid: undefined, unref() {} }) });
  const events = readJournalTail({ homeDir, at: SEPT }).filter((e) => e.agent === 'fixer').map((e) => e.event);
  assert.deepEqual(events, [JOURNAL_EVENTS.SPAWN_FAILED]);
});

// ---------------------------------------------------------------------------
// The integration half: a real run writes its own end
// ---------------------------------------------------------------------------

test('a real scheduled run writes its own ended line', () => {
  // The half a fixture cannot prove. The sweeper detaches and never learns the
  // exit status, so `ended` can only come from the CLI's own exit handler -- and
  // an assertion driven from hand-written JSONL would pass with that handler
  // deleted. This spawns the real fixer.
  const homeDir = emptyDir();
  const repoRoot = boardRepo();
  const script = fileURLToPath(new URL('../scripts/agent-fixer.mjs', import.meta.url));
  const at = new Date();

  const run = spawnSync(process.execPath, [script, repoRoot, '--scheduled'], {
    encoding: 'utf8',
    // `os.homedir()` reads USERPROFILE on Windows and HOME on POSIX, so both are
    // set: the child then resolves its journal under the fixture rather than under
    // the real user's home. No production seam is added for a test's sake, and the
    // default path is the one being exercised.
    env: { ...process.env, USERPROFILE: homeDir, HOME: homeDir },
    windowsHide: true,
  });

  // The run is expected to refuse — ADR 0008's gate is closed and that is the
  // point. What matters is that it recorded its own end on the way out.
  const entries = readJournalTail({ homeDir, at });
  const ended = entries.find((e) => e.agent === 'fixer' && e.event === JOURNAL_EVENTS.ENDED);
  assert.ok(ended, `no ended line was written; the run exited ${run.status}`);
  assert.equal(typeof ended.code, 'number');
});
