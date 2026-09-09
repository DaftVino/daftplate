// The durable record of an unattended run, and the way a human who did not start
// one stops it. ADR 0008 rows 9 and 8, whose shape the ADR deferred on purpose.
//
// Phase 5 of docs/designs/2026-08-27-plan-delegated-fix-loop.md, for
// #193 (FORGE-259). It records and it requests; it invokes no agent, publishes
// nothing, and does not enable the feature — ADR 0008's Consequences gate
// enablement on an owner-held act.
//
// **Row 9 is eight answers, not a schema.** The ADR's own sentence names six
// things a record must identify — what ran, under what authority, against which
// issue, what it changed, what it tested, what it published — and this file has
// one field per answer plus `kind` and the two timestamps. The twenty-field
// record one panel seat proposed in round 1 was withdrawn (panel record, *What
// moved*) and is not revived here. Nothing is invented that a step of the loop
// did not already measure: `changed.baseCommit` is what `createWorktree` recorded
// at creation, `tested` is `assessReproduction`'s verdict, and `state` and
// `published.commit` are `publishRun`'s `{ outcome, commit }` verbatim rather
// than a third vocabulary laid over them.
//
// **Row 8 is a request, not a signal.** A stop is a file a second process writes
// under the runs root; the running process reads it and stops itself. The
// alternative — reading a pid out of the ledger and killing it — was rejected for
// the reason the reaper refuses a worktree it has no creation record for: a pid
// is not an identity. It is reused, and a stopper that signalled one would
// eventually end a process it knows nothing about, which is CLAUDE.md #5 for
// processes. The pid is still recorded, and `holderAlive` still reports on it,
// because a human deciding whether to end a process by hand needs it — but it is
// reported as evidence and never acted on.
//
// **A stop is not a delete, and this file deletes nothing at all.** It does not
// remove the worktree, release the claim, or clear the record. The publisher
// force-removes the replay checkout *it* made, and argues that distinction where
// it makes it; nothing here generalizes from it. A stopped run leaves its
// worktree exactly where it was, for a human to look at.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomically } from './atomic-write.mjs';
import {
  runsRoot, agentRoot, assertRunIdAgent, OUTCOME_PUBLISHED, OUTCOME_REPORTED,
} from './worktree.mjs';
import { AGENTS } from './agent-registry.mjs';

/** The field that proves a file under `records/` is this ledger's own, versioned
 *  so a later shape is a new kind rather than a silent reinterpretation of this
 *  one. Same discipline as `agent-fixer.mjs`'s `CLAIM_KIND`.
 *
 *  **Agent-neutral, not `agent-fixer`.** These named `agent-run`, a script Phase
 *  1 retired, and Phase 2 makes all three shared across agents rather than owned
 *  by one. The `/1` is deliberately not bumped: renaming a kind without a version
 *  bump is a silent format change, and it is safe here only because no record has
 *  ever been written — re-measured at the start of this phase, with the runs root
 *  absent on this machine. */
export const RECORD_KIND = 'daftplate.agent.record/1';
export const STOP_KIND = 'daftplate.agent.stop/1';

/**
 * The four states a run can be in.
 *
 * Two of them are `publishRun`'s own `outcome` values, imported rather than
 * retyped, so the record cannot drift from the publisher it describes. The other
 * two are the states the publisher never sees: a run that is still going, and one
 * that was stopped before it got there.
 */
export const RUN_STATES = {
  RUNNING: 'running',
  STOPPED: 'stopped',
  PUBLISHED: OUTCOME_PUBLISHED,
  REPORTED: OUTCOME_REPORTED,
};

/** Refusal reasons, exported so a caller branches on one rather than on prose. */
export const RECORD_REFUSALS = {
  EXISTS: 'record-exists',
  NO_RECORD: 'no-record',
  WRITE_FAILED: 'record-write-failed',
  ALREADY_REQUESTED: 'stop-already-requested',
  NO_RUN: 'no-such-run',
};

