// The runner skeleton for the delegated-fix loop: which board this repo is on,
// which issues have been delegated on it, and which of them this machine has
// already claimed.
//
// Phase 2 of docs/designs/2026-08-27-plan-delegated-fix-loop.md, for
// #193 (FORGE-259). It detects, polls, claims and hands back a worktree path.
// It invokes no agent (Phase 3) and publishes nothing (Phase 4) — not behind a
// flag, not in a comment, not as a stub that a later phase only has to enable.
// The whole feature is off: ADR 0008's Consequences gate enablement on an
// owner-held act, and no phase performs one as a side effect of its own build.
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { runCli, violation, reportViolations, EXIT_CODES } from './lib/cli.mjs';
import { writeAtomically } from './lib/atomic-write.mjs';
import {
  runsRoot, agentRoot, worktreePath, createWorktree, reapWorktree, ownedWorktrees, branchExists,
  agentForRunId, OUTCOME_PUBLISHED, OUTCOME_REPORTED,
} from './lib/worktree.mjs';
import {
  openRunRecord, listRunRecords, readRunRecord, requestStop, checkStop, holderAlive,
  recordInvocation, closeRunRecord, markStopped, stopSettingsArgs,
  RUN_STATES, RECORD_REFUSALS,
} from './lib/run-record.mjs';
import { sourceAcceptanceCriteria, runGeneration } from './lib/agent-invoke.mjs';
import { publishRun, writeRunAccount, repoShortName } from './lib/publish-run.mjs';
import { composePrompt } from './lib/agent-brief.mjs';
import { agentById, AGENTS } from './lib/agent-registry.mjs';
import { recordEndOnExit } from './lib/agent-state.mjs';
import { ENABLEMENT_CONDITIONS, runAuthorization } from './lib/enablement.mjs';

/** The registry ids a run id may name. Read from the registry so a third agent
 *  needs no edit here. */
const AGENT_IDS = AGENTS.map((a) => a.id);

/** The delegation gesture on the GitHub Projects variant (spec, *Trigger*). */
export const DELEGATION_LABEL = 'agent:delegated';

/** Which registry entry this script is. Taken from the registry rather than
 *  written again here, so the id has one source and a rename cannot leave this
 *  file naming an agent that no longer exists. */
export const THIS_AGENT = agentById('fixer').id;

/** The one field that proves a file under `claims/` is this ledger's own.
 *
 *  Agent-neutral: it named `agent-run`, a script Phase 1 retired, and the ledger
 *  is shared machinery rather than the fixer's own. `/1` is deliberately not
 *  bumped — see the note on `RECORD_KIND`. */
export const CLAIM_KIND = 'daftplate.agent.claim/1';

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

/**
 * Which §6.5 board variant this repo is on, read from `ROADMAP.md` and nowhere
 * else.
 *
 * The reasoning is `/continuum` §4's and is cited rather than re-derived:
 * `check-roadmap.mjs` fails any repo where more than one line beginning `Board:`
 * survives, so the one that does is that repo's single declaration of its
 * variant. `CLAUDE.md` prose is unconstrained and an ADR records the decision
 * rather than its current state; neither can carry this.
 *
 * Where this runner departs from `/continuum` is what it does with a miss.
 * `/continuum` skips in silence, because naming the board is an enrichment step
 * there. Here it is the trigger: with no variant there is nothing to poll, and a
 * runner that went quiet would look like a board with no delegated work. Every
 * miss is therefore a refusal with a reason.
 */
