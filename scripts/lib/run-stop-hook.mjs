// The hook an unattended session runs before every tool call, to find out whether
// somebody has asked it to stop. ADR 0008 row 8's second honourer.
//
// Phase 5 of docs/designs/2026-08-27-plan-delegated-fix-loop.md, for
// #193 (FORGE-259). Registered by `buildStopSettings` in run-record.mjs through
// `--settings`, which is the surface the panel record's *What no seat looked for*
// names as unexamined and cheap.
//
// It takes one argument — the path of this run's stop request — and reads nothing
// else. Not the runs root, not the record, not the repository: a hook that had to
// locate things would be a hook with a way to be wrong about which run it is in.
//
// **It never fails a session shut.** A missing file, an unreadable one, a file
// carrying another `kind`: all of them print nothing and exit 0, which is the
// hook saying *carry on*. The failure this avoids is a stop mechanism that halts
// every run whenever its own plumbing breaks, which is how a safety mechanism
// gets switched off by the people it protects.
import { readFileSync, existsSync } from 'node:fs';
import { isMain } from './cli.mjs';
import { STOP_KIND } from './run-record.mjs';

/**
 * What the hook prints, given the contents of a stop file.
 *
 * `continue: false` is the documented way a hook halts a session rather than one
 * tool call. `permissionDecision: deny` is carried alongside it as the narrower
 * refusal, so a release that ignores one still refuses the tool — the same
 * belt-and-braces idiom as the invocation guard being asserted in both
 * `buildInvocation` and `spawnAgent`.
 */
export function stopDecision(request) {
  if (!request || request.kind !== STOP_KIND) return null;
  const who = request.requestedBy?.user ?? 'somebody';
  const why = request.reason ? `: ${request.reason}` : '';
  const reason = `this unattended run was stopped by ${who} at ${request.requestedAt}${why}`
    + ' (ADR 0008 row 8). Nothing has been removed; the worktree is left for inspection.';
  return {
    continue: false,
    stopReason: reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/** Read a stop file without ever throwing. Anything unreadable is *no request*. */
export function readStopFile(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function main(argv) {
  const decision = stopDecision(readStopFile(argv[2]));
  if (decision) process.stdout.write(`${JSON.stringify(decision)}\n`);
  return 0;
}

// `isMain` rather than `runCli`: that helper exits with main's return value, and
// this hook's exit code is read by Claude Code as a control signal rather than as
// a status. It always exits 0 and says what it means in JSON.
if (isMain(import.meta.url)) main(process.argv);
