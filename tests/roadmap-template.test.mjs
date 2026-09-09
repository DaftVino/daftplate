// base/files/ROADMAP.md — the template itself, and the wiring that ships it.
//
// The rules here are the ones D5 and G4 decided and Phase 3's checker will later
// enforce inside a scaffolded repo. Asserting them against the template is not
// redundant with that checker: the template is Phase 3's happy-path fixture, so a
// template that violates its own rules would make the checker's passing case a
// lie rather than a proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo } from './helpers/make-repo.mjs';
import { scaffold } from '../scripts/scaffold.mjs';
import { emptyDir } from './helpers/make-repo.mjs';
import { REQUIRED_BASE_FILES, checkBase } from '../scripts/verify-templates.mjs';
import { ALLOWED_UPPERCASE_ROOT } from '../scripts/verify-repo.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATE = readFileSync(join(ROOT, 'base', 'files', 'ROADMAP.md'), 'utf8');

test('the template is a required base file', () => {
  assert.equal(REQUIRED_BASE_FILES.includes('files/ROADMAP.md'), true);
});

test('checkBase names the file when the base layer drops it', () => {
  const files = Object.fromEntries(
    REQUIRED_BASE_FILES
      .filter((rel) => rel !== 'files/ROADMAP.md')
      .map((rel) => [
        `base/${rel}`,
        rel.endsWith('CLAUDE.md')
          ? '# CLAUDE.md\n<!-- profile:constraints -->\n<!-- profile:routing -->\n<!-- profile:context -->\n'
          : '# content\n',
      ]),
  );
  const violations = checkBase(makeRepo(files));

  assert.deepEqual(violations.map((v) => v.path), ['base/files/ROADMAP.md']);
  assert.equal(violations[0].rule, 'base-files');
});

// D5: both fields are answered by git and cannot go stale there, so a template
// that ships either one reintroduces the thing a sibling repo's 19-day-old stamp
// is the standing evidence against.
test('the template carries no Updated: or Owner: line', () => {
  assert.equal(TEMPLATE.match(/^.*\b(?:Updated|Owner):.*$/gm), null);
});

// §6.5 rule 8 bans estimates on the board; a roadmap that reintroduced one would
// put the two surfaces back into disagreement.
test('the Now and Next tables are three columns, with no size or estimate', () => {
  const headers = [...TEMPLATE.matchAll(/^\| Item \| Closes when \| Rung \|$/gm)];
  assert.equal(headers.length, 2, 'expected exactly the Now and Next table headers');
  assert.doesNotMatch(TEMPLATE, /\|\s*(?:Size|Estimate|Points)\s*\|/i);
});

