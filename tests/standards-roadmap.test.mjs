// §6.6's ROADMAP clauses, and §6.6.1's honest list of what a check cannot
// establish. Follows the reading pattern tests/standards-html.test.mjs invented
// for asserting on the CONTENT of engineering-standards/repo-standards.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROADMAP_VALUES } from '../scripts/verify-templates.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const standards = readFileSync(join(ROOT, 'engineering-standards', 'repo-standards.md'), 'utf8');

/** A section's body: from its heading to the next level 2–3 heading, so §6.6 is
 *  measured without §6.6.1's prose and §6.6.1 without §7's. */
function sectionBody(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) return '';
  const rest = text.slice(start + heading.length);
  const next = rest.search(/^#{2,3} /m);
  return next === -1 ? rest : rest.slice(0, next);
}

const six6 = sectionBody(standards, '### 6.6 Evidence: what "done" means');
const notChecked = sectionBody(standards, '### 6.6.1 What is not checked');

test('§6.6 and §6.6.1 both exist and are non-empty', () => {
  assert.notEqual(six6.trim(), '');
  assert.notEqual(notChecked.trim(), '');
});

// The subsection is numbered rather than bare, because repo-standards has exactly
// two heading levels and every subsection is `### N.M` (§6.5.1 is the precedent).
// A bare `## What is not checked` would render as an unnumbered top-level section
// between §6.6 and §7, and the citation guard in tests/standards-html.test.mjs
// resolves `§6.6.1` only against a heading of this form.
test('the not-checked list is a numbered subsection of 6.6, not a new top-level section', () => {
  assert.match(standards, /^### 6\.6\.1 What is not checked$/m);
  const topLevel = [...standards.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.equal(topLevel.some((h) => !/^\d+\. /.test(h)), false, `unnumbered top-level heading: ${topLevel}`);
});

test('§6.6 defines an app-profile repo by the meta key rather than leaving the term undefined', () => {
  // The term was undefined before this landed; the whole point of the key is that
  // a profile states the fact about itself.
  assert.match(six6, /roadmap: required/);
  assert.match(six6, /roadmap: optional/);
  assert.match(six6, /profiles\/<type>\/profile\.md/);
  // The classification test, not the deploy-step proxy that was rejected.
  assert.match(six6, /does anyone outside this repo depend on it shipping/);
});

test('§6.6 names every profile it classifies as required, and no other', () => {
  const required = ['app-monolith', 'web-app', 'gas-webapp', 'userscript'];
  for (const name of required) assert.match(six6, new RegExp(`\`${name}\``), `§6.6 omits ${name}`);
  for (const name of ['local-tool', 'content-library', 'design-vault', 'office-automation']) {
    assert.doesNotMatch(six6, new RegExp(`\`${name}\``), `§6.6 names ${name} among the required profiles`);
  }
});

test('§6.6 names the template and separates the copy from the requirement', () => {
  assert.match(six6, /base\/files\/ROADMAP\.md/);
  // D6: the file ships everywhere; the meta key governs enforcement, not the copy.
  assert.match(six6, /ships to \*\*every\*\* scaffolded repo/);
  assert.match(six6, /deleting the file is a correct first act/);
});

test('§6.6 states the shape the checker will later enforce', () => {
  assert.match(six6, /Item \| Closes when \| Rung/);
  assert.match(six6, /at most five rows/);
  assert.match(six6, /`## Standing gates`/);
  assert.match(six6, /Exactly one line beginning `Board:` survives/);
  // D5: both banned lines are named, so nobody reintroduces them as an improvement.
  assert.match(six6, /No `Updated:` line and no owner column/);
  assert.match(six6, /No size or estimate column/);
});

test('§6.6 keeps the clauses it already carried', () => {
  assert.match(six6, /specified → unit-tested → persisted → wired → real-provider-proven → journey-accepted → beta-ready/);
  assert.match(six6, /Standalone remaining-work docs are forbidden/);
  assert.match(six6, /Exactly one launch-pad file is permitted/);
  // #178 (FORGE-253). §6.6 is what imposes the validate-clean requirement, so it
  // is also where "clean against which branch" has to be answered. Without this
  // the clause reverts silently and the file rots on merge again.
  assert.match(six6, /as its reader will stand, not as its writer did/);
  assert.match(six6, /time-invariant except the branch check/);
  assert.match(six6, /\*\*charter\*\*/);
});

test('§6.6.1 lists exactly the seven admissions, each as its own bolded entry', () => {
  const entries = [...notChecked.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1]);
  assert.deepEqual(entries, [
    'The five-row cap on `## Now`.',
    '`Last verified` freshness in `## Standing gates`.',
    'The presence of `## Charter`.',
    'Whether a rung is honest.',
    'Deletion of the launch-pad file on pickup.',
    // #219 (FORGE-283), ADR 0012. The seventh, and the only entry admitting a
    // gap in a rule that IS checked rather than one carried wholly by
    // convention: `validate-prompt.mjs` reaches the launch pad and none of the
    // other six surfaces §6.5.1's closing-keyword clause names. Left unstated it
    // would be the partial check that reads as total — which is the failure this
    // whole section exists to declare, wearing a green tick.
    'Whether a closing keyword sits beside an issue number anywhere but the launch pad.',
    // #176 (FORGE-252). The unslashed third spelling is refused; the qualified
    // form is not, and cannot be without a repo identity the validator is never
    // given. Pinned as prose so adding an eighth admission and dropping this one
    // in the same change still fails.
    'Whether a *qualified* `owner/repo#N` in the launch pad is this repo\'s own issue.',
  ]);
});

test('§6.6.1 says why an unadmitted partial rule is worse than an admitted convention', () => {
  // G3's argument, and the reason §6.5.1 already carries five such clauses.
  assert.match(notChecked, /stops anyone looking for the gap/);
  assert.match(notChecked, /§6\.5\.1 carries five/);
  // The prose states its own count, and nothing pinned it against the list until
  // #176 (FORGE-252) added the sixth and had to correct the sentence by hand.
  // `the ROADMAP carries` became `the list below carries` at #219 (FORGE-283):
  // three of the seven entries are about the launch pad rather than the roadmap,
  // so the old phrase had been describing the wrong thing since the fifth.
  const stated = /the list below carries (\w+)/.exec(notChecked)?.[1];
  assert.equal(stated, 'seven', 'the stated count must track the list below it');
  assert.equal([...notChecked.matchAll(/^- \*\*(.+?)\*\*/gm)].length, 7);
});

test('§6.6.1 refuses to let a green check stand for a true roadmap', () => {
  // The most important of the five: the checker proves a rung was NAMED.
  assert.match(notChecked, /evidence of a well-formed roadmap, never of a true one/);
});

test('§6.6.1 states what a check does establish, so the admissions have a boundary', () => {
  // A list of non-checks with no list of checks reads as "nothing is checked".
  for (const clause of [
    'that the file exists wherever the manifest',
    '`## Now` and `## Next` are both present',
    'seven-item ladder',
    'exactly one `Board:` line survives',
    '`<placeholder>`',
  ]) {
    assert.equal(notChecked.includes(clause), true, `§6.6.1 omits: ${clause}`);
  }
});

test('every value §6.6 offers for the key is one the checker accepts', () => {
  // Guards the drift where the standard names a third classification the code
  // rejects, or the code grows one the standard never documents.
  const offered = [...six6.matchAll(/`roadmap: ([a-z]+)`/g)].map((m) => m[1]);
  assert.ok(offered.length > 0, 'the collector found no roadmap values in §6.6');
  assert.deepEqual([...new Set(offered)].sort(), [...ROADMAP_VALUES].sort());
});
