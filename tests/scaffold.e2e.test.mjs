import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { emptyDir } from './helpers/make-repo.mjs';
import { scaffold } from '../scripts/scaffold.mjs';
import { MAX_PROVENANCE_SCHEMA } from '../scripts/lib/provenance.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const values = (name) => ({
  year: 2026,
  tokens: { PROJECT_NAME: name, PROJECT_SUMMARY: 'A throwaway scaffold used to verify daftplate.' },
});

// Read from disk rather than hardcoding: a profile added without a test edit is
// covered by construction, and forgetting to add one cannot ship green.
const PROFILES = readdirSync(join(ROOT, 'profiles'))
  .filter((name) => lstatSync(join(ROOT, 'profiles', name)).isDirectory())
  .sort();

test('every profile directory is exercised by this suite', () => {
  assert.ok(PROFILES.length >= 4, `found ${PROFILES.length} profiles: ${PROFILES.join(', ')}`);
});

for (const type of PROFILES) {
  test(`scaffolding ${type} from the real layers produces a clean repo`, () => {
    const dest = emptyDir();
    const { violations } = scaffold(ROOT, type, dest, values(`dry-${type}`));
    assert.deepEqual(violations, []);
  });

  test(`scaffolded ${type} CLAUDE.md is complete and under 60 lines`, () => {
    const dest = emptyDir();
    scaffold(ROOT, type, dest, values(`dry-${type}`));
    const text = readFileSync(join(dest, 'CLAUDE.md'), 'utf8');
    assert.equal(text.includes('<!-- profile:'), false);
    assert.equal(text.includes('<PROJECT_SUMMARY>'), false);
    assert.ok(text.split(/\r?\n/).length <= 60, `CLAUDE.md is ${text.split(/\r?\n/).length} lines`);
  });
}

test('a scaffolded repo carries a runnable orient hook', () => {
  const dest = emptyDir();
  scaffold(ROOT, 'web-app', dest, values('dry-hook'));

  const hook = join(dest, '.claude', 'orient-hook.mjs');
  assert.equal(existsSync(hook), true, 'orient-hook.mjs did not survive the dot- rename');

  const result = spawnSync(process.execPath, [hook], { encoding: 'utf8' });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
});

test('scaffold rejects an unknown profile type', () => {
  assert.throws(() => scaffold(ROOT, 'no-such-type', emptyDir(), values('x')), /unknown profile type/);
});

// H1b. Nothing else proves the Dependabot config reaches a scaffolded repo. The
// verifier-clean assertion above does not: `REQUIRED_BASE_FILES` is checked
// against the TEMPLATE tree, not against the scaffold, so dropping the file in
// `apply-layer.mjs`'s collect() — `if (name === 'dependabot.yml') return []` —
// leaves every other H1b test green while no repo ever receives it.
//
// The `dot-` rename is the other half: the file is stored `dot-github/` so it
// stays inert here, and a rename that fired only at the top level would ship
// `.github/dot-dependabot.yml`, which GitHub ignores silently.
for (const type of PROFILES) {
  test(`scaffolding ${type} delivers .github/dependabot.yml with the dot- prefix stripped`, () => {
    const dest = emptyDir();
    scaffold(ROOT, type, dest, values(`dep-${type}`));

    const target = join(dest, '.github', 'dependabot.yml');
    assert.ok(existsSync(target), `${type}: no .github/dependabot.yml`);
    assert.equal(
      existsSync(join(dest, '.github', 'dot-dependabot.yml')),
      false,
      `${type}: the dot- prefix survived the copy`,
    );
    assert.match(readFileSync(target, 'utf8'), /package-ecosystem:\s*github-actions/);
  });
}

test('a scaffolded check-roadmap.mjs is byte-identical to its template', () => {
  const dest = emptyDir();
  scaffold(ROOT, 'web-app', dest, values('dry-token-literal'));
  assert.equal(
    readFileSync(join(dest, 'scripts', 'check-roadmap.mjs'), 'utf8'),
    readFileSync(join(ROOT, 'base', 'files', 'scripts', 'check-roadmap.mjs'), 'utf8'),
  );
});

test('the scaffolded rule-7 comment still names the token and its owner', () => {
  const dest = emptyDir();
  scaffold(ROOT, 'web-app', dest, values('dry-token-comment'));
  const text = readFileSync(join(dest, 'scripts', 'check-roadmap.mjs'), 'utf8');
  assert.match(text, /PROJECT_NAME/);
  assert.match(text, /verify-repo/);
  assert.equal(/<PROJECT_NAME>/.test(text), false);
});

test('base.md records that a copied template may not show a bracketed token', () => {
  const text = readFileSync(join(ROOT, 'base', 'base.md'), 'utf8');
  assert.match(text, /never show a token in its bracketed form/i);
  assert.match(text, /verify-repo/);
});

test('a .git-only destination scaffolds through the real layers with .git intact', () => {
  // Kills the mutation where the helper accepts .git but a later stage — layer
  // composition, substitution, provenance, or the verifier — rejects or rewrites it.
  const dest = emptyDir();
  const head = 'ref: refs/heads/main\n';
  mkdirSync(join(dest, '.git'), { recursive: true });
  writeFileSync(join(dest, '.git', 'HEAD'), head, 'utf8');

  const { violations, provenance } = scaffold(ROOT, 'local-tool', dest, values('dry-git-only'));

  assert.deepEqual(violations, []);
  assert.equal(readFileSync(join(dest, '.git', 'HEAD'), 'utf8'), head);
  assert.equal(provenance.schema, MAX_PROVENANCE_SCHEMA);
  assert.equal(
    Object.values(provenance.files).every((e) => e.ownership === 'managed'),
    true,
  );
});
