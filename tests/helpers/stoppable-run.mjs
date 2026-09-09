// A stand-in for a run that is between steps, used by tests/run-record.test.mjs to
// demonstrate ADR 0008 row 8 against two real processes rather than one mocked one.
//
// It is deliberately not a mock of the stop mechanism: it opens a real record
// with its own pid, blocks in the real `awaitStop`, and closes the real record.
// The only thing it stands in for is the work — a run doing something between
// `--claim` and the publisher is a run doing exactly this and taking longer.
//
// Contract with the test: it prints `ready` once the record is on disk, and exits
// 42 when a stop was honoured, 3 when it timed out waiting for one. Two distinct
// non-zero codes, so a test can never read a timeout as a stop.
import { openRunRecord, awaitStop, markStopped } from '../../scripts/lib/run-record.mjs';

const [, , repoRoot, runsDir, runId, issue, worktree, agent = 'fixer'] = process.argv;
// Phase 2: every run-scoped path is per-agent, and omitting the agent throws
// rather than silently using the flat layout. This process is a stand-in for a
// real run, so it carries one the way a real run does.
const io = { runsDir, agent };

const opened = openRunRecord({
  repoRoot,
  runId,
  issue: Number(issue),
  branch: `fix/${issue}-stoppable`,
  worktree: worktree || null,
}, io);
if (!opened.ok) {
  process.stderr.write(`could not open the record: ${opened.reason}\n`);
  process.exit(4);
}

process.stdout.write('ready\n');

const stop = awaitStop(repoRoot, runId, { timeoutMs: 30_000, pollMs: 25 }, io);
if (!stop) process.exit(3);

const closed = markStopped(repoRoot, runId, stop, io);
process.exit(closed.ok ? 42 : 5);
