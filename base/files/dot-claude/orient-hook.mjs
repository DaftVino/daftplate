#!/usr/bin/env node
// SessionStart hook: asks the agent to run /orient before spending any context.
//
// This file is committed into the repo, but /orient is installed user-level
// (daftplate ADR 0002). On a machine where daftplate's skills were never
// installed, the skill is absent — so probe first and print nothing rather
// than invoking something that does not exist. A hook that fails on every
// session start is worse than no hook.
//
// The probe emits one of two payloads, because /orient does two jobs and only
// one of them depends on the repo:
//
//   1. The situational brief — branch, version, open issues, last handoff,
//      code-map staleness. Useful in every repo, costs almost nothing.
//   2. The large-file read discipline — "never open a file over 50KB". Only
//      meaningful where such a file exists. Sending it to a repo of 5KB source
//      files spends tokens teaching a rule with nothing to bite on, and trains
//      the agent to grep where reading would be cheaper.
//
// So: walk for a large file, and send the discipline only when it applies.
//
// Deliberately does NOT read the hook's stdin payload. `readFileSync(0)` on a
// pipe that is never closed blocks forever, and a hang at session start is the
// exact failure this probe exists to prevent. The payload's `cwd` is the only
// field we would want, and `process.cwd()` already equals the project root when
// Claude Code runs a hook — verified 2026-07-22.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

/** A file at or above this size is one /orient must not open whole. */
export const LARGE_FILE_BYTES = 51200;

/** Entries examined before the walk gives up. A repo this big qualifies anyway. */
export const SCAN_LIMIT = 5000;

// Not the repo's own code: never worth walking, and a vendored bundle over the
// threshold would answer the question wrongly.
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', 'vendor']);

/**
 * Does this repo hold a file big enough for the read discipline to matter?
 * Returns on the first hit, so the common case is fast. Symlinks are never
 * followed. Hitting the scan limit returns true: a tree that large is one where
 * the discipline applies, whatever the individual file sizes turn out to be.
 */
export function hasLargeFile(root, { threshold = LARGE_FILE_BYTES, limit = SCAN_LIMIT } = {}) {
  let seen = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false; // unreadable directory is not a reason to fail a session start
    }
    for (const entry of entries) {
      if ((seen += 1) > limit) return true;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (walk(join(dir, entry.name))) return true;
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        if (statSync(join(dir, entry.name)).size >= threshold) return true;
      } catch { /* vanished mid-walk; not our problem */ }
    }
    return false;
  };
  return existsSync(root) ? walk(root) : false;
}

// Both payloads carry the same escape clause. SessionStart fires before the
// first user message, so the hook cannot know whether this session needs
// orienting at all — only the agent, reading that first message, can. Stating
// the exception here is what keeps /orient off a session that arrived with a
// specific, self-contained task.
const ESCAPE = 'Skip it, and answer directly, unless the brief would actually inform the '
  + "answer — a specific self-contained task that does not depend on this repo's state "
  + 'does not need one.';

const BRIEF = 'Run the /orient skill before anything else, including clarifying questions. '
  + 'It reads CLAUDE.md, the latest CHANGELOG entry, git state, and open issues, and emits '
  + 'a short working brief. ';

const WITH_DISCIPLINE = `${BRIEF}This repo holds at least one file over 50KB: do not open `
  + 'any file that large — read docs/code-map.md for structure, grep for specifics, or '
  + `dispatch an Explore subagent. ${ESCAPE}`;

const BRIEF_ONLY = `${BRIEF}Report state only: no file in this repo is large enough for the `
  + `read-size discipline to apply, so skip that section of the skill. ${ESCAPE}`;

export function orientContext(homeDir, repoRoot = process.cwd()) {
  if (!existsSync(join(homeDir, '.claude', 'skills', 'orient', 'SKILL.md'))) return '';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: hasLargeFile(repoRoot) ? WITH_DISCIPLINE : BRIEF_ONLY,
    },
  });
}

// Run-as-script guard, inlined rather than imported from scripts/lib/cli.mjs:
// this file ships into other repos, where that module does not exist. Without
// the guard the module writes to stdout when the test suite imports it, which
// corrupts the test runner's output.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(orientContext(homedir()));
}
