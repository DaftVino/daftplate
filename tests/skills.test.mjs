import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS = join(fileURLToPath(new URL('..', import.meta.url)), 'skills');

const names = readdirSync(SKILLS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

test('every skill directory holds a SKILL.md', () => {
  for (const name of names) {
    assert.equal(existsSync(join(SKILLS, name, 'SKILL.md')), true, `${name} has no SKILL.md`);
  }
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
