#!/usr/bin/env node
// Pushes template changes into a repo daftplate already produced, without ever
// overwriting work the repo did. Reads the committed .daftplate.json manifest
// (ADR 0003), composes what the template would produce today, and asks
// classify() what may happen to each path.
//
// Every filesystem call lives here; classify() in lib/provenance.mjs is pure.
//
// Usage:
//   node scripts/sync-standards.mjs <templates-root> <target> [--dry-run]
//                                   [--add=<path>]... [--restore=<path>]...
//                                   [--decline=<path>]... [--rebaseline=<path>]...
//                                   [--json] [--diff=<path>]...
//
// Exits EXIT_CODES.REFUSED when any path was refused, 0 otherwise (#269).
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, renameSync,
  readFileSync, writeFileSync, constants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, sep, resolve } from 'node:path';
import { canonical } from './lib/fs.mjs';
import { runCli, EXIT_CODES } from './lib/cli.mjs';
import { scaffold, MISSING_TOKEN, SCAFFOLD_INPUT_TOKENS } from './scaffold.mjs';
import {
  PROVENANCE_FILE, requiredSchema, classify, rebaselineEntry, fileDigest, digestOf,
  readProvenance, writeProvenance, serializeProvenance, unnormalizeProvenance,
} from './lib/provenance.mjs';

// Which report line a --rebaseline produces, per the kind of change it made:
// [applied, would-apply]. Three kinds and not one, because "your divergent file
// is daftplate's now" and "the digest was refreshed" are not the same news.
const REBASELINE_OUTCOMES = {
  managed: ['REBASELINED', 'WOULD_REBASELINE'],
  adopted: ['REBASELINED_ADOPTED', 'WOULD_REBASELINE_ADOPTED'],
  diverged: ['REBASELINED_DIVERGED', 'WOULD_REBASELINE_DIVERGED'],
};

const STAGING_PREFIX = 'daftplate-sync-';

/**
 * A manifest path must stay inside the target. Absolute paths, drive letters,
 * backslashes and `..` are all refused before anything is read or written,
 * because the manifest is a file in a repo and repos can be edited.
 *
 * A colon is refused **anywhere**, not just as a drive letter. `README.md:evil`
 * is an NTFS alternate data stream, and it defeated the containment guard
 * outright: the whole string reaches `lstatSync` as one component, so it is
 * ENOENT rather than a symlink and `inspectTargetPath` returns ok — while a write
 * to it resolves the *base* name, follows a symlink there, and lands outside the
 * repo. Measured on Windows: the stream appeared on the outside file. The old
 * `/^[a-zA-Z]:/` test only ever looked at the first two characters. A colon is
 * not a legal filename character on Windows anyway, so nothing legitimate is lost.
 */
export function isSafeRelPath(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  if (rel.includes('\\') || rel.startsWith('/') || rel.includes(':')) return false;
  return rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * `isSafeRelPath` proves a manifest *key* stays inside the target; this proves the
 * *filesystem* does too. They are different questions, and issue #71 was the gap
 * between them: every call the sync makes follows links, so a symlink anywhere on
 * a managed path let an UPDATE rewrite a file outside the repo, `--add` create one
 * through a linked parent, and a linked `.daftplate.json` be rewritten elsewhere.
 * The write-time digest re-check could not catch any of it — it establishes bytes,
 * never object identity, so a same-digest link passes it every time.
 *
 * Any link is refused, in-repo ones included: the manifest's whole premise is that
 * a key names the exact path daftplate owns, and writing through one name to
 * another object smears that even when the destination stays inside the repo. The
 * accepted cost is that a repo cannot symlink a managed file.
 *
 * `targetRoot` is the trust anchor and is deliberately not inspected — the operator
 * named it. Components below it are walked one at a time, because a leaf-only check
 * misses the linked-parent case entirely. `lstatSync` and not `statSync`: `statSync`
 * follows links and so cannot see the thing being guarded against. Verified on this
 * platform that `isSymbolicLink()` reports Windows junctions as well as symlinks,
 * which is what makes the guard hold here rather than only on POSIX.
 *
 * ENOENT is `ok` with `exists: false`, so `--add` and `--restore` still work on a
 * path whose parents do not exist yet. A dangling link is still refused, because
 * `lstatSync` sees the link rather than its missing target.
 */
export function inspectTargetPath(targetRoot, rel) {
  const parts = rel.split('/');
  const abs = join(targetRoot, ...parts);
  let cursor = targetRoot;

  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        return { ok: false, abs, linkRel: parts.slice(0, index + 1).join('/') };
      }
    } catch (error) {
      if (error.code === 'ENOENT') return { ok: true, abs, exists: false };
      throw error;
    }
  }

  return { ok: true, abs, exists: true };
}

// Composed from a base copy plus a profile append, so a plain "MODIFIED" would
// leave the developer nothing to act on: they cannot tell which lines were ours.
// It promised more than it delivered: "the template's current version is in the
// report" was never true -- no report line carries template bytes, and the staging
// tree that held them is removed in the finally before any caller sees this. The
// actionable half is the composition, which is what the developer cannot infer.
const appendedNote = ' — this file is composed from a base copy plus a profile append, '
  + 'so which lines were daftplate\'s cannot be told from the file; add any new ones by hand';

// An ADDED line built from the ORIGINAL prior (not effectivePrior) carries this
// suffix when that prior was declined: effectivePrior is what got nulled to let
// classify() re-derive NEW/OFFER_ADD (D2), but prior still remembers what the
// path was before the lift, which is the only way describe() can tell "a normal
// add" from "an add that just overrode a recorded no".
const declinedLiftNote = ' — the recorded decline is lifted';

