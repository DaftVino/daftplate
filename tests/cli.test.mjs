import test from 'node:test';
import assert from 'node:assert/strict';
import { violation, reportViolations, isMain } from '../scripts/lib/cli.mjs';

test('violation builds the standard finding shape', () => {
  assert.deepEqual(violation('naming', 'docs/X.md', 'bad'), {
    rule: 'naming', path: 'docs/X.md', message: 'bad',
  });
});

test('reportViolations returns 0 for a clean run', () => {
  assert.equal(reportViolations([]), 0);
});

test('reportViolations returns 1 when violations exist', () => {
  assert.equal(reportViolations([violation('naming', 'a', 'b')]), 1);
});

test('isMain is false when the module is imported rather than run', () => {
  assert.equal(isMain('file:///definitely/not/the/entrypoint.mjs'), false);
});
