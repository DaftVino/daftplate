// The registry: which agents exist in this repository, and what each one is
// called. `#204 (FORGE-265)`, Phase 1 of
// docs/designs/2026-08-28-plan-daft-agent.md.
//
// **A curated data module, not a glob over `scripts/agent-*.mjs`.** A scan cannot
// refuse anything, and D1's gate — an agent earns an entry only if it has
// judgement, a reviewable work product, or state carried across runs — is a
// judgement that has to be reviewable in a diff. Under a scan, `node
// scripts/code-map.mjs .` becomes an agent by filename, acquires a claim ledger
// and a worktree it has no use for, and a human reading `--list` has to tell a
// stalled index refresh from a stalled fixer.
//
// Nothing here spawns, reads a network, or touches the filesystem except
// `validateRegistry`, which stats the paths it is asked about. The menu, the
// sweeper and both entry scripts import from here; nothing here imports them.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { violation } from './cli.mjs';

/** The three things that make something an agent rather than a scheduled command.
 *  D1. An entry declaring none of them is refused by `validateRegistry`. */
export const QUALIFICATIONS = Object.freeze(['judgement', 'work-product', 'state']);

export const TRIGGER_KINDS = Object.freeze(['board-poll', 'schedule']);

/**
 * How an entry answers being started by a timer rather than by a person.
 *
 * - `gated` — it has an unattended driver. A scheduled tick reaches it, and what
 *   it does there is decided by ADR 0008's enablement gate, not by this field.
 * - `none` — it has no unattended driver at all. The work is invoked by a
 *   session; a scheduled tick can only start a process whose sole possible
 *   outcome is a refusal, so the sweeper does not start one.
 *
 * **`none` is a real answer, not a placeholder for a driver nobody wrote yet.**
 * `agent-hunter.mjs` plans invocations for an agent to perform and ingests what
 * comes back — that is its whole shape, settled in `#194 (FORGE-260)` Phase 1 for
 * reasons of argv visibility, and a timer has nobody to hand the plan to. An
 * entry moving off `none` is a design change, which is why it is declared here
 * where a diff shows it rather than inferred from whether a spawn succeeded.
 */
export const UNATTENDED_DRIVERS = Object.freeze(['gated', 'none']);

/**
 * The evaluators a precondition may name.
 *
 * A precondition is **data with a named test, never a closure**. An entry able to
 * carry a function would let a registry addition change the menu's behaviour
 * without touching the menu, which is exactly the reviewability the curated list
 * was chosen for. So the entry names a key here, and this table — which is code,
 * reviewed as code — decides what that key means.
 *
 * Each evaluator takes the inspection context and returns `{ met, detail }`.
 * Phase 3 wires them to `inspect()`; Phase 1 only establishes that every named
 * one exists.
 */
export const PRECONDITION_TESTS = Object.freeze({
  /** Whether this repository's board variant is one a script can actually poll.
   *  The Linear variant is not: delegation there is a workflow state, no GitHub
   *  call can see it, and the `Delegated` state does not exist in FORGE yet. */
  'board-variant-pollable': (ctx) => {
    // `ctx?.board` rather than a destructured `{ board } = {}` default: a default
    // parameter only substitutes for `undefined`, and `evaluate(null)` — a caller
    // passing no context object at all rather than omitting the argument — would
    // throw trying to destructure `null`. Optional chaining short-circuits on
    // either nullish value, so every one of "omitted", "undefined" and "null" reads
    // the same way: no board.
    const board = ctx?.board;
    // **Every declared variant is pollable now, including `linear`.** This used to
    // read `board.variant !== 'linear'`, which refused that variant unconditionally
    // and — worse — could not be closed by the act it told the owner to perform:
    // it never looked at the board at all, so creating a `Delegated` state changed
    // nothing here. A label applied in Linear reaches the GitHub issue in seconds
    // (measured 2026-08-28), so `pollDelegated` reads both variants through one
    // path and the only question left is whether a board was declared.
    return board?.ok
      ? { met: true, detail: `board variant \`${board.variant}\` is pollable` }
      : { met: false, detail: `no board (${board?.reason ?? 'unread'})` };
  },
});

