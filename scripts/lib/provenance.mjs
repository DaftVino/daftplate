// The record of what the layers wrote, committed into every scaffolded repo.
// Phase 6's /sync-standards reads it to tell "the repo changed this file" from
// "the template changed this file". See ADR 0003.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROVENANCE_FILE = '.daftplate.json';

// The highest manifest schema this daftplate can interpret. A manifest with no
// `schema` key is schema 1 — every schema 1 entry was written by a scaffold, so
// daftplate produced its bytes and a missing `ownership` means exactly that.
// Schema 2 writes `ownership` on every entry, so its absence THERE is malformed
// rather than a default: reading it as managed would hand daftplate write
// authority over a path whose author declined to record granting it. Schema 3
// adds `declined` as a third ownership value: an operator-recorded refusal of a
// path the template offers, distinct from `diverged` (the repo owns the bytes)
// because a declined path may have no bytes at all.
export const MAX_PROVENANCE_SCHEMA = 3;

const LAYERS = new Set(['base', 'profile']);
const MODES = new Set(['copied', 'appended', 'overridden']);
const OWNERSHIPS = new Set(['managed', 'diverged', 'declined']);
// 'declined' did not exist before schema 3. A manifest that DECLARES schema 1
// or 2 but carries this value anyway (a hand-edited file, a bad merge, a
// half-finished migration) is refused here rather than accepted — never a
// manifest genuinely written by a newer daftplate, since that would already be
// stopped by the schema check in validateProvenance() before reaching this far.
const OWNERSHIPS_BEFORE_SCHEMA_3 = new Set(['managed', 'diverged']);
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (detail) => new Error(`invalid ${PROVENANCE_FILE}: ${detail}`);

function validateEntry(rel, raw, schema) {
  if (!isPlainObject(raw)) throw invalid(`entry for ${rel} must be an object`);
  if (!LAYERS.has(raw.layer)) {
    throw invalid(`${rel} has an unknown layer: ${JSON.stringify(raw.layer)}`);
  }
  if (!MODES.has(raw.mode)) {
    throw invalid(`${rel} has an unknown mode: ${JSON.stringify(raw.mode)}`);
  }

  let ownership = raw.ownership;
  if (ownership === undefined) {
    if (schema > 1) throw invalid(`${rel} is missing ownership; only schema 1 may omit it`);
    ownership = 'managed';
  } else {
    // See OWNERSHIPS_BEFORE_SCHEMA_3: 'declined' is gated to schema >= 3 the
    // same way the missing-ownership default is gated to schema 1.
    const knownForSchema = schema >= 3 ? OWNERSHIPS : OWNERSHIPS_BEFORE_SCHEMA_3;
    if (!knownForSchema.has(ownership)) {
      throw invalid(`${rel} has an unknown ownership: ${JSON.stringify(ownership)}`);
    }
  }

  // `digest` baselines the bytes at this path. `managed` and `diverged` both
  // claim provenance over bytes that exist, so it is unconditionally required.
  // `declined` claims no such thing: per D5, its presence IS the record of
  // whether the path held an unowned file at decline time — absent means
  // nothing was there, present means an unowned file was and these were its
  // bytes — so it is optional there. Either way, check the digest's shape
  // whenever one is required or one was given: one condition covers both.
  const declaresDigest = 'digest' in raw;
  const digestRequired = ownership !== 'declined';
  if ((digestRequired || declaresDigest) && !DIGEST.test(raw.digest)) {
    throw invalid(`${rel} has a malformed digest: ${JSON.stringify(raw.digest)}`);
  }

  // The two baselines are what divergence IS: `digest` is the repository file as
  // adopted, `templateDigest` the composed candidate at enrollment time. A
  // divergent entry missing one cannot answer either drift question, and a
  // managed entry carrying one is claiming a baseline nothing measured. A
  // declined entry needs `templateDigest` for the same reason divergence does —
  // there is always a candidate, because the template produced the offer that
  // was declined — and it is required exactly like the divergent case.
  const declaresTemplate = 'templateDigest' in raw;
  if (ownership === 'diverged' || ownership === 'declined') {
    if (!declaresTemplate) throw invalid(`${rel} is ${ownership}, so templateDigest is required`);
    if (!DIGEST.test(raw.templateDigest)) {
      throw invalid(`${rel} has a malformed templateDigest: ${JSON.stringify(raw.templateDigest)}`);
    }
  } else if (declaresTemplate) {
    throw invalid(`${rel} is managed, and managed ownership forbids templateDigest`);
  }

  return { ...raw, ownership };
}

