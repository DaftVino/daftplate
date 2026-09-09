#!/usr/bin/env node
// PreToolUse gate for the attribution rule: a Bash command may not carry an
// attribution footer.
//
// `~/.claude/settings.json` sets attribution.commit/pr to "" and sessionUrl to
// false, but those suppress only the footer the HARNESS generates. Typing the
// same text by hand — into a `git commit -F -` heredoc, a `gh pr create
// --body-file`, a `gh issue create --body` — walks straight past the setting.
// Observed on one PR: the commit was clean and the PR body carried the footer,
// with the setting on the whole time. A control that exists only where the text
// is not produced cannot catch the case where it is produced somewhere else.
//
// Installed user-level rather than shipped in base/files/dot-claude/settings.json,
// for ADR 0002's reason applied to hooks: that file reaches a SCAFFOLDED repo, and
// the PR that triggered this was opened in daftplate itself. PRs get opened in
// repos that were never scaffolded.
//
// Standalone by construction — no import from this repo, because it runs from
// ~/.claude/ where nothing else of ours is on disk.
import { pathToFileURL } from 'node:url';

/** The three strings the rule names. Exported so the tests iterate the real list
 *  rather than a copy of it that can drift. */
export const ATTRIBUTION_MARKERS = [
  'Generated with [Claude Code]',
  'claude.com/claude-code',
  'Co-Authored-By: Claude',
];

export const reasonFor = (marker) =>
  `attribution is off: this command contains "${marker}". End the commit message, `
  + 'PR body or issue body at its last substantive line and drop the attribution block. '
  + 'The settings key only suppresses the footer the harness generates; a hand-written '
  + 'one walks past it, which is why this hook exists.';

/**
 * Pure decision over one PreToolUse payload.
 *
 * Scoped to `tool_input.command` on a Bash call, and to nothing else. Two things
 * that scope deliberately does not do:
 *
 * - It does not scan the whole payload. A marker in a `description`, or in the
 *   content of a Write, is someone writing ABOUT the rule — this repo's own docs
 *   quote all three strings — and a gate that blocks documenting itself is worse
 *   than no gate.
 * - It does not read files a command references. `gh pr create --body-file body.md`
 *   passes, and that bypass is known and accepted rather than closed by turning a
 *   hook that runs on every Bash call into a filesystem crawler.
 *
 * The payload shape is {...base, hook_event_name, tool_name, tool_input,
 * tool_use_id}, per base/files/dot-claude/question-gate.mjs:21-26. No field here
 * is invented: an earlier gate in this repo branched on an `auto_decide` field the
 * binary never sends, passed its unit tests, and never fired once.
 */
export function gateDecision(input) {
  if (input?.tool_name !== 'Bash') return { block: false, reason: '' };
  const command = input?.tool_input?.command;
  if (typeof command !== 'string') return { block: false, reason: '' };

  const marker = ATTRIBUTION_MARKERS.find((m) => command.includes(m));
  return marker ? { block: true, reason: reasonFor(marker) } : { block: false, reason: '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let input = {};
    // Fail open. A payload this gate cannot parse is not evidence of an attribution
    // footer, and a hook that blocks every Bash call on a shape change is a worse
    // failure than the one it guards against.
    try { input = JSON.parse(raw); } catch { /* not a reason to block */ }
    const { block, reason } = gateDecision(input);
    if (block) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }));
    }
    process.exit(0);
  });
}