export const AGENTS = Object.freeze([
  Object.freeze({
    id: 'fixer',
    script: 'scripts/agent-fixer.mjs',
    skill: 'skills/agent-fixer/',
    summary: 'a delegated bug becomes a worktree, a reproduction, a tested fix and a draft PR',
    // Judgement: it decides what the fix is. Work product: a reviewable PR.
    // State: the claim ledger and the run record outlive the run.
    qualifies: Object.freeze(['judgement', 'work-product', 'state']),
    trigger: Object.freeze({
      kind: 'board-poll',
      preconditions: Object.freeze([Object.freeze({
        id: 'board-declared',
        test: 'board-variant-pollable',
        unmetMessage: 'this repository declares no single §6.5 board variant in ROADMAP.md, so there is nothing to poll',
        ownerAct: 'declare one board variant in ROADMAP.md — delegation itself is the `agent:delegated` label, which reaches GitHub from Linear through the issues sync',
      })]),
    }),
    // What a timer may say to it, declared where a diff shows it. The sweeper
    // composes its argv from this rather than spelling a flag of its own: the
    // flag the sweeper passed and the flags this CLI parsed were two independent
    // facts for a month, and they disagreed the whole time (`#223 (FORGE-294)`).
    unattended: Object.freeze({ args: Object.freeze(['--scheduled']), driver: 'gated' }),
    gate: 'ENABLEMENT_CONDITIONS',
    defaultWindow: null,
  }),
  Object.freeze({
    id: 'hunter',
    script: 'scripts/agent-hunter.mjs',
    skill: 'skills/agent-hunter/',
    summary: 'five doctrines go looking for defects and report what they find',
    // Judgement: each lens decides what counts as a defect. Work product: a
    // committed report. State: the fingerprint ledger, so a finding is not
    // re-raised on the next run.
    qualifies: Object.freeze(['judgement', 'work-product', 'state']),
    trigger: Object.freeze({ kind: 'schedule', preconditions: Object.freeze([]) }),
    // Corrected in Phase 4. This said `PER_LENS_FILING_GATE`, which is a
    // different and ADDITIONAL gate — it governs whether a lens may FILE, and it
    // rests on a per-lens precision figure `#194 (FORGE-260)` Phase 3 has not
    // measured. The gate on RUNNING unattended is ADR 0008's, whose *Consequences*
    // name both issues by number, so both agents share it. Naming only the filing
    // gate here would have let the hunter be switched on against a weaker
    // condition than the ADR sets.
    // `none`, and it is the honest answer rather than an unfinished one. This
    // script plans invocations and ingests answers; the invoking is done by the
    // agent driving it. There is nothing for a timer to hand a plan to, so a
    // scheduled tick declines to start one and says so.
    unattended: Object.freeze({ args: Object.freeze(['--scheduled']), driver: 'none' }),
    gate: 'ENABLEMENT_CONDITIONS',
    additionalGates: Object.freeze(['PER_LENS_FILING_GATE']),
    defaultWindow: null,
  }),
]);

/** One entry by id, or `undefined`. Absence is a value callers branch on: a menu
 *  asked for a row that is not there refuses with its own message rather than a
 *  stack trace. */
export function agentById(id) {
  return AGENTS.find((a) => a.id === id);
}

/** Whether this agent's doctrine has been written yet. A measured fact, not a
 *  validity question — see the note in `validateRegistry`. Phase 3's `inspect()`
 *  renders it; today it is false for the hunter and true for the fixer. */
export function agentSkillPresent(agent, repoRoot) {
  return existsSync(join(repoRoot, agent.skill));
}

/**
 * Every way a registry entry can be wrong, as violations rather than a throw.
 *
 * A throw would stop at the first bad entry, and a registry with two problems
 * would be fixed twice. `reportViolations` in cli.mjs renders these.
 *
 * **The qualification check is the load-bearing one** and is what makes D1's gate
 * real rather than advisory. M1 no-ops it; the test that catches M1 asserts a
 * zero-qualification entry is refused *by name*, so a check that merely returned
 * some other violation would not pass.
 */
