// §11 HTML conformance, plus the guard that keeps section numbers resolvable.
//
// There is no precedent in this repo for asserting on the CONTENT of
// engineering-standards/repo-standards.md — tests/verify-templates.test.mjs reads
// base/ and .github/ and never the standards document. This file is the first of
// its kind, so it follows that file's node:test conventions and invents the
// reading pattern.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDir } from './helpers/make-repo.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STANDARDS = join(ROOT, 'engineering-standards', 'repo-standards.md');
const standards = readFileSync(STANDARDS, 'utf8');

/** §11's body: from its heading to the next `## ` heading, or end of file. */
function sectionBody(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) return '';
  const rest = text.slice(start + heading.length);
  // Stops at a subsection too, so §11's own prose is measured without §11.1's.
  const next = rest.search(/^#{2,3} /m);
  return next === -1 ? rest : rest.slice(0, next);
}

const eleven = sectionBody(standards, '## 11. HTML conformance');

test('repo-standards gains section 11', () => {
  assert.match(standards, /^## 11\. HTML conformance$/m);
  assert.notEqual(eleven.trim(), '');
});

test('§11 names the WHATWG Living Standard and does not call HTML5 current', () => {
  assert.match(eleven, /WHATWG HTML Living Standard/);
  // The 2019 memorandum is named so nobody "corrects" this back to HTML5.
  assert.match(eleven, /2019/);
  assert.doesNotMatch(eleven, /the HTML5 specification/);
});

test('§11 names the Nu Html Checker as the instrument', () => {
  // WHATWG owns the specification; W3C still ships the checker. Naming both is
  // what keeps the section from reading as though W3C still owns HTML.
  assert.match(eleven, /Nu Html Checker/);
});

test('§11 measures served output rather than source, and says why', () => {
  assert.match(eleven, /served output, never source/);
  // The reason is load-bearing: without it the rule reads as a preference.
  assert.match(eleven, /scriptlets|not HTML/);
});

test('§11 carries a three-column table with one row per UI-serving profile', () => {
  const header = eleven.match(/^\| Profile \| Can a gate exist\? \| Why \|$/m);
  assert.notEqual(header, null, '§11 has no Profile / Can a gate exist? / Why table');

  for (const profile of ['gas-webapp', 'web-app', 'app-monolith', 'userscript']) {
    assert.match(eleven, new RegExp(`\\|\\s*\`${profile}\``), `no row for ${profile}`);
  }
  // userscript is IN the table, stating that a gate cannot exist — excluding it
  // would read as an oversight rather than a ruling.
  assert.match(eleven, /host site's DOM belongs to a third party/);
});

test('§11 contains all five literal baseline strings', () => {
  for (const literal of [
    '<!DOCTYPE html>',
    '<meta charset="utf-8">',
    '`lang` attribute on `<html>`',
    'unique `id` values',
    'escaped `&` and `<`',
  ]) {
    assert.equal(eleven.includes(literal), true, `§11 omits ${literal}`);
  }
});

test('§11 states its own enforcement limit and what a gate would cost', () => {
  assert.match(eleven, /Stating the rule is not enforcing it/);
  // Concrete costs, not a vague "it would be hard".
  assert.match(eleven, /§2\.2/);
  assert.match(eleven, /validator\.w3\.org\/nu/);
  assert.match(eleven, /no dependencies/);
});

test('§11 carries exactly one subsection, and hardcodes no build path or framework', () => {
  // This read "no subsection yet" when §11 landed, and #130's accessibility
  // subsection has since arrived. The heading-depth contract is what mattered,
  // so it is restated rather than deleted: §11's own prose holds no headings,
  // and 11.1 is its only child.
  assert.doesNotMatch(eleven, /^#{3,6} /m);
  const subsections = [...standards.matchAll(/^### 11\.(\d+) /gm)].map((m) => m[1]);
  assert.deepEqual(subsections, ['1']);
  // Neither profile fixes a framework or an output directory, so naming one
  // would be an inference presented as fact.
  assert.doesNotMatch(eleven, /dist\/|\.astro|Astro\b/);
});

test('the ten pre-existing top-level sections are unchanged and in order', () => {
  // Section numbers are cited from five base-layer files that ship into every
  // scaffolded repo, where this repo cannot reach in to fix a broken reference.
  // §11 appends; nothing renumbers.
  const headings = [...standards.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => `${m[1]}. ${m[2]}`);
  assert.deepEqual(headings.slice(0, 10), [
    '1. Naming conventions',
    '2. Required root files',
    '3. Canonical folder structure',
    '4. Branching and commits (GitHub Flow)',
    '5. Versioning and releases',
    '6. Tracking taxonomy: where things live',
    '7. AI agent integration',
    '8. Migrating existing notes into this system',
    '9. New repo checklist',
    '10. Executing with agents',
  ]);
});

// --- the citation guard -------------------------------------------------------
//
// Two designs were tried against the real tree and both failed.
//
// Design 1, "resolve every §N in the repo", is dead on arrival: CHANGELOG.md uses
// § as a line-number sigil and to cite OTHER documents' sections, and eight of its
// tokens resolve to nothing here.
//
// Design 2, "scope to the doc locations and keep an exemptions allowlist", fails
// worse and more quietly: docs/adr/0002 cites a DESIGN DOC's §5.1, and this
// document also has a §5.1 — so the token false-resolves and the guard reports
// green over exactly the class of error it exists to catch.
//
// The lesson is structural: a heading-existence test cannot see WHICH document is
// being cited, and that is the only fact distinguishing a real citation from a
// coincidence. Design 3 makes the citation form explicit instead.

const SCOPE = [
  'base/files/CLAUDE.md',
  'base/files/docs/quick-ref-workflow.md',
  'base/files/dot-env.example',
  'base/files/dot-github/ISSUE_TEMPLATE/bug-report.yml',
  'base/files/dot-github/ISSUE_TEMPLATE/feature-request.yml',
  'CLAUDE.md',
  'docs/architecture.md',
  'docs/adr/0002-skills-installed-user-level.md',
  'docs/adr/0003-hand-rolled-layer-propagation.md',
  'docs/adr/0004-publication-by-curated-export.md',
  'docs/adr/0006-issues-are-created-in-github-and-managed-in-linear.md',
];

/**
 * Every §-token within 60 characters of a `repo-standards` marker on the same line.
 *
 * EVERY token in the window, not just the first: `docs/adr/0003:43` reads
 * "required by `repo-standards.md` §2.1 and §9", and a non-greedy match stopping
 * at the first would silently drop §9, which is a real citation of this document.
 *
 * Cross-document citations carry no marker and are therefore invisible here, with
 * no allowlist to rot. That is the point of the design, not a gap in it.
 */
export function collectMarkedTokens(root, scope) {
  const found = [];
  for (const rel of scope) {
    let text;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;                    // a fixture tree need not hold every file
    }
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      let at = line.indexOf('repo-standards');
      while (at !== -1) {
        const window = line.slice(at, at + 60);
        for (const m of window.matchAll(/§(\d+(?:\.\d+)*)/g)) {
          found.push({ rel, line: index + 1, token: m[1] });
        }
        at = line.indexOf('repo-standards', at + 1);
      }
    }
  }
  return found;
}

/**
 * A token resolves iff a level 2–6 heading is followed by a space, exactly the
 * token, and then either a period-and-space or a space.
 *
 * BOTH terminators, because this document uses both: top-level headings carry a
 * trailing period (`## 6. Tracking taxonomy`) and subsections do not
 * (`### 6.5 Boards`). Requiring only the period was the first implementation
 * here, and it reported seven real, resolvable citations as broken — a third
 * failed guard design, caught because the guard was run against the live tree
 * rather than a fixture.
 *
 * The terminator is what stops `§6.5` being satisfied by `### 6.5.1 Variant: …`:
 * after `6.5` comes `.1`, which is neither `. ` nor ` `. Prefix matching is the
 * obvious wrong implementation and this rule exists to forbid it. Three levels
 * exist, so a two-level pattern would also be wrong.
 */
export function resolvesIn(standardsText, token) {
  const escaped = token.replace(/\./g, '\\.');
  return new RegExp(`^#{2,6} ${escaped}(?:\\. | )`, 'm').test(standardsText);
}

test('every marked section citation resolves against repo-standards', () => {
  const tokens = collectMarkedTokens(ROOT, SCOPE);

  // Vacuity guard. Borrowed from tests/skill-routing.test.mjs, whose own
  // empty-section assertion exists because a heading rename turned its resolution
  // test green over nothing. Without this, reformatting the scoped files makes
  // this guard a permanent silent pass.
  assert.ok(tokens.length > 0, 'the collector found no marked citations at all');

  const unresolved = tokens
    .filter(({ token }) => !resolvesIn(standards, token))
    .map(({ rel, line, token }) => `${rel}:${line} cites §${token}`);
  assert.deepEqual(unresolved, []);
});

test('the guard fails on an unresolvable marked citation', () => {
  const root = emptyDir();
  const write = (rel, body) => {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, 'utf8');
  };
  write('CLAUDE.md', 'See `repo-standards.md` §99.4 for the rule.\n');

  const tokens = collectMarkedTokens(root, ['CLAUDE.md']);
  assert.deepEqual(tokens.map((t) => t.token), ['99.4']);
  assert.equal(resolvesIn(standards, '99.4'), false);
});

test('the guard fails when it collects nothing, and prefix matching does not count', () => {
  const root = emptyDir();
  writeFileSync(join(root, 'CLAUDE.md'), 'See the standards, §6.5, for the rule.\n', 'utf8');

  // No marker, so nothing is collected — which the vacuity guard above treats as
  // a failure rather than a pass. This is the mutation that matters most: it is
  // the one that turns the guard into a silent no-op in production.
  assert.deepEqual(collectMarkedTokens(root, ['CLAUDE.md']), []);

  // And the resolution rule is not a prefix match: a §6.5 citation must not be
  // satisfied by the existence of a 6.5.1 heading alone.
  assert.equal(resolvesIn('### 6.5.1 Variant: a Linear board\n', '6.5'), false);
  assert.equal(resolvesIn('### 6.5 Boards\n', '6.5'), true);
  assert.equal(resolvesIn('## 6. Tracking taxonomy\n', '6'), true);
  // …and a longer number is not a prefix match either.
  assert.equal(resolvesIn('### 2.11 Something\n', '2.1'), false);
});

test('CHANGELOG.md is deliberately out of the guard scope', () => {
  // It uses § as a line-number sigil ("and §182 called a changelog entry…") and
  // cites other documents' sections. Those are accurate history describing this
  // document as it was, so the file is scoped out rather than rewritten.
  assert.equal(SCOPE.includes('CHANGELOG.md'), false);
});