/** The one gate every manifest read passes through, so synchronization and
 *  enrollment cannot disagree about what a manifest means. Returns a normalized
 *  copy: schema 1's implicit ownership becomes explicit IN MEMORY, and the file
 *  on disk is never touched — an unsolicited migration write over a repo that is
 *  working is not a read. Unknown properties survive under a known schema, so a
 *  field a later daftplate adds is preserved rather than silently dropped by a
 *  round trip through sync. */
export function validateProvenance(manifest) {
  if (!isPlainObject(manifest)) {
    throw invalid(`expected an object, got ${Array.isArray(manifest) ? 'an array' : typeof manifest}`);
  }

  const schema = manifest.schema === undefined ? 1 : manifest.schema;
  if (!Number.isInteger(schema) || schema < 1) {
    throw invalid(`schema must be a positive integer, got ${JSON.stringify(manifest.schema)}`);
  }
  // Refusing a higher number is the whole point of carrying one: a manifest from
  // a later daftplate is structurally valid and unreadable, and guessing at
  // fields this version was not written to understand is how a reader converts
  // someone else's correctness into this one's silent wrong answer.
  if (schema > MAX_PROVENANCE_SCHEMA) {
    throw new Error(
      `unsupported ${PROVENANCE_FILE} schema: ${schema}; this daftplate implements ${MAX_PROVENANCE_SCHEMA}`,
    );
  }

  for (const field of ['daftplate', 'profile']) {
    if (typeof manifest[field] !== 'string' || !manifest[field]) {
      throw invalid(`${field} must be a non-empty string`);
    }
  }
  if (!isPlainObject(manifest.files)) throw invalid('files must be an object');
  // `tokens` is checked when present and not required when absent. Manifests
  // predating this gate omit it, nothing but pass-through reads it, and adding a
  // hard refusal with no decision riding on it would break repos that work.
  if (manifest.tokens !== undefined && !isPlainObject(manifest.tokens)) {
    throw invalid('tokens must be an object');
  }

  // fromEntries rather than assignment: `files['__proto__'] = entry` hits the
  // setter and creates no own property, so a manifest key named __proto__ would
  // vanish from a map every later gate walks.
  return {
    ...manifest,
    schema,
    tokens: manifest.tokens ?? {},
    files: Object.fromEntries(
      Object.entries(manifest.files).map(([rel, raw]) => [rel, validateEntry(rel, raw, schema)]),
    ),
  };
}

/** The write-side inverse of the normalization above, and the reason a manifest
 *  never declares one schema while carrying another's shape (#125).
 *
 *  The rule is not a list of fields to strip — a list is a thing someone forgets,
 *  and the field they forget ships as the next hybrid. It is one property:
 *  **a writer never states a value a reader would supply from its absence.**
 *  Everything below is that property applied to the three things
 *  `validateProvenance()` supplies today, and a fourth is a fourth clause here
 *  rather than a silent omission, because the round-trip test asserts the
 *  property and not the clauses.
 *
 *  Deliberately not folded into `writeProvenance()`. Composition writes a fresh
 *  manifest at the current schema and has nothing to un-normalize; only a writer
 *  that first *read* a manifest can round-trip one, and synchronization is the
 *  only one of those. */
