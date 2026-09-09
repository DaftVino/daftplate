// The gate ADR 0008 puts on switching an unattended agent on, and where each of
// its conditions stands.
//
// **Shared, not the fixer's.** This lived in `agent-fixer.mjs` while the fixer was
// the only agent. ADR 0008's *Consequences* say neither `#193 (FORGE-259)` nor
// `#194 (FORGE-260)` may be enabled until the same two conditions are met, so the
// gate governs both, and leaving it in one agent's file would have meant the
// hunter either re-declaring it or quietly gating on something weaker. Moved here
// by Phase 4 of `#204 (FORGE-265)` for the reason Phase 2 renamed the on-disk
// kinds agent-neutral: shared machinery does not live in one participant's file.
//
// The data and the reporting functions read nothing. `runAuthorization` — added
// by `#194 (FORGE-260)` — reads one agent state file, and it is the only thing
// here that touches the filesystem. It lives here rather than beside a runner
// because the whole point of it is that no runner may answer this question for
// itself.

/**
 * The two conditions ADR 0008 sets on switching an unattended agent on, and where
 * each one stands.
 *
 * Recorded as data rather than as a paragraph so a refusal quotes the conditions
 * themselves instead of somebody's summary of them, and so closing one is an edit
 * a reviewer sees rather than a sentence that quietly softens.
 *
 * The second row is not a code change and no phase of any plan may perform it. It
 * is a change to the credential this workstation authenticates with, which is the
 * operator's own, and an implementation that narrowed it as a side effect of
 * building against the ADR would be deciding the ADR's own gate for the owner.
 *
 * **Its `act` names one command because ADR 0011 settled which one.** The wording
 * it replaces — *"an owner narrows the token this workstation authenticates with"*
 * — is ADR 0008's *Consequences* sentence, and it had three readings with none
 * chosen; the vagueness is what sent a session costing out a whole credential
 * migration. ADR 0011 reads that sentence against row 7, which asks the token drop
 * every scope the workflow does not use *that its issuer will let go of*, and
 * measures the answer: `repo`, `read:org` and `gist` are `gh`'s irremovable floor,
 * `project` is required by `scripts/setup-repo.mjs:22`, `workflow` by every
 * scaffolded repo's first push, and `read:user` is used by nothing.
 *
 * The `condition` above it is left in ADR 0008's own words. ADR 0011 narrows how
 * that sentence is read; it does not reword the ADR, which is immutable, and a
 * condition that quoted the newer document would stop quoting the one that set it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { agentStatePath } from './agent-state.mjs';

export const ENABLEMENT_CONDITIONS = [
  {
    condition: "an unattended run's own credential is refused a direct `main` push and a merge, shown by probe",
    closed: true,
    evidence: 'docs/designs/relay-probes/results-2026-08-27-publication-boundary.md, rows P2 and P3',
  },
  {
    condition: 'the ambient credential this machine holds is narrowed',
    closed: true,
    evidence: 'docs/designs/relay-probes/results-2026-09-04-ambient-narrowing.md, performed by the owner',
  },
];

/** The conditions still open. Zero of them does not mean an agent is on — it
 *  means nothing stands between an owner and switching one on. */
export function openConditions() {
  return ENABLEMENT_CONDITIONS.filter((c) => !c.closed);
}

/**
 * A copy of every condition and its standing, taken at the moment of an act.
 *
 * **A copy, not a pointer.** If a condition later closes, an enablement record
 * holding a reference would silently re-describe what the owner saw — and the
 * only thing an audit trail can honestly claim is what was on the screen when the
 * decision was made.
 */
export function conditionsSnapshot(conditions = ENABLEMENT_CONDITIONS) {
  return conditions.map((c) => ({
    condition: c.condition,
    closed: c.closed,
    ...(c.closed ? { evidence: c.evidence } : { act: c.act }),
  }));
}

// `renderConditions()` stood here and had no callers, in `scripts/`, in `tests/`
// or in `skills/` — `#307 (FORGE-351)`. Removed rather than wired to one, and the
// reason is which module owns a rendering rather than how much code it saves.
//
// It was not obviously dead. It was exported and its docstring called it the
// operator-facing surface, so the next session wanting that surface would
// reasonably have reached for it — and shipped a screen whose act half no test
// covers, on the exact surface ADR 0008 row 8 and the enablement gate depend on
// being legible. A mutant emptying its act half survived the whole suite while
// the same mutant applied to `agent-menu.mjs` killed a test immediately, which is
// what located the duplication.
//
// This module holds the conditions and the authority. Every surface that prints
// them formats them where it prints them, against its own indentation and its own
// stream, and is asserted through what it renders. A renderer here would be dead
// the moment it was written, for the reason that one was.

/**
 * The one answer to "may this agent run now", for every surface that asks.
 *
 * `#194 (FORGE-260)`, plan-agents Phase 3. Three surfaces answered this
 * independently and disagreed: the menu said `ON` on `state.enabled` alone, the
 * sweeper started the agent on `state.enabled` alone, and the fixer's runtime
 * refused on the ADR conditions alone and never read the state file at all. One
 * machine, three answers — and the two that said yes were the two an owner acts
 * on.
 *
 * **Two independent halves, and a run needs both.** The owner's act (`enabled`)
 * and the ADR's gate (every condition closed). Either alone is a `no`, and the
 * reason names which, because an operator told only "no" learns nothing about what
 * to do next.
 *
 * **Acknowledgement is not permission.** The menu lets an owner enable over an
 * open condition and records that they saw it. That record is what they saw, never
 * a substitute for the condition closing — D4's note is that acknowledge-and-run
 * would need a superseding ADR, and this does not do that.
 *
 * `conditions` is injected rather than read from the module constant so the
 * permitted case is reachable in a test. It is unreachable on this machine today,
 * and without the seam the only way to reach it would be mutating exported module
 * state across a test file — which is how a suite starts depending on its own
 * execution order.
 */
export function runAuthorization({ agentId, homeDir }, { conditions = ENABLEMENT_CONDITIONS } = {}) {
  const path = agentStatePath(agentId, { homeDir });
  let data = null;
  let readable = true;
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // Unreadable is not "off with a shrug": it is a state nothing actually
      // knows, and it is reported as its own fact so a screen can say so rather
      // than rendering a machine nobody can read as safely disabled.
      readable = false;
    }
  }

  const enabled = readable && data?.enabled === true;
  const acknowledgedOpen = readable ? (data?.acknowledgedOpen ?? 0) : 0;
  const open = conditions.filter((c) => !c.closed);

  const reason = !readable
    ? 'the agent state file could not be parsed, so nothing knows whether it is on'
    : !enabled
      ? 'the agent is off — an owner has not switched it on'
      : open.length
        ? `ADR 0008 has ${open.length} of ${conditions.length} enablement condition(s) still open`
        : 'the agent is on and every enablement condition is closed — it may run';

  return { mayRun: enabled && open.length === 0, enabled, readable, open, acknowledgedOpen, reason };
}
