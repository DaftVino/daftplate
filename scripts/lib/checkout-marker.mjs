// The format of the daftplate checkout record in ~/.claude/CLAUDE.md, and its parser.
// Lives here rather than in install-skills.mjs because three consumers need it — the
// writer (install-skills.mjs), the checker (check-machine.mjs) and this module's own
// tests — and a format restated in two scripts is a format the writer and the reader
// can disagree about. Same threshold that moved commandExists into lib/probe.mjs.
//
// Nothing here reads, writes or spawns: it is string in, string or verdict out, so it
// stays free of side effects at module scope for the two scripts that import it.

export const CHECKOUT_MARKER_OPEN = '<!-- daftplate:checkout -->';
export const CHECKOUT_MARKER_CLOSE = '<!-- /daftplate:checkout -->';

/** The line the path is recorded on, and the pattern that reads it back. */
const PATH_LINE = (path) => `Local \`daftplate\` checkout: \`${path}\`.`;
const PATH_PATTERN = /^Local `daftplate` checkout: `(.+)`\.$/m;

/**
 * The recorded block, delimiters included. Delimited rather than a bare line because
 * ~/.claude/CLAUDE.md is user-authored prose: a delimited block is the only shape that
 * can be rewritten in place on a second install without a regex over someone else's
 * sentences (D1). The body reads as an instruction because an agent, not a script, is
 * the consumer.
 */
export function renderCheckoutBlock(path) {
  return [
    CHECKOUT_MARKER_OPEN,
    PATH_LINE(path),
    '`engineering-standards/repo-standards.md` is canonical there and is never copied out (ADR 0001).',
    CHECKOUT_MARKER_CLOSE,
  ].join('\n');
}

/** Every index at which `needle` occurs in `text`. */
function indicesOf(text, needle) {
  const found = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
    found.push(at);
  }
  return found;
}

/**
 * Locate daftplate's own block in `text`.
 *
 * `{ ok: true, start, end, path }` — `start` is the first character of the opening
 * marker and `end` is one past the last character of the closing marker, so
 * `text.slice(0, start) + renderCheckoutBlock(p) + text.slice(end)` is the in-place
 * rewrite (D3). `path` is null when the delimiters are sound but the body no longer
 * carries a readable path line; the caller then treats it as a mismatch and rewrites,
 * which is right — the region is daftplate's own by construction.
 *
 * `{ ok: false, present, reason }` for everything else. Anything other than exactly one
 * well-ordered pair is refused rather than repaired: the region's bounds cannot be
 * established, and guessing them would rewrite text daftplate cannot prove it wrote
 * (CLAUDE.md #5, D7). A delimiter proves where a block claims to start, not who wrote
 * what sits inside it.
 *
 * `present` separates the two failures that get opposite answers: `false` means no
 * marker at all, which is a file the block may simply be appended to (cell 3 of the
 * state machine), while `true` means a marker is there but its span is unusable, which
 * is a refusal (cell 6). A caller that has to tell those apart by reading `reason`
 * would be parsing prose to make a write decision.
 */
export function findCheckoutSpan(text) {
  const opens = indicesOf(text, CHECKOUT_MARKER_OPEN);
  const closes = indicesOf(text, CHECKOUT_MARKER_CLOSE);

  if (opens.length === 0 && closes.length === 0) {
    return { ok: false, present: false, reason: 'no marker block is present' };
  }
  if (opens.length > 1 || closes.length > 1) {
    return {
      ok: false,
      present: true,
      reason: `more than one marker block is present (${opens.length} opening, ${closes.length} closing); its bounds are ambiguous`,
    };
  }
  if (closes.length === 0) {
    return { ok: false, present: true, reason: `the marker block is unclosed — no ${CHECKOUT_MARKER_CLOSE}` };
  }
  if (opens.length === 0) {
    return { ok: false, present: true, reason: `a closing marker appears with no ${CHECKOUT_MARKER_OPEN}` };
  }
  if (closes[0] < opens[0]) {
    return { ok: false, present: true, reason: 'the marker block is reordered — its closing marker precedes its opening marker' };
  }

  const start = opens[0];
  const end = closes[0] + CHECKOUT_MARKER_CLOSE.length;
  const path = text.slice(start, end).match(PATH_PATTERN)?.[1] ?? null;
  return { ok: true, start, end, path };
}