// `status` is what classify() decided; `outcome` is what the run actually did.
// They differ whenever an offer was taken up: a path classified MISSING that
// --restore then wrote must not still print "rerun with --restore", which is
// what it said before a CLI smoke run caught it.
function describe(rel, outcome, prior, linkRel, decision) {
  const appended = prior?.mode === 'appended' ? appendedNote : '';
  const lifted = prior?.ownership === 'declined' ? declinedLiftNote : '';
  switch (outcome) {
    case 'ADDED':
      return `ADDED ${rel} — created from the current template and recorded in ${PROVENANCE_FILE}${lifted}`;
    case 'RESTORED':
      return `RESTORED ${rel} — rewritten from the current template and recorded in ${PROVENANCE_FILE}`;
    case 'WOULD_UPDATE':
      return `WOULD UPDATE ${rel} — matched ${PROVENANCE_FILE}; the template has moved`;
    case 'NEW':
      return `NEW ${rel} — daftplate now produces this path; this repo has no provenance for it; rerun with --add=${rel}`;
    case 'COLLISION':
      return `REFUSED COLLISION ${rel} — daftplate now produces this path but a file it never wrote is already there; left untouched`;
    case 'OVERRIDDEN':
      return `REFUSED OVERRIDDEN ${rel} — the manifest records a profile override; a base-layer file will not replace it; left untouched`;
    case 'MISSING':
      return `MISSING ${rel} — daftplate wrote this path at scaffold time and it is absent; rerun with --restore=${rel}`;
    case 'MODIFIED':
      // #271 (FORGE-332) AC 2: which part changed. For an appended path the
      // refusal now means something narrower than it used to — the run has
      // already checked whether daftplate's own bytes are still there, so
      // reaching MODIFIED says they are not, and the note stops being an apology
      // for a question nobody asked.
      return decision?.part === 'appended-segment'
        ? `REFUSED MODIFIED ${rel} — the lines daftplate appended are no longer in the file as it wrote `
          + `them, so its own segment changed rather than the repository's additions; left untouched`
        : `REFUSED MODIFIED ${rel} — on-disk digest differs from ${PROVENANCE_FILE}; left untouched${appended}`;
    case 'APPENDED_EXTENDED':
      // #271 (FORGE-332) AC 1. Not a refusal and not an update: a standing
      // condition, reported once per run and touched by nothing. The status name
      // covers a repository extension, and line-ending-normalised containment now
      // reaches it for a CRLF-only re-save too — so the shared prefix states the
      // one thing both cases prove, and the tail states which of them this is.
      //
      // Two messages rather than one, because `classify()` can tell them apart and
      // a single message that named both possibilities would take the ordinary
      // case — a repository adding its own ignore rules — and answer it with a
      // hedge. Adding to a `.gitignore` daftplate wrote is the expected thing for
      // a repository to do, and the previous answer, REFUSED MODIFIED
      // permanently, told an operator their repository had done something wrong by
      // working normally. Replacing that with a vaguer sentence would have kept
      // half of the same fault.
      return decision?.difference === 'line-endings'
        ? `APPENDED CONTENT INTACT ${rel} — every line daftplate appended is present and the line `
          + 'endings are the whole difference from the recorded bytes; nothing to do, and nothing here will rewrite them'
        : `APPENDED CONTENT INTACT ${rel} — the lines daftplate appended are unchanged and this repo has `
          + 'added its own below them; nothing to do, and nothing here will rewrite them';
    case 'VANISHED':
      // Its own outcome because MODIFIED described the wrong event entirely:
      // there is no on-disk digest to differ, and nothing was left untouched
      // because there was nothing there. --restore is not a guess -- it is
      // exactly what the next run will offer for this path.
      return `REFUSED VANISHED ${rel} — the file was removed after this run classified it and before it was written; nothing was written; rerun with --restore=${rel}`;
    case 'REBASELINED':
      // Deliberately not phrased as an update. Nothing about the repository
      // changed; what changed is what daftplate claims to know about it, and an
      // operator reading this line needs to see that no file was touched.
      return `REBASELINED ${rel} — on-disk bytes already equal today's template; ${PROVENANCE_FILE} now records them, and no file was written`;
    case 'WOULD_REBASELINE':
      return `WOULD REBASELINE ${rel} — ${PROVENANCE_FILE} would record the bytes already on disk; no file would be written`;
    // An ownership change gets its own line rather than sharing REBASELINED's:
    // this is the one that ends a DIVERGED or DECLINED record, and G5 is about
    // the operator seeing each ownership change happen.
    case 'REBASELINED_ADOPTED':
      return `REBASELINED ${rel} — the repository's bytes already equal today's template, so ${PROVENANCE_FILE} now records the path as managed; no file was written`;
    case 'WOULD_REBASELINE_ADOPTED':
      return `WOULD REBASELINE ${rel} — would be recorded as managed, its bytes already matching today's template; no file would be written`;
    case 'REBASELINED_DIVERGED':
      return `REBASELINED ${rel} — a declined path holding bytes daftplate did not write; ${PROVENANCE_FILE} now records it as diverged against today's template, and no file was written`;
    case 'WOULD_REBASELINE_DIVERGED':
      return `WOULD REBASELINE ${rel} — would be recorded as diverged against today's template; no file would be written`;
    case 'CURRENT_REFRESHED':
      return `CURRENT ${rel} — bytes unchanged; the template now produces it from a different layer or mode, and ${PROVENANCE_FILE} is refreshed to say so`;
    case 'UNSAFE_LINK':
      return `REFUSED UNSAFE LINK ${rel} — ${linkRel} is a symbolic link or junction; left untouched`;
    case 'DIRECTORY':
      return `REFUSED DIRECTORY ${rel} — a directory is at a path the template produces a file for; left untouched`;
    case 'DIVERGED': {
      // Both baselines are named because they answer different questions and
      // need different operator action: repository drift is an edit since
      // enrollment, template drift is upstream movement someone must port by
      // hand. Collapsing them into one word is the thing D6 rejects.
      const repo = decision.repoDrift.toLowerCase();
      const template = decision.templateDrift.toLowerCase();
      return `DIVERGED ${rel} — enrollment recorded this path as repository-owned; repository ${repo}, template ${template}; left untouched, and neither baseline is refreshed`;
    }
    case 'DECLINED': {
      // The standing record, reported every run a decline is not being lifted.
      // Two baselines for the same reason DIVERGED carries two: the repository
      // question and the template question need different operator action.
      const repo = decision.repoState.toLowerCase();
      const template = decision.templateDrift.toLowerCase();
      return `DECLINED ${rel} — ${PROVENANCE_FILE} records this path as declined; repository ${repo}, template ${template}; not offered, not written`;
    }
    case 'DECLINED_RECORDED':
      // The run that recorded it, distinct from the standing DECLINED line
      // above the same way ADDED is distinct from NEW.
      return `DECLINED ${rel} — recorded in ${PROVENANCE_FILE}; daftplate will not offer this path again`;
    case 'WOULD_DECLINE':
      return `WOULD DECLINE ${rel} — would be recorded in ${PROVENANCE_FILE} as declined`;
    case 'WOULD_ADD':
      return `WOULD ADD ${rel} — would be written and recorded in ${PROVENANCE_FILE} as managed`;
    case 'WOULD_RESTORE':
      return `WOULD RESTORE ${rel} — would be written back from the template`;
    case 'RETAINED':
      return `RETAINED ${rel} — ${PROVENANCE_FILE} records this path but daftplate no longer produces it; left untouched`;
    case 'CURRENT':
      return `CURRENT ${rel}`;
    default:
      return `UPDATED ${rel}`;
  }
}

/**
 * Replaces a file by staging beside it and renaming over it, never by writing
 * onto it. `copyFileSync(source, destination)` opens the destination and writes
 * through whatever is there, which follows a leaf symlink **and** writes through
 * a hard link. `lstatSync` can see the first and provably cannot see the second —
 * a hard link is indistinguishable from a regular file — so the containment walk
 * closes only half the class on its own. `renameSync` replaces the directory
 * entry instead: an outside name stays bound to the old inode, and a leaf symlink
 * is replaced rather than followed. Measured on Windows against both.
 *
 * The staged file is created beside the destination so the rename stays on one
 * volume, and it is removed on failure — that is a file this function just made,
 * which is the only thing CLAUDE.md #5 permits deleting.
 *
 * This does not cover a symlinked *ancestor*, and is not meant to:
 * `inspectTargetPath` owns that, and the two are complementary rather than
 * alternatives. Nor does it close a hostile race that swaps an ancestor between
 * the walk and the rename.
 */