// ---------------------------------------------------------------------------
// Where things live — all of it under the runs root, none of it in a worktree
// ---------------------------------------------------------------------------

/**
 * The three directories row 8 and row 9 use, all siblings of `worktrees/`.
 *
 * Outside the worktree is the whole of row 9's requirement — "retained after the
 * worktree is gone" — and it is also what keeps the reaper working: a file
 * written inside a worktree is untracked content, and `reapWorktree` refuses a
 * dirty checkout. `publish-run.mjs` placed its body files here for that reason
 * and this follows it rather than re-deriving it.
 */
export function recordsDir(repoRoot, opts = {}) {
  return join(agentRoot(repoRoot, opts), 'records');
}

export function recordPath(repoRoot, runId, opts = {}) {
  assertRunIdAgent(runId, opts);
  return join(recordsDir(repoRoot, opts), `${runId}.json`);
}

export function stopsDir(repoRoot, opts = {}) {
  return join(agentRoot(repoRoot, opts), 'stops');
}

export function stopPath(repoRoot, runId, opts = {}) {
  assertRunIdAgent(runId, opts);
  return join(stopsDir(repoRoot, opts), `${runId}.json`);
}

export function settingsPath(repoRoot, runId, opts = {}) {
  assertRunIdAgent(runId, opts);
  return join(agentRoot(repoRoot, opts), 'settings', `${runId}.json`);
}

// ---------------------------------------------------------------------------
// Row 9 — the record
// ---------------------------------------------------------------------------

function writeRecord(path, record, { replace }) {
  const refusal = writeAtomically(path, `${JSON.stringify(record, null, 2)}\n`, { replace });
  return refusal ? { ok: false, reason: RECORD_REFUSALS.WRITE_FAILED, path, message: refusal } : { ok: true, path, record };
}

/**
 * Open the record for a run that is starting.
 *
 * `replace: false` — a hard-link publish that throws rather than overwriting, the
 * claim ledger's exclusion for the claim ledger's reason. A run id colliding with
 * an open record is a runner bug, and overwriting the record would erase the
 * authority the earlier run acted under, which is the one thing row 9 exists to
 * keep.
 *
 * Everything unknown at open time is present and null rather than absent. An
 * auditor reading a record of a run that died before it published should see
 * which answers were never filled in, not have to know which keys a complete
 * record would have had.
 */
export function openRunRecord({
  repoRoot, runId, issue, linearKey = null, issueTitle = null,
  branch = null, worktree = null, baseCommit = null,
  permissionMode = 'acceptEdits', pid = process.pid, startedAt = null,
}, opts = {}) {
  const record = {
    kind: RECORD_KIND,
    runId,
    state: RUN_STATES.RUNNING,
    startedAt: startedAt ?? new Date().toISOString(),
    endedAt: null,
    // Against which issue.
    issue: { number: issue ?? null, linearKey, title: issueTitle },
    // Under what authority. `adr` names the grant rather than restating it: the
    // rows are the contract and a copy here would be a second, editable one.
    authority: {
      adr: '0008',
      permissionMode,
      worktree,
      branch,
      pid,
      user: opts.user ?? userInfo().username,
    },
    // What ran. Filled by recordInvocation, once there is an argv to name.
    ran: { command: null, argv: null, prompt: null, status: null, account: null },
    // What it changed.
    changed: { baseCommit, files: null },
    // What it tested.
    tested: { reproduction: null, reason: null, tests: null, verdict: null },
    // What it published — `commit` is publishRun's own, and `state` above is its
    // `outcome`. Two values, not three.
    published: { commit: null, pr: null, comment: null },
  };
  const path = recordPath(repoRoot, runId, opts);
  const written = writeRecord(path, record, { replace: false });
  // One gate, and it is the atomic one. A prior `existsSync` would be a check with
  // a window after it; the hard-link publish is the exclusion, and the filesystem
  // is asked afterwards which of the two refusals happened — claimIssue's idiom,
  // for claimIssue's reason.
  if (!written.ok && existsSync(path)) return { ok: false, reason: RECORD_REFUSALS.EXISTS, path };
  return written;
}

