// The fixture helper's cleanup contract. Exercised through child processes,
// because the behaviour under test is a process-exit handler and an injected
// main() would prove the bookkeeping and nothing about whether teardown fires.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir, shouldClean } from './helpers/make-repo.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HELPER = fileURLToPath(new URL('./helpers/make-repo.mjs', import.meta.url));
// A file:// URL, not a path: on Windows an absolute path reaches the ESM loader
// as the scheme "x:" and is rejected before the child runs.
const helperUrl = JSON.stringify(pathToFileURL(HELPER).href);

/** Run a child that imports the real helper and prints the paths it created. */
function child(body, env = {}) {
  const script = `import { makeRepo, emptyDir, tempDir } from ${helperUrl};\n${body}`;
  const file = join(tempDir('helper-child-'), 'child.mjs');
  writeFileSync(file, script, 'utf8');
  return spawnSync(process.execPath, [file], {
    encoding: 'utf8',
    env: { ...process.env, DAFTPLATE_KEEP_TMP: '', ...env },
  });
}

test('a successful child process removes every directory its helper created', () => {
  const result = child(`
    console.log(JSON.stringify([makeRepo({ 'a.txt': 'x' }), emptyDir()]));
  `);
  assert.equal(result.status, 0, result.stderr);
  const [repo, empty] = JSON.parse(result.stdout);

  assert.equal(existsSync(repo), false, `left behind: ${repo}`);
  assert.equal(existsSync(empty), false, `left behind: ${empty}`);
});

test('cleanup uses the temp root captured at creation', () => {
  // Recomputing tmpdir() during teardown lets an environment change between
  // creation and exit turn a legitimate removal into a retention.
  const result = child(`
    const dirs = [makeRepo({ 'a.txt': 'x' }), emptyDir()];
    process.env.TMPDIR = process.env.TEMP = process.env.TMP = 'nowhere-real';
    console.log(JSON.stringify(dirs));
  `);
  assert.equal(result.status, 0, result.stderr);

  for (const dir of JSON.parse(result.stdout)) {
    assert.equal(existsSync(dir), false, `left behind: ${dir}`);
  }
});

test('a successful child leaves a temp directory created by another process untouched', () => {
  // Created by the PARENT, sharing the helper's own prefix. A prefix glob or a
  // scan of the temp root would take it; the in-process ownership record cannot.
  const outsider = tempDir('pt-');
  writeFileSync(join(outsider, 'keep.txt'), 'mine\n', 'utf8');

  const result = child(`console.log(JSON.stringify([emptyDir()]));`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(JSON.parse(result.stdout)[0]), false);

  assert.equal(existsSync(outsider), true, 'another process\'s fixture was removed');
  assert.equal(readFileSync(join(outsider, 'keep.txt'), 'utf8'), 'mine\n');
});

test('fixture retention policy keeps failed and explicitly requested runs', () => {
  // A pure predicate rather than a deliberately failing child: that child's
  // retained fixture would make this suite leak by construction, which is the
  // very thing the helper exists to stop.
  assert.equal(shouldClean(0, {}), true);
  assert.equal(shouldClean(1, {}), false);
  assert.equal(shouldClean(0, { DAFTPLATE_KEEP_TMP: '1' }), false);
  assert.equal(shouldClean(1, { DAFTPLATE_KEEP_TMP: '1' }), false);
});

test('test fixtures create temporary directories only through the tracked helper', () => {
  // A direct temp-directory call in a test module is an untracked fixture that no
  // teardown owns, which is exactly how the leak accumulated in the first place.
  // Matched as a CALL, so prose naming the banned function does not self-flag.
  const call = /mkdtempSync\s*\(/;
  const offenders = readdirSync(join(ROOT, 'tests'))
    .filter((name) => name.endsWith('.mjs'))
    .filter((name) => call.test(readFileSync(join(ROOT, 'tests', name), 'utf8')));

  assert.deepEqual(offenders, []);
});
