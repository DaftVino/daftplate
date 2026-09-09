// A hunt is a run: `#194 (FORGE-260)` Phase 7, ADR 0008 rows 8 and 9.
//
// **This file spawns for real, for `tests/agent-sweep-argv.test.mjs`'s reason.**
// The property under test is "discoverable and stoppable by a human who did not
// start it", and a helper called in-process cannot distinguish a run the ledger
// holds from a value this test happens to have in a variable. So the hunt is a
// child process, the stop comes from a second child process, and the assertions
// are made from a third place — here.
//
// **What this file does not prove, stated rather than left to be inferred.** The
// stop is honoured at the ingest boundary and nowhere else: a hunt's lens
// invocations are performed by an interactive session, nothing polls between
// them, and so a stop that arrives mid-flight waits until the session comes back
// to ingest. Row 8's second half is delivered for the window this runner owns and
// no further. Nothing here enables an agent, and nothing here can — no code path
// below starts a scheduled run of anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import { EXIT_CODES } from '../scripts/lib/cli.mjs';
import { RUN_ID_CHARSET, agentForRunId } from '../scripts/lib/worktree.mjs';
import { listRunRecords, readRunRecord, requestStop, RUN_STATES } from '../scripts/lib/run-record.mjs';
import { newRunId } from '../scripts/agent-fixer.mjs';
import { newHuntRunId, HUNTER_AGENT } from '../scripts/agent-hunter.mjs';
import { inspect, render } from '../scripts/agent-menu.mjs';

const CHECKOUT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HUNTER = join(CHECKOUT_ROOT, 'scripts', 'agent-hunter.mjs');
const FIXER = join(CHECKOUT_ROOT, 'scripts', 'agent-fixer.mjs');

const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

/** One valid answer, so an ingest has something to accept. */
const ANSWER = JSON.stringify([{
  lens: 'export-integrity',
  path: 'scripts/publish.mjs',
  symbol: 'selectPaths',
  defectClass: 'dangling-reference',
  severity: 'high',
  severityReasoning: 'the export ships a file whose import resolves to a withheld path',
  evidence: 'reasoned',
  summary: 'an exported test imports a path the export withholds',
  detail: 'A stranger cloning the export cannot run the suite.',
  provenance: { doctrine: 'tests/publish.test.mjs guards', invocation: 'r1:export-integrity' },
}]);

/** Plan a hunt in a child process and hand back the run id it minted, read off
 *  the plan it printed rather than guessed at. */
function planHunt(repoRoot, runsDir, extra = []) {
  const child = run(HUNTER, [repoRoot, '--lens', 'export-integrity', '--runs-dir', runsDir, ...extra]);
  assert.equal(child.status, 0, `the hunt did not plan: ${child.stderr}`);
  return { child, runId: JSON.parse(child.stdout).runId };
}

// ---------------------------------------------------------------------------
// Row 8, first half — a hunt is in the ledger while it is running
// ---------------------------------------------------------------------------

test('a hunt is discoverable by a process that did not start it', () => {
  // Red before this phase: `agent-hunter.mjs` imported nothing from
  // `run-record.mjs`, so a hunt left no trace anywhere outside its own stdout and
  // the only way to find out one existed was to read a transcript — which is the
  // situation ADR 0008 row 8 names in so many words.
  //
  // MUTANT (M11): delete the `openRunRecord` call in `openHunt`. Every assertion
  // below fails, starting with the empty ledger.
  const repoRoot = makeRepo({});
  const runsDir = emptyDir();
  const { runId } = planHunt(repoRoot, runsDir);

  const records = listRunRecords(repoRoot, { runsDir });
  assert.equal(records.length, 1, 'the hunt left no record in the ledger');
  const [record] = records;
  assert.equal(record.runId, runId, 'the record names a different run than the plan printed');
  assert.equal(record.agent, HUNTER_AGENT);
  assert.equal(record.state, RUN_STATES.RUNNING);
  // Legal and deliberate: a hunt is not against an issue, and `openRunRecord`
  // already represents that.
  assert.equal(record.issue.number, null);
  // Row 9's "under what authority".
  assert.equal(record.authority.adr, '0008');
  assert.equal(record.authority.permissionMode, 'acceptEdits');
  // Not this process's pid. The planner exits; the session holds the run.
  assert.equal(record.authority.pid, null);
  // Row 9's "what ran".
  assert.equal(record.ran.command, 'agent-hunter.mjs');
  assert.ok(record.ran.argv.includes('--lens'), 'the record does not say what the run was asked to do');
});

