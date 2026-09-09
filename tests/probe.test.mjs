import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandExists } from '../scripts/lib/probe.mjs';

// Built with join() from ROOT rather than as a relative URL literal. The publish
// dangling-import guard is a text scan over URL and import specifiers, so a bare
// directory specifier reads to it as exactly the unresolvable reference it exists
// to catch — and, being a text scan, so does prose that merely quotes one.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(ROOT, 'scripts');

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

// --- DEP0190: an argument vector may never meet a shell (#60) ----------------

test('no scripts/ spawn combines shell: true with an argument vector', () => {
  // Node concatenates rather than escapes when both are present, so the shell
  // re-parses the joined line. This is a static guard because the four sites it
  // found were each written independently and a fifth will be too — a
  // ghReleases()-style call added later is caught the moment it lands.
  const offenders = [];
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { scan(path); continue; }
      if (!entry.name.endsWith('.mjs')) continue;
      const text = readFileSync(path, 'utf8');
      // spawnSync(<cmd>, <array>, { ... shell: true ... }) on one logical call.
      const pattern = /spawnSync\(\s*[^,)]+,\s*\[[^\]]*\][^)]*shell:\s*true/gs;
      if (pattern.test(text)) offenders.push(path);
    }
  };
  scan(SCRIPTS);

  assert.deepEqual(offenders, []);
});

test('commandExists refuses a name outside its safe grammar before reaching a shell', () => {
  // Each of these would execute through a shell if the grammar were widened or
  // dropped. False, not a throw: a name the probe will not run is not present as
  // far as any caller is concerned.
  for (const hostile of [
    'node; echo pwned',
    'node && echo pwned',
    'node | echo pwned',
    'node $(echo pwned)',
    'node `echo pwned`',
    'node "quoted"',
    'node with space',
  ]) {
    assert.equal(commandExists(hostile, ['--version']), false, `accepted: ${hostile}`);
  }
  // A hostile ARGUMENT is refused on the same grammar, not just a hostile name.
  assert.equal(commandExists('node', ['--version; echo pwned']), false);

  // A safe shim-style name still follows the shell-resolution path that exists
  // for Windows .cmd/.ps1 bins, so the guard did not close the feature.
  assert.equal(commandExists('node', ['--version']), true);
});
