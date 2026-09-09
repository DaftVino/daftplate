import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ATTRIBUTION_MARKERS, gateDecision, reasonFor } from '../scripts/attribution-gate.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/attribution-gate.mjs', import.meta.url));
const feed = (raw) => spawnSync(process.execPath, [SCRIPT], { input: raw, encoding: 'utf8' });

// The payload shape is {...base, hook_event_name, tool_name, tool_input, tool_use_id},
// taken from base/files/dot-claude/question-gate.mjs:21-26 — this repo's own record of
// a gate that branched on an `auto_decide` field the binary never sends, passed its
// tests, and never fired. Nothing here invents a field.
const bash = (command) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_use_id: 'toolu_test',
  tool_input: { command },
});

const ALLOW = { block: false, reason: '' };

test('gateDecision blocks each forbidden attribution marker in a Bash command', () => {
  assert.equal(ATTRIBUTION_MARKERS.length, 3);
  for (const marker of ATTRIBUTION_MARKERS) {
    const result = gateDecision(bash(`git commit -m "feat: a thing\n\n${marker}"`));
    assert.equal(result.block, true, `not blocked: ${marker}`);
    assert.equal(result.reason, reasonFor(marker));
  }
});

test('gateDecision ignores attribution text presented to a non-Bash tool', () => {
  // Writing *about* the rule must stay possible — this repo's own docs quote the
  // markers. The gate covers the sink it can see, and says so rather than
  // pretending to cover every one.
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_use_id: 'toolu_test',
    tool_input: { file_path: 'notes.md', content: ATTRIBUTION_MARKERS.join('\n') },
  };
  assert.deepEqual(gateDecision(input), ALLOW);
});

test('gateDecision allows a clean Bash command, body-file indirection included', () => {
  assert.deepEqual(gateDecision(bash('git commit -m "fix: bound the guard by shape"')), ALLOW);
  // The known bypass, allowed deliberately: the gate does not read referenced
  // files, because doing so would make it a filesystem crawler on every Bash call.
  assert.deepEqual(gateDecision(bash('gh pr create --body-file body.md')), ALLOW);
});

test('gateDecision ignores a missing or non-string command without throwing', () => {
  const cases = [
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} },
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: null } },
    // A marker in an unrelated field must not block: scanning the whole payload
    // would blow up on every tool that happens to carry the words.
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: { nested: ATTRIBUTION_MARKERS[0] }, description: ATTRIBUTION_MARKERS[1] },
    },
    {},
  ];
  for (const input of cases) assert.deepEqual(gateDecision(input), ALLOW);
});

test('the executable emits an exact deny response for a blocked payload', () => {
  const result = feed(JSON.stringify(bash(`git commit -m "x\n\n${ATTRIBUTION_MARKERS[0]}"`)));

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reasonFor(ATTRIBUTION_MARKERS[0]),
    },
  });
});

test('the executable stays silent on a clean payload and fails open on malformed JSON', () => {
  const clean = feed(JSON.stringify(bash('git status --short')));
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout, '');

  const malformed = feed('{not json');
  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, '');
});
