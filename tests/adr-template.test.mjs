import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
