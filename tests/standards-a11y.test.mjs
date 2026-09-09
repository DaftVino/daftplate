// §11.1 accessibility, and the 60-line cap that decides which fragments carry it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDir } from './helpers/make-repo.mjs';
import { scaffold } from '../scripts/scaffold.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const standards = readFileSync(join(ROOT, 'engineering-standards', 'repo-standards.md'), 'utf8');
const fragment = (name) => readFileSync(join(ROOT, 'profiles', name, 'claude-md-fragment.md'), 'utf8');

/** The number §11 landed at, derived rather than hardcoded — the companion issue
 *  could have placed HTML conformance at §11, §12 or anywhere else, and this
 *  section is defined as its first subsection either way. */
const htmlSection = standards.match(/^## (\d+)\. HTML conformance$/m);

function sectionBody(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) return '';
  const rest = text.slice(start + heading.length);
  const next = rest.search(/^#{2,3} /m);
  return next === -1 ? rest : rest.slice(0, next);
}

test('the accessibility subsection sits under the HTML conformance section', () => {
  assert.notEqual(htmlSection, null, 'no "## <N>. HTML conformance" heading to derive N from');
  assert.match(standards, new RegExp(`^### ${htmlSection[1]}\\.1 Accessibility$`, 'm'));
});

const a11y = sectionBody(standards, `### ${htmlSection?.[1]}.1 Accessibility`);

test('the target is WCAG 2.2 Level AA, with the version explicit', () => {
  // "WCAG AA" unqualified has meant three different criteria sets since 2008.
  assert.match(a11y, /WCAG 2\.2 Level AA/);
});

test('it states the criteria count and the AA delta from 2.1', () => {
  assert.match(a11y, /86 success criteria/);
  // Nine were added in 2.2, but only six are A or AA — for an AA target the
  // delta is six, and quoting nine would overstate the obligation.
  assert.match(a11y, /six are Level A or AA/);
  assert.match(a11y, /3\.3\.8 Accessible Authentication/);
});

test('four UI-serving profiles are in scope and userscript is narrowed, not excluded', () => {
  for (const profile of ['web-app', 'app-monolith', 'gas-webapp', 'userscript']) {
    assert.match(a11y, new RegExp(`\`${profile}\``), `${profile} is not named`);
  }
  assert.match(a11y, /narrowed obligation/);
  assert.match(a11y, /not for the host page/);
  assert.match(a11y, /Narrowed, never excluded/);
});

test('it contains all six literal baseline strings', () => {
  for (const literal of [
    '4.5:1', 'visible focus indicator', 'empty alt',
    'programmatic labels', 'one h1', 'landmark elements',
  ]) {
    assert.equal(a11y.includes(literal), true, `§11.1 omits ${literal}`);
  }
});

test('house practice is marked as such, and AA governs where they conflict', () => {
  // Blurring the two would let a reviewer cite a house preference as though it
  // were a success criterion.
  assert.match(a11y, /\*\*House practice\*\*/);
  assert.match(a11y, /no A\/AA criterion requires it/);
  assert.match(a11y, /never override a success criterion/);
});

test('the enforcement statement carries no percentage figure anywhere', () => {
  // An earlier draft had a standards document assert that tooling catches
  // "roughly 30–40% of WCAG issues by the vendors' own published figures" —
  // unsourced, no vendor named. An unsourced statistic in a canonical document
  // is worse than the argument it supports, and the argument stands without it.
  assert.doesNotMatch(a11y, /\d+\s*%/);
  assert.doesNotMatch(a11y, /\d+\s*–\s*\d+\s*%/);
  assert.match(a11y, /A green automated run is not conformance/);
});

test('it says daftplate ships no checker, without advising scaffolded repos against one', () => {
  // CLAUDE.md #4 governs daftplate's own scripts, not the repos it scaffolds. A
  // scaffolded web-app has a build and is free to install axe-core.
  assert.match(a11y, /scaffolding ships no accessibility checker/);
  assert.match(a11y, /free to install one/);
});

test('it names the 60-line cap as the reason two fragments carry no pointer', () => {
  assert.match(a11y, /60 lines/);
  assert.match(a11y, /app-monolith` and `userscript`|`app-monolith` and `userscript`/);
});

test('the web-app fragment carries both replacement constraints and no "checks both"', () => {
  const text = fragment('web-app');
  assert.match(text, /`\/design-review` checks this\./);
  assert.match(text, /Accessibility is a conformance target, not a preference/);
  // The old sentence's "checks both" had two referents — tokens AND accessibility
  // — and only the first was true.
  assert.equal(text.includes('checks both'), false);
});

test('gas-webapp gains the constraint and the two capped profiles are untouched', () => {
  assert.match(fragment('gas-webapp'), /^5\. \*\*Accessibility is a conformance target/m);
  for (const profile of ['app-monolith', 'userscript']) {
    assert.equal(
      /[Aa]ccessibilit/.test(fragment(profile)),
      false,
      `${profile} was edited despite composing at the cap`,
    );
  }
});

test('no fragment claims /design-review checks accessibility, or hardcodes a section number', () => {
  for (const name of readdirSync(join(ROOT, 'profiles'))) {
    if (!lstatSync(join(ROOT, 'profiles', name)).isDirectory()) continue;
    const text = fragment(name);
    // /design-review is a third-party pack this repo cannot pin, version or
    // inspect; a standard must not delegate a conformance claim to it.
    assert.doesNotMatch(
      text,
      /design-review`? (?:checks|verifies)[^.]*accessib/i,
      `${name} claims /design-review checks accessibility`,
    );
    // A §-plus-dotted-number literal would break when the companion section
    // moves. Fragments name the referent, not the number.
    assert.doesNotMatch(text, /§\d+\.\d+/, `${name} hardcodes a section number`);
  }
});

test('every profile still composes a CLAUDE.md at 59 lines or fewer', () => {
  // One line of headroom under checkClaudeMdLength's cap of 60. Passing by zero
  // lines means the next fragment edit — this section's companion, or anything
  // else — breaks scaffolding outright.
  const profiles = readdirSync(join(ROOT, 'profiles'))
    .filter((name) => lstatSync(join(ROOT, 'profiles', name)).isDirectory())
    .sort();
  assert.ok(profiles.length >= 8, `expected the full profile set, got ${profiles.length}`);

  for (const type of profiles) {
    const dest = emptyDir();
    scaffold(ROOT, type, dest, {
      year: 2026,
      tokens: { PROJECT_NAME: `a11y-${type}`, PROJECT_SUMMARY: 'A composed-length fixture.' },
    });
    const lines = readFileSync(join(dest, 'CLAUDE.md'), 'utf8').split(/\r?\n/).length;
    assert.ok(lines <= 59, `${type} composes to ${lines} lines, leaving no headroom`);
  }
});

test('the standards headings renumber nothing; 11.1 and 6.6.1 are additions', () => {
  const headings = [...standards.matchAll(/^#{2,3} (\d+(?:\.\d+)*)[. ]/gm)].map((m) => m[1]);
  assert.deepEqual(headings, [
    '1', '2', '2.1', '2.2', '2.3', '3', '4', '4.1', '4.2', '5', '5.1',
    '6', '6.1', '6.2', '6.3', '6.4', '6.5', '6.5.1', '6.6', '6.6.1',
    '7', '8', '9', '10', '11', '11.1', '12',
  ]);
});
