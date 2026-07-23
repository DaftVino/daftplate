import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSkills } from '../scripts/install-skills.mjs';
import { scaffold } from '../scripts/scaffold.mjs';
import { emptyDir } from './helpers/make-repo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(ROOT, 'profiles', 'app-monolith', 'files', 'dot-claude', 'skills');
const values = (name) => ({ year: 2026, tokens: { PROJECT_NAME: name, PROJECT_SUMMARY: 'A throwaway scaffold.' } });

// Grows to all five by session 4d.
const SHIPPED = ['architecture-docs', 'feature-flow', 'domain-module', 'database-schema', 'architecture-audit'];

for (const name of SHIPPED) {
  test(`app-monolith ships the ${name} skill source`, () => {
    assert.ok(existsSync(join(SKILLS_DIR, name, 'SKILL.md')), `missing ${name}/SKILL.md`);
  });
}

// The load-bearing integration test: source existence is not enough — the
// dot-claude/ -> .claude/ rename over a NESTED subtree is a code path no prior
// profile exercises, so assert the skills actually reach a scaffolded repo.
test('scaffolding app-monolith delivers every skill into .claude/skills/', () => {
  const dest = emptyDir();
  scaffold(ROOT, 'app-monolith', dest, values('dry-am-skills'));
  for (const name of SHIPPED) {
    assert.ok(
      existsSync(join(dest, '.claude', 'skills', name, 'SKILL.md')),
      `${name} did not survive the dot-claude/ -> .claude/ scaffold`,
    );
  }
});

// Every shipped skill's frontmatter name must match its directory — a
// zero-dependency regex parse, no YAML library.
for (const name of SHIPPED) {
  test(`${name} frontmatter name matches its directory`, () => {
    const text = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(m, `${name}/SKILL.md has no frontmatter block`);
    const nameLine = m[1].match(/^name:\s*(\S+)/m);
    assert.ok(nameLine, `${name}/SKILL.md frontmatter has no name field`);
    assert.equal(nameLine[1], name, `${name}/SKILL.md declares name: ${nameLine?.[1]}`);
  });
}

test('install-skills never picks up the repo-scoped app-monolith skills', () => {
  // Guards the ADR-0002 boundary: these skills live under profiles/, which
  // install-skills.mjs never walks (it reads the root skills/ only), so today
  // this holds by construction. It fails loudly if someone duplicates a skill
  // into root skills/ or rewrites the installer to scan profiles/**.
  const { installed } = installSkills(ROOT, join(ROOT, 'nonexistent-install-target'), { dryRun: true });
  for (const name of SHIPPED) {
    assert.ok(!installed.includes(name), `${name} must stay repo-scoped, not user-installed`);
  }
});