function replaceFile(source, destination) {
  const staged = join(dirname(destination), `.${basename(destination)}.daftplate-tmp`);
  copyFileSync(source, staged);
  try {
    renameSync(staged, destination);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
}

const ROLLBACK_DIR = '.daftplate-rollback';

/**
 * Undo the writes this invocation landed, newest first.
 *
 * The sync writes files one at a time and records provenance once at the end, so
 * a throw in between used to leave the target updated while the manifest still
 * described the old digests — and the *next* run then classified the sync's own
 * writes as MODIFIED and refused them, which is unrecoverable without hand-editing
 * the manifest. The failure direction was the bad one.
 *
 * Every restore re-proves what it is about to touch, because rollback runs after
 * an unexpected failure and the tree is exactly the thing that cannot be assumed:
 *
 *   - containment is re-walked, so a link that appeared mid-run is refused;
 *   - the current digest must still be the one THIS invocation wrote. Anything
 *     else means somebody changed the file after we did, and overwriting that is
 *     the one outcome worse than leaving the sync half-applied;
 *   - a created path is removed only as a single leaf `rmSync` with no `recursive`.
 *     Directories `mkdirSync(recursive)` may have made are deliberately left: they
 *     are empty and harmless, and proving we created each one is not possible.
 *
 * Returns the refusals. Empty means the target is back to its pre-run state.
 */
function rollback(targetRoot, journal) {
  const refusals = [];
  for (const entry of [...journal].reverse()) {
    const { rel, kind, backup, writtenDigest } = entry;
    try {
      const now = inspectTargetPath(targetRoot, rel);
      if (!now.ok) {
        refusals.push(`${rel}: ${now.linkRel} became a link during the run; left as written`);
        continue;
      }
      if (!now.exists) {
        // Nothing to undo: something else already removed what we wrote.
        continue;
      }
      if (lstatSync(now.abs).isDirectory()) {
        refusals.push(`${rel}: a directory is now at this path; left as written`);
        continue;
      }
      const nowDigest = fileDigest(now.abs);
      // Journalling before the write makes one state reachable that the digest
      // check below reads as sabotage: the entry exists and the write never
      // landed, so the file still holds its pre-run bytes. Those are the bytes
      // rollback exists to restore. Undoing nothing is not a weaker answer here,
      // it is the correct one -- and without this branch a clean, fully
      // recoverable failure escalates into the retained-staging AggregateError
      // path, which tells an operator to reconcile a file nobody harmed.
      if (kind === 'replaced' && backup !== null && nowDigest === fileDigest(backup)) {
        continue;
      }
      if (nowDigest !== writtenDigest) {
        refusals.push(`${rel}: changed after this sync wrote it; left as found, not overwritten`);
        continue;
      }
      if (kind === 'replaced') replaceFile(backup, now.abs);
      else rmSync(now.abs, { force: true });
    } catch (error) {
      refusals.push(`${rel}: ${error.message}`);
    }
  }
  return refusals;
}

/** One spelling of a path, for comparing it with another. Folded on win32 because
 *  the filesystem folds there: `x:` and `X:` name one directory, and a guard that
 *  disagrees with the filesystem about that is a guard with a way past it. */
const comparablePath = (path) => {
  const full = resolve(canonical(path));
  return process.platform === 'win32' ? full.toLowerCase() : full;
};

/**
 * Is `inner` the same path as `outer`, or below it?
 *
 * Boundary-aware on purpose. A bare `startsWith` makes `repo-other` look like a
 * child of `repo`, which would refuse a perfectly legitimate sibling temp root.
 * Case-folding on win32 does not weaken that: the boundary is still a separator,
 * so a case-varied sibling stays a sibling.
 */
export function isWithin(outer, inner) {
  const a = comparablePath(outer);
  const b = comparablePath(inner);
  return a === b || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

// Only ever called on a directory this process made with mkdtempSync, under the
// temp root CAPTURED AT CREATION — not tmpdir() read again here. Reading it again
// lets an environment change between staging and cleanup turn a legitimate removal
// into a refusal, or worse, validate a path against a root that no longer holds
// it. The guard is here rather than assumed because CLAUDE.md #5 makes "nothing
// deletes what it did not create" absolute, and a recursive delete is the one
// operation where being wrong is unrecoverable.
function removeStaging(staging, root) {
  if (!staging.startsWith(root + sep) || !staging.includes(STAGING_PREFIX)) {
    throw new Error(`refusing to remove a staging path outside ${root}: ${staging}`);
  }
  rmSync(staging, { recursive: true, force: true });
}

/**
 * A unified-ish line diff, or null when the two are identical.
 *
 * `#270 (FORGE-331)`. Written here rather than pulled in, because this repository
 * has no dependencies (CLAUDE.md #4) and the files it runs over are a `.gitignore`
 * and a handful of markdown documents. A longest-common-subsequence table over
 * lines is quadratic and entirely adequate at that size; it is capped anyway, and
 * the cap reports itself rather than silently truncating.
 *
 * Exported for its test, and for the reason `#294 (FORGE-345)` exported
 * `LOAD_FAILURE`: a formatter whose output an operator relies on should be
 * assertable without capturing a whole run's stdout.
 */
export const DIFF_LINE_CAP = 4000;

export function unifiedDiff(before, after) {
  if (before === after) return null;
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  // Line endings are not a difference an operator can act on, and reporting one
  // would show every line of a CRLF checkout as changed — burying the line that
  // actually did. The split already normalises them; this is what makes the
  // normalisation reach the answer rather than only the display.
  if (a.length === b.length && a.every((line, i) => line === b[i])) return null;
  if (a.length + b.length > DIFF_LINE_CAP) {
    return `  (diff not shown: ${a.length} + ${b.length} lines exceeds the ${DIFF_LINE_CAP}-line cap)`;
  }

  // LCS lengths, then walk back. Two rolling rows would halve the memory and
  // cost the backtrack, which is the half that produces the output.
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const lines = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { lines.push(`   ${a[i]}`); i += 1; j += 1; } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push(`  -${a[i]}`); i += 1;
    } else { lines.push(`  +${b[j]}`); j += 1; }
  }
  while (i < a.length) { lines.push(`  -${a[i]}`); i += 1; }
  while (j < b.length) { lines.push(`  +${b[j]}`); j += 1; }
  return lines.join('\n');
}

