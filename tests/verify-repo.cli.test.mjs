import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo, MINIMAL } from './helpers/make-repo.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/verify-repo.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('CLI exits 2 and prints usage when given no target', () => {
  const result = run();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});

test('CLI exits 0 and prints clean on a valid repo', () => {
  const result = run(makeRepo(MINIMAL));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /clean/);
});

test('CLI exits 1 and names the rule on an invalid repo', () => {
  const { LICENSE: _license, ...rest } = MINIMAL;
  const result = run(makeRepo(rest));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /root-files: LICENSE/);
});

test('CLI honours --docs-subdirs', () => {
  const dir = makeRepo({ ...MINIMAL, 'docs/database/erd.md': '# x\n' });
  assert.equal(run(dir).status, 1);
  assert.equal(run(dir, '--docs-subdirs=designs,adr,database').status, 0);
});
