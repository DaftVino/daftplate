import { mkdtempSync, mkdirSync, writeFileSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep, resolve } from 'node:path';

// Every throwaway directory this helper creates, with the two facts cleanup needs:
// the temp root captured AT CREATION, and the filesystem identity measured
// immediately after. Nothing else may authorize a recursive removal.
//
// CLAUDE.md #5 is absolute — nothing deletes what it did not create — and a
// recursive delete under the system temp directory is the one operation where
// being wrong is unrecoverable. So the authority is this in-process record, never
// a filename prefix and never a scan of the temp root: another process's fixture
// can share our prefix, and a scan cannot tell its directories from ours.
const owned = [];

/** Retain on failure or on request; clean only on an ordinary success.
 *
 *  Exported as a pure predicate so the policy is testable without spawning a
 *  deliberately failing child, whose retained fixture would make this very suite
 *  leak by construction. */
export function shouldClean(exitCode, env = process.env) {
  return exitCode === 0 && !env.DAFTPLATE_KEEP_TMP;
}

/** Create a tracked throwaway directory under the OS temp root. */
export function tempDir(prefix) {
  const root = resolve(tmpdir());
  const path = mkdtempSync(join(root, prefix));
  // Measured now, not at teardown: it is what proves the directory removed later
  // is the same object created here and not a replacement at the same name.
  const { ino, dev } = lstatSync(path);
  owned.push({ path, root, ino, dev });
  return path;
}

function cleanup(exitCode) {
  const keep = [];
  if (!shouldClean(exitCode)) {
    for (const { path } of owned) keep.push(path);
  } else {
    for (const entry of owned) {
      const { path, root, ino, dev } = entry;
      try {
        // Three gates, all of which must hold. Containment is boundary-aware so a
        // sibling root cannot masquerade as a parent; the directory check refuses
        // a path that became a file or a link; and identity refuses a directory
        // that was replaced at the same name since we made it.
        if (!path.startsWith(root + sep)) { keep.push(path); continue; }
        const stat = lstatSync(path);
        if (!stat.isDirectory()) { keep.push(path); continue; }
        // ino is 0 on some Windows filesystems, where identity is unavailable
        // rather than mismatched; containment plus the creation record still hold.
        if (ino !== 0 && (stat.ino !== ino || stat.dev !== dev)) { keep.push(path); continue; }
        rmSync(path, { recursive: true, force: true });
      } catch {
        // A cleanup failure retains and warns. It must never mask the test result
        // the process is exiting with.
        keep.push(path);
      }
    }
  }

  if (keep.length) {
    // Synchronous, because the process is already exiting and anything queued
    // asynchronously here is simply lost.
    process._rawDebug?.(`daftplate: ${keep.length} test fixture(s) retained:\n  ${keep.join('\n  ')}`);
  }
}

process.on('exit', cleanup);

/** Build a throwaway tree from a { relativePath: contents } map. Returns its root. */
export function makeRepo(files = {}) {
  const dir = tempDir('pt-');
  for (const [rel, contents] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }
  return dir;
}

/** An empty throwaway directory. */
export function emptyDir() {
  return tempDir('pt-dest-');
}

/**
 * Run `body` with the OS temp root pointed at a directory this test owns, and
 * return that directory.
 *
 * #231 (FORGE-301). A staging-cleanup test that counts entries in the
 * process-wide temp root is asserting something about the machine rather than
 * about the run: a `daftplate-sync-*` left there by an interrupted run, a
 * concurrent session, or a mutation sweep turns correct code red, and it did —
 * twice, once costing a full diagnostic detour. It is also weaker than it looks
 * in the other direction, because a count taken before and after can be equal
 * while the run created and abandoned a directory somebody else removed.
 *
 * Scoping the run to a root nothing else writes to answers both: what is left in
 * the returned directory afterwards was put there by the run under test and by
 * nothing else, so the assertion can be `deepEqual([])` rather than a count.
 *
 * Build every fixture BEFORE calling this — a `makeRepo()` inside `body` would
 * land in the owned root and be measured as part of the run's residue.
 *
 * The directory is a `tempDir()` like any other, so the exit handler owns its
 * removal; nothing here deletes anything.
 */
export function withOwnedTempRoot(body) {
  const root = tempDir('pt-root-');
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = root;
  process.env.TEMP = root;
  process.env.TMP = root;
  try {
    body(root);
  } finally {
    // Restored from what was captured here, never deleted: `delete process.env.X`
    // for a variable that was set would leave the process without a temp root at
    // all, and on Windows that is not a state anything downstream survives.
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return root;
}

/** The smallest repo tree that should pass verifyRepo with no violations. */
export const MINIMAL = {
  'README.md': '# thing\n',
  LICENSE: 'MIT License\n\nCopyright (c) 2026 James M. Baker\n',
  'CHANGELOG.md': '# Changelog\n',
  'CLAUDE.md': '# CLAUDE.md\n\n## Project\n\nA thing.\n',
  '.gitignore': 'node_modules/\n',
  'docs/architecture.md': '# Architecture\n',
};
