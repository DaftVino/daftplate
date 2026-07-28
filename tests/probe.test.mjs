import test from 'node:test';
import assert from 'node:assert/strict';
import { commandExists } from '../scripts/lib/probe.mjs';

// Unlike tests/check-machine.test.mjs, this file DOES touch PATH — it is the one
// place the real spawn is exercised, because the argument list is the whole
// point and an injected prober would prove nothing about it. `node` is the only
// command it depends on, and the suite is running inside it.

test('a command that answers its version probe is present', () => {
  assert.equal(commandExists('node'), true);
});

test('a command that is not there is absent', () => {
  assert.equal(commandExists('definitely-not-a-real-command-xyzzy'), false);
});

// The defect this file exists for: the probe form is per-tool. `restic
// --version` is an unknown flag and exits 1, so a fixed `--version` reported an
// installed restic as missing. Proven here against node, which is present in
// every environment this suite runs in — a bad argument list must be the
// difference between present and absent.
test('the probe uses the argument list it is given', () => {
  assert.equal(commandExists('node', ['--version']), true);
  assert.equal(commandExists('node', ['--no-such-flag']), false);
});

test('omitting the argument list falls back to --version', () => {
  assert.equal(commandExists('node'), commandExists('node', ['--version']));
});
