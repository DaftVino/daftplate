import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { walkFiles } from '../scripts/lib/fs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const template = readFileSync(join(ROOT, 'engineering-standards', 'templates', 'adr.md'), 'utf8');

test('the ADR template records alternatives considered', () => {
  assert.match(template, /^## Alternatives considered$/m);
});

test('alternatives sits between Decision and Consequences', () => {
  const iDecision = template.indexOf('## Decision');
  const iAlt = template.indexOf('## Alternatives considered');
  const iCons = template.indexOf('## Consequences');
  assert.ok(iDecision < iAlt && iAlt < iCons, 'order must be Decision → Alternatives → Consequences');
});

// ---------------------------------------------------------------------------
// #278 (FORGE-339) — the template's shape, applied to everything that copies it
// ---------------------------------------------------------------------------
//
// The two tests above read the TEMPLATE and nothing else, so every other copy of
// this shape in the repository drifted unwatched. Two had:
//
//   skills/new-project/SKILL.md told an agent to write "Status / Context /
//   Decision / Consequences / Alternatives considered" — Consequences BEFORE
//   Alternatives, which is the order the test above forbids, for the very
//   template the same sentence tells the agent to copy.
//
//   profiles/design-vault/files/docs/adr/0001-numbered-doc-buckets.md shipped
//   with the same inversion, and with `- **Status:**` where the template and
//   app-monolith's ADR use a bare bold field.
//
// Both ship. The skill instructs every new repository, and the profile ADR is
// copied into every design-vault repo scaffolded from it — so a drift here is not
// one wrong file, it is the shape of every ADR written after it.

/** The section order is stated here, then pinned against the template below. That
 *  pairing makes a restatement safe: the literal is the expectation a reviewer
 *  can read, and the companion test fails if the template drifts away from it
 *  instead of comparing the template against a value derived from itself. */
const SECTIONS = ['## Context', '## Decision', '## Alternatives considered', '## Consequences'];

/** Every ADR any layer ships into a scaffolded repository. Discovered rather than
 *  listed: a third profile adding one must be covered by having added it, not by
 *  somebody remembering to extend an array. */
function shippedAdrs() {
  const found = [];
  for (const layer of ['base', 'profiles']) {
    const root = join(ROOT, layer);
    if (!existsSync(root)) continue;
    // walkFiles yields { rel, isDir } relative to the root it was given, not
    // absolute paths — so the layer is put back on the front here rather than
    // assumed away.
    for (const entry of walkFiles(root)) {
      if (entry.isDir) continue;
      const rel = `${layer}/${entry.rel}`;
      if (/\/files\/docs\/adr\/[^/]+\.md$/.test(rel)) found.push(rel);
    }
  }
  return found;
}

test('#278 (FORGE-339) — the template orders its own sections the way its test says', () => {
  // The premise the two tests below rest on, asserted rather than assumed: if the
  // template itself stopped following this order, those tests would be comparing
  // everything against a moved baseline and reporting agreement.
  const at = SECTIONS.map((s) => template.indexOf(s));
  assert.equal(at.every((i) => i !== -1), true, `the template is missing one of ${SECTIONS.join(', ')}`);
  assert.deepEqual(at.slice().sort((a, b) => a - b), at, 'the template no longer follows its own order');
});

test('#278 (FORGE-339) — every ADR a profile ships follows the template order', () => {
  // AC 1. Nothing checked these, which is why one of them has been shipping the
  // wrong order: `tests/adr-template.test.mjs` read the template only.
  const adrs = shippedAdrs();
  assert.ok(adrs.length >= 2, 'the discovery found no shipped ADRs, so this test asserts nothing');

  const wrong = [];
  for (const rel of adrs) {
    const text = readFileSync(join(ROOT, rel), 'utf8');

    // Present, then ordered — and present first, because a filter over the
    // sections a file happens to have makes a MISSING section indistinguishable
    // from a correctly ordered one. Measured: with that filter, renaming
    // `## Alternatives considered` in a shipped ADR killed no test, so an ADR
    // could lose a whole section and still read as conforming. The four are the
    // template's own, so a shipped example that drops one teaches the next author
    // to drop it too.
    const missing = SECTIONS.filter((s) => !text.includes(s));
    if (missing.length) {
      wrong.push(`${rel}: missing ${missing.join(', ')}`);
      continue;
    }

    const at = SECTIONS.map((s) => [s, text.indexOf(s)]);
    const ordered = at.slice().sort((a, b) => a[1] - b[1]).map(([s]) => s);
    if (ordered.join(' ') !== SECTIONS.join(' ')) {
      wrong.push(`${rel}: ${ordered.join(' → ')}`);
    }
  }
  assert.deepEqual(wrong, [],
    'a profile ships an ADR in an order the template\'s own test forbids, or missing a section it '
    + 'declares, and every repo scaffolded from that profile inherits it as the example to follow');
});

test('#278 (FORGE-339) — every ADR a profile ships uses the template\'s field form', () => {
  // The second drift in the same file, and the one `plan-scaffolding` Phase 7's
  // prescribed test would have caught while missing the ordering. A list-prefixed
  // `- **Status:**` is not what the template shows or what app-monolith's ADR
  // uses, and a reader copying the nearest example copies whichever they meet.
  const wrong = [];
  for (const rel of shippedAdrs()) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    for (const field of ['Status', 'Date']) {
      if (new RegExp(`^- \\*\\*${field}:`, 'm').test(text)) wrong.push(`${rel}: - **${field}:**`);
    }
  }
  assert.deepEqual(wrong, [], 'a shipped ADR writes a list-prefixed field where the template writes a bare bold one');
});