export function syncStandards(templatesRoot, targetRoot, opts = {}) {
  const {
    dryRun = false, add = [], restore = [], decline = [], rebaseline = [], diff = [], hooks = {},
  } = opts;

  const initialProvenance = inspectTargetPath(targetRoot, PROVENANCE_FILE);
  if (!initialProvenance.ok) {
    throw new Error(`refusing to sync: unsafe link in target path: ${PROVENANCE_FILE}`);
  }
  const manifest = readProvenance(targetRoot);
  if (!manifest) {
    throw new Error(`refusing to sync: ${targetRoot} has no ${PROVENANCE_FILE}`);
  }
  const priorFiles = manifest.files ?? {};
  const unsafe = Object.keys(priorFiles).find((rel) => !isSafeRelPath(rel));
  if (unsafe) {
    throw new Error(`refusing to sync: unsafe path in ${PROVENANCE_FILE}: ${unsafe}`);
  }

  // Selector refusal is a preflight, not a per-path reaction, and that ordering
  // is the guarantee rather than a detail of where the code sits. Discovering a
  // divergent selector mid-iteration would already have let earlier managed
  // writes land, leaving a partial synchronization — which is the outcome the
  // refusal exists to prevent. Nothing has been staged or composed at this point.
  //
  // Ownership is read off the manifest validateProvenance() already normalized,
  // so a schema 1 entry reads as managed here without a second default living in
  // this file.
  for (const [flag, selectors] of [['--add', add], ['--restore', restore]]) {
    const divergent = selectors.find((rel) => priorFiles[rel]?.ownership === 'diverged');
    if (divergent) {
      throw new Error(
        `refusing to sync: ${flag} cannot name divergent path ${divergent}; `
        + 'enrollment recorded it as repository-owned, and no selector grants write '
        + 'authority over bytes daftplate did not write',
      );
    }
  }

  // --decline naming a managed or divergent entry refuses: there is no route
  // from managed back to unowned (that is #119's territory, not this work's),
  // and divergence is already report-only, so a --decline selector on either
  // would claim authority over a state this run has no business changing.
  // Naming an already-declined entry is deliberately NOT refused here — that
  // is the no-op case, handled inline in the write loop below.
  const declineManaged = decline.find((rel) => priorFiles[rel]?.ownership === 'managed');
  if (declineManaged) {
    throw new Error(
      `refusing to sync: --decline cannot name managed path ${declineManaged}; `
      + 'there is no route from managed back to unowned',
    );
  }
  const declineDivergent = decline.find((rel) => priorFiles[rel]?.ownership === 'diverged');
  if (declineDivergent) {
    throw new Error(
      `refusing to sync: --decline cannot name divergent path ${declineDivergent}; `
      + 'divergence is already report-only, so there is nothing a decline would add',
    );
  }

  // --restore naming a declined entry refuses: daftplate never wrote that
  // path, so there is nothing to restore.
  const restoreDeclined = restore.find((rel) => priorFiles[rel]?.ownership === 'declined');
  if (restoreDeclined) {
    throw new Error(
      `refusing to sync: --restore cannot name declined path ${restoreDeclined}; `
      + 'daftplate never wrote this path, so there is nothing to restore',
    );
  }

  // --decline and --add naming the same path is a contradiction, not a
  // selection, and is refused rather than arbitrarily resolved.
  const contradictory = decline.find((rel) => add.includes(rel));
  if (contradictory) {
    throw new Error(
      `refusing to sync: --decline and --add cannot both name ${contradictory}; `
      + 'that is a contradiction, not a selection',
    );
  }

  // Same rule for --rebaseline against each of the other three. The other
  // selectors settle a path by writing it or by recording a refusal to; this one
  // settles it by recording what is already there. Both at once is two different
  // answers to one question, and the pair a real operator reaches for by
  // accident is --add with --rebaseline on a declined path, where each on its
  // own is a sensible thing to want.
  for (const [flag, selectors] of [['--add', add], ['--restore', restore], ['--decline', decline]]) {
    const both = rebaseline.find((rel) => selectors.includes(rel));
    if (both) {
      throw new Error(
        `refusing to sync: --rebaseline and ${flag} cannot both name ${both}; `
        + 'that is a contradiction, not a selection',
      );
    }
  }

  // Compose what the template would produce today by running the real scaffold.
  // Reimplementing its four steps would drift, and drift here means every
  // scaffolded CLAUDE.md reads as MODIFIED forever. Two side effects on the
  // staging tree are deliberately ignored: scaffold writes a .daftplate.json
  // into it (never read — the target's manifest is already loaded) and runs
  // verifyRepo over it (meaningless for a throwaway composition).
  // Captured once, before staging exists, and used for both creation and the
  // cleanup guard. The design claimed staging under the OS temp root made it
  // "impossible to accidentally commit a staging tree into a user's repo"; that
  // held only while tmpdir() was outside the repo, which is one environment
  // variable away from being false. TMPDIR=<target> put a full scaffold —
  // second .daftplate.json included — inside the user's repository, and killing
  // the process before the finally left it there.
  const tempRoot = resolve(tmpdir());
  if (isWithin(targetRoot, tempRoot)) {
    throw new Error(
      `refusing to sync: the OS temp root is inside the target (${tempRoot}); `
      + 'staging would be written into the repository being synchronized',
    );
  }
  const staging = mkdtempSync(join(tempRoot, STAGING_PREFIX));
  const result = {
    staging,
    reports: [],
    updated: [],
    added: [],
    restored: [],
    refused: [],
    offered: [],
    retained: [],
    diverged: [],
    declined: [],
    // #271 (FORGE-332): appended paths whose daftplate segment is intact and whose
    // repository has added its own lines below it. Reported, never written.
    extended: [],
    rebaselined: [],
    wouldUpdate: [],
    wouldAdd: [],
    wouldRestore: [],
    wouldRebaseline: [],
    versionAdvanced: false,
  };

  // Declared outside the try so the catch can undo what the try landed. See
  // rollback() for what "undo" is allowed to mean here.
  const journal = [];
  let rollbackRefusals = null;

  try {
    // Declared from the contract, never destructured by hand. The two names this
    // used to pull out came back as own properties holding `undefined` whenever
    // the manifest predated the tokens gate -- indistinguishable, at the
    // substitution site, from values somebody meant -- and a fourth required token
    // added to scaffold.mjs would have been silently omitted here instead of
    // declared missing. The `= {}` default it also carried was dead:
    // validateProvenance() already supplies one.
    const { YEAR, ...tokens } = Object.fromEntries(
      SCAFFOLD_INPUT_TOKENS.map((name) => [name, manifest.tokens[name]]),
    );
    let composed;
    try {
      composed = scaffold(templatesRoot, manifest.profile, staging, {
        year: YEAR,
        tokens,
      });
    } catch (error) {
      // Two layers, one detector. fillPlaceholders knows the token and the file;
      // only sync knows which manifest declared nothing and what an operator does
      // about it. Anything else propagates untouched.
      if (error.code !== MISSING_TOKEN) throw error;
      throw new Error(
        `refusing to sync: ${join(targetRoot, PROVENANCE_FILE)} declares no value `
        + `for <${error.token}>, which the template substitutes into ${error.rel}. `
        + 'A manifest predating the tokens gate composes every input from nothing, '
        + 'and writing that composition puts the literal string "undefined" into '
        + 'each token-bearing file. Give the manifest a "tokens" object naming '
        + `${SCAFFOLD_INPUT_TOKENS.join(', ')} with the values this repo was `
        + 'scaffolded from, then re-run — skills/sync-standards/SKILL.md carries '
        + 'the recovery note, including what to do if a sync already ran.',
      );
    }
    const candidates = composed.provenance.files;

    // Preflight B: every manifest-only way a --decline selector can be wrong
    // was already refused above, before composition — a managed or divergent
    // prior, an --add/--decline collision on the same path. An already-declined
    // prior naming --decline again is a no-op (handled inline in the loop
    // below), and a path with no prior at all classifies NEW or COLLISION
    // whenever the template produces it. That leaves exactly one remaining way
    // for a --decline path to fail the spec's "must classify NEW or COLLISION"
    // requirement: the template does not produce it today at all, i.e.
    // candidates[rel] is undefined. This single check is that whole
    // requirement, not a partial implementation of it — every other way to
    // fail it is already excluded by the checks above.
    //
    // This cannot live in preflight A because nothing is composed there yet.
    // It must run here, before the write loop below, because a refusal
    // discovered after earlier writes have already landed would itself be the
    // partial sync G1 forbids — and nothing has been written to the target
    // when this runs.
    const unknownDecline = decline.find((rel) => !candidates[rel]);
    if (unknownDecline) {
      throw new Error(
        `refusing to sync: --decline cannot name ${unknownDecline}; `
        + 'daftplate does not produce this path today',
      );
    }

    // Preflight C: --add and --restore were consulted in exactly one place, an
    // `includes(rel)` inside the write loop, so a path that never reached that
    // line was never looked at. A typo, a stale path, or a path in the wrong
    // ownership class did nothing and appeared nowhere — the operator read
    // `outstanding 0` and believed the file was adopted.
    //
    // The predicate is NOT --decline's "the template produces this path". That
    // one accepts README.md, which the template certainly produces and --add
    // certainly cannot adopt. It is "this path was OFFERED this run", which is
    // only knowable after classification — so the named paths are classified
    // here, asking classify() the same question the loop asks, D2's declined
    // lift included. Drop that lift and --add stops lifting a decline, which is
    // a shipped feature.
    //
    // A handful of paths are inspected twice. The alternative is a full
    // two-pass classify-then-write refactor of the most safety-critical loop in
    // the repository, which buys nothing this does not.
    //
    // Refusing the whole run over one bad selector follows --decline and G1: an
    // operator who names five paths and mistypes one wants to know before the
    // other four are written.
    //
    // Extracted so --rebaseline's ladder below asks the same three questions of
    // the same path in the same order, rather than becoming a fourth validation
    // shape that could drift from this one.
    const measureSelected = (selector, rel) => {
      const candidate = candidates[rel] ?? null;
      if (!candidate) {
        throw new Error(
          `refusing to sync: ${selector} cannot name ${rel}; `
          + 'daftplate does not produce this path today',
        );
      }
      const inspected = inspectTargetPath(targetRoot, rel);
      // An unsafe link, a directory, a COLLISION, a standing decline: every one
      // of these already reaches the operator as its own report line, with its
      // status, counted in `outstanding`. Refusing the run for them would trade
      // a complete report for an early exit and would break four shipped
      // behaviours. Only SILENCE is the defect here.
      if (!inspected.ok) return null;
      if (inspected.exists && lstatSync(inspected.abs).isDirectory()) return null;
      return {
        candidate,
        prior: priorFiles[rel] ?? null,
        actual: inspected.exists ? fileDigest(inspected.abs) : null,
      };
    };

    for (const [selector, expected, named] of [['--add', 'OFFER_ADD', add], ['--restore', 'OFFER_RESTORE', restore]]) {
      for (const rel of named) {
        const measured = measureSelected(selector, rel);
        if (!measured) continue;
        const { candidate, prior, actual } = measured;
        const { status, disposition } = classify(prior, candidate, actual);
        // No D2 lift here, deliberately. A declined prior named by --add would
        // classify DECLINED / REPORT_ONLY without it and NEW / OFFER_ADD with it,
        // and both are permitted below — so applying the lift cannot change this
        // gate's answer. It was written in and then removed, because the mutant
        // that dropped it killed nothing: dead code that looks load-bearing is
        // worse than no code. The loop still applies the lift, which is where the
        // decline is actually lifted and where its tests point.
        if (disposition === expected || disposition === 'REFUSE' || disposition === 'REPORT_ONLY') {
          continue;
        }
        throw new Error(
          `refusing to sync: ${selector} cannot name ${rel}; `
          + `it classifies ${status} this run, not an offer to take up`,
        );
      }
    }

    // Preflight D: --rebaseline (D11). Every other selector asks "was this path
    // offered this run"; this one asks whether what the manifest would come to
    // say is ALREADY true on disk. The act is a measurement, and a measurement
    // that needs a write to become true is not one — so every refusal
    // rebaselineEntry() can return is a way the truth could not be recorded
    // without writing repository bytes.
    //
    // The decision itself is pure and lives beside classify(), which is what
    // lets the write loop below re-derive it from its own digest read rather
    // than trusting this one across the window between them.
    for (const rel of rebaseline) {
      const measured = measureSelected('--rebaseline', rel);
      if (!measured) continue;
      const { refusal } = rebaselineEntry(rel, measured.prior, measured.candidate, measured.actual);
      if (refusal) throw new Error(`refusing to sync: ${refusal}`);
    }

    // The manifest is rollback material too: restoring the files while leaving a
    // rewritten .daftplate.json behind would leave the repo describing a state it
    // is no longer in, which is the same class of damage as the half-applied sync.
    const manifestPath = join(targetRoot, PROVENANCE_FILE);
    const manifestBefore = existsSync(manifestPath) ? readFileSync(manifestPath) : null;

    const paths = [...new Set([...Object.keys(priorFiles), ...Object.keys(candidates)])].sort();
    const nextFiles = { ...priorFiles };
    let unresolved = 0;
    let wrote = false;
    let manifestChanged = false;

    // A divergent or declined path never reaches a write site, so it can never
    // enter the journal — which keeps report-only entries out of the rollback
    // plan by construction rather than by a filter that could be forgotten.
    const backupInto = (rel, abs) => {
      const backup = join(staging, ROLLBACK_DIR, rel);
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(abs, backup);
      return backup;
    };

    for (const rel of paths) {
      const prior = priorFiles[rel] ?? null;
      const candidate = candidates[rel] ?? null;

      // Manifest-only: the template stopped producing this path. Never a
      // classify() state — it cannot block an update because there is no update
      // to block, and nothing here deletes.
      if (!candidate) {
        result.retained.push(rel);
        result.reports.push({ rel, status: 'RETAINED', disposition: 'NONE', outcome: 'RETAINED', message: describe(rel, 'RETAINED', prior) });
        continue;
      }

      const refuseUnsafe = (linkRel) => {
        result.refused.push({ rel, status: 'UNSAFE_LINK' });
        result.reports.push({
          rel,
          status: 'UNSAFE_LINK',
          disposition: 'REFUSE',
          outcome: 'UNSAFE_LINK',
          message: describe(rel, 'UNSAFE_LINK', prior, linkRel),
        });
        unresolved += 1;
      };
      const inspected = inspectTargetPath(targetRoot, rel);
      if (!inspected.ok) {
        refuseUnsafe(inspected.linkRel);
        continue;
      }
      const { abs } = inspected;

      // After link inspection, before any fileDigest(). The driver used to hash
      // every existing candidate path before knowing whether daftplate owned it,
      // so a directory sitting at a path the template produces threw EISDIR out
      // of the loop — no COLLISION line, and every path sorted after it never
      // classified at all. One unowned directory cost the operator the entire
      // report.
      //
      // It applies to a newly produced path and to a recorded managed one alike:
      // --restore naming a path that now holds a directory must refuse, not
      // write over it. Deliberately not a classify() state — classify() decides
      // what may be done to a FILE from three digests, and a directory is a
      // shape question answered before any digest exists. It is also kept out of
      // divergent drift, which compares baselines this path has none of.
      if (inspected.exists && lstatSync(abs).isDirectory()) {
        result.refused.push({ rel, status: 'DIRECTORY' });
        result.reports.push({
          rel,
          status: 'DIRECTORY',
          disposition: 'REFUSE',
          outcome: 'DIRECTORY',
          message: describe(rel, 'DIRECTORY', prior),
        });
        unresolved += 1;
        continue;
      }

      const actual = inspected.exists ? fileDigest(abs) : null;
      // D2's lift: a declined prior named by --add re-classifies against a
      // null prior, so every existing gate applies as if the path had never
      // been touched. `prior` (not effectivePrior) is kept around for message
      // building below — describe() needs the real history to say a decline
      // was lifted, which effectivePrior has deliberately forgotten.
      const effectivePrior = (prior?.ownership === 'declined' && add.includes(rel)) ? null : prior;
      // #270 (FORGE-331). The bytes the template WOULD have written are in
      // staging right now and are deleted in the `finally` below, so an operator
      // reading a REFUSED row afterwards has nothing to compare against. The
      // answer is to compute the comparison HERE, while the bytes exist, rather
      // than to keep them: nothing then outlives the run, which is AC 4 met by
      // construction instead of by a cleanup that has to be trusted.
      //
      // Opt-in per path, not per run. A whole-run flag would put every managed
      // file's contents into a report — and into whatever CI log collects it —
      // to answer a question about one of them.
      //
      // Not gated on the disposition. A `disposition === 'REFUSE'` guard was
      // written here first and turned out to be almost inert: by the time an
      // UPDATE row is reported the file has been written, so the two texts are
      // equal and `unifiedDiff` returns null anyway. The mutant removing that
      // guard killed nothing, which is the shape #294 (FORGE-345) settled — a
      // condition no test can distinguish is decoration. Content decides instead,
      // which also makes `--dry-run --diff=<path>` show what an update WOULD do,
      // the one case the guard actively suppressed.
      const wantsDiff = diff.includes(rel);
      const diffFor = () => {
        if (!wantsDiff || !inspected.exists) return {};
        const stagedAt = join(staging, ...rel.split('/'));
        if (!existsSync(stagedAt)) return {};
        const text = unifiedDiff(readFileSync(abs, 'utf8'), readFileSync(stagedAt, 'utf8'));
        return text === null ? {} : { diff: text };
      };
      // #271 (FORGE-332): the appended branch answers from the text, so the text
      // is measured here — where every other filesystem call already lives —
      // and handed to a classify() that stays pure. Read only for an appended
      // prior, so no other path pays for it, and the staged candidate is the
      // composition this run just produced rather than anything remembered.
      const texts = effectivePrior?.mode === 'appended' && inspected.exists
        ? {
          candidate: readFileSync(join(staging, ...rel.split('/')), 'utf8'),
          actual: readFileSync(abs, 'utf8'),
        }
        : null;
      const decision = classify(effectivePrior, candidate, actual, texts);
      const { status, disposition } = decision;

      // --rebaseline is intercepted before every branch below, because the two
      // dispositions it takes over are the two an ordinary run has NO exit from:
      // REFUSE (MODIFIED, OVERRIDDEN) and REPORT_ONLY (DIVERGED, DECLINED).
      // Left alone, the first pushes the path into result.refused and holds the
      // version back on the very thing the operator just resolved, and the
      // second reports a standing condition forever. Nothing with an exit of its
      // own — CURRENT, UPDATE, an offer — is touched, which is also why a path
      // whose manifest entry is already accurate simply reports CURRENT.
      //
      // The decision is RE-DERIVED here from this loop's digest read rather than
      // carried down from the preflight. That read happens after composition and
      // after the earlier paths in this run, and a file edited in that window
      // changes the answer; recording the preflight's answer over it would be
      // exactly the silent adoption the convergence rule exists to prevent. A
      // refusal at this point does not throw — earlier writes have landed, and
      // an exception here would be the partial sync G1 forbids. The path falls
      // through to its ordinary reported outcome instead: MODIFIED, DIVERGED,
      // whatever it now is. Reported, never silent, and nothing written.
      //
      // It writes no repository byte, so it joins no journal: there is nothing
      // to undo, and rollback restoring the manifest restores the truth with it.
      const rebaselining = rebaseline.includes(rel)
        && (disposition === 'REFUSE' || disposition === 'REPORT_ONLY')
        ? rebaselineEntry(rel, prior, candidate, actual)
        : null;
      if (rebaselining?.entry) {
        const [applied, wouldApply] = REBASELINE_OUTCOMES[rebaselining.kind];
        const rebaselineOutcome = dryRun ? wouldApply : applied;
        if (dryRun) {
          result.wouldRebaseline.push(rel);
        } else {
          nextFiles[rel] = rebaselining.entry;
          manifestChanged = true;
          result.rebaselined.push(rel);
        }
        result.reports.push({
          rel,
          status,
          disposition,
          outcome: rebaselineOutcome,
          message: describe(rel, rebaselineOutcome, prior),
        });
        continue;
      }

      // REPORT_ONLY is its own terminus, and an explicit one rather than a path
      // that happens to match no branch below. Divergence and a standing decline
      // are both expected recorded conditions, not outstanding work: neither
      // writes, becomes an offer or a refusal, or counts toward `unresolved` —
      // counting either would pin the daftplate version forever on a path no
      // sync can ever resolve, which is the mistake the RETAINED comment below
      // already records. Both baselines stay out of nextFiles, so neither is
      // refreshed. `prior` and `effectivePrior` are identical whenever this
      // branch is reached — a lift that nulls effectivePrior always moves the
      // decision away from REPORT_ONLY (D2) — so using `prior` below costs
      // nothing and reads as what it is: the path's own history.
      if (disposition === 'REPORT_ONLY') {
        // Each status gets its own bucket, so a caller never has to infer
        // divergence or a decline by searching formatted per-path messages,
        // and never has to subtract either back out of refused or offered.
        // DIVERGED and DECLINED share one disposition but need different
        // operator action (D6), which is why they do not share one bucket.
        // #271 (FORGE-332). A third status reaches this terminus now, and it
        // gets its own bucket for the reason DIVERGED and DECLINED have two: a
        // caller must never have to infer which condition it is by searching
        // formatted messages. It carries no templateDrift and no repoState —
        // those are questions about a baseline this status does not have — so it
        // is intercepted before the drift object is built rather than given
        // undefined fields to keep a shape it does not share.
        if (status === 'APPENDED_EXTENDED') {
          result.extended.push({ rel });
          result.reports.push({
            rel, status, disposition, outcome: status, message: describe(rel, status, prior, undefined, decision),
          });
          continue;
        }
        const drift = { rel, templateDrift: decision.templateDrift };
        if (status === 'DIVERGED') {
          result.diverged.push({ ...drift, repoDrift: decision.repoDrift });
        } else {
          result.declined.push({ ...drift, repoState: decision.repoState });
        }
        result.reports.push({
          rel,
          status,
          disposition,
          outcome: status,
          ...(status === 'DIVERGED'
            ? { repoDrift: decision.repoDrift }
            : { repoState: decision.repoState }),
          templateDrift: decision.templateDrift,
          message: describe(rel, status, prior, undefined, decision),
        });
        continue;
      }

      // A NEW or COLLISION path named in --decline is intercepted here, before
      // the OFFER/REFUSE handling below: a COLLISION carries
      // disposition: 'REFUSE', which would otherwise push it into
      // result.refused and increment `unresolved` — exactly the outcome
      // recording a decline exists to avoid. Reached only for a genuinely new
      // decline: preflight A already refused --decline naming a managed or
      // divergent prior, and an already-declined prior that was not lifted
      // took the REPORT_ONLY branch above instead of reaching here.
      if ((status === 'NEW' || status === 'COLLISION') && decline.includes(rel)) {
        const outcome = dryRun ? 'WOULD_DECLINE' : 'DECLINED_RECORDED';
        if (!dryRun) {
          nextFiles[rel] = {
            ...(actual !== null ? { digest: actual } : {}),
            templateDigest: candidate.digest,
            layer: candidate.layer,
            mode: candidate.mode,
            ownership: 'declined',
          };
          manifestChanged = true;
          // The state as measured right now, so the summary this run prints
          // agrees with what the very next run will report for the same path
          // (classify() would compute the same repoState from the entry just
          // written): ABSENT for a NEW decline (actual is null by definition
          // of NEW), UNCHANGED for a COLLISION decline (digest was just set
          // to actual).
          result.declined.push({
            rel,
            repoState: actual === null ? 'ABSENT' : 'UNCHANGED',
            templateDrift: 'UNCHANGED',
          });
        }
        result.reports.push({
          rel, status, disposition, outcome, message: describe(rel, outcome, prior, undefined, decision),
        });
        continue;
      }

      const wanted = disposition === 'OFFER_ADD' ? add.includes(rel) : restore.includes(rel);
      const source = join(staging, rel);
      let acted = false;
      let outcome = status;

      if (disposition === 'UPDATE' && !dryRun) {
        hooks.beforeWrite?.(rel, abs);
        // Re-check between classification and write: the file may have moved
        // under us, and the manifest only licenses replacing what it still
        // matches.
        const rechecked = inspectTargetPath(targetRoot, rel);
        if (!rechecked.ok) {
          refuseUnsafe(rechecked.linkRel);
          continue;
        }
        // One walk covers the digest read and the copy together: nothing but the
        // read happens between them, so a second walk here would re-prove what
        // this one just proved. The window that matters is the one beforeWrite
        // opens, and it is closed above.
        if (rechecked.exists && fileDigest(rechecked.abs) === prior.digest) {
          const backup = backupInto(rel, rechecked.abs);
          replaceFile(source, rechecked.abs);
          journal.push({
            rel, kind: 'replaced', backup, writtenDigest: candidate.digest,
          });
          result.updated.push(rel);
          outcome = 'UPDATE';
          acted = true;
          wrote = true;
        } else {
          // Two different events shared this branch and reported as one. A file
          // that is GONE has no on-disk digest to differ from anything.
          const reported = rechecked.exists ? 'MODIFIED' : 'VANISHED';
          result.refused.push({ rel, status: reported });
          result.reports.push({
            rel,
            status: reported,
            disposition: 'REFUSE',
            outcome: reported,
            // #270 (FORGE-331): the diff, when the operator named this path.
            ...diffFor(),
            // #271 (FORGE-332): the decision carries which part of an appended file
            // changed, and a refusal that does not pass it says less than it knows.
            message: describe(rel, reported, prior, undefined, decision),
          });
          unresolved += 1;
          continue;
        }
      } else if (disposition === 'UPDATE') {
        result.wouldUpdate.push(rel);
        outcome = 'WOULD_UPDATE';
      } else if ((disposition === 'OFFER_ADD' || disposition === 'OFFER_RESTORE') && wanted && dryRun) {
        // The symmetry --decline already had. `wanted && !dryRun` sent a taken-up
        // offer to the offered bucket, where it printed "rerun with --add=X" —
        // the flag that had just been passed — and counted toward `outstanding`.
        // It does not count, for WOULD_DECLINE's reason: the operator has
        // decided, and the real run will leave nothing outstanding. A dry run
        // then reports the counts the real run produces, which is the point.
        if (disposition === 'OFFER_ADD') {
          result.wouldAdd.push(rel);
          outcome = 'WOULD_ADD';
        } else {
          result.wouldRestore.push(rel);
          outcome = 'WOULD_RESTORE';
        }
      } else if ((disposition === 'OFFER_ADD' || disposition === 'OFFER_RESTORE') && wanted && !dryRun) {
        const beforeMkdir = inspectTargetPath(targetRoot, rel);
        if (!beforeMkdir.ok) {
          refuseUnsafe(beforeMkdir.linkRel);
          continue;
        }
        mkdirSync(dirname(beforeMkdir.abs), { recursive: true });
        // Walked again because mkdirSync just changed the ancestry this depends on
        // — `recursive: true` traverses an existing linked parent rather than
        // failing on it, so the pre-mkdir walk no longer describes the tree.
        const afterMkdir = inspectTargetPath(targetRoot, rel);
        if (!afterMkdir.ok) {
          refuseUnsafe(afterMkdir.linkRel);
          continue;
        }
        // Exclusive: a file that appeared since classification is never clobbered.
        // Deliberately NOT replaceFile: this branch only runs for NEW and MISSING,
        // where the destination is absent, so there is no existing entry to write
        // through — a hard link or symlink at the path would make it present and
        // classify as COLLISION or MODIFIED instead. Renaming here would also
        // discard the exclusivity that stops a file appearing mid-run from being
        // silently overwritten, which is a guarantee replaceFile cannot offer.
        copyFileSync(source, afterMkdir.abs, constants.COPYFILE_EXCL);
        journal.push({
          rel, kind: 'created', backup: null, writtenDigest: candidate.digest,
        });
        (disposition === 'OFFER_ADD' ? result.added : result.restored).push(rel);
        outcome = disposition === 'OFFER_ADD' ? 'ADDED' : 'RESTORED';
        acted = true;
        wrote = true;
      } else if (disposition === 'OFFER_ADD' || disposition === 'OFFER_RESTORE') {
        result.offered.push({ rel, status });
        unresolved += 1;
      } else if (disposition === 'REFUSE') {
        result.refused.push({ rel, status });
        unresolved += 1;
      }

      // A CURRENT path never acts, so its entry used to be carried forward
      // verbatim -- including a `layer` and `mode` the template has since moved
      // away from. That is not only a stale line in a file: classify()'s
      // OVERRIDDEN gate reads prior.mode, so a byte-identical file can carry a
      // wrong input into a later refusal.
      //
      // Metadata only. The bytes did not move, so the digest may not; ownership
      // is the repository's answer, not this run's. Reached only through
      // disposition NONE, which classify() gives to managed entries alone --
      // diverged and declined return REPORT_ONLY from gates that sit above it, so
      // this cannot touch a baseline G2 protects.
      if (!acted && disposition === 'NONE'
          && (prior.layer !== candidate.layer || prior.mode !== candidate.mode)) {
        nextFiles[rel] = { ...prior, layer: candidate.layer, mode: candidate.mode };
        manifestChanged = true;
        outcome = 'CURRENT_REFRESHED';
      }
      if (acted) nextFiles[rel] = candidate;
      result.reports.push({
        rel,
        status,
        disposition,
        outcome,
        ...diffFor(),
        message: describe(rel, outcome, prior, undefined, decision),
      });
    }

    // Only paths actually written change provenance. A refused path keeps its
    // old entry, so the next run still sees the difference.
    // The version advances only when nothing is outstanding, because a partial
    // sync must not claim the repo represents the new template version.
    // RETAINED does not count: the sync can never resolve it, so counting it
    // would pin the version forever. Neither does DIVERGED, for the same reason
    // and more strongly — no sync can ever resolve it, because resolving it would
    // mean writing bytes daftplate does not own.
    result.versionAdvanced = unresolved === 0 && !dryRun;
    // A run whose only action was recording or lifting a decline writes no
    // file bytes (wrote stays false) and may not advance the version either,
    // so manifestChanged is a third, independent reason to write: without it
    // that run's decline would be computed and reported but never persisted.
    // Re-declining an already-declined path leaves manifestChanged false (it
    // took the REPORT_ONLY branch above, not the recording branch), so a
    // no-op run stays a no-op and does not rewrite the manifest.
    // Three separate facts, and #72's third gap was letting one of them stand in
    // for another. `wrote` is "file bytes changed"; `manifestChanged` is
    // "provenance entries changed"; `versionAdvanced` is "the sync resolved
    // everything, so the version is ENTITLED to advance" — which is true on every
    // clean run, including one where the recorded version already equals the
    // template's. Using it directly as the write condition therefore truncated and
    // rewrote a byte-identical .daftplate.json on every fully current sync:
    // harmless on an ordinary filesystem, and an exception on a read-only manifest,
    // where a no-op run threw instead of reporting that everything was current.
    //
    // The write needs the narrower fact — did the version actually MOVE — while
    // the summary line and the entitlement semantics keep the broader one.
    const versionMoved = result.versionAdvanced
      && manifest.daftplate !== composed.provenance.daftplate;
    if (!dryRun && (wrote || manifestChanged || versionMoved)) {
      const provenance = inspectTargetPath(targetRoot, PROVENANCE_FILE);
      if (!provenance.ok) {
        throw new Error(`refusing to sync: unsafe link in target path: ${PROVENANCE_FILE}`);
      }
      // Bumping schema here — not touching the `...manifest` spread or the
      // `daftplate:` line — is #123's fix, not #125's, and the two stay
      // separable because it asks a different question than either of those
      // lines. #125 is a run that changes nothing; this branch is never reached
      // by one.
      //
      // The question is what the ENTRIES need, not that a write happened —
      // #242 (FORGE-316). It used to be `manifestChanged ? MAX : manifest.schema`,
      // on the belief that manifestChanged meant "a decline was just recorded".
      // That stopped being true at #237: a CURRENT metadata refresh sets it, and
      // so does every `--rebaseline` row, and neither needs anything schema 1
      // cannot express. So an operator who re-baselined one path in a schema 1
      // repository got a manifest a daftplate 1.6.0 checkout refuses outright —
      // the schema refusal firing for a migration nobody requested.
      //
      // Recording a decline still bumps, which is the case the old condition was
      // written for: a schema 1 or 2 manifest cannot legally carry
      // `ownership: 'declined'` (Phase 1 gated it to schema >= 3), so writing one
      // without bumping bricks the manifest this run just wrote — the next sync
      // throws "unknown ownership" before it can do anything. requiredSchema()
      // says so from the entry rather than from the occasion.
      //
      // Math.max, because the number never runs backwards: a schema 3 manifest
      // whose last decline is lifted needs only 1, and writing 1 would hand an
      // older checkout a manifest this daftplate had already migrated. Bumping is
      // safe because every entry in nextFiles carries an explicit ownership,
      // which is what schema 2 and 3 require.
      // `manifest` is what readProvenance() returned, which is a NORMALIZED copy
      // (#125): schema 1's implicit ownership is explicit in it, a schema key was
      // supplied where the file had none, and an absent tokens map became {}.
      // Spreading it writes that normalization to disk, which is how a file comes
      // to declare schema 1 while carrying schema 2's shape. unnormalizeProvenance()
      // is the inverse, applied here rather than inside writeProvenance() because
      // only a writer that first read a manifest can round-trip one.
      const nextManifest = unnormalizeProvenance({
        ...manifest,
        schema: Math.max(manifest.schema, requiredSchema(nextFiles)),
        daftplate: result.versionAdvanced ? composed.provenance.daftplate : manifest.daftplate,
        files: nextFiles,
      });

      // Journalled BEFORE the write, and still last in the journal so it is undone
      // first. The old ordering pushed after, above a comment claiming a
      // post-provenance failure would restore the prior manifest — but the backup
      // copy, its mkdirSync and the fileDigest all sat between the write and the
      // push, and each of them throws into exactly the state the comment said was
      // prevented: files restored, new provenance left beside them.
      //
      // The backup is the bytes captured before any write, never a copy taken from
      // disk here. Reading the path now would back up whatever is at it, which
      // after the write is the new manifest, restoring nothing.
      //
      // writtenDigest comes from the serialized string rather than from the file,
      // because there is no file yet — that is the whole point of the reordering.
      let manifestBackup = null;
      if (manifestBefore !== null) {
        manifestBackup = join(staging, ROLLBACK_DIR, PROVENANCE_FILE);
        mkdirSync(dirname(manifestBackup), { recursive: true });
        writeFileSync(manifestBackup, manifestBefore);
      }
      journal.push({
        rel: PROVENANCE_FILE,
        kind: manifestBefore === null ? 'created' : 'replaced',
        backup: manifestBackup,
        writtenDigest: digestOf(serializeProvenance(nextManifest)),
      });
      writeProvenance(targetRoot, nextManifest, { rename: hooks.renameProvenance });
      hooks.afterProvenance?.(targetRoot);
    }
  } catch (error) {
    rollbackRefusals = rollback(targetRoot, journal);
    if (rollbackRefusals.length) {
      // Staging is retained and named: it holds the only copies of the bytes that
      // could not be restored. Nothing further is overwritten or deleted, because
      // every refusal above means the tree stopped matching what we wrote, and
      // guessing past that is how a recovery tool destroys the thing it came for.
      throw new AggregateError(
        [error, ...rollbackRefusals.map((r) => new Error(r))],
        [
          `sync failed and could not be fully rolled back: ${error.message}`,
          ...rollbackRefusals.map((r) => `  ${r}`),
          `  recovery material retained at ${staging}`,
          '  no further overwrite or deletion was attempted',
        ].join('\n'),
      );
    }
    throw error;
  } finally {
    // Retained only when rollback could not finish — then it is evidence, not
    // debris, and the message above names it.
    if (!rollbackRefusals?.length) removeStaging(staging, tempRoot);
  }

  return result;
}

