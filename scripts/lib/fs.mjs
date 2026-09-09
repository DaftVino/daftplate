// Filesystem walking, shared by every script that needs to see a whole tree.
// Lived in verify-repo.mjs until it had three consumers.
import { existsSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Never walked: version control, dependencies, build output.
export const EXCLUDED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.astro', '.wrangler', '.next',
]);

/** Depth-first list of entries under `dir`. Skips excluded dirs and never follows symlinks. */
export function walkFiles(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const stats = lstatSync(full);
    if (stats.isSymbolicLink()) return [];
    const rel = prefix ? `${prefix}/${name}` : name;
    if (!stats.isDirectory()) return [{ rel, isDir: false }];
    return EXCLUDED_DIRS.has(name) ? [] : [{ rel, isDir: true }, ...walkFiles(full, rel)];
  });
}

/**
 * Canonical where the path exists, normalized where it does not.
 *
 * Shared rather than duplicated because containment and equality are asked about
 * the same filesystem by two different modules, and two spellings of "the same
 * directory" is how one guard folds case and its neighbour does not. The fallback
 * matters: the injected-execFile tests name paths no filesystem has, and
 * realpathSync throws on those.
 */
export function canonical(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}
