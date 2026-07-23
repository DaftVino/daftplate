#!/usr/bin/env node
// PreToolUse gate for /insist: while the toggle is on, a question may not be
// auto-decided. Auto-approve and preference-based auto-decide both resolve a
// question without the user ever seeing it; an instruction in a SKILL.md cannot
// override machinery, so this runs as a hook and refuses.
//
// It never answers. It blocks, and the agent then states the question and stops.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const QUESTION_TOOLS = /AskUserQuestion$/;

export function isEnabled(homeDir) {
  const path = join(homeDir, '.daftplate', 'insist');
  if (!existsSync(path)) return false;
  return readFileSync(path, 'utf8').trim().toLowerCase() !== 'off';
}

// There is deliberately no test for "was this about to be auto-decided". The
// PreToolUse payload is {...base, hook_event_name, tool_name, tool_input,
// tool_use_id} and carries no decision provenance — an earlier draft of this
// gate branched on an `auto_decide` field that does not exist in the binary, so
// it passed its unit tests and never fired. While the toggle is on, every
// question goes to the user; that is the whole rule.
export function gateDecision(input, state) {
  if (!state.enabled) return { block: false, reason: '' };
  if (!QUESTION_TOOLS.test(input.tool_name ?? '')) return { block: false, reason: '' };
  return {
    block: true,
    reason:
      '/insist is on: this question goes to the user. State the question and '
      + 'every option verbatim, add your recommendation, and stop. Wait for the user.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let input = {};
    try { input = JSON.parse(raw); } catch { /* a malformed payload is not a reason to block */ }
    const { block, reason } = gateDecision(input, { enabled: isEnabled(homedir()) });
    if (block) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
      }));
    }
    process.exit(0);
  });
}
