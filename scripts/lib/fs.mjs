// Filesystem walking, shared by every script that needs to see a whole tree.
// Lived in verify-repo.mjs until it had three consumers.
import { existsSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

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
