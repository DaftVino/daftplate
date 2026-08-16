import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECKOUT_MARKER_OPEN,
  CHECKOUT_MARKER_CLOSE,
  renderCheckoutBlock,
  findCheckoutSpan,
} from '../scripts/lib/checkout-marker.mjs';

// findCheckoutSpan decides cells 3-6 of the recordCheckout() state machine, so it is
// tested directly rather than through its caller: a parser exercised only through the
// writer is a parser whose rejection cases are untested.

test('findCheckoutSpan reports no span in a file that has none', () => {
  assert.equal(findCheckoutSpan('# gates\n').ok, false);
  assert.match(findCheckoutSpan('# gates\n').reason, /no marker/);
});

test('findCheckoutSpan locates a well-formed span and extracts the path', () => {
  const span = findCheckoutSpan(`# gates\n\n${renderCheckoutBlock('X:/Projects/daftplate')}\n`);
  assert.equal(span.ok, true);
  assert.equal(span.path, 'X:/Projects/daftplate');
});

test('findCheckoutSpan refuses an unclosed span', () => {
  assert.equal(findCheckoutSpan(`${CHECKOUT_MARKER_OPEN}\nstuff\n`).ok, false);
});

test('findCheckoutSpan refuses two spans rather than picking one', () => {
  // Bounds are ambiguous, and guessing would rewrite over user text
  // daftplate cannot prove it wrote (CLAUDE.md #5).
  const two = `${renderCheckoutBlock('X:/a')}\n\n${renderCheckoutBlock('X:/b')}\n`;
  assert.equal(findCheckoutSpan(two).ok, false);
  assert.match(findCheckoutSpan(two).reason, /more than one/);
});

test('findCheckoutSpan refuses a reordered span (close before open)', () => {
  const flipped = `${CHECKOUT_MARKER_CLOSE}\ntext\n${CHECKOUT_MARKER_OPEN}\n`;
  assert.equal(findCheckoutSpan(flipped).ok, false);
});

test('findCheckoutSpan separates "no marker" from "unusable marker" for the caller', () => {
  // recordCheckout appends in the first case and refuses in the second, so a
  // caller forced to tell them apart by matching `reason` would be parsing prose
  // to decide whether to write.
  assert.equal(findCheckoutSpan('# gates\n').present, false);
  assert.equal(findCheckoutSpan(`${CHECKOUT_MARKER_OPEN}\nstuff\n`).present, true);
  assert.equal(findCheckoutSpan(`${renderCheckoutBlock('X:/a')}\n${renderCheckoutBlock('X:/b')}\n`).present, true);
});
