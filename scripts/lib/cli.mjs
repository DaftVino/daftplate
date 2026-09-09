// Shared plumbing: every script here is an importable module and a command.
import { pathToFileURL } from 'node:url';

/**
 * The exit codes this repository's CLIs answer with when `0` and `1` are not
 * honest.
 *
 * **The scope was "an agent CLI answering an unattended invocation" and is
 * wider now.** `#274 (FORGE-335)` needed a code for an installer refusing to
 * install, which is not an agent and has no unattended invocation, and the
 * choice was between stretching `GATED` to cover it, falling back on `1`, or
 * saying plainly that the vocabulary is the repository's rather than the
 * fleet's. The last is what this is: the codes below are still each defined by
 * what they mean, and only the sentence above them widened.
 *
 * **Named once because several parties read them and none of them can see the
 * others.** The sweeper decides whether a tick did anything, the agent CLIs
 * decide what to return, the installer reports a refusal, and the suite asserts
 * they differ. Spelled as literals in three files, they drift — and the drift is
 * invisible, because every one of them is "a non-zero number" to the party that
 * did not change it.
 *
 * `0` (clean) and `1` (violations, from `reportViolations`) are already spoken
 * for, so these start at 2.
 *
 * - `USAGE` — the invocation was not understood. It is `2` because
 *   `agent-hunter.mjs` already answered a usage error with `2` and its own test
 *   records why: "a run that was never pointed at a repository has not swept one
 *   clean", so it must not read the same as `1`.
 * - `GATED` — understood, refused: the agent has an unattended driver, and ADR
 *   0008's enablement conditions are not all closed.
 * - `NO_DRIVER` — understood, refused: this agent has no unattended driver at
 *   all. A run of it is invoked by a session, so no schedule can start one.
 *
 * - `STOPPED` — understood, obeyed: a stop request stood against this run and the
 *   run honoured it rather than doing the work. `#194 (FORGE-260)` Phase 7.
 *
 * - `REFUSED` — understood, declined: the invocation was correct and the work was
 *   deliberately not done, because something a user owns is in the way and only
 *   they may move it. `#274 (FORGE-335)`: `install-skills.mjs` finds a loose
 *   skill sitting at the plugin tree's own root, refuses rather than deleting it
 *   (CLAUDE.md #5), and used to exit `0` having installed nothing.
 *
 * - `INSTALL_FAILED` — understood, attempted, failed: the installer accepted the
 *   source and destination, but source validation or filesystem I/O prevented a
 *   complete install. `#274 (FORGE-335)` F4 separates that outcome from the
 *   public export's intentional absence of skills and from a refusal.
 *
 * `GATED` and `NO_DRIVER` are different numbers on purpose. Both are refusals,
 * but one is closed by an owner performing an act and the other is closed by
 * nothing, and an operator reading a task history cannot tell those apart from a
 * shared code. `STOPPED` is a third kind again and is not a refusal at all: the
 * run was permitted, was under way, and a human asked it to stop. Reading that as
 * `GATED` would tell an operator their agent is switched off.
 *
 * `REFUSED` is a fourth kind by the same rule, and it is why `GATED` was not
 * reused for the installer. `GATED`'s remedy is ADR 0008's enablement
 * conditions; `REFUSED`'s is a directory the operator removes. An installer
 * exiting `3` sends its reader to look for enablement conditions that have
 * nothing to do with the thing in their way.
 *
 * `INSTALL_FAILED` does not fall back to `1`. That number says a completed check
 * found violations; it cannot also tell automation that an installer may have
 * stopped after copying only part of its tree. It does not reuse `REFUSED`
 * either: moving a user-owned obstacle completes a refusal's remedy, while a
 * failed copy may need permissions, space and repair before a retry is honest.
 */
export const EXIT_CODES = Object.freeze({
  USAGE: 2,
  GATED: 3,
  NO_DRIVER: 4,
  STOPPED: 5,
  REFUSED: 6,
  INSTALL_FAILED: 7,
});

export const violation = (rule, path, message) => ({ rule, path, message });

export function reportViolations(violations) {
  for (const v of violations) console.error(`${v.rule}: ${v.path} — ${v.message}`);
  console.log(violations.length ? `${violations.length} violation(s)` : 'clean');
  return violations.length ? 1 : 0;
}

export function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && importMetaUrl === pathToFileURL(process.argv[1]).href;
}

export function runCli(importMetaUrl, main) {
  if (isMain(importMetaUrl)) process.exit(main(process.argv));
}
