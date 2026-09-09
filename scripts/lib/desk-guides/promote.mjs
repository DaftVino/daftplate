// Publishing a validated set into `output/pdf/desk-guides/`, and never touching
// anything else.
//
// CLAUDE.md #5 is absolute: nothing deletes what it did not create. Every rule
// below exists to keep that true when the output path is wrong, when a previous
// run was interrupted, or when someone put their own file in the output
// directory. The ownership record is the prior manifest -- not the directory
// name, not a filename pattern, and never "it looks generated".
//
// On atomicity, stated plainly rather than claimed: Node offers no cross-platform
// atomic replacement of one non-empty directory by another. Promotion is two
// renames, each atomic on its own, with a crash window between them. What closes
// the window is not a stronger primitive but a recognisable artifact: the
// displaced directory is left under a marked, run-identified name, and the next
// invocation finds it by its marker and recovers or reports. A run that crashes
// mid-promotion is recoverable; it is not invisible.
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync, lstatSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, parse, relative, sep, dirname } from 'node:path';

export class PromoteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PromoteError';
  }
}

const fail = (message) => { throw new PromoteError(message); };

/** Written into every directory this module creates. Its presence plus a
 *  matching run id is the ONLY thing that authorizes a recursive removal. */
export const MARKER = '.desk-guides-run.json';

const norm = (p) => resolve(p);

/** True when `child` is inside `parent`, boundary-aware so `/a/bc` is not
 *  treated as inside `/a/b`. */
function contains(parent, child) {
  const rel = relative(norm(parent), norm(child));
  return rel !== '' && !rel.startsWith('..') && !parse(rel).root;
}

/**
 * Everything that must be true of an output path before anything is created.
 *
 * Pure: it takes paths and returns refusals, so every dangerous target can be
 * tested without a filesystem that has one. The guard runs BEFORE staging, not
 * after, because a guard that fires after the first mkdir has already created
 * something in the place it was meant to protect.
 */
export function preflight({ outputDir, repoRoot, home = homedir() }) {
  const out = norm(outputDir);
  const repo = norm(repoRoot);
  const problems = [];

  if (out === repo) problems.push(`${out} is the repository root`);
  if (out === norm(home)) problems.push(`${out} is your home directory`);
  if (out === parse(out).root) problems.push(`${out} is a filesystem root`);
  // An ancestor of the repository, which includes every parent of it. Written as
  // "does the output contain the repo", not "does the repo contain the output" --
  // the reversed comparison passes for `X:\` and refuses the legitimate default.
  if (contains(out, repo)) problems.push(`${out} is an ancestor of the repository at ${repo}`);
  if (existsSync(out) && !statSync(out).isDirectory()) problems.push(`${out} exists and is not a directory`);

  return problems;
}

/** The prior run's ownership record, or a reason there is none.
 *  An existing output directory with no readable manifest is NOT assumed to be
 *  ours: someone may have made it, and the remedy is to say so, not to replace
 *  its contents. */
export function readPriorManifest(outputDir) {
  const path = join(outputDir, 'manifest.json');
  if (!existsSync(outputDir)) return { state: 'absent', owned: new Set() };
  if (!existsSync(path)) {
    return { state: 'unowned', reason: `${outputDir} exists but has no manifest.json, so this generator cannot prove it wrote what is there`, owned: new Set() };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { state: 'unowned', reason: `${path} is not readable JSON (${err.message}), so ownership cannot be established`, owned: new Set() };
  }
  if (!Array.isArray(parsed.targets)) {
    return { state: 'unowned', reason: `${path} has no targets list, so ownership cannot be established`, owned: new Set() };
  }
  return {
    state: 'owned',
    manifest: parsed,
    owned: new Set(parsed.targets.map((t) => String(t.path).replace(/\\/g, '/'))),
  };
}

/** Every file actually present under a directory, as forward-slash relatives. */
export function listTree(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (current, prefix) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stats = lstatSync(full);
      if (stats.isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

/**
 * Can this staged set replace what is in the output directory?
 *
 * Refuses a collision with anything the prior manifest does not name, and
 * refuses when unknown entries make a whole-directory replacement unsafe. The
 * cost is real: an output directory someone dropped a file into stops working
 * until they move it. That is the intended trade -- the alternative is a
 * generator that deletes a file it never wrote.
 */
export function planPromotion({ outputDir, stagedTargets }) {
  const prior = readPriorManifest(outputDir);
  if (prior.state === 'unowned') fail(prior.reason);

  const present = listTree(outputDir).filter((rel) => rel !== MARKER);
  const staged = new Set(stagedTargets.map((t) => t.replace(/\\/g, '/')));
  const unknown = present.filter((rel) => !prior.owned.has(rel));
  if (unknown.length) {
    fail(`${outputDir} holds ${unknown.length} file(s) this generator did not write: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ', ...' : ''}. Move them elsewhere; nothing here deletes what it did not create`);
  }
  const collisions = present.filter((rel) => staged.has(rel) && !prior.owned.has(rel));
  if (collisions.length) {
    fail(`${outputDir} holds target(s) the prior manifest does not own: ${collisions.join(', ')}`);
  }
  return { prior, replacing: present.length > 0 };
}

/** A staging directory this invocation created, with its marker written before
 *  anything else goes in. */
export function createStaging({ parent, runId }) {
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'run-'));
  writeFileSync(join(dir, MARKER), `${JSON.stringify({ runId, kind: 'staging', createdBy: 'build-desk-guides' }, null, 2)}\n`, 'utf8');
  return dir;
}