/**
 * The one line an operator actually reads, extracted so it can be asserted
 * without capturing stdout.
 *
 * `diverged N (M with template drift)` appears only when N is nonzero. A
 * permanent "diverged 0" would train the eye to skip the one term that means
 * somebody has a file to port by hand. M counts only entries whose template
 * moved, because repository drift on a path daftplate does not own is the
 * repository doing its job, while template drift is work waiting for a person.
 *
 * Divergence sits beside `outstanding` and never inside it: it is an expected
 * recorded condition, not unresolved work, and folding it in would block the
 * version advancing forever on a path no sync can resolve.
 */
export function formatSyncSummary(result, dryRun) {
  const outstanding = result.refused.length + result.offered.length;
  const diverged = result.diverged ?? [];
  const drifted = diverged.filter(({ templateDrift }) => templateDrift === 'CHANGED').length;
  const declined = result.declined ?? [];
  const declinedDrifted = declined.filter(({ templateDrift }) => templateDrift === 'CHANGED').length;
  // Conditional for diverged's reason rather than added's: re-baselining is a
  // named act on a named path, so a permanent "re-baselined 0" would train the
  // eye past the one term that means an ownership baseline moved.
  const rebaselined = (dryRun ? result.wouldRebaseline : result.rebaselined) ?? [];

  return [
    `${dryRun ? 'would update' : 'updated'} ${dryRun ? result.wouldUpdate.length : result.updated.length}`,
    `added ${dryRun ? (result.wouldAdd ?? []).length : result.added.length}`,
    `restored ${dryRun ? (result.wouldRestore ?? []).length : result.restored.length}`,
    ...(rebaselined.length ? [`${dryRun ? 'would re-baseline' : 're-baselined'} ${rebaselined.length}`] : []),
    `retained ${result.retained.length}`,
    ...(diverged.length ? [`diverged ${diverged.length} (${drifted} with template drift)`] : []),
    // Same rule as diverged, same reason: a permanent "declined 0" would train
    // the eye to skip the one term that means somebody made a standing choice
    // worth a second glance when its template moves.
    ...(declined.length ? [`declined ${declined.length} (${declinedDrifted} with template drift)`] : []),
    `outstanding ${outstanding}`,
  ].join(', ');
}

