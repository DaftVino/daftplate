import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKOUT_MARKER_OPEN } from '../scripts/lib/checkout-marker.mjs';

// Both files this reads ship in the daftplate export (docs/setup-guide.md and
// scripts/ are allowlisted), so this test runs in a stranger's clone — checked
// against the selection in tests/publish.test.mjs rather than assumed. Issue #54
// is what makes that check part of adding a test here at all.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const guide = readFileSync(join(ROOT, 'docs', 'setup-guide.md'), 'utf8');

test('the setup guide names the checkout step using the marker install-skills actually writes', () => {
  // NOT assert.match(guide, /install-skills\.mjs/) — the guide already names that
  // script four times, so that assertion passes today and proves nothing. Issue
  // #97's class exactly. These two strings are absent until the step is written.
  assert.equal(guide.includes(CHECKOUT_MARKER_OPEN), true);
  assert.match(guide, /~\/\.claude\/CLAUDE\.md/);
});

test('the setup guide says the export reports a missing skills/ and records the path anyway', () => {
  // D5: on the public daftplate export the command prints a skills/ complaint and
  // still does the work. Unsaid, that output reads as a failed install and the
  // reader stops there — which is the state this whole change exists to leave.
  assert.match(guide, /no skills\/ directory|withholds `skills\/`|without `skills\/`/);
});
