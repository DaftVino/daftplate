import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo } from './helpers/make-repo.mjs';
import { gateDecision, isEnabled } from '../base/files/dot-claude/question-gate.mjs';

test('isEnabled reads the toggle file and defaults to off', () => {
  assert.equal(isEnabled(makeRepo({})), false);
  assert.equal(isEnabled(makeRepo({ '.daftplate/insist': 'on\n' })), true);
});

test('a toggle file containing "off" counts as off', () => {
  assert.equal(isEnabled(makeRepo({ '.daftplate/insist': 'off\n' })), false);
});

test('gateDecision blocks every question while insist is on', () => {
  const input = { tool_name: 'AskUserQuestion', tool_input: {} };

  const { block, reason } = gateDecision(input, { enabled: true });

  assert.equal(block, true);
  assert.match(reason, /insist/i);
});

test('gateDecision never blocks while insist is off', () => {
  const input = { tool_name: 'AskUserQuestion', tool_input: {} };
  assert.equal(gateDecision(input, { enabled: false }).block, false);
});

test('gateDecision ignores tools that are not questions', () => {
  const input = { tool_name: 'Bash', tool_input: { command: 'ls' } };
  assert.equal(gateDecision(input, { enabled: true }).block, false);
});