/** The record for `runId`, or null. A file that does not parse, or that carries
 *  another `kind`, reads as null: this ledger reports only what it wrote. */
export function readRunRecord(repoRoot, runId, opts = {}) {
  const path = recordPath(repoRoot, runId, opts);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed?.kind === RECORD_KIND ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Every record under the runs root, oldest first, **across every agent**.
 *
 * The discovery half of row 8: a second process reads a directory and learns what
 * is running, without a transcript and without asking the runner anything. It
 * takes no agent on purpose — a human who has just been told an agent is loose
 * should not have to know *which* one in order to find it, and a listing that
 * required naming the agent first would fail row 8's "without reading a
 * transcript" by sending them somewhere else to look it up.
 *
 * Each record is stamped with the agent whose directory it came from, so the
 * caller can tell two runs apart without parsing a run id to do it.
 *
 * **A subdirectory is an agent only if the registry says so.** The runs root is a
 * real directory on a real machine and things end up in it; treating every
 * subdirectory as an agent would report a half-written temp directory as a run
 * nobody can stop.
 */
export function listRunRecords(repoRoot, opts = {}) {
  const agents = opts.agent ? [opts.agent] : AGENTS.map((a) => a.id);
  const out = [];
  for (const agent of agents) {
    const scoped = { ...opts, agent };
    const dir = recordsDir(repoRoot, scoped);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const record = readRunRecord(repoRoot, name.slice(0, -'.json'.length), scoped);
      if (record) out.push({ ...record, agent });
    }
  }
  return out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

function updateRecord(repoRoot, runId, mutate, opts = {}) {
  const held = readRunRecord(repoRoot, runId, opts);
  if (!held) return { ok: false, reason: RECORD_REFUSALS.NO_RECORD, path: recordPath(repoRoot, runId, opts) };
  return writeRecord(recordPath(repoRoot, runId, opts), mutate(held), { replace: true });
}

/**
 * Record what ran: the command, its argv, and a digest of the prompt.
 *
 * Written when the agent is invoked and not at the end, because "what ran, under
 * what authority" is exactly the question asked about a run that never reached an
 * end. A run killed at its budget has no publish result and still has an argv.
 *
 * **The prompt is digested, not stored.** It carries the issue body and whatever
 * the sourcing step pulled in with it, and a record kept for audit is the wrong
 * place for a copy of it. The digest is enough to answer the question a record is
 * asked — whether two runs were given the same instructions — and the argv, which
 * is where every ADR 0008 row 1 and 2 flag lives, is kept in full.
 */
export function recordInvocation(repoRoot, runId, { command, args = [], prompt = null }, opts = {}) {
  const text = prompt === null ? null : String(prompt);
  // Matched by value rather than by position: buildInvocation puts the prompt
  // last today, and a record that assumed so would quietly start storing an
  // extraArg the day that changes.
  const argv = args.map(String).filter((arg) => text === null || arg !== text);
  return updateRecord(repoRoot, runId, (held) => ({
    ...held,
    ran: {
      command: command ?? null,
      argv,
      prompt: text === null ? null : {
        bytes: Buffer.byteLength(text, 'utf8'),
        sha256: createHash('sha256').update(text).digest('hex'),
      },
      status: held.ran.status,
    },
  }), opts);
}

/**
 * Close the record with what the publisher decided.
 *
 * `publish` is `publishRun`'s return value, read for the two fields it already
 * returns in the shape `reapWorktree` consumes — `outcome` and `commit` — plus
 * the reproduction it measured on the way. Nothing is recomputed here and nothing
 * is asked of the agent: a record assembled from the run's self-report would
 * describe the run's opinion of itself, which is the thing the whole construction
 * exists not to trust.
 */
export function closeRunRecord(repoRoot, runId, { publish = null, generation = null, endedAt = null, account = null }, opts = {}) {
  const reproduction = publish?.reproduction ?? null;
  return updateRecord(repoRoot, runId, (held) => ({
    ...held,
    state: publish?.outcome ?? RUN_STATES.REPORTED,
    endedAt: endedAt ?? new Date().toISOString(),
    // `account` is the path to what the run said it did — evidence a human reads,
    // never something the publisher consults. Named here so it is found without
    // knowing the layout, for the same reason row 9 keeps the record outside the
    // worktree: the checkout is disposable and the account has to outlive it.
    ran: { ...held.ran, status: generation?.agent?.status ?? held.ran.status, account: account ?? held.ran.account ?? null },
    changed: { ...held.changed, files: reproduction?.changed ?? held.changed.files },
    tested: {
      reproduction: reproduction ? reproduction.ok === true : held.tested.reproduction,
      reason: reproduction?.reason ?? publish?.reason ?? null,
      tests: reproduction?.tests ?? held.tested.tests,
      verdict: reproduction?.replay?.verdict ?? held.tested.verdict,
    },
    published: {
      commit: publish?.commit ?? null,
      pr: publish?.pr?.url ?? null,
      comment: publish?.comment?.path ?? null,
    },
  }), opts);
}

// ---------------------------------------------------------------------------
// Row 8 — discovery and stop
// ---------------------------------------------------------------------------

/**
 * Is the process that opened this record still running?
 *
 * `kill(pid, 0)` asks the OS and changes nothing. It is **evidence and not
 * proof**: pids are reused, so a live answer can be about a process that has
 * nothing to do with this run. Stated here rather than left implicit, because it
 * is the reason nothing in this file signals a pid — and because a listing that
 * printed "running" without the caveat would be the transcript-free discovery row
 * 8 asks for, telling a lie.
 */
export function holderAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Ask a run to stop. Writes a file and does nothing else.
 *
 * `replace: false` again, and here it is the point rather than a precaution: a
 * second stop request must not overwrite the first, because the first is the
 * record of who asked and when. Two people stopping the same run is a normal
 * thing to happen, and the second one being told the request already stands is
 * the correct answer.
 *
 * It removes nothing. Not the worktree — this process did not create it, and
 * `reapWorktree` would refuse it anyway, which is the design working rather than
 * an obstacle to route around. Not the claim — releasing one is `--release`, a
 * deliberate act by a human who has looked at what the run left behind.
 */
export function requestStop({ repoRoot, runId, issue = null, reason = null, by = null }, opts = {}) {
  const path = stopPath(repoRoot, runId, opts);
  const request = {
    kind: STOP_KIND,
    runId,
    issue,
    requestedAt: new Date().toISOString(),
    requestedBy: by ?? { pid: process.pid, user: opts.user ?? userInfo().username },
    reason: reason ?? null,
  };
  const refusal = writeAtomically(path, `${JSON.stringify(request, null, 2)}\n`, { replace: false, link: opts.link });
  if (refusal) {
    if (existsSync(path)) {
      return { ok: false, reason: RECORD_REFUSALS.ALREADY_REQUESTED, path, request: checkStop(repoRoot, runId, opts) };
    }
    return { ok: false, reason: RECORD_REFUSALS.WRITE_FAILED, path, message: refusal };
  }
  return { ok: true, path, request };
}

/** The standing stop request for `runId`, or null. Validated by `kind` for the
 *  claim ledger's reason: a file somebody dropped under `stops/` is not a
 *  request, and reading it as one would stop a run on a stranger's say-so. */
export function checkStop(repoRoot, runId, opts = {}) {
  const path = stopPath(repoRoot, runId, opts);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed?.kind === STOP_KIND ? parsed : null;
  } catch {
    return null;
  }
}

