// §12's contract, and the plan template that collects the evidence it asks for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkFiles } from '../scripts/lib/fs.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const standards = readFileSync(join(ROOT, 'engineering-standards', 'repo-standards.md'), 'utf8');
const template = readFileSync(
  join(ROOT, 'engineering-standards', 'templates', 'implementation-plan.md'),
  'utf8',
);

function sectionBody(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) return '';
  const rest = text.slice(start + heading.length);
  const next = rest.search(/^#{2,3} /m);
  return next === -1 ? rest : rest.slice(0, next);
}

const twelve = sectionBody(standards, '## 12. Regression test authenticity');

test('the canonical standard requires a named mutation and an observed failing run', () => {
  // Mutation killed: weakening "must demonstrate failure" into optional review
  // advice, or dropping the named-mutation requirement so "a test was added"
  // satisfies the rule. Either leaves a tautological green test compliant.
  assert.match(standards, /^## 12\. Regression test authenticity$/m);
  assert.match(twelve, /\*\*The mutation\*\*/);
  assert.match(twelve, /Named specifically enough that someone else could apply it/);
  assert.match(twelve, /\*\*`Observed red:`\*\*/);
  assert.match(twelve, /seen failing with that mutation applied, before the fix was accepted/);
});

test('the standard names the weaker checks that do not establish the claim', () => {
  // Mutation killed: dropping the concrete null-versus-undefined example and
  // leaving only the abstract rule, which is the form everyone already agrees
  // with and nobody applies.
  assert.match(twelve, /Coverage, "it executed", "it did not throw", "the result is not `undefined`"/);
  assert.match(twelve, /if the mutation returns `null` and the assertion only rejects `undefined`/);
  assert.match(twelve, /Compare exact values or exact bytes/);
});

test('the standard states its own limit rather than overclaiming', () => {
  // Mutation killed: presenting this as sound analysis. It is not, and a rule
  // that oversells itself stops anyone looking for what it misses.
  assert.match(twelve, /Nothing here is sound static analysis/);
  assert.match(twelve, /a sufficiently subtle tautology survives it/);
});

test('the implementation-plan template captures mutation and red evidence separately', () => {
  // Mutation killed: collapsing the two into a single "test added" field, which
  // a tautological green test satisfies. They are separate because a named
  // mutation with no observed red is a plan; an observed red with no named
  // mutation is an anecdote.
  assert.match(template, /\*\*Mutation killed:\*\*/);
  assert.match(template, /\*\*Observed red:\*\*/);
  assert.match(template, /\*\*Claim:\*\*/);
  assert.match(template, /\*\*Observable:\*\*/);
  // And the escape hatch is explicit, so a purely additive test is not forced
  // to invent a regression it does not have.
  assert.match(template, /omit only with a note saying this is not a regression test/);
});

test('the rule lives in the canonical standard and is not vendored', () => {
  // ADR 0001: the standards are canonical in daftplate and a copy elsewhere
  // goes stale. Mutation killed: shipping §12's prose into base/ or a profile so
  // scaffolded repos "have" it locally — which is how a rule ends up frozen at
  // the version it was copied at.
  //
  // The first draft of this test asserted `typeof execFileSync === 'function'`,
  // which cannot fail and proved nothing about vendoring. It is left recorded
  // here rather than quietly replaced, because it is exactly the shape §12 and
  // /audit exist to catch, and it got written anyway.
  const marker = 'Regression test authenticity';
  const offenders = [];
  for (const root of ['base', 'profiles']) {
    for (const { isDir, rel } of walkFiles(join(ROOT, root))) {
      if (isDir || !/\.(md|txt)$/i.test(rel)) continue;
      if (readFileSync(join(ROOT, root, rel), 'utf8').includes(marker)) {
        offenders.push(`${root}/${rel}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
