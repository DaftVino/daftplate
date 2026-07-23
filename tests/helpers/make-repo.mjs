import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

/** Build a throwaway tree from a { relativePath: contents } map. Returns its root. */
export function makeRepo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pt-'));
  for (const [rel, contents] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }
  return dir;
}

/** An empty throwaway directory. */
export function emptyDir() {
  return mkdtempSync(join(tmpdir(), 'pt-dest-'));
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