export function unnormalizeProvenance(manifest) {
  const out = { ...manifest };

  // Absence reads as schema 1, so 1 is the one number a manifest never states.
  // Any other number is the entire reason the field exists.
  if (out.schema === 1) delete out.schema;

  // Absent tokens read as {} at every schema, so an empty map is a default
  // nobody stated. This is the clause a two-field strip would have missed: it is
  // not schema-versioned, and a manifest predating the tokens gate acquires
  // `"tokens": {}` on its next sync without it.
  if (isPlainObject(out.tokens) && Object.keys(out.tokens).length === 0) delete out.tokens;

  // Absent ownership reads as 'managed', and only under schema 1 — from schema 2
  // absence is malformed rather than a default, so there the field is content.
  if (manifest.schema === 1) {
    out.files = Object.fromEntries(Object.entries(out.files).map(([rel, entry]) => {
      // The dangerous direction, not the tidy one. Schema 1 has no way to say
      // 'diverged' or 'declined', so stripping one would publish a manifest
      // claiming daftplate owns bytes it measured and does not own — CLAUDE.md
      // #5 through the front door. Synchronization cannot reach this, because
      // recording either value bumps the schema first (#123), which is exactly
      // why this refuses rather than trusting that it stays true.
      if (entry.ownership !== 'managed') {
        throw new Error(
          `refusing to write ${PROVENANCE_FILE}: `
            + `schema 1 cannot express ownership ${JSON.stringify(entry.ownership)} on ${rel}`,
        );
      }
      const { ownership, ...rest } = entry;
      return [rel, rest];
    }));
  }

  return out;
}

export function fileDigest(absPath) {
  return `sha256:${createHash('sha256').update(readFileSync(absPath)).digest('hex')}`;
}

// The single writer of ordinary managed entries. Scaffold composition and, later,
// enrollment composition both come through here rather than appending ownership
// fields of their own, so there is one place where "daftplate produced these
// bytes" gets said. Divergent entries are not built here — they are the one case
// where daftplate measured a path it does not own, and only enrollment can know
// that.
export function buildProvenance({ root, version, profile, tokens, files }) {
  const entries = {};
  for (const { rel, layer, mode } of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    const abs = join(root, rel);
    if (existsSync(abs)) {
      entries[rel] = { digest: fileDigest(abs), layer, mode, ownership: 'managed' };
    }
  }
  return {
    schema: MAX_PROVENANCE_SCHEMA, daftplate: version, profile, tokens, files: entries,
  };
}