export function validateRegistry(agents, { repoRoot } = {}) {
  const violations = [];
  const seen = new Set();

  for (const agent of agents) {
    const at = `agent:${agent.id}`;

    if (seen.has(agent.id)) {
      violations.push(violation('agent-duplicate-id', at,
        'two entries share this id, so `--list` and `--stop` would name two runs the same thing'));
    }
    seen.add(agent.id);

    // `Array.isArray`, not `agent.qualifies?.filter(...) ?? []`: that reads as
    // safe because `?.` guards a nullish `qualifies`, but it does nothing for a
    // `qualifies` that is present and truthy yet not an array — a string or a
    // plain object — and `.filter` on either of those is `undefined`, so calling
    // it throws instead of landing here as a violation. A non-array `qualifies`
    // has no known qualification in it either way, so it is treated exactly like
    // an empty one.
    const known = Array.isArray(agent.qualifies)
      ? agent.qualifies.filter((q) => QUALIFICATIONS.includes(q))
      : [];
    if (known.length === 0) {
      violations.push(violation('agent-unqualified', at,
        'an agent needs judgement, a reviewable work-product, or state carried across runs;'
        + ' anything else is a scheduled command and belongs in Task Scheduler directly'));
    }

    // The sweeper composes what it spawns from `unattended.args`. An entry
    // missing it would compose `undefined` into an argv, and an entry naming a
    // driver outside this set would be treated as `none` by every `=== 'none'`
    // test and as startable by every `!== 'none'` one — the two halves
    // disagreeing silently, which is the shape of the defect this field exists to
    // close. Neither is left to be discovered at spawn time.
    if (!Array.isArray(agent.unattended?.args)) {
      violations.push(violation('agent-no-unattended-args', at,
        'an entry must declare `unattended.args`, the argv a scheduled tick composes;'
        + ' a sweeper spelling its own flags is how the flag it passes and the flags this'
        + ' CLI parses drift apart'));
    }
    if (!UNATTENDED_DRIVERS.includes(agent.unattended?.driver)) {
      violations.push(violation('agent-unknown-unattended-driver', at,
        `unattended driver "${agent.unattended?.driver}" is not one of ${UNATTENDED_DRIVERS.join(', ')}`));
    }

    if (!TRIGGER_KINDS.includes(agent.trigger?.kind)) {
      violations.push(violation('agent-unknown-trigger', at,
        `trigger kind "${agent.trigger?.kind}" is not one of ${TRIGGER_KINDS.join(', ')}`));
    }

    // Same shape of guard as `qualifies` above, and for the same reason: `??  []`
    // only substitutes for a nullish `preconditions`. A `preconditions` that is
    // present but not an array — an object literal, say — is truthy, so `?? []`
    // leaves it untouched and `for...of` throws on the first non-iterable value
    // instead of this function returning a violation the way its own doc comment
    // promises.
    const rawPreconditions = agent.trigger?.preconditions;
    if (rawPreconditions !== undefined && rawPreconditions !== null && !Array.isArray(rawPreconditions)) {
      violations.push(violation('agent-invalid-preconditions', at,
        'trigger.preconditions must be an array of precondition objects'));
    } else {
      for (const pre of rawPreconditions ?? []) {
        if (!(pre.test in PRECONDITION_TESTS)) {
          violations.push(violation('agent-unknown-precondition', at,
            `precondition "${pre.id}" names evaluator "${pre.test}", which does not exist`));
        }
        if (!pre.ownerAct) {
          violations.push(violation('agent-precondition-no-act', at,
            `precondition "${pre.id}" reports being unmet without naming the act that would close it`));
        }
      }
    }

    // A missing script is a broken entry: it names nothing runnable. A missing
    // SKILL is NOT, and the difference is measured rather than assumed —
    // `skills/agent-hunter/` does not exist today, because it is Phase 6's
    // deliverable and `#194 (FORGE-260)` Phase 5 never ran. An entry is a
    // declaration of what an agent is called; whether its doctrine has been
    // written yet is a fact about the checkout, and `inspect()` reports it the
    // way config-menu.mjs already reports a daftplate skill that exists but is
    // not installed — as part of the report, not an omission from it.
    if (repoRoot && !existsSync(join(repoRoot, agent.script))) {
      violations.push(violation('agent-missing-script', at,
        `no script at ${agent.script}, so this entry names nothing that can run`));
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// The retired names
// ---------------------------------------------------------------------------

/**
 * The gestures that start, stop, inspect or schedule an agent.
 *
 * Named as data so "the per-agent skills carry no triggering" is checkable rather
 * than a matter of opinion. `/daft-agent` must document every one of these and no
 * `skills/agent-<id>/` may mention any — the second half matters as much as the
 * first, or the rule would be satisfied by deleting the instructions everywhere.
 *
 * **Command tokens, not English words.** The first draft listed `register`,
 * `unregister` and `window`, and every one of them matched innocent prose — "a
 * hook registered into the run's own settings file", "the window while the agent
 * process is running". A vocabulary that false-positives on ordinary sentences
 * makes the rule unenforceable, because the only way to pass it is to stop
 * writing English. Each entry here appears in a document only when that document
 * is telling somebody how to trigger something.
 *
 * `--runs-dir` is deliberately absent: it is an option on a gesture rather than a
 * gesture, and listing it would make `--run=` unmatchable.
 */
export const TRIGGERING_VOCABULARY = Object.freeze([
  '--claim', '--release', '--run=', '--stop', '--list',
  '--render', '--plan', '--apply', 'run now',
]);

/** The names Phase 1 retired, as `git grep -E` patterns. `\b` keeps
 *  `skills/agent-fix` from matching `skills/agent-fixer`. */
export const RETIRED_NAMES = Object.freeze([
  'agent-run\\.mjs',
  'hunt-run\\.mjs',
  '\\bagent-fix\\b',
]);

/**
 * Files that contain a retired name because they **define or exercise the
 * patterns themselves**, which is definitional rather than a stale reference.
 *
 * Separate from `HISTORICAL_NAME_REFERENCES` on purpose: that map is about
 * records whose past must not be rewritten, and folding a definition site into it
 * would make the historical list mean two things.
 *
 * This file is the first entry and it was a latent bug: `git grep` skips
 * untracked files, so the sweep passed while the module was still uncommitted and
 * would have failed on the very next run. The test caught it one commit later.
 */
export const NAME_PATTERN_SOURCES = Object.freeze([
  'scripts/lib/agent-registry.mjs',
]);

/**
 * Files that still name a retired script or skill **on purpose**.
 *
 * The plan's exit criterion said no tracked file may reference the old names.
 * That was wrong, and this map is the correction: applied literally it would
 * rewrite a shipped changelog entry and a committed run record to match a rename
 * that happened afterwards, which is falsifying a record rather than tidying one.
 *
 * Each entry carries a reason the suite reads, for the same cause the export
 * denylist's reason fields exist: a bare list under a prose comment reads as
 * something nobody got round to deleting, and the next reader deletes it. A test
 * refuses a reason that merely restates the path it explains, and a second test
 * refuses an exemption whose file no longer references anything retired, so the
 * list cannot rot into permissions nobody needs.
 */
export const HISTORICAL_NAME_REFERENCES = Object.freeze({
  'CHANGELOG.md': 'a released entry records what was built and under which name; editing it to match a later rename makes the history say something that was never true',
  'docs/records/hunt/2026-08-27-phase-1.md': 'a committed run record is evidence, and evidence is not rewritten to agree with a decision taken after it was gathered',
  'docs/designs/2026-08-27-plan-delegated-fix-loop.md': 'the phase contract for work that has landed; its per-phase read manifests name the files as they stood when each phase ran',
  'docs/designs/2026-08-27-plan-issue-hunters.md': 'same, and its superseded Phase 5 deliberately names the old skill directory so the marker above it reads as a correction',
  'docs/designs/2026-08-28-spec-daft-agent.md': 'the rename table has to name both sides of every rename, so it references the retired names by construction',
  'docs/designs/2026-08-28-plan-daft-agent.md': 'same: Phase 1 cannot instruct a session to perform a rename without naming what is being renamed',
});