/** True only when `dir` carries this run's marker. The authority for every
 *  recursive removal in this module, and deliberately not the directory's name:
 *  a name is a coincidence, and another process can produce the same one. */
export function markedForRun(dir, runId, kind = null) {
  try {
    const marker = JSON.parse(readFileSync(join(dir, MARKER), 'utf8'));
    return marker.runId === runId && (kind === null || marker.kind === kind);
  } catch {
    return false;
  }
}

/** Remove a directory this invocation created, and nothing else.
 *  Three gates, all required: the path is inside the approved parent, it is a
 *  directory, and its marker names this run. A name that merely looks like a
 *  staging directory survives untouched. */
export function removeOwnDirectory({ dir, parent, runId, kind = null }) {
  if (!existsSync(dir)) return { removed: false, reason: 'absent' };
  if (!contains(parent, dir)) return { removed: false, reason: 'outside the approved parent' };
  if (!statSync(dir).isDirectory()) return { removed: false, reason: 'not a directory' };
  if (!markedForRun(dir, runId, kind)) return { removed: false, reason: 'no marker for this run' };
  rmSync(dir, { recursive: true, force: true });
  return { removed: true };
}

/**
 * Two renames, and the recovery rule for the gap between them.
 *
 * 1. If an output directory exists, rename it aside to a marked, run-identified
 *    rollback directory.
 * 2. Rename staging into place.
 * 3. Revalidate, then remove the rollback.
 *
 * A crash between 1 and 2 leaves no output directory and one marked rollback.
 * That state is recoverable and `recoverInterrupted` below is what recovers it.
 * A failure at 2 restores the rollback and reports; the previous set is byte
 * for byte what it was.
 */
export function promote({ staging, outputDir, runId, rename = renameSync, revalidate = null }) {
  const parent = dirname(norm(outputDir));
  mkdirSync(parent, { recursive: true });

  const rollback = `${norm(outputDir)}.rollback-${runId}`;
  let displaced = false;

  if (existsSync(outputDir)) {
    writeFileSync(join(outputDir, MARKER), `${JSON.stringify({ runId, kind: 'rollback', createdBy: 'build-desk-guides' }, null, 2)}\n`, 'utf8');
    rename(outputDir, rollback);
    displaced = true;
  }

  try {
    rename(staging, outputDir);
  } catch (err) {
    if (displaced) {
      rename(rollback, outputDir);
      fail(`promotion failed (${err.code ?? err.message}) and the previous output was restored unchanged`);
    }
    fail(`promotion failed (${err.code ?? err.message}); no previous output existed, so nothing was lost`);
  }

  if (revalidate) {
    const problems = revalidate(outputDir);
    if (problems.length) {
      rename(outputDir, staging);
      if (displaced) rename(rollback, outputDir);
      fail(`the promoted set failed revalidation and was rolled back: ${problems.join('; ')}`);
    }
  }

  if (displaced) {
    removeOwnDirectory({ dir: rollback, parent, runId, kind: 'rollback' });
  }
  return { outputDir, rolledBack: false };
}

/**
 * A rollback directory left by an interrupted run, found by its marker.
 *
 * Conservative on purpose. If the output directory is missing, the rollback IS
 * the last good set and is moved back. If both exist, nothing is guessed: the
 * rollback is reported and left for a person, because choosing between two
 * plausible sets is not a decision a generator gets to make silently.
 */
export function recoverInterrupted({ outputDir, parent = dirname(norm(outputDir)) }) {
  if (!existsSync(parent)) return { found: [] };
  const base = `${parse(norm(outputDir)).base}.rollback-`;
  const found = readdirSync(parent)
    .sort()
    .filter((name) => name.startsWith(base))
    .map((name) => join(parent, name))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory() && JSON.parse(readFileSync(join(dir, MARKER), 'utf8')).kind === 'rollback';
      } catch {
        // No marker means this generator did not create it, whatever it is
        // called. It is never removed and never moved.
        return false;
      }
    });

  if (!found.length) return { found: [] };
  if (existsSync(outputDir)) {
    return {
      found,
      recovered: false,
      message: `an interrupted run left ${found.length} rollback director(y/ies) beside ${outputDir}: ${found.join(', ')}. Both a current set and a rollback exist, so nothing was moved; inspect and remove the one you do not want`,
    };
  }
  // Two interrupted runs are the same problem as a rollback beside a current set,
  // one layer in: there is more than one candidate for "the previous output" and
  // no fact here distinguishes them. `readdirSync` order is not a fact -- it is
  // whatever the filesystem returns -- so picking `found[0]` would restore an
  // arbitrary set and report it as *the* previous one. Sorted above so the report
  // is at least stable; still not chosen from.
  if (found.length > 1) {
    return {
      found,
      recovered: false,
      message: `${found.length} interrupted runs left rollback directories beside ${outputDir} and no current set exists: ${found.join(', ')}. Nothing was moved, because which one is the previous output set is not something this can know; inspect them and rename the one you want to ${outputDir}`,
    };
  }

  renameSync(found[0], outputDir);
  return {
    found,
    recovered: true,
    message: `recovered the previous output set from ${found[0]}, left by an interrupted run`,
  };
}
