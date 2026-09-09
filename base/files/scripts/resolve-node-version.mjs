#!/usr/bin/env node
// Answers one question for CI: which Node should this repository run on?
//
// Every shipped workflow used to hardcode `node-version: '20'`. Node 20 reached
// end of life on 2026-04-30, so every repo daftplate scaffolded was testing on an
// unsupported runtime — and doing it silently even where the repo's own
// package.json declared something else. A literal in four files re-rots at the
// next LTS boundary, so the fix is a resolver rather than four edits.
//
// The repo's declaration wins; `lts/*` is the fallback. Not a pinned major:
// a default that contradicts a declared `engines` is worse than no default, and
// `lts/*` is the one value that cannot go stale on a calendar.
//
// Zero dependencies, node: built-ins only (CLAUDE.md #4). It ships into scaffolded
// repos as base/files/scripts/resolve-node-version.mjs, byte-identical, so it must
// import nothing from daftplate.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** setup-node resolves this to the current LTS at run time, so it never expires. */
export const DEFAULT_NODE_VERSION = 'lts/*';

/**
 * The selector to hand `actions/setup-node`.
 *
 * A declared value is passed through **unchanged**. Ranges like `>=22 <25` are
 * exactly what setup-node accepts, and normalizing one — extracting a major,
 * say — would silently run a different runtime than the repo asked for.
 *
 * Absence is not an error: most repos declare nothing, and demanding a
 * declaration would break every one of them to fix a contradiction they do not
 * have. Malformed metadata IS an error, because a `package.json` that will not
 * parse, or an `engines` that is not an object, means the caller believes
 * something this cannot read — falling back there would hide it.
 */
export function resolveNodeVersion(root = process.cwd()) {
  const manifest = join(root, 'package.json');
  if (!existsSync(manifest)) return { version: DEFAULT_NODE_VERSION, source: 'default' };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch (error) {
    throw new Error(`package.json could not be parsed: ${error.message}`);
  }

  const { engines } = parsed;
  if (engines === undefined || engines === null) {
    return { version: DEFAULT_NODE_VERSION, source: 'default' };
  }
  if (typeof engines !== 'object' || Array.isArray(engines)) {
    throw new Error('package.json engines is present but is not an object');
  }
  if (engines.node === undefined) return { version: DEFAULT_NODE_VERSION, source: 'default' };

  const declared = engines.node;
  // The safety boundary this script owns, and no more. It does not validate
  // SemVer — setup-node is the authority on what it accepts — but the value ends
  // up in $GITHUB_OUTPUT, so a line break would let a declaration append
  // arbitrary output records. Blank and untrimmed are rejected rather than
  // repaired: silently trimming means the file says one thing and CI does
  // another, which is the class of defect this whole script exists to close.
  if (typeof declared !== 'string') {
    throw new Error(`package.json engines.node must be a string, got ${typeof declared}`);
  }
  if (declared === '' || declared.trim() !== declared) {
    throw new Error('package.json engines.node must be non-empty and already trimmed');
  }
  if (/[\r\n]/.test(declared)) {
    throw new Error('package.json engines.node must not contain a line break');
  }

  return { version: declared, source: 'engines' };
}

function main() {
  let resolved;
  try {
    resolved = resolveNodeVersion(process.cwd());
  } catch (error) {
    // Nonzero and no partial record: a half-written $GITHUB_OUTPUT is worse than
    // a failed step, because the workflow would carry on with a value nobody set.
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  // stdout is the machine channel — the caller redirects it into $GITHUB_OUTPUT,
  // so exactly one record goes here and diagnostics must not.
  process.stdout.write(`node-version=${resolved.version}\n`);
  process.stderr.write(
    resolved.source === 'engines'
      ? `node-version ${resolved.version} (from package.json engines.node)\n`
      : `node-version ${resolved.version} (no engines.node declared; using the default)\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

export { main };