export function detectBoard(roadmapText) {
  const lines = roadmapText.split(/\r?\n/);
  const starts = lines.reduce((at, line, i) => (line.startsWith('Board:') ? [...at, i] : at), []);
  if (starts.length === 0) return { ok: false, reason: 'no-board-line' };
  // Refused rather than resolved by taking the first, for checkout-marker.mjs's
  // reason: two declarations mean the repo's variant is not established, and
  // picking one would poll the wrong board without saying so.
  if (starts.length > 1) return { ok: false, reason: 'ambiguous-board', count: starts.length };

  // The declaration is a wrapped paragraph, not a line. `check-roadmap.mjs` counts
  // lines beginning `Board:` because uniqueness is all it needs; reading only that
  // first line here would miss what continues onto the second — in the template's
  // own Linear block, that is the team name.
  const end = lines.findIndex((l, i) => i > starts[0] && l.trim() === '');
  const declaration = lines.slice(starts[0], end === -1 ? undefined : end).join('\n');
  // Linear first: its declaration also says "GitHub is canonical for whether an
  // issue exists", so a GitHub-Projects test run first would match it. The GitHub
  // Projects block carries no "Linear" at all, which is what makes this order safe.
  if (/\bLinear\b/.test(declaration)) {
    const team = declaration.match(/team `([^`]+)`/)?.[1] ?? null;
    return { ok: true, variant: 'linear', declaration, team };
  }
  if (/GitHub Project/.test(declaration)) {
    return { ok: true, variant: 'github-projects', declaration, team: null };
  }
  return { ok: false, reason: 'unrecognized-board', declaration };
}

/** `detectBoard` against a repository on disk. A repo with no `ROADMAP.md` is
 *  either pre-template or on an `optional` profile; either way it declares no
 *  variant, so there is no board to poll. */
export function readBoard(repoRoot) {
  const path = join(resolve(repoRoot), 'ROADMAP.md');
  if (!existsSync(path)) return { ok: false, reason: 'no-roadmap' };
  return detectBoard(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// The poll
// ---------------------------------------------------------------------------

function defaultGh(args, cwd) {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/**
 * Why a `gh` call failed, in words, never an empty string.
 *
 * A failing `gh` gives its reason on stderr — unless the binary is not there at
 * all, in which case `spawnSync` reports through `error` and both streams are
 * empty. `main` used to print the message falling back on the reason with `??`,
 * which falls back only on null and undefined, so an empty message printed an
 * **empty line**: a refusal that names nothing. `refusalWords` now honours the
 * empty string at every print site; this function is the same rule kept where the
 * value is made, and both are wanted.
 *
 * Found by CI on Linux, where `gh` is absent, against a suite green on Windows,
 * where it is not. Neither platform's run is evidence about the other and this is
 * what that costs when it goes unchecked.
 */
function ghFailureMessage(r, reason) {
  return (r.stderr || r.stdout || r.error?.message || '').trim() || reason;
}

/**
 * The issues delegated on this repo's board.
 *
 * Poll, do not receive — the issue's own recommendation, kept: no inbound
 * surface, no tunnel, no secret to rotate, at a latency a delegation measured in
 * hours does not feel.
 *
 * **Both variants poll the same label, and the Linear one does so without a Linear
 * credential.** This used to refuse outright on the Linear variant, reasoning that
 * delegation there is a *workflow state* (spec, *Trigger*), that the GitHub Issues
 * Sync does not project a state back onto the issue, and that therefore nothing a
 * `gh` call could read would be evidence of a delegation. Every step of that was
 * true and the conclusion was still wrong, because it never tested whether some
 * *other* gesture crosses the sync.
 *
 * One does. Measured 2026-08-28 against a Linear-synced repository on this team:
 * `agent:delegated` applied in Linear appeared on the GitHub issue at `13:42:14Z`
 * and its removal at `13:42:43Z`, with a second label removed and re-added inside
 * the same window — the sync reconciling the whole label set, not somebody clicking
 * twice. So a label applied in Linear is readable by `gh` within seconds, and the
 * Projects code path already reads it. The repository and issue are named in the
 * measurement on `#193 (FORGE-259)` rather than here, because this file ships.
 *
 * The old objection — that a label would *"substitute a gesture the spec did not
 * choose"* — is answered rather than ignored: the gesture the spec chose is
 * unreachable from here by construction, and the owner performs this one in Linear
 * exactly where they already work.
 *
 * The `DELEGATION_STATE` constant this file used to export went with the refusal.
 * Nothing read it once the refusal was gone — one test imported it and never used
 * it — and an exported constant with no reader is the shape `#307 (FORGE-351)` was
 * filed about. The spec's `Trigger` still names the state; a reader belongs there,
 * not at a constant kept alive to agree with it.
 */
export function pollDelegated(board, opts = {}) {
  if (!board.ok) return { ok: false, reason: board.reason };

  const gh = opts.gh ?? defaultGh;

  // **The label must be known to exist before its absence can mean anything.**
  // `gh issue list --label <nonexistent>` exits 0 with `[]`, which is byte-identical
  // to "the label exists and nothing is delegated". Skipping this check makes a repo
  // that never got the label poll clean on every tick, forever, without ever saying
  // why — the silent failure, not the loud one.
  //
  // It is asked on both variants because the hazard is per-repo rather than
  // per-board: a team-level Linear label does not propagate to every synced
  // repository. Measured 2026-08-28 across five Linear-synced repositories on one
  // team — present in two, absent from three, appearing per-repo on first use. The
  // repositories are named in the measurement on `#193 (FORGE-259)`, not here.
  const labels = gh(['label', 'list', '--search', DELEGATION_LABEL, '--json', 'name'], opts.repoRoot);
  if (labels.status !== 0) {
    return { ok: false, reason: 'gh-unavailable', message: ghFailureMessage(labels, 'gh-unavailable') };
  }
  let known;
  try {
    known = JSON.parse(labels.stdout);
  } catch {
    return { ok: false, reason: 'gh-unreadable', message: labels.stdout.trim().slice(0, 200) };
  }
  // Exact match: `--search` is a substring query, so `agent:delegated-later` would
  // otherwise answer for `agent:delegated`.
  if (!known.some((l) => l.name === DELEGATION_LABEL)) {
    return {
      ok: false,
      reason: 'no-delegation-label',
      message: `this repository has no \`${DELEGATION_LABEL}\` label, so a poll for it`
        + ' cannot tell "nothing is delegated" from "the gesture does not exist here"'
        + ' — create it on the repository, or apply it once in Linear and let the sync create it',
    };
  }

  const r = gh([
    'issue', 'list', '--state', 'open', '--label', DELEGATION_LABEL,
    '--json', 'number,title', '--limit', '30',
  ], opts.repoRoot);
  if (r.status !== 0) {
    return { ok: false, reason: 'gh-unavailable', message: ghFailureMessage(r, 'gh-unavailable') };
  }
  let issues;
  try {
    issues = JSON.parse(r.stdout);
  } catch {
    return { ok: false, reason: 'gh-unreadable', message: r.stdout.trim().slice(0, 200) };
  }
  return { ok: true, issues };
}

// ---------------------------------------------------------------------------
// The claim ledger
// ---------------------------------------------------------------------------

export function claimsDir(repoRoot, opts = {}) {
  // Under the agent, not the repository. `claimPath` keyed on the issue number
  // alone, so the hunter reading `#193` took the claim the fixer was holding —
  // one ledger, one file per issue, two agents.
  return join(agentRoot(repoRoot, opts), 'claims');
}

/**
 * The claim file for one issue.
 *
 * **The issue is a path segment too, and this is the one run-scoped family whose
 * key is not a run id** — so `assertRunIdAgent`, which every other family passes
 * through, never sees it. Measured while writing the traversal table for
 * `#215 (FORGE-275)`: `claimPath(REPO, '../../evil', io)` resolved to
 * `…/runs/<key>/evil.json`, two levels above the agent root, and the backslash
 * spelling resolved to the same place.
 *
 * It is not reachable today — `--issue` is parsed with `/^[1-9][0-9]*$/` and
 * `runIssue` takes `issue.number` off the `gh` JSON — so this is the containment
 * holding by the good manners of every caller rather than by a check, which is
 * exactly what `assertRunIdAgent` was found doing in this same issue. The class
 * is `Number.isInteger`, the spelling `newRunId` already uses for the same value,
 * rather than a second traversal regex nobody would keep in step with it.
 */
export function claimPath(repoRoot, issue, opts = {}) {
  if (!Number.isInteger(issue)) {
    throw new Error(`a claim is keyed on the issue number, and \`${String(issue)}\` is not one`
      + ' — the issue becomes a path segment, so a separator or a dot in it names'
      + ' a file outside the claim ledger rather than a claim inside it');
  }
  return join(claimsDir(repoRoot, opts), `${issue}.json`);
}

/**
 * Claim an issue, or refuse because someone already has.
 *
 * The exclusion is `writeAtomically(..., { replace: false })` — a hard-link
 * publish that throws EEXIST rather than overwriting. That module exists and
 * already argues why this is neither a checked rename (a rival between the check
 * and the rename is silently destroyed) nor `COPYFILE_EXCL` (observable at zero
 * length while it fills, which a concurrent reader would take for a claim with no
 * holder). A second poll racing the first loses the link and reads the winner's
 * file; there is no window in which it reads half of one.
 *
 * **A claim does not expire, and nothing breaks one automatically.** The
 * alternatives were a TTL and a liveness check, and both re-claim an issue whose
 * worktree may still be open — on Windows, still holding a lock — which is the
 * one situation where two runs sharing a checkout is most likely and least
 * visible. A stuck claim is cheap by comparison: v1 fixes one issue at a time,
 * the claim file names its holder, its pid and when it started, and clearing it
 * is `--release`, a deliberate act by a human who has looked. Phase 5's kill
 * switch (ADR 0008 row 8) inherits this ledger and is where "stoppable by
 * somebody who did not start it" gets its design; it is not smuggled in here.
 */
export function claimIssue(claim, opts = {}) {
  const { repoRoot, issue } = claim;
  const path = claimPath(repoRoot, issue, opts);
  const record = {
    kind: CLAIM_KIND,
    issue,
    runId: claim.runId,
    branch: claim.branch ?? null,
    worktree: claim.worktree ?? null,
    pid: claim.pid ?? process.pid,
    startedAt: claim.startedAt ?? new Date().toISOString(),
  };
  // Only the two keys writeAtomically reads are forwarded. Passing the ledger's
  // own options through would hand it a `rename` or a `link` any caller happened
  // to name, and `replace: false` is the whole exclusion.
  const refusal = writeAtomically(path, `${JSON.stringify(record, null, 2)}\n`, {
    replace: false, link: opts.link,
  });
  if (refusal) {
    // The refusal string does not distinguish "a rival got there first" from "this
    // filesystem has no hard links", and the two want opposite answers, so the
    // question is asked of the filesystem instead of parsed out of the prose.
    if (existsSync(path)) {
      return { ok: false, reason: 'already-claimed', path, holder: readClaim(repoRoot, issue, opts) };
    }
    return { ok: false, reason: 'claim-write-failed', path, message: refusal };
  }
  return { ok: true, path, claim: record };
}

/** The claim on `issue`, or null. An unparseable or foreign file reads as null:
 *  this ledger reports only what it can prove it wrote. */
export function readClaim(repoRoot, issue, opts = {}) {
  const path = claimPath(repoRoot, issue, opts);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed?.kind === CLAIM_KIND ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Drop a claim. The deliberate act that a claim never expiring makes necessary.
 *
 * It removes a file only after reading it back and finding this ledger's own
 * `kind` — CLAUDE.md #5 applied to the smallest thing the runner deletes. A file
 * under `claims/` that does not parse as a claim is somebody else's, and is
 * reported rather than removed.
 */
export function releaseClaim(repoRoot, issue, opts = {}) {
  const path = claimPath(repoRoot, issue, opts);
  if (!existsSync(path)) return { ok: false, reason: 'no-claim', path };
  const held = readClaim(repoRoot, issue, opts);
  if (!held) return { ok: false, reason: 'foreign-file', path };
  unlinkSync(path);
  return { ok: true, path, released: held };
}

// ---------------------------------------------------------------------------
// Branch naming
// ---------------------------------------------------------------------------

/** `type/N-slug`, the shape `setup-repo.mjs`'s pre-push hook enforces. Built here
 *  so the branch a run pushes in Phase 4 is one the hook will accept; a run whose
 *  branch the hook refuses has done all its work and cannot publish it. */
export function branchForIssue(issue, title, type = 'fix') {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-');
  return `${type}/${issue}-${slug || 'issue'}`;
}

/** How many names one issue may burn through before the runner stops guessing. */
export const MAX_BRANCH_ATTEMPTS = 50;

/**
 * The first `type/N-slug` this repository does not already carry.
 *
 * `reapWorktree` removes a worktree and leaves its branch, deliberately: the
 * branch may hold the commits a pull request was opened from, and deleting it
 * would be deleting work (CLAUDE.md #5). The consequence is that a **second run
 * on one issue meets its own leftover** — `git worktree add -b` refuses a name
 * that exists — and the spec's repeat-delegation case says to start clean in a
 * new worktree and report that a prior one exists, not to stop. Measured: after
 * `git worktree remove`, `refs/heads/fix/193-a` survives and the next add fails
 * `fatal: a branch named 'fix/193-a' already exists`.
 *
 * So the name gains a numeric segment. The pre-push hook still accepts it, because
 * every segment stays lowercase alphanumeric — that is asserted against the hook's
 * own pattern rather than assumed.
 *
 * Returns `{ branch, priorAttempts }`, or `{ branch: null, reason }` once the cap
 * is reached: fifty leftover branches for one issue is a repository nobody is
 * cleaning up, and guessing a fifty-first would hide that rather than report it.
 */
export function freeBranchForIssue(repoRoot, issue, title, type = 'fix', opts = {}) {
  const base = branchForIssue(issue, title, type);
  if (!branchExists(repoRoot, base, opts)) return { branch: base, priorAttempts: 0 };
  for (let n = 2; n <= MAX_BRANCH_ATTEMPTS; n += 1) {
    const candidate = `${base}-${n}`;
    if (!branchExists(repoRoot, candidate, opts)) return { branch: candidate, priorAttempts: n - 1 };
  }
  return { branch: null, priorAttempts: MAX_BRANCH_ATTEMPTS, reason: 'branch-names-exhausted', base };
}

/**
 * A run id, in one place, because the loop and `--claim` must name a run the same
 * way or `--list` shows two vocabularies for the same thing.
 *
 * **It leads with the agent.** The old form was `run-<issue>-<timestamp>`, which
 * is the same string for two agents polling one issue at one instant — so
 * `--list` showed two runs it could not tell apart and the second record written
 * replaced the first.
 *
 * A missing agent throws rather than producing `undefined-193-…`: the run id is
 * the key every path family derives from, and one built without an agent
 * reintroduces exactly the collision the per-agent subdirectory removes.
 */
export function newRunId(agent, issue, at = new Date()) {
  // Checked against the registry, not merely for being truthy.
  //
  // A falsy-only guard let `newRunId(5)` through — the pre-Phase-2 single-argument
  // call, with the ISSUE number landing in the agent position. It produced
  // `5-undefined-<timestamp>`: a run id naming an agent that does not exist, for
  // an issue that is not a number, which every path family would then have keyed
  // off. Five such call sites survived the rename in `tests/agent-loop.test.mjs`
  // and nothing caught them, because they also passed an explicit `runId`
  // override and the malformed value was silently discarded.
  if (!AGENT_IDS.includes(agent)) {
    throw new Error(`a run id needs the agent that produced it, and \`${agent}\``
      + ` is not one of ${AGENT_IDS.join(', ')}`);
  }
  if (!Number.isInteger(issue)) {
    throw new Error(`a run id needs the issue it is for, and \`${issue}\` is not a number`);
  }
  return `${agent}-${issue}-${at.toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z`;
}

// ---------------------------------------------------------------------------
// The enablement gate — ADR 0008, *Consequences*
// ---------------------------------------------------------------------------

// `ENABLEMENT_CONDITIONS` moved to `scripts/lib/enablement.mjs` in Phase 4 of
// `#204 (FORGE-265)`: ADR 0008's *Consequences* gate BOTH agents on the same two
// conditions, so it is shared machinery rather than the fixer's own. Re-exported
// here because this file's own CLI and tests name it, and because a reader of the
// runner should still find the gate it refuses on without a second hop.
export { ENABLEMENT_CONDITIONS };

export const LOOP_REFUSALS = {
  ENABLEMENT_GATE: 'enablement-gate',
  ALREADY_CLAIMED: 'already-claimed',
  WORKTREE_REFUSED: 'worktree-refused',
  CLAIM_LOST: 'claim-lost',
  RECORD_REFUSED: 'record-refused',
  SETTINGS_REFUSED: 'stop-settings-refused',
  STOPPED: 'stopped',
};

/**
 * May this loop run? Today: no, and the answer is a fact about the machine rather
 * than a placeholder.
 *
 * Phase 1 closed the first condition and there is nothing left to measure for it;
 * the second is open and closing it is an owner-held act. So this returns a
 * refusal naming both rows, which of them is outstanding, and the act that would
 * close it — the shape every other refusal in this runner takes, because an
 * operator told only "disabled" learns nothing about what to do next.
 */
export function enablementRefusal({ agentId = 'fixer', homeDir = homedir() } = {}, opts = {}) {
  // `#194 (FORGE-260)` Phase 3. This used to take no arguments and read only the
  // ADR conditions, so it answered "is the gate closed" and never "is this agent
  // on" — which meant the owner's own act changed nothing here, and a machine with
  // every condition closed and the agent switched off would still have run.
  //
  // It now defers to the one authority rather than re-deriving half of it. The
  // conditions seam is threaded through so the permitted case is reachable in a
  // test; it is unreachable on this machine today.
  const conditions = opts.conditions ?? ENABLEMENT_CONDITIONS;
  const auth = runAuthorization({ agentId, homeDir }, { conditions });
  const outstanding = auth.open;
  if (auth.mayRun) {
    return { ok: true, outstanding, conditions, message: auth.reason };
  }
  return {
    ok: false,
    reason: LOOP_REFUSALS.ENABLEMENT_GATE,
    outstanding,
    conditions,
    enabled: auth.enabled,
    message: auth.enabled
      ? `ADR 0008 gates enabling the delegated-fix loop on ${conditions.length} conditions, and`
        + ` ${outstanding.length} is still open`
        + ' — building against the ADR is unblocked, switching this on is not'
      : `${auth.reason} — ADR 0008's conditions are not the only thing between this loop and a run`,
  };
}

// ---------------------------------------------------------------------------
// The loop, end to end
// ---------------------------------------------------------------------------

/**
 * Claim, brief, invoke, publish, record, reap — the whole of it, in the order the
 * spec's *The loop* sets, with the D1 split intact: the agent process exits before
 * anything outbound is attempted, and it is this process that attempts it.
 *
 * Phases 2 to 5 each built one step and left the next uncalled, deliberately: no
 * phase enabled the feature by wiring its own piece into a running whole. This is
 * the wiring, and it changes none of their behaviour — every step is called with
 * the arguments its own tests already pin.
 *
 * **The gate is checked here, not only at the CLI.** `opts.gate` is an injected
 * seam like `opts.git`, `opts.gh` and `opts.spawn`, and it exists so this file's
 * tests can exercise the wiring against a fixture repository and a bare remote
 * without an owner act. A caller supplying one anywhere else is substituting their
 * own answer to ADR 0008's *Consequences*, which the ADR reserves to the owner.
 *
 * **A stop is checked twice and honoured as a terminal state, never as a
 * cleanup.** Nothing is removed on a stop: not the worktree (this process created
 * it, and the run's work may exist only there), not the claim. `--release` is the
 * deliberate act, by a human who has looked.
 */
export function runLoop({
  repoRoot, issue, type = 'fix', remote = 'origin', base = 'main',
}, opts = {}) {
  const gate = (opts.gate ?? enablementRefusal)();
  if (!gate.ok) return { ...gate, published: false, outcome: null };

  const number = issue?.number;
  const title = issue?.title ?? '';
  // Read once from the repo's own Board: line (ADR 0014), never from the caller:
  // the identifier a human reads is a fact about the repo, not a run parameter.
  const shortName = repoShortName(repoRoot);

  const held = readClaim(repoRoot, number, opts);
  if (held) return { ok: false, reason: LOOP_REFUSALS.ALREADY_CLAIMED, holder: held, published: false, outcome: null };

  const runId = opts.runId ?? newRunId(opts.agent ?? THIS_AGENT, number);
  const chosen = freeBranchForIssue(repoRoot, number, title, type, opts);
  if (!chosen.branch) {
    return {
      ok: false, reason: LOOP_REFUSALS.WORKTREE_REFUSED, runId, detail: chosen,
      published: false, outcome: null,
    };
  }
  const branch = chosen.branch;

  const tree = createWorktree({ repoRoot, runId, branch }, opts);
  if (!tree.ok) return { ok: false, reason: LOOP_REFUSALS.WORKTREE_REFUSED, runId, detail: tree, published: false, outcome: null };

  const claimed = claimIssue({ repoRoot, issue: number, runId, branch, worktree: tree.path }, opts);
  if (!claimed.ok) {
    // The one reap that is legitimate before a run has done anything: this process
    // made the worktree moments ago, nothing has touched it, and it is exactly the
    // base commit. Phase 2 argues this at the same call in `--claim`.
    reapWorktree(tree.path, { state: OUTCOME_REPORTED }, opts);
    return { ok: false, reason: LOOP_REFUSALS.CLAIM_LOST, runId, detail: claimed, published: false, outcome: null };
  }

  const opened = openRunRecord({
    repoRoot, runId, issue: number, issueTitle: title || null,
    branch, worktree: tree.path, baseCommit: tree.baseCommit,
  }, opts);
  if (!opened.ok) {
    // Not reaped and not released. A run with no record is a run nobody can audit,
    // so it stops here — and what it leaves behind is reported rather than tidied,
    // because the tidying is what would make it unauditable twice over.
    return { ok: false, reason: LOOP_REFUSALS.RECORD_REFUSED, runId, worktree: tree.path, detail: opened, published: false, outcome: null };
  }

  // The stop the agent session itself honours. A failure to write it stops the run
  // rather than proceeding without it: the runner-side poll cannot reach inside the
  // one long call a run makes, so a run invoked without this file is a run nobody
  // can stop for the whole of its working life.
  const settings = stopSettingsArgs({ repoRoot, runId }, opts);
  if (!settings.ok) {
    return { ok: false, reason: LOOP_REFUSALS.SETTINGS_REFUSED, runId, worktree: tree.path, detail: settings, published: false, outcome: null };
  }

  const before = checkStop(repoRoot, runId, opts);
  if (before) {
    markStopped(repoRoot, runId, before, opts);
    return { ok: false, reason: LOOP_REFUSALS.STOPPED, runId, worktree: tree.path, stop: before, invoked: false, published: false, outcome: null };
  }

  // Sourced here for the brief and again inside `runGeneration`, which is the step
  // that owns the refusal. Reading twice costs one file read and keeps the refusal
  // and its report in one place; passing the result in would give this function a
  // second way to be right about criteria it does not decide.
  const sourced = sourceAcceptanceCriteria(issue, { worktree: tree.path });
  const prompt = sourced.ok
    ? composePrompt({ issue, branch, worktree: tree.path, shortName, sourced })
    : '';

  const generation = runGeneration({
    repoRoot, runId, issue, worktree: tree.path, branch, shortName,
    prompt, extraArgs: settings.extraArgs,
  }, opts);

  // Written when the agent is invoked and not at the end, run-record.mjs's reason:
  // a run killed at its budget has no publish result and still has an argv, and the
  // argv is where every ADR 0008 row 1 and row 2 flag would be.
  if (generation.invoked) {
    recordInvocation(repoRoot, runId, { command: 'claude', args: generation.argv, prompt }, opts);
  }

  const after = checkStop(repoRoot, runId, opts);
  if (after) {
    markStopped(repoRoot, runId, after, opts);
    return {
      ok: false, reason: LOOP_REFUSALS.STOPPED, runId, worktree: tree.path, stop: after,
      generation, invoked: generation.invoked === true, published: false, outcome: null,
    };
  }

  // Kept before the publisher rules, so an account exists whatever it decides — and
  // whatever it decides, the publisher never reads it. Evidence, not a verdict.
  const account = generation.invoked === true
    ? writeRunAccount(repoRoot, runId, generation.agent, opts)
    : null;

  const publish = publishRun({
    repoRoot, worktree: tree.path, branch: generation.branch, issue: number,
    baseCommit: tree.baseCommit, runId, shortName, issueTitle: title,
    criteria: generation.criteria ?? [], generation, remote, base,
  }, opts);

  const closed = closeRunRecord(repoRoot, runId, { publish, generation, account }, opts);

  // Last, and only ever with the publisher's own verdict. `reapWorktree` refuses a
  // non-terminal state, a dirty tree and a HEAD that is neither the published
  // commit nor the base, so a run that failed anywhere above leaves its worktree
  // standing and this call says why.
  const reaped = reapWorktree(tree.path, { state: publish.outcome, commit: publish.commit ?? null }, opts);

  // **A run that published keeps its claim; a run that only reported gives it
  // back.** Claims not expiring is what stops two runs on one issue, and that is
  // right while a pull request is standing — a second run would open a duplicate
  // against a branch a human is already reading.
  //
  // It is wrong once a run has ended having published nothing. The comment such a
  // run files says, in as many words, *"add an `## Acceptance criteria` section and
  // delegate it again"* — and the claim it left made delegating it again impossible.
  // Measured on the first real delegation: a refused run reaped its worktree, closed
  // its record, and every later `--run` answered `already-claimed` on behalf of a run
  // that no longer existed. A lock outliving its holder is not the same thing as a
  // lock that does not expire.
  //
  // Only this run's own claim, and only after the publisher has ruled: releasing on
  // any earlier line would hand the issue back while the worktree still stood.
  if (publish.outcome === OUTCOME_REPORTED) releaseClaim(repoRoot, number, opts);

  return {
    ok: publish.ok === true,
    reason: publish.ok === true ? null : publish.reason,
    runId, branch, worktree: tree.path,
    invoked: generation.invoked === true,
    published: publish.published === true,
    outcome: publish.outcome ?? null,
    generation, publish, reaped,
    record: closed.ok ? closed.record : null,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = 'usage: node scripts/agent-fixer.mjs [<repo>] [--claim=N [--title=…] [--type=…]]'
  + ' [--release=N] [--run=N] [--stop=<run|N> [--reason=…]] [--list] [--runs-dir=<path>]';

export function parseAgentRunArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    repoRoot: process.cwd(), command: 'plan', issue: null, title: '', type: 'fix',
    runsDir: null, target: null, reason: null,
  };
  for (const arg of args) {
    const [key, value] = arg.startsWith('--') ? [arg.slice(2).split('=')[0], arg.slice(2).split('=').slice(1).join('=')] : [null, arg];
    if (key === 'claim' || key === 'release' || key === 'run') {
      if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`--${key} needs an issue number`);
      opts.command = key;
      opts.issue = Number(value);
    } else if (key === 'stop') {
      // Either identifier, because the two ways a human finds a run name it
      // differently: `--list` prints run ids, and the board they came from prints
      // issue numbers. Refusing one of them would send somebody back to a listing
      // mid-incident, which is the moment row 8 exists for.
      if (!value) throw new Error('--stop needs a run id or an issue number');
      opts.command = 'stop';
      opts.target = value;
      if (/^[1-9][0-9]*$/.test(value)) opts.issue = Number(value);
    } else if (key === 'reason') {
      opts.reason = value;
    } else if (key === 'scheduled') {
      // What the sweeper says, declared in the registry as this entry's
      // `unattended.args`. It is a command rather than a modifier on `plan`
      // because the two do entirely different things: `plan` polls the board, and
      // a tick that polled GitHub every window would be a side effect nobody
      // asked for. `#223 (FORGE-294)`.
      opts.command = 'scheduled';
    } else if (key === 'list') {
      opts.command = 'list';
    } else if (key === 'title') {
      opts.title = value;
    } else if (key === 'type') {
      opts.type = value;
    } else if (key === 'runs-dir') {
      if (!value) throw new Error('--runs-dir needs a path');
      opts.runsDir = value;
    } else if (key) {
      throw new Error(`unknown option --${key}`);
    } else {
      opts.repoRoot = value;
    }
  }
  return opts;
}

/**
 * Find the run a `--stop` names, by run id or by issue number.
 *
 * By issue it takes the one run still in `running`, and refuses rather than
 * guesses when there is more than one — the same refusal `detectBoard` makes on
 * two `Board:` lines, for the same reason: picking one would stop the wrong run
 * and say nothing about it.
 *
 * **Neither branch trusts `opts.agent` to name the right directory.** This is a
 * lookup, not a write, and the human asking it is `listRunRecords`'s own case —
 * "just been told an agent is loose" — so it must not require knowing which one
 * first. By run id, the agent is read off the id itself (`agentForRunId`),
 * falling back to `opts.agent` only for an id that names no known agent — a test
 * fixture's own scheme, which contradicts nothing. By issue, every agent's
 * directory is swept (`listRunRecords` with no agent forced), the same call
 * `agent-menu.mjs` makes for the same reason. Before this, both branches forced
 * `opts.agent`: `agent-fixer.mjs --stop <a hunter run id>` threw
 * `assertRunIdAgent`'s mismatch error instead of finding it, and `--stop <issue>`
 * silently missed a run any agent but this CLI's own had claimed.
 */
export function resolveRun(repoRoot, args, opts = {}) {
  if (args.issue === null) {
    const agent = agentForRunId(args.target) ?? opts.agent;
    const run = readRunRecord(repoRoot, args.target, { ...opts, agent });
    return run ? { ok: true, run: { ...run, agent } } : { ok: false, reason: 'no-such-run' };
  }
  const forIssue = listRunRecords(repoRoot, { ...opts, agent: undefined }).filter((r) => r.issue.number === args.issue);
  if (forIssue.length === 0) return { ok: false, reason: 'no-such-run' };
  const live = forIssue.filter((r) => r.state === RUN_STATES.RUNNING);
  if (live.length === 1) return { ok: true, run: live[0] };
  if (live.length > 1) return { ok: false, reason: 'ambiguous-run', runs: live };
  return { ok: false, reason: 'no-run-running', runs: forIssue };
}

const STOP_REFUSALS = {
  'no-such-run': 'no run under this runs root carries that run id or issue number — `--list` shows what is there',
  'ambiguous-run': 'more than one run on that issue is still running; name the run id from `--list` instead',
  'no-run-running': 'every run on that issue has already ended — `--list` shows how each one finished',
};

/** One run, on one line, for a human who has just been told an agent is loose.
 *  The pid's liveness is reported as evidence rather than as a state, because a
 *  pid can be reused and run-record.mjs says so where it measures it.
 *
 *  `run.agent` — stamped by `listRunRecords` and by `resolveRun` — scopes
 *  `checkStop` rather than `opts.agent`: a listing spans every agent, and a
 *  `checkStop` still forced to the caller's own agent would throw on every run
 *  that is not this CLI's own, `assertRunIdAgent`'s guard reading as a crash
 *  rather than the mismatch it exists to catch. */
export function describeRun(repoRoot, run, opts = {}) {
  const stop = checkStop(repoRoot, run.runId, { ...opts, agent: run.agent ?? opts.agent });
  // A null pid is a session-held run — a hunt — not a runner that died. The two
  // read identically through `holderAlive` and must not read identically here:
  // `pid null not running` is what a crashed fixer looks like.
  const holder = run.authority.pid === null
    ? 'session-held'
    : `pid ${run.authority.pid} ${holderAlive(run.authority.pid) ? 'alive' : 'not running'}`;
  const held = run.state === RUN_STATES.RUNNING ? `${run.state} (${holder})` : run.state;
  const asked = stop ? ` · stop requested at ${stop.requestedAt} by ${stop.requestedBy?.user ?? 'somebody'}` : '';
  return `${run.runId} · ${run.issue.number === null ? 'no issue' : `#${run.issue.number}`} · ${held}`
    + ` · started ${run.startedAt}`
    + `${run.authority.worktree ? ` · ${run.authority.worktree}` : ''}${asked}`;
}

/** The refusals, rendered for a human. Each says what is missing, because a
 *  runner that printed "no delegated issues" for any of them would be reporting
 *  an empty board when the truth is that it never found one. */
const BOARD_REFUSALS = {
  'no-roadmap': 'no ROADMAP.md — this repo declares no §6.5 board variant, so there is nothing to poll',
  'no-board-line': 'ROADMAP.md has no line beginning `Board:` — check-roadmap.mjs would fail this repo too',
  'ambiguous-board': 'ROADMAP.md has more than one line beginning `Board:`; which board this repo is on is not established',
  'unrecognized-board': 'the `Board:` line names neither Linear nor a GitHub Project',
};

/**
 * The words a refusal is printed with: its message if it has any, its reason if
 * not, and never nothing.
 *
 * Every site in this file that renders a refusal for a human reads this, and the
 * shape it replaces was `message` falling back on `reason` with `??` — which falls
 * back only on null and undefined. A producer whose message is the empty string
 * therefore printed a violation line ending at the dash, and on the plan path,
 * which prints the message bare, a literally empty line: a command exiting
 * non-zero having said nothing at all.
 *
 * **One function rather than six corrected expressions.** The defect is not that
 * six authors each chose `??`; it is that the rule lived nowhere, so each site was
 * written by somebody reading the last one. Six corrected expressions leave the
 * seventh site exactly as exposed, and `tests/agent-fixer.test.mjs` asserts over
 * this source that no site renders its own words.
 *
 * `ghFailureMessage` above is the same rule kept at the other end of the value and
 * is not made redundant by this: it answers for the two `gh-unavailable` refusals
 * it makes, and a producer that names its own failure well is better than one
 * rescued here. But a rule kept only where one value is made is a rule the next
 * producer does not know about, and the five others whose refusals reach these
 * sites — `gh-unreadable`, `runLoop`, `createWorktree`, `openRunRecord`,
 * `requestStop` — never learned it.
 *
 * Whitespace is nothing. Every producer here trims, so a message of blanks cannot
 * arrive from any of them today — which is the reason the guarantee belongs here
 * rather than with them: a caller that stopped trimming would otherwise restore the
 * empty line at a site nobody looked at again.
 */
function refusalWords(refusal) {
  const said = typeof refusal?.message === 'string' ? refusal.message.trim() : '';
  const named = typeof refusal?.reason === 'string' ? refusal.reason.trim() : '';
  // A refusal carrying neither is a bug in its producer, and printing nothing for
  // it would report that bug as silence — the failure this whole function is about.
  return said || named || 'refused without naming a reason';
}

/**
 * Print both of ADR 0008's conditions with their standing, and hand back the
 * refusal.
 *
 * One function for the two ways this runner can be asked to do the gated thing —
 * a person typing `--run`, and a timer passing `--scheduled` — because an
 * operator told only "disabled" cannot tell an unbuilt feature from a built one
 * that is switched off, and that is as true of a line in a task history as it is
 * of a terminal. What the two callers do NOT share is the exit code: see
 * `EXIT_CODES`.
 */
function printEnablementGate(authority = {}) {
  const gate = enablementRefusal(
    { agentId: THIS_AGENT, ...(authority.homeDir ? { homeDir: authority.homeDir } : {}) },
    { conditions: authority.conditions },
  );
  // `gate.conditions`, not the module constant. `enablementRefusal` already
  // resolves the injected seam against `ENABLEMENT_CONDITIONS` and hands the
  // result back on both branches, so reading the constant here made the refusal
  // and the screen answer to different data: a caller passing `conditions` was
  // told one condition is open and then shown two closed ones. It was invisible
  // while the seam had no caller on this path, which is the same reason `#339
  // (FORGE-370)` exists — the half of this print nothing read.
  for (const row of gate.conditions) {
    console.error(`  [${row.closed ? 'closed' : ' open '}] ${row.condition}`);
    console.error(`            ${row.closed ? row.evidence : row.act}`);
  }
  return gate;
}

/**
 * `main`'s injection points, and why it has any.
 *
 * The two run paths consult the enablement gate, which reads an agent state file
 * under the operator's own home. Without a seam a test could only reach the
 * permitted case by writing into the real `~/.daftplate/`, which is a test that
 * switches an agent on for the machine it runs on.
 *
 * `runLoop` is injected for the same reason and a sharper one: the permitted path
 * ends in a worktree, a spawned agent and a pull request. A test proving the loop is
 * *reached* must not be the test that runs it.
 */
/**
 * Poll, pick the delegated issue, and hand it to the loop. Both run paths share it.
 *
 * **Only a delegated issue may be run.** `--run=N` requires N to carry
 * `DELEGATION_LABEL`, so it selects among delegations rather than being a second,
 * unlabelled trigger with none of the gesture's meaning — a `--run` that took any
 * issue number would let an operator start an unattended agent on work nobody
 * delegated, which is the whole gesture bypassed by a flag.
 *
 * A scheduled tick takes the first delegated issue and no more. One run per tick is
 * the spec's own "one at a time; no parallel fixes in v1", and it is also what keeps
 * a tick's cost bounded by something an operator can reason about.
 */
function runDelegated(args, { authority, loop, scheduled, ...injected }) {
  const io = { runsDir: args.runsDir ?? undefined, repoRoot: args.repoRoot, agent: THIS_AGENT, ...injected };

  const board = readBoard(args.repoRoot);
  if (!board.ok) return reportViolations([violation('board', args.repoRoot, BOARD_REFUSALS[board.reason] ?? board.reason)]);

  const polled = pollDelegated(board, io);
  if (!polled.ok) return reportViolations([violation('poll', args.repoRoot, refusalWords(polled))]);

  const issue = scheduled
    ? polled.issues[0]
    : polled.issues.find((i) => i.number === args.issue);

  if (!issue) {
    if (scheduled) {
      console.log(`no open issue carries \`${DELEGATION_LABEL}\``);
      return 0;
    }
    return reportViolations([violation('delegation', `#${args.issue}`,
      `#${args.issue} does not carry \`${DELEGATION_LABEL}\` — only a delegated issue may be run`)]);
  }

  // **The poll's issue is not the run's issue.** `pollDelegated` asks for
  // `number,title`, which is what a queue needs; `sourceAcceptanceCriteria` reads
  // `issue.body`, and handing it a polled issue gives it `undefined` — a run that
  // refuses `no-issue-body` on an issue whose body is right there. Measured on the
  // first real delegation. The body is fetched for the one issue about to run
  // rather than added to the list call, so a tick polling thirty issues does not
  // pull thirty bodies to use one.
  const detail = (io.gh ?? defaultGh)(
    ['issue', 'view', String(issue.number), '--json', 'number,title,body'], args.repoRoot,
  );
  if (detail.status !== 0) {
    return reportViolations([violation('issue', `#${issue.number}`,
      ghFailureMessage(detail, 'issue-unreadable'))]);
  }
  let full;
  try {
    full = JSON.parse(detail.stdout);
  } catch {
    // Unreadable and empty are different facts. Merging them would report "no
    // acceptance criteria" about an issue nobody could read.
    return reportViolations([violation('issue', `#${issue.number}`,
      `issue-unreadable: ${detail.stdout.trim().slice(0, 200)}`)]);
  }

  // `linearKey` stays null. It is a record field only: under ADR 0014 no prose this
  // run writes carries a Linear key, and it is never computed from the GitHub number.
  const outcome = loop({ repoRoot: args.repoRoot, issue: { ...issue, ...full }, type: args.type }, io);
  if (!outcome.ok) {
    // `generationReason` when there is one. `run-refused` alone told the operator of
    // the first real delegation that something declined and nothing about what —
    // the answer was two files away in the run record, and the reason it exists is
    // that a refusal an operator cannot act on is barely better than a hang.
    const why = [refusalWords(outcome), outcome.generationReason]
      .filter(Boolean).join(' — ');
    return reportViolations([violation('run', `#${issue.number}`, why)]);
  }
  console.log(`run:      #${issue.number} ${outcome.outcome ?? ''}`.trimEnd());
  if (outcome.pr) console.log(`pr:       ${outcome.pr}`);
  return 0;
}

export function main(argv, opts = {}) {
  const authority = { homeDir: opts.homeDir, conditions: opts.conditions };
  const loop = opts.runLoop ?? runLoop;
  // Test seams, in `opts.runLoop`'s idiom and for a sharper version of its reason.
  // Three of this file's six refusal print sites are reached only when one of these
  // three refuses, and none of the three can be made to refuse with an empty message
  // from outside: `createWorktree` takes its words from git's own streams and the two
  // ledger writers from `writeAtomically`, which never returns an empty string. So
  // those sites had no test of any kind, and a reviewer restored `??` at one of them
  // against a suite that stayed green. A caller supplying one of these anywhere else
  // is substituting its own worktree, its own run record or its own stop request.
  const makeWorktree = opts.createWorktree ?? createWorktree;
  const openRecord = opts.openRunRecord ?? openRunRecord;
  const askToStop = opts.requestStop ?? requestStop;
  let args;
  try {
    args = parseAgentRunArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    // `EXIT_CODES.USAGE`, not the `1` this returned before. `1` is what
    // `reportViolations` answers a run that happened and found something with,
    // and a scheduled tick reading that code cannot tell "the loop ran and
    // refused" from "the flag you passed me does not exist" — which is the pair
    // `#223 (FORGE-294)` defect 1 confused for a month. `agent-hunter.mjs` already
    // answered usage with 2 and its own test records the same reasoning.
    return EXIT_CODES.USAGE;
  }

  if (args.command === 'scheduled') {
    // #194 (FORGE-260) Phase 4: a scheduled run records its own end, and it is
    // registered BEFORE the gate so that even the refusal leaves a line. A tick
    // that was declined is a fact about this machine worth reading afterwards --
    // it is, on a machine with ADR 0008's second condition still open, the only
    // fact this journal will ever hold.
    recordEndOnExit(THIS_AGENT);

    // First, and before `io` even exists. A scheduled tick has no operator
    // watching, so every line below this point is a side effect performed on
    // nobody's behalf — and the default `plan` path shells out to `gh`. Placing
    // the gate here rather than beside `--run`'s makes "it must not reach
    // `pollDelegated`" a property of the control flow instead of a promise.
    const gate = printEnablementGate(authority);
    if (!gate.ok) {
      console.error(`agent-fixer: ${gate.message}`);
      return EXIT_CODES.GATED;
    }
    // Permitted. The gate stays *here*, before `io` exists, so "a refused tick
    // reaches no side effect" remains a property of the control flow rather than a
    // promise — the branch is what changed, not the placement.
    return runDelegated(args, { ...opts, authority, loop, scheduled: true });
  }

  const io = { runsDir: args.runsDir ?? undefined, repoRoot: args.repoRoot, agent: THIS_AGENT };

  if (args.command === 'list') {
    const board = readBoard(args.repoRoot);
    console.log(`runs root: ${runsRoot(args.repoRoot, io)}`);
    console.log(`board: ${board.ok ? board.variant : `unknown (${board.reason})`}`);
    const owned = ownedWorktrees();
    console.log(owned.length ? `${owned.length} worktree(s) created by this process` : 'no worktree created by this process');
    // The discovery half of ADR 0008 row 8, and the reason it reads the ledger on
    // disk rather than `ownedWorktrees()`: the process that needs to find a run is
    // by definition not the process that started it, so anything held in memory is
    // invisible to it. This is what "discoverable without reading a transcript"
    // costs — one directory listing.
    //
    // `agent` is forced out of `io` rather than threaded, and deliberately: `io`
    // carries THIS_AGENT so `--claim`/`--release`/`--run` write under the right
    // directory, but a human running `--list` after being told an agent is loose
    // should not have to already know which one — `listRunRecords`'s own reason
    // for taking no agent at all. Forcing `io.agent` through here would have
    // silently narrowed `--list` to this script's own runs.
    const records = listRunRecords(args.repoRoot, { ...io, agent: undefined });
    if (records.length === 0) {
      console.log('no run has been recorded under this runs root');
      return 0;
    }
    for (const run of records) {
      console.log(describeRun(args.repoRoot, run, io));
    }
    return 0;
  }

  if (args.command === 'stop') {
    const found = resolveRun(args.repoRoot, args, io);
    if (!found.ok) {
      return reportViolations([violation('stop', args.target, STOP_REFUSALS[found.reason] ?? found.reason)]);
    }
    const run = found.run;
    // Scoped to the run's own agent, not this CLI's — `resolveRun` may have
    // resolved a run another agent claimed, and `requestStop` builds a run-scoped
    // path that throws `assertRunIdAgent`'s mismatch error if handed the wrong one.
    const asked = askToStop({
      repoRoot: args.repoRoot, runId: run.runId, issue: run.issue.number, reason: args.reason,
    }, { ...io, agent: run.agent ?? io.agent });
    if (!asked.ok && asked.reason !== RECORD_REFUSALS.ALREADY_REQUESTED) {
      return reportViolations([violation('stop', asked.path, refusalWords(asked))]);
    }
    // `issue.number` is null for a hunt, which claims nothing and is a legal
    // record (`openRunRecord` writes `issue: { number: null, … }`). Before
    // `#194 (FORGE-260)` Phase 7 no such run reached this CLI, so all three lines
    // below interpolated it unconditionally and would have printed `issue #null`
    // and offered to release a claim that does not exist.
    const forIssue = run.issue.number === null ? '' : ` (issue #${run.issue.number})`;
    console.log(asked.ok
      ? `stop requested for ${run.runId}${forIssue}`
      : `${run.runId} was already asked to stop at ${asked.request?.requestedAt}`);
    // Said every time, because the one way this mechanism turns into a data loss
    // is somebody assuming it tidied up. It did not: CLAUDE.md #5, and the reaper
    // would refuse this worktree anyway — this process did not create it.
    if (run.authority.worktree) {
      console.log(`worktree left untouched for inspection: ${run.authority.worktree}`);
    }
    if (run.issue.number !== null) {
      console.log(`the claim on #${run.issue.number} still stands — release it deliberately with --release`);
    }
    if (!holderAlive(run.authority.pid)) {
      // Two different facts, and merging them told the operator the wrong one. A
      // null pid is a run whose holder is a SESSION rather than a process — a
      // hunt — and "pid null is not running" reads as a crashed runner. A real
      // pid that is gone is the crashed runner.
      console.log(run.authority.pid === null
        ? `note: ${run.runId} is held by a session rather than a process, so this request is`
          + ' honoured when that session next ingests — not while it is mid-run'
        : `note: pid ${run.authority.pid} is not running, so nothing is left to honour this request`);
    }
    return 0;
  }

  if (args.command === 'run') {
    // The whole loop is wired and this is the one place a human can reach it, so
    // this is where the gate stands. It refuses and prints both of ADR 0008's
    // conditions with their standing, because an operator told only "disabled"
    // cannot tell an unbuilt feature from a built one that is switched off.
    //
    // **It used to refuse whatever the gate said**, never reading `gate.ok`, and
    // `runLoop` had no caller outside the suite. That was honest while the second
    // condition could not be closed and became wrong the moment it was — silently,
    // because every test asserted the refusal and none asserted the other branch.
    const gate = printEnablementGate(authority);
    if (!gate.ok) return reportViolations([violation('enablement', `#${args.issue}`, gate.message)]);
    return runDelegated(args, { ...opts, authority, loop, scheduled: false });
  }

  if (args.command === 'release') {
    const released = releaseClaim(args.repoRoot, args.issue, io);
    if (!released.ok) {
      return reportViolations([violation('release', released.path, released.reason)]);
    }
    console.log(`released the claim on #${args.issue} (run ${released.released.runId})`);
    if (released.released.worktree) {
      // Never reaped from here. This process did not create it, so it cannot
      // vouch for it, and CLAUDE.md #5 makes that the end of the matter.
      console.log(`worktree left for inspection: ${released.released.worktree}`);
    }
    return 0;
  }

  if (args.command === 'claim') {
    const chosen = freeBranchForIssue(args.repoRoot, args.issue, args.title, args.type, io);
    if (!chosen.branch) {
      return reportViolations([violation('branch', chosen.base,
        `${MAX_BRANCH_ATTEMPTS} branches already exist for #${args.issue}; clean them up before claiming it again`)]);
    }
    const branch = chosen.branch;
    const runId = newRunId(THIS_AGENT, args.issue);
    const held = readClaim(args.repoRoot, args.issue, io);
    if (held) {
      return reportViolations([violation('claim', claimPath(args.repoRoot, args.issue, io),
        `#${args.issue} is already claimed by run ${held.runId} (pid ${held.pid}, since ${held.startedAt}) — release it deliberately`)]);
    }
    const tree = makeWorktree({ repoRoot: args.repoRoot, runId, branch }, io);
    if (!tree.ok) {
      return reportViolations([violation('worktree', tree.path, refusalWords(tree))]);
    }
    const claimed = claimIssue({
      repoRoot: args.repoRoot, issue: args.issue, runId, branch, worktree: tree.path,
    }, io);
    if (!claimed.ok) {
      // The claim lost a race after the worktree was made. Reaping is legitimate
      // here and only here: this process created it moments ago, it has been
      // touched by nothing, and it is exactly the base commit.
      reapWorktree(tree.path, { state: OUTCOME_REPORTED }, io);
      return reportViolations([violation('claim', claimed.path, claimed.reason)]);
    }
    // The record opens here and not later. A run that dies between the claim and
    // its first step is exactly the run nobody can find, and a record written at
    // the end would be written by the runs that need it least.
    const opened = openRecord({
      repoRoot: args.repoRoot, runId, issue: args.issue, issueTitle: args.title || null,
      branch, worktree: tree.path, baseCommit: tree.baseCommit,
    }, io);
    if (!opened.ok) {
      return reportViolations([violation('record', opened.path, refusalWords(opened))]);
    }
    console.log(`claimed #${args.issue} as ${runId}`);
    if (chosen.priorAttempts) {
      // The spec's repeat-delegation case: start clean, and say a prior one exists.
      // Their worktrees are gone; their branches are not, and neither is their work.
      console.log(`prior:    ${chosen.priorAttempts} earlier branch(es) for this issue remain — nothing was reused`);
    }
    console.log(`branch:   ${branch}`);
    console.log(`worktree: ${tree.path}`);
    console.log('no agent was invoked and nothing was published — `--claim` is the ledger and the');
    console.log('worktree only. The whole loop is `--run`, which ADR 0008 still gates shut.');
    return 0;
  }

  // plan — the default. Detect, poll, and report. It claims nothing and creates
  // nothing, so running it on an unfamiliar repo cannot change that repo.
  const board = readBoard(args.repoRoot);
  if (!board.ok) {
    console.error(BOARD_REFUSALS[board.reason] ?? board.reason);
    return 1;
  }
  console.log(`board: ${board.variant}${board.team ? ` (team ${board.team})` : ''}`);
  const polled = pollDelegated(board, io);
  if (!polled.ok) {
    // The site this issue is named for: it prints the words bare, with no rule, no
    // path and no dash, so an empty message is an empty line and nothing else.
    console.error(refusalWords(polled));
    return 1;
  }
  if (polled.issues.length === 0) {
    console.log(`no open issue carries \`${DELEGATION_LABEL}\``);
    return 0;
  }
  for (const issue of polled.issues) {
    const held = readClaim(args.repoRoot, issue.number, io);
    const state = held ? `claimed by ${held.runId}` : 'unclaimed';
    console.log(`#${issue.number} ${issue.title} — ${state}`);
  }
  return 0;
}

export { OUTCOME_PUBLISHED, OUTCOME_REPORTED, worktreePath };

runCli(import.meta.url, main);