function main(argv) {
  const args = argv.slice(2);
  const flags = (key) => args
    .filter((a) => a.startsWith(`--${key}=`))
    .map((a) => a.slice(key.length + 3));
  const [templatesRoot, target] = args.filter((a) => !a.startsWith('--'));

  if (args.includes('--add-all') || args.includes('--restore-all')) {
    console.error('there is no --add-all: naming each path is what makes adding it a decision');
    return 2;
  }
  // G4: no bulk selector for declining, same reasoning as --add-all — naming
  // each path is what makes declining it a decision, and a decline expands
  // what the manifest asserts about operator intent, which a bulk flag makes
  // not-a-decision.
  if (args.includes('--decline-all')) {
    console.error('there is no --decline-all: naming each path is what makes declining it a decision');
    return 2;
  }
  // G5 again, and the reason is if anything stronger here: a re-baseline moves
  // what daftplate claims to have authored, on a path whose bytes it did not
  // write. Naming each one is the whole of the operator's consent.
  if (args.includes('--rebaseline-all')) {
    console.error('there is no --rebaseline-all: naming each path is what makes re-baselining it a decision');
    return 2;
  }
  if (!templatesRoot || !target) {
    console.error('usage: node scripts/sync-standards.mjs <templates-root> <target> [--dry-run] [--add=<path>]... [--restore=<path>]... [--decline=<path>]... [--rebaseline=<path>]... [--json] [--diff=<path>]...');
    return 2;
  }

  const dryRun = args.includes('--dry-run');
  let result;
  try {
    result = syncStandards(templatesRoot, target, {
      dryRun,
      add: flags('add'),
      restore: flags('restore'),
      decline: flags('decline'),
      rebaseline: flags('rebaseline'),
      diff: flags('diff'),
    });
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  const outstanding = result.refused.length + result.offered.length;

  // #269 (FORGE-330) half 2. Prose on stdout was this command's only machine
  // surface, so a batch driver had to parse English to learn what happened. The
  // rows are the SAME rows — `result.reports` is what the prose is rendered from,
  // and the JSON carries each row's `message` alongside its fields so the two
  // cannot describe different runs. A test asserts the row sets agree.
  if (args.includes('--json')) {
    console.log(JSON.stringify({
      dryRun,
      outstanding,
      versionAdvanced: result.versionAdvanced ?? false,
      summary: formatSyncSummary(result, dryRun),
      reports: result.reports,
    }, null, 2));
  } else {
    for (const { message, diff } of result.reports) {
      console.log(message);
      // #270 (FORGE-331): printed under the row it belongs to, and only for a
      // path the operator named. The staging tree is already gone by the time
      // this prints — the comparison was made while it existed, which is why
      // nothing had to be retained for it. The --json branch above needs no
      // equivalent: the diff is a field on the row it already emits.
      if (diff) console.log(diff);
    }
    console.log(formatSyncSummary(result, dryRun));
    if (dryRun) console.error('dry run: nothing was written');
    else if (!result.versionAdvanced && outstanding) {
      console.error(`${outstanding} path(s) outstanding — ${PROVENANCE_FILE} still records the old daftplate version`);
    }
  }

  // #269 (FORGE-330) half 1. A run that refused a path exited 0, indistinguishable
  // from a clean one to any caller — which is what blocks a fleet-wide batch
  // driver, since the only way to learn a path was left untouched was to read the
  // prose.
  //
  // **Refusals only, not `outstanding`.** An OFFER is not a refusal: NEW and
  // MISSING are the command telling an operator it found work it may not do
  // unasked, and a first sync against a repository that has drifted legitimately
  // reports several. Exiting non-zero for those would make the normal case look
  // like a failure, and a caller that learned to ignore the code would learn to
  // ignore it for refusals too. `outstanding` still holds the version back and
  // still prints; it is the exit code alone that is narrower.
  //
  // `EXIT_CODES.REFUSED` rather than a private number, and rather than `1`:
  // `1` is what the catch above returns for a sync that could not run at all, and
  // "I ran and declined to touch three paths" is a different fact from "I threw".
  return result.refused.length ? EXIT_CODES.REFUSED : 0;
}

export { main };
runCli(import.meta.url, main);
