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
import {
  lstatSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, renameSync, constants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, sep } from 'node:path';
import { runCli } from './lib/cli.mjs';
import { scaffold } from './scaffold.mjs';
import {
  PROVENANCE_FILE, classify, fileDigest, readProvenance, writeProvenance,
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

// `status` is what classify() decided; `outcome` is what the run actually did.
// They differ whenever an offer was taken up: a path classified MISSING that
// --restore then wrote must not still print "rerun with --restore", which is
// what it said before a CLI smoke run caught it.
function describe(rel, outcome, prior, linkRel) {
  const appended = prior?.mode === 'appended' ? appendedNote : '';
  switch (outcome) {
    case 'ADDED':
      return `ADDED ${rel} — created from the current template and recorded in ${PROVENANCE_FILE}`;
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
    dryRun = false, add = [], restore = [], hooks = {},
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

    const paths = [...new Set([...Object.keys(priorFiles), ...Object.keys(candidates)])].sort();
    const nextFiles = { ...priorFiles };
    let unresolved = 0;
    let wrote = false;

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
      const { status, disposition } = classify(prior, candidate, actual);
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
    // would pin the version forever.
    result.versionAdvanced = unresolved === 0 && !dryRun;
    if (!dryRun && (wrote || result.versionAdvanced)) {
      const provenance = inspectTargetPath(targetRoot, PROVENANCE_FILE);
      if (!provenance.ok) {
        throw new Error(`refusing to sync: unsafe link in target path: ${PROVENANCE_FILE}`);
      }
      writeProvenance(targetRoot, {
        ...manifest,
        daftplate: result.versionAdvanced ? composed.provenance.daftplate : manifest.daftplate,
        files: nextFiles,
      });
    }
  } finally {
    removeStaging(staging);
  }

  return result;
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
  if (!templatesRoot || !target) {
    console.error('usage: node scripts/sync-standards.mjs <templates-root> <target> [--dry-run] [--add=<path>]... [--restore=<path>]...');
    return 2;
  }

  const dryRun = args.includes('--dry-run');
  let result;
  try {
    result = syncStandards(templatesRoot, target, {
      dryRun, add: flags('add'), restore: flags('restore'),
    });
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  for (const { message } of result.reports) console.log(message);
  const outstanding = result.refused.length + result.offered.length;
  console.log(
    `${dryRun ? 'would update' : 'updated'} ${dryRun ? result.wouldUpdate.length : result.updated.length}, `
    + `added ${result.added.length}, restored ${result.restored.length}, `
    + `retained ${result.retained.length}, outstanding ${outstanding}`,
  );
  if (dryRun) console.error('dry run: nothing was written');
  else if (!result.versionAdvanced && outstanding) {
    console.error(`${outstanding} path(s) outstanding — ${PROVENANCE_FILE} still records the old daftplate version`);
  }
  return 0;
}

export { main };
runCli(import.meta.url, main);
