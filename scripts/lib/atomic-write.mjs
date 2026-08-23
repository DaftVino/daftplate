// The one atomic writer. Lifted out of install-skills.mjs when enrollment needed
// the same guarantees for .daftplate.json; writing a second one is the failure
// this module exists to avoid. Everything below is the routine that was already
// paid for, generalized only past its two hardcoded inputs — the directory and
// the temp basename now come from the target path.
import {
  existsSync, mkdirSync, mkdtempSync, writeFileSync, renameSync, linkSync,
  unlinkSync, rmdirSync, statSync, chmodSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';

const RENAME_ATTEMPTS = 3;
const RENAME_RETRY_MS = 150;

/** Sync sleep with no dependency and no busy-wait. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write `contents` to `target` without ever leaving it half-written.
 *
 * Temp-file-plus-rename, with the temp file on the same volume as the target so the
 * rename is a rename and not a copy (measured 2026-08-16: a cross-volume rename fails
 * EXDEV). The staging directory is mkdtemp-derived rather than a fixed name, so two
 * concurrent writers cannot clobber each other's staging file.
 *
 * On NTFS a rename over a file that any process holds open throws EPERM — an editor
 * tab, antivirus mid-scan, another agent reading it. POSIX permits it. Retried three
 * times to clear a transient scan, then refused. It never falls back to a plain
 * writeFileSync: that would reintroduce the torn write precisely when contention makes
 * it most likely.
 *
 * `replace: false` publishes by hard link instead, for a target that must be created
 * and never replaced. It is deliberately NOT a checked rename: `rename` replaces an
 * existing file on POSIX and NTFS alike, so a rival that lands between the check and
 * the rename is silently destroyed, and a second check only narrows that window. Nor
 * is it `copyFileSync(..., COPYFILE_EXCL)`, which closes the clobber but publishes an
 * O_CREAT|O_EXCL file that is observable at zero length while it fills — disqualifying
 * for a provenance file with concurrent readers. `linkSync` publishes a file that was
 * written and closed in full, so it appears complete or not at all, and throws EEXIST
 * rather than overwriting. A filesystem without hard links refuses; the only available
 * fallback is the unsafe write this branch exists to prevent.
 *
 * Returns null on success, or the refusal reason.
 */
export function writeAtomically(target, contents, opts = {}) {
  const rename = opts.rename ?? renameSync;
  const link = opts.link ?? linkSync;
  const replace = opts.replace ?? true;
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const staging = mkdtempSync(join(dir, '.daftplate-'));
  const temp = join(staging, basename(target));

  try {
    writeFileSync(temp, contents, 'utf8');

    if (!replace) {
      try {
        link(temp, target);
        return null;
      } catch (err) {
        if (err.code === 'EEXIST') {
          return `${target} already exists or appeared during the write, so it was left untouched`;
        }
        return `${target} could not be published by hard link (${err.code}), so it was left untouched`;
      }
    }

    // Replacing by rename gives the new file the temp file's mode (0600 from mkdtemp),
    // which would silently tighten permissions on a file the user may have deliberately
    // made group-readable. No-op on Windows.
    if (existsSync(target)) chmodSync(temp, statSync(target).mode);

    for (let attempt = 1; ; attempt += 1) {
      try {
        rename(temp, target);
        return null;
      } catch (err) {
        if (err.code !== 'EPERM') throw err;   // only EPERM is a contention signal
        if (attempt >= RENAME_ATTEMPTS) {
          return `${target} is open in another process, so it was left untouched`;
        }
        pause(RENAME_RETRY_MS);
      }
    }
  } finally {
    // A failed publication leaves the temp file behind — debris in the user's
    // directory. Guarded so a cleanup failure never masks the original error, and
    // scoped to the directory this function itself created (CLAUDE.md #5). After a
    // successful link the staging name is one of two names for the published file;
    // unlinking it leaves the target intact at nlink = 1.
    try {
      if (existsSync(temp)) unlinkSync(temp);
      rmdirSync(staging);
    } catch { /* nothing here is worth losing the real error over */ }
  }
}