/** Sleep without a dependency and without a busy-wait. atomic-write.mjs's, for
 *  atomic-write.mjs's reason; three lines is not worth a shared import that would
 *  make a writer's internals part of its API. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Block until a stop is requested, or until the deadline passes.
 *
 * The honoured half of row 8, and the half that is measured: the runner calls it
 * between the steps of a run, and a stop that arrives is a stop that lands. It
 * cannot reach inside the one long call a run makes — `spawnSync` of the agent —
 * and `buildStopSettings` below is what addresses that window.
 */
export function awaitStop(repoRoot, runId, { timeoutMs = 60_000, pollMs = 100 } = {}, opts = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stop = checkStop(repoRoot, runId, opts);
    if (stop) return stop;
    if (Date.now() >= deadline) return null;
    pause(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

/** Close the record because a stop was honoured. A terminal state like any other,
 *  and the stop request file is left in place beside it: the record says the run
 *  stopped, the request says who asked it to. */
export function markStopped(repoRoot, runId, request = null, opts = {}) {
  return updateRecord(repoRoot, runId, (held) => ({
    ...held,
    state: RUN_STATES.STOPPED,
    endedAt: new Date().toISOString(),
    tested: { ...held.tested, reason: request?.reason ?? held.tested.reason },
  }), opts);
}

// ---------------------------------------------------------------------------
// The stop the agent session honours — the surface no panel seat looked for
// ---------------------------------------------------------------------------

/**
 * Command shapes an unattended run is launched denied. `#205 (FORGE-266)` AC 3.
 *
 * **Defence in depth against the accidental path. Never a boundary, and nothing
 * may describe it as one.** ADR 0008 rejected tool allowlists as boundaries
 * because a shell is arbitrary execution, and the argument applies to a denylist
 * unchanged: the same publication is reachable through `curl` against
 * `api.github.com/gists`, through a script the run writes and then runs, through
 * `git` against `gist.github.com`, or through any of them shaped so the pattern
 * misses. These match a *prefix of a Bash command string*, so `cd x && gh gist
 * create …`, `GH_TOKEN=… gh gist …` and `gh  gist` with two spaces are all
 * unmatched. It bounds the typed gesture. It does not bound the capability.
 *
 * **Which is why it is not the thing standing between a run and a public gist.**
 * The generation step holds no credential at all: `agent-invoke.mjs` redirects
 * `GH_CONFIG_DIR`, measured at P3b as `gh` answering *"To get started with GitHub
 * CLI, please run: `gh auth login`"*, and `verifyIsolation` requires a live
 * refusal before a run is invoked. This intercepts the gesture one layer earlier
 * than that, and is worth its one settings entry for the case where the isolation
 * is wrong — not as the reason to believe it is right.
 *
 * The accidental shape is specific and worth naming: a run told to *share the
 * failing output* reaches for `gh gist create <path>`, which is correct behaviour
 * against an ambiguous instruction rather than a mistake. The instructional half
 * of that lives in `RUN_PROHIBITIONS`; a denylist cannot reach a decision.
 */
/**
 * The two commands an unattended run is launched able to run. `#321 (FORGE-359)`.
 *
 * **This restores ADR 0008's grant; it does not widen it.** Row 3 already permits a
 * run to push its own branch and row 4 to open a pull request, and committing inside
 * a disposable worktree is strictly less than either. The architecture is stricter
 * still: the run pushes nothing at all — `publish-run.mjs` does, out of process and
 * behind `ALLOWED_GH_COMMANDS`.
 *
 * The run could not commit at all until this. Measured 2026-09-05 on Claude Code
 * 2.1.261 (`docs/designs/relay-probes/results-2026-09-05-acceptedits-bash.md`):
 * `acceptEdits` auto-accepts Write and refuses mutating Bash with *"This command
 * requires approval"*, there being no human to ask. ADR 0008 line 62 says
 * `acceptEdits` auto-accepts Bash; that was measured against 2.1.247 and is no longer
 * true. Five real runs produced complete work and could not commit a line of it.
 *
 * **Deliberately not the suite.** `npm test` and `node --test` are not here. The
 * publisher replays the run's committed tests itself, in its own checkout, in the
 * runner process — so the reproduction predicate never depended on the agent
 * executing anything. Granting them would hand arbitrary code execution to a run that
 * has none, to buy something publication does not need.
 *
 * **A prefix match, not a boundary**, exactly as `DENIED_PUBLICATION` is not one.
 * `git -C <elsewhere> add` and `cd elsewhere && git add` do not match these patterns,
 * which bounds the typed gesture; what bounds the filesystem is row 2's `cwd`.
 */
export const ALLOWED_WORK = [
  'Bash(git add:*)',
  'Bash(git commit:*)',
];

export const DENIED_PUBLICATION = [
  'Bash(gh gist:*)',
  'Bash(gh api gists:*)',
  'Bash(gh api /gists:*)',
];

/**
 * A run-scoped `--settings` file whose hook reads this run's stop request.
 *
 * The panel record's *What no seat looked for* names the surface: a headless run
 * inherits this user's `~/.claude/` — every skill, every hook — and `--settings`
 * and `--agent` exist and no seat examined either. This is the cheapest reach
 * into the only window the runner-side poll cannot cover, which is the whole
 * duration of the agent process.
 *
 * **Scoped to one hook, deliberately.** The same seam could be used to narrow
 * what an unattended session loads from `~/.claude/`, and that is a larger and
 * unmeasured decision: settings levels merge, so "strip the inherited hooks" is
 * not a thing this file can assert it did. Doing one measurable thing here and
 * naming the rest as unexamined is the honest version.
 *
 * **What is and is not measured.** The hook script is a real process and is
 * tested as one — given a standing request it emits the stop, given none it emits
 * nothing. Its *effect on a live Claude Code session* is not measured by this
 * phase, because no unattended run is enabled to measure it against (ADR 0008,
 * Consequences). It is the second of two honourers, not the load-bearing one, and
 * Phase 6's journey is where it gets its first real exercise.
 */
export function buildStopSettings({ repoRoot, runId }, opts = {}) {
  const stop = stopPath(repoRoot, runId, opts);
  // The runner's own copy of the hook, resolved from this module rather than from
  // the worktree. The worktree copy is inside the agent's write boundary — under
  // `acceptEdits` it may edit anything in `cwd` — so a hook read from there is a
  // stop the run could switch off.
  const hook = resolve(dirname(fileURLToPath(import.meta.url)), 'run-stop-hook.mjs');
  return {
    hook,
    stop,
    settings: {
      permissions: { allow: [...ALLOWED_WORK], deny: [...DENIED_PUBLICATION] },
      hooks: {
        PreToolUse: [{
          matcher: '*',
          hooks: [{
            type: 'command',
            command: `"${process.execPath}" "${hook}" "${stop}"`,
          }],
        }],
      },
    },
  };
}

/** Write that settings file and return the `extraArgs` an invocation carries it
 *  with. `buildInvocation` passes `extraArgs` through `assertInvocationSafe` with
 *  everything else, which is why the seam is used rather than a second argv
 *  builder — a flag that skipped the guard would be a flag nobody audits. */
export function stopSettingsArgs({ repoRoot, runId }, opts = {}) {
  const built = buildStopSettings({ repoRoot, runId }, opts);
  const path = settingsPath(repoRoot, runId, opts);
  const refusal = writeAtomically(path, `${JSON.stringify(built.settings, null, 2)}\n`, { replace: true });
  if (refusal) return { ok: false, reason: RECORD_REFUSALS.WRITE_FAILED, path, message: refusal };
  return { ok: true, path, extraArgs: ['--settings', path], ...built };
}

export { OUTCOME_PUBLISHED, OUTCOME_REPORTED };
