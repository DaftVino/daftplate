// The record of what the layers wrote, committed into every scaffolded repo.
// Phase 6's /sync-standards reads it to tell "the repo changed this file" from
// "the template changed this file". See ADR 0003.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROVENANCE_FILE = '.daftplate.json';

export function fileDigest(absPath) {
  return `sha256:${createHash('sha256').update(readFileSync(absPath)).digest('hex')}`;
}

export function buildProvenance({ root, version, profile, tokens, files }) {
  const entries = {};
  for (const { rel, layer, mode } of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    const abs = join(root, rel);
    if (existsSync(abs)) entries[rel] = { digest: fileDigest(abs), layer, mode };
  }
  return { daftplate: version, profile, tokens, files: entries };
}

export function writeProvenance(root, provenance) {
  const path = join(root, PROVENANCE_FILE);
  writeFileSync(path, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  return path;
}

export function readProvenance(root) {
  const path = join(root, PROVENANCE_FILE);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}
