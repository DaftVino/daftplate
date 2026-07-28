import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSkills } from '../scripts/install-skills.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKILLS = join(ROOT, 'skills');

const dirs = readdirSync(SKILLS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

// A skill is a directory that holds a SKILL.md. A directory without one is a
// skill under construction — bundled scripts land in one phase and the SKILL.md
// in the next — and the installer must skip it whole rather than install half of
// it into ~/.claude/skills/.
const names = dirs.filter((name) => existsSync(join(SKILLS, name, 'SKILL.md')));

test('a skill directory with no SKILL.md installs nothing, and says which one it skipped', () => {
  const unbuilt = dirs.filter((name) => !names.includes(name));
  const result = installSkills(ROOT, join(ROOT, 'this-target-is-never-written'), { dryRun: true });

  assert.deepEqual(result.installed, [...names].sort());
  assert.deepEqual(result.skipped, unbuilt.sort());
});

test('every SKILL.md opens with frontmatter whose name matches its directory', () => {
  for (const name of names) {
    const text = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
    assert.equal(text.startsWith('---\n'), true, `${name}: no opening frontmatter fence`);

    const end = text.indexOf('\n---\n', 4);
    assert.notEqual(end, -1, `${name}: frontmatter is not closed`);

    const frontmatter = text.slice(4, end);
    assert.match(frontmatter, new RegExp(`^name:\\s*${name}$`, 'm'), `${name}: name does not match directory`);
    assert.match(frontmatter, /^description:\s*\S/m, `${name}: no description`);
  }
});

test('every skill Phase 2 ships is present', () => {
  for (const expected of ['brief', 'code-map', 'curious', 'deliberate', 'gas-deploy', 'handoff', 'insist', 'new-project', 'orient']) {
    assert.equal(names.includes(expected), true, `missing skill: ${expected}`);
  }
});
