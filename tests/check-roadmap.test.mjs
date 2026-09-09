// scripts/check-roadmap.mjs — the seven rules of the plan's D7, the absent-manifest
// rule of D8, and the two places this script is mirrored.
//
// The happy-path fixture is DERIVED from base/files/ROADMAP.md rather than written
// out here. That is the point of the ordering: the shipped template is the passing
// case, so a template edit that breaks a rule turns this file red instead of
// leaving a checker that passes a document nobody ships.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { emptyDir } from './helpers/make-repo.mjs';
import {
  checkRoadmap, sectionTable,
  RUNGS, TABLE_HEADER, ROADMAP_BY_PROFILE, ROADMAP_FILE,
} from '../scripts/check-roadmap.mjs';
import { parseProfileMeta } from '../scripts/verify-templates.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATE = readFileSync(join(ROOT, 'base', 'files', 'ROADMAP.md'), 'utf8');

/** The shipped template with the two things a `required` repo must do to it: fill
 *  the blanks, and keep one board block. Everything else is left as it ships. */
function filled() {
  const lines = TEMPLATE.split('\n');
  const linearBoard = lines.findIndex((l) => l.startsWith('Board: issues are created in GitHub'));
  // The Linear block is three lines; drop it, keeping the §6.5 default.
  lines.splice(linearBoard, 3);
  return lines.join('\n')
    .replace(/<PROJECT_NAME>/g, 'fixture')
    .replace(/\| #N Title \| The observable fact that makes this true\. \| `wired` \|/,
      '| Ship the thing | A real user completes the journey on prod. | `journey-accepted` |')
    .replace(/\| #N Title \| The observable fact that makes this true\. \| `persisted` \|/,
      '| Ship the next thing | The row survives a restart. | `persisted` |')
    // The Later and Parked bullets ship example rows too; a fixture that left
    // them would not be a document anyone would call filled in.
    .replace('- **<theme>** — #N, #N, #N.', '- **Reliability** — #12, #13.')
    .replace('- #N Title — reinstated by <the condition>.', '- #9 Old idea — reinstated by a second request for it.')
    .replace(/<[a-z][^<>\n]*>/g, 'filled in');
}

/** A repo directory containing `body` as ROADMAP.md, enrolled under `profile`. */
function repo(body, profile = 'web-app') {
  const dir = emptyDir();
  if (body !== null) writeFileSync(join(dir, ROADMAP_FILE), body, 'utf8');
  if (profile !== null) {
    writeFileSync(join(dir, '.daftplate.json'), JSON.stringify({
      schema: 3, daftplate: '1.7.0', profile, tokens: {}, files: {},
    }), 'utf8');
  }
  return dir;
}

const rules = (dir) => checkRoadmap(dir).violations.map((v) => v.rule);

// --- the happy path ---------------------------------------------------------

test('the shipped template, filled and with one board block, passes', () => {
  const result = checkRoadmap(repo(filled()));
  assert.deepEqual(result.violations, []);
  assert.equal(result.roadmap, 'required');
});

