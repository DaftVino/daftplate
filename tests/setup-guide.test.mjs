import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKOUT_MARKER_OPEN } from '../scripts/lib/checkout-marker.mjs';
import { BRANCH_BYPASS_ENV } from '../scripts/setup-repo.mjs';

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

test('the setup guide names both managed hooks and tells existing repos to re-run', () => {
  // Documenting only fresh repositories, or only the pre-commit hook, leaves the
  // branch gate installed on nothing — the repos that predate it are exactly the
  // ones carrying the badly named branches #104 measured.
  assert.match(guide, /pre-commit/);
  assert.match(guide, /pre-push/);
  assert.match(guide, /gitleaks git --staged/);
  assert.match(guide, /type\/N-slug/);
  assert.match(guide, /[Ee]xisting repositories need to re-run it|re-run `setup-repo`/);
});

test('both quick references carry the branch form, the rename, and the exact bypass', () => {
  // Two copies exist by design: engineering-standards/ is canonical and never
  // vendored (ADR 0001), while base/files/docs/ is what ships INTO a scaffolded
  // repo, where the canonical file is unreachable. Updating one and not the other
  // is the failure this pins — as is quietly renaming the environment variable in
  // one place, since the operator's escape hatch is only useful if it is spelled
  // the same everywhere.
  const canonical = readFileSync(join(ROOT, 'engineering-standards', 'quick-ref-workflow.md'), 'utf8');
  const scaffolded = readFileSync(join(ROOT, 'base', 'files', 'docs', 'quick-ref-workflow.md'), 'utf8');

  for (const [name, text] of [['canonical', canonical], ['scaffolded', scaffolded]]) {
    assert.match(text, /type\/N-slug/, `${name} quick ref omits the branch form`);
    assert.match(text, /git branch -m/, `${name} quick ref omits the rename remedy`);
    assert.equal(
      text.includes(BRANCH_BYPASS_ENV),
      true,
      `${name} quick ref does not name ${BRANCH_BYPASS_ENV}`,
    );
  }
});