// G4: a bare `#N` in a file that ships into other repositories resolves against
// whatever repository the reader is standing in. `#N` as a literal placeholder is
// fine; `#147` is not, and would point at a stranger's issue.
test('the template carries no issue number that would resolve elsewhere', () => {
  assert.equal(TEMPLATE.match(/#\d+/g), null);
});

// D2: both blocks ship, one gets deleted on adoption. Phase 3's checker fails a
// file where more than one survives, so the shipped template is deliberately in
// the failing state until a human chooses.
test('both board blocks ship, so the choice is a deliberate act', () => {
  assert.equal((TEMPLATE.match(/^Board:/gm) ?? []).length, 2);
  assert.match(TEMPLATE, /keep exactly ONE of the two blocks below and delete the other/);
});

test('every section the standard names is present', () => {
  for (const heading of [
    '## Charter', '## Now — ', '## Next — ', '## Gate — ',
    '## Later — ', '## Parked', '## Standing gates', '## Standing decisions',
  ]) {
    assert.equal(TEMPLATE.includes(heading), true, `template omits ${heading}`);
  }
});

test('the standing gates table names a cadence and a last-verified column', () => {
  assert.match(TEMPLATE, /^\| Gate \| Target \| Cadence \| Last verified \|$/m);
  // These two rows shipped reading `TBD — no conformance target set upstream`,
  // which was true when the plan was written and false by the time the template
  // landed: #128 and #130 closed, and §11 and §11.1 now set both targets. A gate
  // row that says a target is unset while the standard sets it teaches every
  // scaffolded repo something untrue, so the rows name the real targets.
  assert.doesNotMatch(TEMPLATE, /no conformance target set upstream/);
  assert.match(TEMPLATE, /\| Accessibility \| WCAG 2\.2 Level AA/);
  assert.match(TEMPLATE, /\| HTML conformance \| WHATWG HTML Living Standard/);
});

// The template's own account of the checker must not be narrower than §6.6.1's,
// or the file that ships into every repo teaches a smaller claim than the standard
// makes — and understating a check is the same failure as overstating one.
test('the template states what is checked and admits what is not', () => {
  assert.match(TEMPLATE, /Every other rule on this page is convention/);
  assert.match(TEMPLATE, /a green run proves a rung\s*\n?was named, never that it was earned/);
  assert.match(TEMPLATE, /§6\.6\.1/);
});

// --- the scaffold path ------------------------------------------------------

const scaffolded = () => {
  const dest = emptyDir();
  scaffold(ROOT, 'web-app', dest, {
    year: 2026,
    tokens: { PROJECT_NAME: 'roadmap-fixture', PROJECT_SUMMARY: 'A throwaway scaffold.' },
  });
  return readFileSync(join(dest, 'ROADMAP.md'), 'utf8');
};

test('a scaffold fills PROJECT_NAME and leaves the hand-filled blanks alone', () => {
  const text = scaffolded();

  assert.equal(text.includes('<PROJECT_NAME>'), false);
  assert.match(text, /^roadmap-fixture's only live state document/m);
  // Everything else is the repo's to fill, and a scaffold that helpfully guessed
  // at them would produce a file that looks complete and says nothing.
  assert.equal(text.includes('<the one outcome this section buys>'), true);
  assert.equal(text.includes('<the outcome after that>'), true);
  assert.equal(text.includes('<horizon>'), true);
});

// The hand-filled blanks are lowercase on purpose. verify-repo flags an uppercase
// `<LIKE_THIS>` span as an unsubstituted scaffold token, so an uppercase blank
// would report a violation on every fresh scaffold — and scaffold.mjs runs
// verifyRepo over its own output, so the template would fail the act that ships it.
test('no blank in the scaffolded file looks like an unsubstituted scaffold token', () => {
  assert.equal(scaffolded().match(/(?<!<)<[A-Z][A-Z_]{2,}>(?!>)/g), null);
});

// ROADMAP.md is uppercase at the root of every scaffolded repo, which verify-repo
// rejects unless the name is on its canonical list. It is NOT added to
// REQUIRED_ROOT_FILES: a repo whose profile says `roadmap: optional` may delete
// the file, and requiring it at the root would contradict the meta key.
test('ROADMAP.md is a canonical root name but is not required at the root', async () => {
  assert.equal(ALLOWED_UPPERCASE_ROOT.includes('ROADMAP.md'), true);
  const { REQUIRED_ROOT_FILES } = await import('../scripts/verify-repo.mjs');
  assert.equal(REQUIRED_ROOT_FILES.includes('ROADMAP.md'), false);
});

test('the base layer documents the file and the lowercase-blank rule', () => {
  const baseMd = readFileSync(join(ROOT, 'base', 'base.md'), 'utf8');
  assert.match(baseMd, /## ROADMAP\.md/);
  assert.match(baseMd, /roadmap: required/);
  assert.match(baseMd, /lowercase on purpose/);
});

test('the quick-ref decision rule sends live state to ROADMAP.md and handoffs to issues', () => {
  const quickRef = readFileSync(join(ROOT, 'base', 'files', 'docs', 'quick-ref-workflow.md'), 'utf8');
  assert.match(quickRef, /\*\*`ROADMAP\.md`\*\* at root/);
  assert.match(quickRef, /never a file of its own/);
});

// D3 (#152 / FORGE-246): one variant-neutral row rather than two of which one is
// always wrong. Under §6.5 the required fields are a project, a type and a
// priority, not a draft; under §6.5.1 a project, a priority and blocking
// relations within 24h. The row names neither set, because the standards already
// do and a row restating them would drift from them.
const gateRow = (text, gate) => {
  const line = text.split('\n').find((l) => l.startsWith(`| ${gate} |`));
  assert.ok(line, `no standing-gate row for ${gate}`);
  return line.slice(1, -1).split('|').map((cell) => cell.trim());
};

test('the template carries a variant-neutral Board dressing gate', () => {
  const [gate, target, cadence] = gateRow(TEMPLATE, 'Board dressing');

  assert.equal(gate, 'Board dressing');
  assert.equal(cadence, 'weekly');
  assert.match(target, /§6\.5, §6\.5\.1/, 'the row cites both variants rather than enumerating either');
  assert.doesNotMatch(
    target,
    /\bLinear\b|\bGitHub Project\b/,
    'a row naming one board ships wrong to every repo on the other',
  );
});

// The section's own instruction: a gate with no date is a claim, not evidence,
// and a date on a gate nobody has verified is the backfill the column exists to
// prevent. It ships `—` and earns a date the first time someone actually checks.
test('the Board dressing row ships unverified, not backfilled', () => {
  const cells = gateRow(TEMPLATE, 'Board dressing');

  assert.equal(cells.at(-1), '—');
  assert.doesNotMatch(cells.at(-1), /\d{4}-\d{2}-\d{2}/, 'a shipped template has verified nothing');
  // Not a rule about one row: every row in a freshly shipped template is unverified.
  const verified = TEMPLATE.slice(TEMPLATE.indexOf('## Standing gates')).split('\n')
    .filter((l) => /^\| (?!Gate \|)[^|]+\|/.test(l) && !/^\|[\s|:-]+\|$/.test(l))
    .map((l) => l.slice(1, -1).split('|').map((c) => c.trim()).at(-1));
  assert.deepEqual([...new Set(verified)], ['—'], 'the template verifies nothing on anybody else\'s behalf');
});