export function writeProvenance(root, provenance) {
  const path = join(root, PROVENANCE_FILE);
  writeFileSync(path, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  return path;
}

export function readProvenance(root) {
  const path = join(root, PROVENANCE_FILE);
  return existsSync(path) ? validateProvenance(JSON.parse(readFileSync(path, 'utf8'))) : null;
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
// │       ├─ prior.ownership === 'diverged' ─────────> DIVERGED     / REPORT_ONLY
// │       │        + repoDrift     UNCHANGED | CHANGED | MISSING
// │       │        + templateDrift UNCHANGED | CHANGED
// │       │        (enrollment measured this path and daftplate does not own
// │       │         its bytes; every managed gate below would claim it does)
// │       │
// │       ├─ prior.ownership === 'declined' ─────────> DECLINED     / REPORT_ONLY
// │       │        + repoState     ABSENT | APPEARED | UNCHANGED | CHANGED | MISSING
// │       │        + templateDrift UNCHANGED | CHANGED
// │       │        (an operator refused this path; daftplate does not own its
// │       │         bytes either, and prior.digest may be entirely absent —
// │       │         every managed gate below would mis-measure that absence)
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
//
// The divergent gate stays SECOND, above every managed gate. Each of those gates
// decides what daftplate may write to a path it owns, and a divergent entry is
// precisely the one it does not: fall through and an edited divergent file reads
// as MODIFIED, a deleted one offers restoration, and one whose bytes drifted into
// agreement with today's candidate reads as CURRENT — three different ways of
// forgetting that the repository, not daftplate, authored those bytes.
//
// The declined gate stays THIRD, still above every managed gate, for the same
// reason and a sharper failure mode: a declined entry's prior.digest may be
// entirely absent (a declined NEW path never had bytes). Fall through and gate 4
// (actual === null) offers to restore a file the repository never had — exactly
// the failure D7 forbids entry-invention for. Gate 5 compares actual against
// undefined, so any file that later appears at a declined path reads as
// MODIFIED / REFUSE: the right disposition for the wrong reason, and it re-enters
// the unresolved count this work exists to keep clear of decisions already made.
// Gate 6 compares candidate.digest against the same undefined and would read a
// coincidental byte match as CURRENT, which claims daftplate owns bytes it does
// not. Position, not a status check downstream, is what keeps all three false.
//
// Ownership is read through the effective value, not raw: schema 1 entries carry
// no field and validateProvenance() has already supplied 'managed' for them. This
// function is pure and takes records as data, so a hand-built prior with no
// ownership is managed here too, which is what every existing caller and fixture
// means by it.
export function classify(prior, candidate, actual) {
  if (!prior) {
    return actual === null
      ? { status: 'NEW', disposition: 'OFFER_ADD' }
      : { status: 'COLLISION', disposition: 'REFUSE' };
  }
  if (prior.ownership === 'diverged') {
    // Two baselines, two independent questions. Repository drift is measured
    // against the file as adopted; template drift against the candidate as
    // composed at enrollment — including its layer and mode, so a byte-identical
    // change in how the file is produced still reports as movement.
    const repoDrift = actual === null
      ? 'MISSING'
      : (actual === prior.digest ? 'UNCHANGED' : 'CHANGED');
    const templateUnchanged = candidate.digest === prior.templateDigest
      && candidate.layer === prior.layer
      && candidate.mode === prior.mode;
    return {
      status: 'DIVERGED',
      disposition: 'REPORT_ONLY',
      repoDrift,
      templateDrift: templateUnchanged ? 'UNCHANGED' : 'CHANGED',
    };
  }
  if (prior.ownership === 'declined') {
    // repoState widens divergence's three-word vocabulary to five, because a
    // declined prior.digest may be entirely absent and divergence's is not:
    // "nothing was ever at this path, and nothing is" (ABSENT) and "the
    // unowned file that was here is unchanged" (UNCHANGED) would otherwise
    // collapse to the same word, and likewise "a file appeared where nothing
    // was" (APPEARED) would collapse into plain CHANGED. Divergence cannot
    // tell those pairs apart because it always has a baseline to compare
    // against; declined does not, and an operator reading the report needs
    // to see which of the two actually happened.
    let repoState;
    if (prior.digest === undefined) {
      repoState = actual === null ? 'ABSENT' : 'APPEARED';
    } else if (actual === null) {
      repoState = 'MISSING';
    } else {
      repoState = actual === prior.digest ? 'UNCHANGED' : 'CHANGED';
    }
    const templateUnchanged = candidate.digest === prior.templateDigest
      && candidate.layer === prior.layer
      && candidate.mode === prior.mode;
    return {
      status: 'DECLINED',
      disposition: 'REPORT_ONLY',
      repoState,
      templateDrift: templateUnchanged ? 'UNCHANGED' : 'CHANGED',
    };
  }
  if (prior.mode === 'overridden' && candidate.layer === 'base') {
    return { status: 'OVERRIDDEN', disposition: 'REFUSE' };
  }
  if (actual === null) return { status: 'MISSING', disposition: 'OFFER_RESTORE' };
  if (actual !== prior.digest) return { status: 'MODIFIED', disposition: 'REFUSE' };
  if (candidate.digest === prior.digest) return { status: 'CURRENT', disposition: 'NONE' };
  return { status: 'UPDATE', disposition: 'UPDATE' };
}
