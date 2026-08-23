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
//                                   [--decline=<path>]...
import {
  lstatSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, renameSync, constants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, sep } from 'node:path';
import { runCli } from './lib/cli.mjs';
import { scaffold } from './scaffold.mjs';
import {
  PROVENANCE_FILE, MAX_PROVENANCE_SCHEMA, classify, fileDigest, readProvenance, writeProvenance,
  unnormalizeProvenance,
} from './lib/provenance.mjs';

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
const appendedNote = ' — this file is composed from a base copy plus a profile append; '
  + 'the template\'s current version is in the report, add any new lines by hand';

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
      return `REFUSED MODIFIED ${rel} — on-disk digest differs from ${PROVENANCE_FILE}; left untouched${appended}`;
    case 'UNSAFE_LINK':
      return `REFUSED UNSAFE LINK ${rel} — ${linkRel} is a symbolic link or junction; left untouched`;
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

// Only ever called on a directory this process made with mkdtempSync, under the
// OS temp root. The guard is here rather than assumed because CLAUDE.md #5 makes
// "nothing deletes what it did not create" absolute, and a recursive delete is
// the one operation where being wrong is unrecoverable.
function removeStaging(staging) {
  const root = tmpdir();
  if (!staging.startsWith(root + sep) || !staging.includes(STAGING_PREFIX)) {
    throw new Error(`refusing to remove a staging path outside ${root}: ${staging}`);
  }
  rmSync(staging, { recursive: true, force: true });
}

export function syncStandards(templatesRoot, targetRoot, opts = {}) {
  const {
    dryRun = false, add = [], restore = [], decline = [], hooks = {},
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

  // Compose what the template would produce today by running the real scaffold.
  // Reimplementing its four steps would drift, and drift here means every
  // scaffolded CLAUDE.md reads as MODIFIED forever. Two side effects on the
  // staging tree are deliberately ignored: scaffold writes a .daftplate.json
  // into it (never read — the target's manifest is already loaded) and runs
  // verifyRepo over it (meaningless for a throwaway composition).
  const staging = mkdtempSync(join(tmpdir(), STAGING_PREFIX));
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
    wouldUpdate: [],
    versionAdvanced: false,
  };

  try {
    const { tokens = {} } = manifest;
    const { PROJECT_NAME, PROJECT_SUMMARY } = tokens;
    const composed = scaffold(templatesRoot, manifest.profile, staging, {
      year: tokens.YEAR,
      tokens: { PROJECT_NAME, PROJECT_SUMMARY },
    });
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

    const paths = [...new Set([...Object.keys(priorFiles), ...Object.keys(candidates)])].sort();
    const nextFiles = { ...priorFiles };
    let unresolved = 0;
    let wrote = false;
    let manifestChanged = false;

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
      const actual = inspected.exists ? fileDigest(abs) : null;
      // D2's lift: a declined prior named by --add re-classifies against a
      // null prior, so every existing gate applies as if the path had never
      // been touched. `prior` (not effectivePrior) is kept around for message
      // building below — describe() needs the real history to say a decline
      // was lifted, which effectivePrior has deliberately forgotten.
      const effectivePrior = (prior?.ownership === 'declined' && add.includes(rel)) ? null : prior;
      const decision = classify(effectivePrior, candidate, actual);
      const { status, disposition } = decision;

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
          rel, status, disposition, outcome, message: describe(rel, outcome, prior),
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
          replaceFile(source, rechecked.abs);
          result.updated.push(rel);
          outcome = 'UPDATE';
          acted = true;
          wrote = true;
        } else {
          result.refused.push({ rel, status: 'MODIFIED' });
          result.reports.push({ rel, status: 'MODIFIED', disposition: 'REFUSE', outcome: 'MODIFIED', message: describe(rel, 'MODIFIED', prior) });
          unresolved += 1;
          continue;
        }
      } else if (disposition === 'UPDATE') {
        result.wouldUpdate.push(rel);
        outcome = 'WOULD_UPDATE';
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

      if (acted) nextFiles[rel] = candidate;
      result.reports.push({ rel, status, disposition, outcome, message: describe(rel, outcome, prior) });
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
    if (!dryRun && (wrote || manifestChanged || result.versionAdvanced)) {
      const provenance = inspectTargetPath(targetRoot, PROVENANCE_FILE);
      if (!provenance.ok) {
        throw new Error(`refusing to sync: unsafe link in target path: ${PROVENANCE_FILE}`);
      }
      // Bumping schema here — not touching the `...manifest` spread or the
      // `daftplate:` line — is #123's fix, not #125's, and the two stay
      // separable because it fires on a different condition than either of
      // those lines: only when manifestChanged, i.e. only when a decline was
      // just recorded. #125 is a run that changes nothing; this branch is
      // never reached by one. A schema 1 or 2 manifest cannot legally carry
      // `ownership: 'declined'` (Phase 1 gated it to schema >= 3), so writing
      // one without bumping bricks the very manifest this run just wrote —
      // the next sync throws "unknown ownership" before it can do anything.
      // Bumping is safe because every entry in nextFiles already passed
      // through validateProvenance(), so each already carries an explicit
      // ownership, which is exactly what schema 3 requires. It is also the
      // sanctioned migration per docs/architecture.md: the schema number
      // "advances only when something writes a manifest anyway, never as an
      // upgrade pass over repos that are working" — recording a decline is
      // something writing the manifest anyway.
      // `manifest` is what readProvenance() returned, which is a NORMALIZED copy
      // (#125): schema 1's implicit ownership is explicit in it, a schema key was
      // supplied where the file had none, and an absent tokens map became {}.
      // Spreading it writes that normalization to disk, which is how a file comes
      // to declare schema 1 while carrying schema 2's shape. unnormalizeProvenance()
      // is the inverse, applied here rather than inside writeProvenance() because
      // only a writer that first read a manifest can round-trip one.
      writeProvenance(targetRoot, unnormalizeProvenance({
        ...manifest,
        schema: manifestChanged ? MAX_PROVENANCE_SCHEMA : manifest.schema,
        daftplate: result.versionAdvanced ? composed.provenance.daftplate : manifest.daftplate,
        files: nextFiles,
      }));
    }
  } finally {
    removeStaging(staging);
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

  return [
    `${dryRun ? 'would update' : 'updated'} ${dryRun ? result.wouldUpdate.length : result.updated.length}`,
    `added ${result.added.length}`,
    `restored ${result.restored.length}`,
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
  if (!templatesRoot || !target) {
    console.error('usage: node scripts/sync-standards.mjs <templates-root> <target> [--dry-run] [--add=<path>]... [--restore=<path>]... [--decline=<path>]...');
    return 2;
  }

  const dryRun = args.includes('--dry-run');
  let result;
  try {
    result = syncStandards(templatesRoot, target, {
      dryRun, add: flags('add'), restore: flags('restore'), decline: flags('decline'),
    });
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  for (const { message } of result.reports) console.log(message);
  const outstanding = result.refused.length + result.offered.length;
  console.log(formatSyncSummary(result, dryRun));
  if (dryRun) console.error('dry run: nothing was written');
  else if (!result.versionAdvanced && outstanding) {
    console.error(`${outstanding} path(s) outstanding — ${PROVENANCE_FILE} still records the old daftplate version`);
  }
  return 0;
}

export { main };
runCli(import.meta.url, main);