test('the runs CLI lists a hunt without being told which agent produced it', () => {
  // D9's claim, exercised end to end through a separate process: `--stop` and
  // `--list` on the fixer's script resolve a run of ANY agent, which is why the
  // menu relays that one CLI for every agent. A human who has just been told an
  // agent is loose does not know which one.
  const repoRoot = makeRepo({});
  const runsDir = emptyDir();
  const { runId } = planHunt(repoRoot, runsDir);

  const listed = run(FIXER, [repoRoot, '--list', `--runs-dir=${runsDir}`]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(runId), 'the runs CLI cannot see a hunt');
  // A hunt claims no issue, and before this phase every one of these lines
  // interpolated `issue.number` unconditionally.
  assert.doesNotMatch(listed.stdout, /#null/, 'the listing printed a null issue number');
  assert.match(listed.stdout, /session-held/,
    'the listing reported a session-held run as a process that is not running');
});

// ---------------------------------------------------------------------------
// Row 8, second half — as far as it actually goes
// ---------------------------------------------------------------------------

test('a stop asked for by a second process is honoured when the hunt ingests', () => {
  // The verdict pass's third objection to this phase as written: a stop marker
  // with no honourer would make the prescribed test pass — `requestStop` returns
  // ok and `checkStop` finds the file — while proving nothing about
  // stoppability. So the honourer is asserted, not the marker: the ingest
  // refuses to do the work and closes the record.
  //
  // MUTANT (M12): delete the `checkStop` branch from the ingest half. The ingest
  // then exits 0 having written a report, and the record closes `reported`.
  const repoRoot = makeRepo({});
  const runsDir = emptyDir();
  const { runId } = planHunt(repoRoot, runsDir);

  const stopped = run(FIXER, [repoRoot, `--stop=${runId}`, `--runs-dir=${runsDir}`]);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, new RegExp(`stop requested for ${runId}`));
  assert.doesNotMatch(stopped.stdout, /#null/, 'the stop printed a null issue number');
  assert.doesNotMatch(stopped.stdout, /release it deliberately/,
    'the stop offered to release a claim on a run that claims nothing');
  assert.match(stopped.stdout, /honoured when that session next ingests/,
    'the stop did not say what will honour it');

  const answers = makeRepo({ 'export-integrity.json': ANSWER });
  const out = join(emptyDir(), 'report.md');
  const ingest = run(HUNTER, [
    repoRoot, '--lens', 'export-integrity', '--ingest', answers, '--out', out,
    '--run-id', runId, '--runs-dir', runsDir,
  ]);

  assert.equal(ingest.status, EXIT_CODES.STOPPED, `the ingest did not honour the stop: ${ingest.stdout}`);
  assert.equal(existsSync(out), false, 'a stopped hunt still wrote its report');
  assert.equal(readRunRecord(repoRoot, runId, { runsDir, agent: HUNTER_AGENT }).state, RUN_STATES.STOPPED);
});

test('the stopped exit code is not the refusal codes and not a clean run', () => {
  // A stop is not a refusal: the run was permitted and under way, and a human
  // asked it to stop. Reading it as GATED would tell an operator their agent is
  // switched off; reading it as 0 would hide it entirely.
  assert.notEqual(EXIT_CODES.STOPPED, EXIT_CODES.GATED);
  assert.notEqual(EXIT_CODES.STOPPED, EXIT_CODES.NO_DRIVER);
  assert.notEqual(EXIT_CODES.STOPPED, EXIT_CODES.USAGE);
  assert.notEqual(EXIT_CODES.STOPPED, 0);
  assert.notEqual(EXIT_CODES.STOPPED, 1);
});

// ---------------------------------------------------------------------------
// Row 9 — the record after the run, for the report-only mode
// ---------------------------------------------------------------------------

test('an ingested hunt closes its record as reported, having changed and published nothing', () => {
  // Row 9 asks what a run changed, tested and published. A report-only hunt's
  // honest answer to the first two is "nothing", and its answer to the third is
  // its report. That is why the row is recorded as met for THIS MODE only rather
  // than met outright — a `null` here is a fact about the mode, not a gap.
  //
  // MUTANT (M13): drop the `closeRunRecord` call. The record stays `running` for
  // ever and the menu keeps listing a finished hunt as live.
  const repoRoot = makeRepo({});
  const runsDir = emptyDir();
  const { runId } = planHunt(repoRoot, runsDir);

  const answers = makeRepo({ 'export-integrity.json': ANSWER });
  const out = join(emptyDir(), 'report.md');
  const ingest = run(HUNTER, [
    repoRoot, '--lens', 'export-integrity', '--ingest', answers, '--out', out,
    '--run-id', runId, '--runs-dir', runsDir,
  ]);
  assert.equal(ingest.status, 0, ingest.stderr);

  const record = readRunRecord(repoRoot, runId, { runsDir, agent: HUNTER_AGENT });
  assert.equal(record.state, RUN_STATES.REPORTED);
  assert.notEqual(record.endedAt, null, 'a closed record with no end time is not a record of a run');
  assert.equal(record.changed.files, null, 'a report-only hunt recorded changing something');
  assert.equal(record.published.commit, null);
  assert.equal(record.published.pr, null);
  assert.equal(record.published.comment, out, 'the record does not say where the report went');
  assert.match(readFileSync(out, 'utf8'), /nothing was filed/);

  assert.deepEqual(listRunRecords(repoRoot, { runsDir })
    .filter((r) => r.state === RUN_STATES.RUNNING), [], 'the finished hunt is still listed as live');
});

test('an ingest with no --run-id says the run stays open rather than closing it silently', () => {
  // The failure this warns about is invisible: the planning half opened a
  // record, and an ingest that closes none leaves it `running` in `--list` for
  // ever — a discovery surface telling an operator a hunt is under way when it
  // finished an hour ago.
  //
  // MUTANT: delete the `else` branch. The ingest then completes with no
  // indication that anything was left open.
  const repoRoot = makeRepo({});
  const runsDir = emptyDir();
  const { runId } = planHunt(repoRoot, runsDir);

  const answers = makeRepo({ 'export-integrity.json': ANSWER });
  const ingest = run(HUNTER, [
    repoRoot, '--lens', 'export-integrity', '--ingest', answers, '--runs-dir', runsDir,
  ]);
  assert.equal(ingest.status, 0, ingest.stderr);
  assert.match(ingest.stderr, /no --run-id/);
  assert.match(ingest.stderr, /stays open in `--list`/);
  assert.equal(readRunRecord(repoRoot, runId, { runsDir, agent: HUNTER_AGENT }).state, RUN_STATES.RUNNING,
    'the fixture did not actually leave a run open, so the warning is about nothing');
});

// ---------------------------------------------------------------------------
// The run id, and the two places it must agree with something else
// ---------------------------------------------------------------------------

test('a minted hunt run id is a legal path segment and names its own agent', () => {
  // Both properties are load-bearing and neither is obvious from the string.
  // `RUN_ID_CHARSET` is what keeps eight path families inside the runs root, and
  // the agent prefix is how `--stop <run id>` finds a hunt without being told
  // which agent produced it.
  //
  // MUTANT (M14): drop the `Z`-slicing `replace` and mint from a raw
  // `toISOString()`. The colons and dots make `RUN_ID_CHARSET` fail, which is
  // the traversal guard `#215 (FORGE-275)` built.
  const at = new Date('2026-09-03T04:15:00.000Z');
  const id = newHuntRunId(at);
  assert.match(id, RUN_ID_CHARSET);
  assert.equal(agentForRunId(id), HUNTER_AGENT);
  // The same timestamp shape the fixer's minter produces, pinned against it
  // rather than against a literal: two spellings of one shape is how one of them
  // quietly stops matching the charset.
  assert.equal(id.slice(`${HUNTER_AGENT}-`.length), newRunId('fixer', 1, at).split('-').at(-1));
});

test('a --run-id naming another agent is refused before anything is written', () => {
  // `assertRunIdAgent` would catch it, thrown out of a path builder as a stack
  // trace — for what is a typo on a command line.
  const repoRoot = makeRepo({});
  const runsDir = emptyDir();
  const child = run(HUNTER, [repoRoot, '--run-id', 'fixer-1-20260828T200000Z', '--runs-dir', runsDir]);
  assert.equal(child.status, EXIT_CODES.USAGE);
  assert.match(child.stderr, /names agent `fixer`, not hunter/);
  assert.deepEqual(listRunRecords(repoRoot, { runsDir }), [], 'a refused hunt still wrote to the ledger');
});

test('a scheduled tick opens no record, because a refused tick is not a run', () => {
  // The refusal happens before anything is written, exactly as it happens before
  // anything is spawned. A record for a tick nobody started would put a hunt that
  // never happened into `--list`.
  //
  // MUTANT: move `openHunt` above the `--scheduled` branch. The ledger is then
  // non-empty and this goes red.
  const repoRoot = makeRepo({});
  const runsDir = emptyDir();
  const child = run(HUNTER, [repoRoot, '--scheduled', '--runs-dir', runsDir]);
  assert.equal(child.status, EXIT_CODES.NO_DRIVER);
  assert.deepEqual(listRunRecords(repoRoot, { runsDir }), [], 'a refused scheduled tick opened a run record');
});

// ---------------------------------------------------------------------------
// The screen — asserted through render(), never through the state object
// ---------------------------------------------------------------------------

test('the menu counts a real hunt among the hunter\'s runs, and shows it as live', () => {
  // The verdict pass's fourth objection: the prescribed assertion — "the menu's
  // per-agent run count for the hunter is non-zero once a hunt record exists" —
  // was already green before this phase started, because
  // `tests/agent-menu-edits.test.mjs` opened a hunter record BY HAND. So this one
  // is driven from a spawned hunt and from nothing else, and it reads the count
  // off the rendered screen rather than off `state.agents[].runs`.
  //
  // MUTANT (M11 again): delete `openRunRecord` from `openHunt`. The hunter's RUNS
  // cell reads `0` and the LIVE RUNS block never appears.
  const repoRoot = makeRepo({ 'ROADMAP.md': '# ROADMAP\n\nBoard: the GitHub Project for this repository.\n\n## Now\n' });
  const homeDir = emptyDir();
  mkdirSync(join(homeDir, '.daftplate'), { recursive: true });
  const { runId } = planHunt(repoRoot, join(homeDir, '.daftplate', 'runs'));

  const checkoutRoot = makeRepo({
    'scripts/agent-fixer.mjs': '// stand-in\n',
    'scripts/agent-hunter.mjs': '// stand-in\n',
  });
  const lines = render(inspect({ repoRoot, checkoutRoot, homeDir }));

  const hunterRow = lines.find((l) => /^\s+\d+\s+hunter\s/.test(l));
  assert.ok(hunterRow, 'the hunter is not on the screen at all');
  assert.match(hunterRow, /1 live\s*$/, `the hunter's RUNS cell does not show the hunt: ${hunterRow}`);
  assert.ok(lines.some((l) => l.includes(runId)), 'the hunt never reaches the LIVE RUNS block');
});

test('a hunt with a standing stop request is still on the screen, because nothing has honoured it yet', () => {
  // The residual, asserted rather than described. A stop is recorded immediately
  // and honoured at the next ingest, so between those two moments the run is
  // legitimately still live — and a screen that hid it would be hiding the one
  // run an operator is currently interested in.
  const repoRoot = makeRepo({ 'ROADMAP.md': '# ROADMAP\n\nBoard: the GitHub Project for this repository.\n\n## Now\n' });
  const homeDir = emptyDir();
  mkdirSync(join(homeDir, '.daftplate'), { recursive: true });
  const runsDir = join(homeDir, '.daftplate', 'runs');
  const { runId } = planHunt(repoRoot, runsDir);

  const asked = requestStop({ repoRoot, runId, reason: 'the residual' }, { runsDir, agent: HUNTER_AGENT });
  assert.equal(asked.ok, true, asked.message);

  const checkoutRoot = makeRepo({
    'scripts/agent-fixer.mjs': '// stand-in\n',
    'scripts/agent-hunter.mjs': '// stand-in\n',
  });
  const lines = render(inspect({ repoRoot, checkoutRoot, homeDir }));
  assert.ok(lines.some((l) => l.includes(runId)),
    'a run with a standing stop request vanished from the screen before anything honoured it');
});

// ---------------------------------------------------------------------------
// The one thing this phase must not do
// ---------------------------------------------------------------------------

test('nothing in the hunt lifecycle writes an enablement file', () => {
  // ADR 0008's second condition is owner-held and no phase performs it as a side
  // effect. A hunt now writes to `~/.daftplate/` for the first time, so the
  // assertion is that what it writes is a ledger and never an enablement.
  const repoRoot = makeRepo({});
  const homeDir = emptyDir();
  const runsDir = join(homeDir, '.daftplate', 'runs');
  mkdirSync(runsDir, { recursive: true });
  const { runId } = planHunt(repoRoot, runsDir);

  const answers = makeRepo({ 'export-integrity.json': ANSWER });
  const out = join(emptyDir(), 'report.md');
  run(HUNTER, [repoRoot, '--lens', 'export-integrity', '--ingest', answers, '--out', out,
    '--run-id', runId, '--runs-dir', runsDir]);

  const state = inspect({ repoRoot, checkoutRoot: repoRoot, homeDir });
  for (const agent of state.agents) {
    assert.equal(agent.enabled, false, `${agent.id} came out of a hunt switched on`);
    assert.equal(agent.mayRun, false, `${agent.id} came out of a hunt authorized to run`);
  }
  assert.equal(existsSync(join(homeDir, '.daftplate', 'agents')), false,
    'a hunt created the directory the enablement files live in');
});
