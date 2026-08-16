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

// Decides what /sync-standards may do to one path. Pure: it takes three measured
// digests as data and returns a decision, leaving every filesystem call and all
// message formatting to the caller — the same split untaggedReleases() uses in
// publish.mjs. No path is passed in, because the path cannot affect the decision.
//
//   prior      manifest entry {digest, layer, mode}, or null if never managed
//   candidate  today's composed entry; never null (see the caller-error note)
//   actual     digest of the bytes on disk, or null if the file is absent
//
// classify(prior, candidate, actual)
// │
// ├─ prior === null ?  ("daftplate has never owned this path here")
// │  │
// │  YES ─┬─ actual === null ─────────────────────────> NEW          / OFFER_ADD
// │       └─ actual !== null ─────────────────────────> COLLISION    / REFUSE
// │                                              (unowned file sits at the path)
// │  NO  ── prior is a record; every gate below may dereference it
// │       │
// │       ├─ prior.mode === 'overridden'
// │       │  && candidate.layer === 'base' ───────────> OVERRIDDEN   / REFUSE
// │       │        (profile dropped its override; do not push base in)
// │       │
// │       ├─ actual === null ─────────────────────────> MISSING      / OFFER_RESTORE
// │       │
// │       ├─ actual !== prior.digest ─────────────────> MODIFIED     / REFUSE
// │       │        (fires even if actual === candidate.digest —
// │       │         convergence is not provenance)
// │       │
// │       ├─ candidate.digest === prior.digest ───────> CURRENT      / NONE
// │       │
// │       └─ otherwise ───────────────────────────────> UPDATE       / UPDATE
// │                (repo untouched, template moved: the one safe write)
// │
// ├─ mode: 'appended' gets NO branch of its own. A matching digest means the
// │  staged whole-file composition is safe to write; a differing one is
// │  MODIFIED like any other file. An earlier draft refused every appended
// │  file because a whole-file digest cannot locate the appended segment —
// │  true, and beside the point, because locating it is unnecessary in the
// │  only case that could be written safely.
// │
// └─ candidate === null is a CALLER ERROR, never reached. Manifest-only paths
//    are a set difference computed by the caller and reported as "no longer
//    produced; retained".
//
// The !prior cases MUST stay first: the OVERRIDDEN gate reads prior.mode, so
// ordering it above them throws a TypeError on exactly the newly-added-file
// case this function exists to serve.
export function classify(prior, candidate, actual) {
  if (!prior) {
    return actual === null
      ? { status: 'NEW', disposition: 'OFFER_ADD' }
      : { status: 'COLLISION', disposition: 'REFUSE' };
  }
  if (prior.mode === 'overridden' && candidate.layer === 'base') {
    return { status: 'OVERRIDDEN', disposition: 'REFUSE' };
  }
  if (actual === null) return { status: 'MISSING', disposition: 'OFFER_RESTORE' };
  if (actual !== prior.digest) return { status: 'MODIFIED', disposition: 'REFUSE' };
  if (candidate.digest === prior.digest) return { status: 'CURRENT', disposition: 'NONE' };
  return { status: 'UPDATE', disposition: 'UPDATE' };
}