test('the fixture is not vacuously passing — it really is the shipped template', () => {
  // Guards the failure where filled() drifts into a hand-written document that
  // passes while the real template does not.
  const text = filled();
  assert.match(text, /^\| Item \| Closes when \| Rung \|$/m);
  assert.match(text, /^## Standing gates$/m);
  assert.equal((text.match(/^Board:/gm) ?? []).length, 1);
  assert.equal(text.includes('#N Title'), false);
});

// --- rule 1: the file exists where the profile requires it ------------------

test('a required profile with no ROADMAP.md is a violation naming the file', () => {
  const violations = checkRoadmap(repo(null, 'web-app')).violations;
  assert.deepEqual(violations.map((v) => v.rule), ['roadmap-missing']);
  assert.equal(violations[0].path, ROADMAP_FILE);
});

test('an optional profile with no ROADMAP.md exits clean, with the reason printed', () => {
  const result = checkRoadmap(repo(null, 'local-tool'));
  assert.deepEqual(result.violations, []);
  assert.equal(result.roadmap, 'optional');
  assert.match(result.reason, /local-tool/);
});

// --- D8: the absent manifest ------------------------------------------------

test('no manifest reads as optional and never fails the repo for not being enrolled', () => {
  const result = checkRoadmap(repo(null, null));
  assert.deepEqual(result.violations, []);
  assert.equal(result.roadmap, 'optional');
  assert.match(result.reason, /not enrolled/);
});

for (const [label, manifest] of [
  ['unparseable', '{ not json'],
  ['profile-less', '{"schema":3}'],
  ['unknown profile', '{"schema":3,"profile":"space-station"}'],
]) {
  test(`a ${label} manifest resolves to optional and says which branch it took`, () => {
    const dir = emptyDir();
    writeFileSync(join(dir, '.daftplate.json'), manifest, 'utf8');
    const result = checkRoadmap(dir);
    assert.equal(result.roadmap, 'optional');
    assert.notEqual(result.reason, '');
    assert.deepEqual(result.violations, []);
  });
}

// --- rules 2–7: one crafted fixture per rule --------------------------------

test('rule 2 — a missing ## Next section is a violation', () => {
  const text = filled().replace(/^## Next.*$/m, '## Soon, maybe');
  assert.deepEqual(rules(repo(text)), ['roadmap-section']);
});

test('rule 3 — a two-column table under ## Now is a violation naming the header', () => {
  const text = filled()
    .replace('| Item | Closes when | Rung |\n|---|---|---|\n| Ship the thing | A real user completes the journey on prod. | `journey-accepted` |',
      '| Item | Closes when |\n|---|---|\n| Ship the thing | A real user completes the journey on prod. |');
  const violations = checkRoadmap(repo(text)).violations;
  assert.deepEqual(violations.map((v) => v.rule), ['roadmap-table']);
  assert.match(violations[0].message, /Item \| Closes when \| Rung/);
});

test('rule 3 — a section with no table at all is a violation', () => {
  const text = filled().replace(
    '| Item | Closes when | Rung |\n|---|---|---|\n| Ship the next thing | The row survives a restart. | `persisted` |',
    'Nothing queued.');
  assert.deepEqual(rules(repo(text)), ['roadmap-table']);
});

test('rule 4 — a rung outside the ladder is a violation naming all seven', () => {
  const text = filled().replace('| `journey-accepted` |', '| `done` |');
  const violations = checkRoadmap(repo(text)).violations;
  assert.deepEqual(violations.map((v) => v.rule), ['roadmap-rung']);
  for (const rung of RUNGS) assert.match(violations[0].message, new RegExp(rung));
});

test('rule 4 — an unbackticked rung is a violation, because the column is a vocabulary', () => {
  const text = filled().replace('| `journey-accepted` |', '| journey-accepted |');
  assert.deepEqual(rules(repo(text)), ['roadmap-rung']);
});

test('rule 5 — an empty "Closes when" cell is a violation naming the row', () => {
  const text = filled().replace('| A real user completes the journey on prod. |', '|   |');
  const violations = checkRoadmap(repo(text)).violations;
  assert.deepEqual(violations.map((v) => v.rule), ['roadmap-evidence']);
  assert.match(violations[0].message, /Ship the thing/);
});

test('rule 6 — the template as shipped fails, because two board blocks survive', () => {
  // Deliberate: the adopter chooses, and until they do the file is not conformant.
  const text = TEMPLATE.replace(/<PROJECT_NAME>/g, 'fixture');
  assert.ok(rules(repo(text)).includes('roadmap-board'));
});

test('rule 6 — zero board blocks is equally a violation', () => {
  const text = filled().replace(/^Board:.*$/m, 'No board here.');
  assert.deepEqual(rules(repo(text)), ['roadmap-board']);
});

test('rule 7 — an unfilled skeleton under required is a violation naming a placeholder', () => {
  const text = filled().replace('filled in', '<the one outcome this section buys>');
  const violations = checkRoadmap(repo(text)).violations;
  assert.deepEqual(violations.map((v) => v.rule), ['roadmap-skeleton']);
  assert.match(violations[0].message, /<the one outcome this section buys>/);
});

test('rule 7 — the shipped example row under required is a violation', () => {
  const text = filled().replace(
    '| Ship the thing | A real user completes the journey on prod. | `journey-accepted` |',
    '| #N Title | The observable fact that makes this true. | `wired` |');
  assert.deepEqual(rules(repo(text)), ['roadmap-skeleton']);
});

test('rule 7 — the same skeleton under optional is clean', () => {
  // An optional repo may keep the file unfilled or delete it; failing it for
  // keeping the shipped copy would punish the repo that did nothing wrong.
  const text = filled().replace('filled in', '<the one outcome this section buys>');
  assert.deepEqual(rules(repo(text, 'design-vault')), []);
});

// --- the parser -------------------------------------------------------------

test('sectionTable distinguishes an absent heading from a heading with no table', () => {
  assert.equal(sectionTable('# x\n', '## Now'), null);
  assert.deepEqual(sectionTable('## Now\n\nprose only\n', '## Now'), { header: null, rows: [] });
});

test('sectionTable matches a heading carrying the template’s trailing outcome text', () => {
  const table = sectionTable(`## Now — ship it\n\n${TABLE_HEADER}\n|---|---|---|\n| a | b | \`wired\` |\n`, '## Now');
  assert.deepEqual(table.rows, [['a', 'b', '`wired`']]);
});

test('sectionTable does not read the next section’s table as this one’s', () => {
  const text = [
    '## Now', '', TABLE_HEADER, '|---|---|---|', '| a | b | `wired` |', '',
    '## Next', '', TABLE_HEADER, '|---|---|---|', '| c | d | `persisted` |', '',
  ].join('\n');
  assert.deepEqual(sectionTable(text, '## Now').rows, [['a', 'b', '`wired`']]);
  assert.deepEqual(sectionTable(text, '## Next').rows, [['c', 'd', '`persisted`']]);
});

// --- the two mirrors --------------------------------------------------------

test('the root checker and the shipped template copy are byte-identical', () => {
  // Editing only the dogfooding copy means scaffolded repos keep the old
  // behaviour; editing only the template means this repo does.
  assert.equal(
    readFileSync(join(ROOT, 'scripts', 'check-roadmap.mjs'), 'utf8'),
    readFileSync(join(ROOT, 'base', 'files', 'scripts', 'check-roadmap.mjs'), 'utf8'),
  );
});

// The embedded table is the second source of truth this design accepts, and this
// is the test that makes it safe. Without it, a profile reclassified in
// profile.md would keep the old answer in every repo the checker ships to.
test('the embedded classification equals what the eight profile.md files declare', () => {
  const declared = Object.fromEntries(
    readdirSync(join(ROOT, 'profiles')).map((name) => [
      name,
      parseProfileMeta(readFileSync(join(ROOT, 'profiles', name, 'profile.md'), 'utf8')).roadmap,
    ]),
  );
  assert.deepEqual(ROADMAP_BY_PROFILE, declared);
});

// --- the CLI ----------------------------------------------------------------

test('the CLI prints the branch it took and exits 0 on a clean repo', () => {
  const dir = repo(filled());
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-roadmap.mjs'), dir], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /roadmap: required — profile "web-app" declares roadmap: required/);
  assert.match(run.stdout, /clean/);
});

test('the CLI exits 1 and names the rule on a bad repo', () => {
  const dir = repo(filled().replace('| `journey-accepted` |', '| `done` |'));
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-roadmap.mjs'), dir], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /roadmap-rung/);
});

test('the CLI exits 0 in this repository, which keeps no manifest', () => {
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-roadmap.mjs'), ROOT], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /not enrolled/);
});

// --- CI ---------------------------------------------------------------------

test('both ci.yml files carry the step, and carry it identically (G5)', () => {
  const template = readFileSync(join(ROOT, 'base/files/dot-github/workflows/ci.yml'), 'utf8');
  const live = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.equal(template, live);
  assert.match(template, /- name: Check the roadmap/);
  assert.match(template, /node scripts\/check-roadmap\.mjs \./);
});

test('the CI step tolerates a repo that has the workflow but not yet the script', () => {
  // A repo scaffolded before this existed picks the workflow up from
  // sync-standards without the script; MODULE_NOT_FOUND there would be the
  // workflow failing on its own upgrade path.
  const yaml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(yaml, /if \[ -f scripts\/check-roadmap\.mjs \]/);
  // And says so, rather than passing silently.
  assert.match(yaml, /No scripts\/check-roadmap\.mjs — re-run/);
});
