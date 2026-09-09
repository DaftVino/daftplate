// The record of what the layers wrote, committed into every scaffolded repo.
// Phase 6's /sync-standards reads it to tell "the repo changed this file" from
// "the template changed this file". See ADR 0003.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomically } from './atomic-write.mjs';

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
  // `tokens` is checked when present and not required when absent. That is still
  // the right shape, but not for the reason this comment used to give. It said
  // "nothing but pass-through reads it, and adding a hard refusal with no decision
  // riding on it would break repos that work". Both halves were false: sync reads
  // it to compose, and it was the ABSENCE of a refusal that broke repos that work,
  // by writing the literal string "undefined" into every token-bearing file and
  // then re-digesting the corruption as current.
  //
  // Requiring `tokens` HERE would still be wrong, for a different reason. A
  // manifest with no tokens and templates with no placeholders is a legitimate
  // repo whose composition needs nothing, and a refusal at the schema gate refuses
  // it too. The refusal belongs at the substitution site, where a missing value
  // costs nothing until a template actually matches it -- see fillPlaceholders in
  // scripts/scaffold.mjs.
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

// The lowest schema each ownership value can be written under. It is the write
// side of validateEntry's two ownership gates, spelled as data so the two cannot
// drift into disagreement: `declined` is refused below 3 by
// OWNERSHIPS_BEFORE_SCHEMA_3, and anything but `managed` is refused below 2 by
// unnormalizeProvenance, because schema 1 says `managed` by ABSENCE and has no
// way to say anything else.
const SCHEMA_FOR_OWNERSHIP = { managed: 1, diverged: 2, declined: 3 };

/**
 * The lowest schema number that can express every entry in `files`.
 *
 * #242 (FORGE-316). The write side used to bump on the fact that a write
 * happened — `manifestChanged ? MAX_PROVENANCE_SCHEMA : manifest.schema` — on
 * the belief that `manifestChanged` meant "a decline was just recorded". It
 * stopped meaning that at #237 (FORGE-305): a CURRENT metadata refresh sets it,
 * and so does every `--rebaseline` row. Neither needs anything schema 1 cannot
 * express, so both migrated a working repository out of the reach of an older
 * checkout for a write that required no new expressiveness — against
 * docs/architecture.md's rule that "the number advances when an entry needs a
 * value the current number cannot express, never because a write happened for
 * some other reason".
 *
 * It reads EVERY entry, not the ones a run touched: a decline standing on a path
 * this run never looked at is exactly as unexpressible under schema 1 as one the
 * run just wrote, and answering from the write set alone would drop the number
 * and brick the manifest on the next read.
 *
 * An unknown ownership refuses here rather than downgrading to 1. Nothing on the
 * write path validates entries — `writeProvenance()` serializes what it is
 * given — so this is the last place that can tell a caller its manifest is
 * unwritable before the bytes land, and refusal precedes mutation (G1).
 */
export function requiredSchema(files) {
  let required = 1;
  for (const [rel, entry] of Object.entries(files)) {
    const needed = SCHEMA_FOR_OWNERSHIP[entry?.ownership];
    if (needed === undefined) {
      throw new Error(
        `refusing to write ${PROVENANCE_FILE}: `
          + `${rel} has an unknown ownership: ${JSON.stringify(entry?.ownership)}`,
      );
    }
    if (needed > required) required = needed;
  }
  return required;
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

/**
 * The digest of bytes that need not be on disk yet.
 *
 * Journalling a write before performing it needs the digest of what is about to
 * land, and reading it back from the path afterwards is the ordering #222
 * (FORGE-293) exists to remove: every operation between the write and the
 * journal push is a window in which the write has landed and nothing records it.
 */
export function digestOf(contents) {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

export function fileDigest(absPath) {
  return digestOf(readFileSync(absPath));
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

/**
 * `opts.create` publishes create-only, through the hard-link branch of the one
 * atomic writer: the manifest appears complete or not at all, and an existing one
 * is never replaced. Scaffolding uses it, because a manifest at a destination the
 * guard just called empty is a rival writer, not a file to overwrite.
 *
 * Synchronization takes the replace branch of the same writer, not a plain
 * writeFileSync. It cannot use create-only -- it rewrites a manifest it read,
 * which is the case that branch exists to refuse -- but "not create-only" was
 * never a reason to publish non-atomically, and the manifest being replaced is
 * the one with concurrent readers and the most to lose from a torn write.
 *
 * `opts.rename` is the atomic writer's own injectable, forwarded rather than
 * reinvented so a refused publication can be exercised without a rival process.
 */
export function writeProvenance(root, provenance, opts = {}) {
  const path = join(root, PROVENANCE_FILE);
  const contents = serializeProvenance(provenance);
  if (opts.create) {
    const refused = writeAtomically(path, contents, { replace: false });
    if (refused) throw new Error(`refusing to scaffold: ${refused}`);
    return path;
  }
  const refused = writeAtomically(path, contents, { replace: true, rename: opts.rename });
  if (refused) throw new Error(`refusing to write ${PROVENANCE_FILE}: ${refused}`);
  return path;
}

/**
 * The exact bytes writeProvenance publishes, without publishing them.
 *
 * Exported so a caller that must journal a manifest write before performing it
 * hashes the same string the writer will land, rather than a second spelling of
 * it that could drift into disagreement one formatting change from now.
 */
export function serializeProvenance(provenance) {
  return `${JSON.stringify(provenance, null, 2)}\n`;
}

export function readProvenance(root) {
  const path = join(root, PROVENANCE_FILE);
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    // A bare `Unexpected token } in JSON at position 41` names no file, and every
    // caller here is holding one path it read and several it did not. A parse
    // failure is the same class of answer validateProvenance() gives for a
    // structurally wrong manifest, and it should read the same way.
    throw new Error(`invalid ${PROVENANCE_FILE} at ${path}: ${error.message}`);
  }
  return validateProvenance(parsed);
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
// ├─ mode: 'appended' HAS a branch now, inside gate 5. `#271 (FORGE-332)`.
// │  The paragraph this replaces said locating the appended segment was
// │  unnecessary "in the only case that could be written safely", which is true
// │  and answers a narrower question than the one an operator has. The case it
// │  left out is the ordinary one: daftplate writes `.gitignore`, the repository
// │  then ignores something of its own, and the whole-file digest stops matching
// │  forever. `--rebaseline` was no exit — it applies only when the bytes already
// │  equal today's candidate, which is exactly when the repository has added
// │  nothing.
// │
// │  So gate 5 asks one more question before refusing, and asks it of the TEXT:
// │  after applying unifiedDiff()'s existing line-ending normalisation, does the
// │  file on disk still contain what daftplate produces for this path today? If
// │  it does, daftplate's content is intact; the remaining byte difference is
// │  line endings, repository content, or both ─────> APPENDED_EXTENDED / REPORT_ONLY
// │  If it does not, the refusal stands and now says which part changed.
// │
// │  No manifest change, and none was needed. A stored digest identifies bytes
// │  but carries neither their length nor their location, so locating a segment
// │  from one alone is undefined without delimiters these files do not have —
// │  any workable version would have to store the boundary or the text itself,
// │  which is a schema bump for a mode whose only user is a 2-4 line
// │  `.gitignore` fragment. Revisit if an appended segment ever needs updating
// │  across template revisions; that needs real delimiters, not a second digest.
// │
// │  `texts` is optional and consulted only here. A caller that does not pass it
// │  gets the old behaviour, which keeps every non-appended call site and every
// │  existing test reading exactly as before.
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
export function classify(prior, candidate, actual, texts = null) {
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
  if (actual !== prior.digest) {
    // `#271 (FORGE-332)`. An appended file is the one managed shape a repository
    // is EXPECTED to add to: daftplate writes `.gitignore` and the repository
    // then ignores things of its own, which is the normal thing for a repository
    // to do to its own `.gitignore`. Under one whole-file digest that made the
    // path REFUSED MODIFIED forever, and `--rebaseline` was no exit — it applies
    // only when the bytes already equal today's candidate, which is exactly the
    // case where the repository has NOT added anything.
    //
    // The question is answered from the text rather than from a stored boundary.
    // `texts.candidate` is what daftplate produces for this path today, composed
    // into the staging tree the caller already has. The split-and-join is the
    // same normalisation unifiedDiff() already uses: line endings are not a
    // content difference an operator can act on there, and treating them as one
    // here would bury the stronger fact that the appended text still survives.
    // Importing a report formatter back into the pure provenance module would
    // reverse the existing dependency, so the deliberately identical operation
    // lives at this decision point instead of creating a second convention.
    //
    // Containment after normalisation proves that daftplate's CONTENT is intact.
    // It does not, on its own, say what accounts for the bytes still differing —
    // and the first draft of this branch stopped there and reported one vague
    // message for every case. That is honest but it is not the most that can be
    // said, and it cost the common case the sentence it had: a repository adding
    // an ignore rule was told "line endings or repository-owned content differ"
    // where it used to be told its own additions were fine.
    //
    // The two are separable with one comparison, so they are separated. Equal
    // after normalisation means the CONTENT is identical and the line endings are
    // the whole difference — nothing was added. Strictly containing means the
    // repository's own lines account for it, which is the ordinary case and the
    // one worth naming. A CRLF re-save that ALSO added lines reports as an
    // addition, which is true; it simply does not also mention the line endings,
    // and no operator action follows from that half.
    //
    // The digest gate above stays byte-exact, which is why both remain
    // REPORT_ONLY and nothing writes.
    if (prior.mode === 'appended' && texts?.candidate && texts?.actual) {
      const asLineText = (text) => text.split(/\r?\n/).join('\n');
      const actualText = asLineText(texts.actual);
      const candidateText = asLineText(texts.candidate);
      if (actualText.includes(candidateText)) {
        return {
          status: 'APPENDED_EXTENDED',
          disposition: 'REPORT_ONLY',
          difference: actualText === candidateText ? 'line-endings' : 'repo-additions',
        };
      }
    }
    // AC 2: which part changed. For an appended path the answer is worth saying,
    // because "MODIFIED" alone reads as "you edited our file" when the common
    // cause is the opposite.
    return {
      status: 'MODIFIED',
      disposition: 'REFUSE',
      ...(prior.mode === 'appended' ? { part: 'appended-segment' } : {}),
    };
  }
  if (candidate.digest === prior.digest) return { status: 'CURRENT', disposition: 'NONE' };
  return { status: 'UPDATE', disposition: 'UPDATE' };
}

/** A managed entry carrying a templateDigest is invalid (validateEntry), so
 *  every adoption has to drop it rather than leave it behind as a fossil of the
 *  ownership the path used to have. */
const withoutTemplateDigest = (entry) => {
  const next = { ...entry };
  delete next.templateDigest;
  return next;
};

/**
 * D11's table as one function: what `--rebaseline` would record for a path, or
 * the reason the truth about it cannot be recorded without writing repository
 * bytes.
 *
 * Deliberately beside classify() and not a branch inside it. classify() answers
 * *what may be done to these bytes* from three digests; this answers *what is
 * measurably true about them*, which is a different question with a different
 * safety argument — and folding the second into the first would put a
 * selector-only transition on the path every ordinary sync already takes.
 *
 * Returns `{ kind, entry }` or `{ refusal }`, never both. `kind` names what the
 * operator gets, because the three are not interchangeable to a person reading
 * the report: `managed` refreshes a baseline in place, `adopted` moves a path
 * into daftplate's ownership, and `diverged` records that the repository owns
 * bytes the manifest had recorded as declined.
 *
 * **Byte convergence is what makes the adopting rows safe.** When the
 * repository's bytes already equal what the template produces, recording
 * daftplate's ownership costs the repository nothing and erases no evidence,
 * because there is no divergence left to erase. Every row where the two still
 * differ refuses — which is the whole of the objection D9 raised against
 * re-baselining divergent entries, and it does not reach this case.
 *
 * Pure, and takes records as data, exactly as classify() does: `rel` is a
 * parameter only because the refusals name the command an operator should have
 * reached for instead, and a refusal that cannot name the path is half a
 * sentence.
 */
export function rebaselineEntry(rel, prior, candidate, actual) {
  const refuse = (why) => ({ refusal: `--rebaseline cannot name ${rel}; ${why}` });
  // Both digests, because "they differ" leaves the operator to work out which
  // side moved, and after a botched sync that is the whole question.
  const differ = `its bytes still differ from today's candidate (on disk ${actual}, `
    + `template ${candidate.digest})`;
  // The production this run measured, carried onto every entry written below for
  // the reason the CURRENT metadata refresh carries it: classify()'s OVERRIDDEN
  // gate reads prior.mode, so a stale layer or mode is a wrong input into a
  // later refusal rather than only a stale line in a file.
  const production = { layer: candidate.layer, mode: candidate.mode };

  if (!prior) {
    return refuse('the manifest holds no provenance for this path, so there is no baseline '
      + `to re-measure; --add=${rel} is what adopts a path daftplate has never recorded`);
  }

  if (prior.ownership === 'declined') {
    if (actual === null) {
      return refuse('the manifest records this path as declined and no file is there, so '
        + `there is nothing to measure; --add=${rel} is what lifts a decline`);
    }
    // R2. The converged half is an ordinary adoption. The unconverged half is
    // the one row in D11 that does NOT require convergence, because `diverged`
    // is exactly what is measurably true of a declined path now holding bytes
    // daftplate did not write — and recording it writes none of them.
    //
    // R2 was taken with its objection in view: this does convert an operator's
    // recorded "no" into an ownership claim of a different kind. The deciding
    // point is that --rebaseline is per-path and the operator must name the
    // path, so the conversion is an explicit act rather than a side effect.
    return actual === candidate.digest
      ? { kind: 'adopted', entry: { ...withoutTemplateDigest(prior), ...production, digest: actual, ownership: 'managed' } }
      : {
        kind: 'diverged',
        entry: {
          ...prior, ...production, digest: actual, templateDigest: candidate.digest, ownership: 'diverged',
        },
      };
  }

  if (actual === null) {
    // --restore is named for a managed path and deliberately not for a divergent
    // one: sync's first preflight refuses a --restore selector on a divergent
    // path outright, so naming it here would send the operator to a command that
    // cannot help them.
    return refuse(prior.ownership === 'managed'
      ? 'the file is absent, and --rebaseline records what is on disk rather than putting '
        + `it there; rerun with --restore=${rel}`
      : 'the file is absent, and a divergent baseline cannot be re-measured against nothing');
  }

  if (actual !== candidate.digest) {
    return refuse(prior.ownership === 'managed'
      ? `${differ}, and recording that difference away would claim daftplate authored bytes it did not write`
      : `${differ}, and adopting it would turn outstanding template drift into "unchanged" `
        + 'without a port or review, which is the silent overwrite in accounting form (D9)');
  }

  return prior.ownership === 'managed'
    ? { kind: 'managed', entry: { ...prior, ...production, digest: actual } }
    : {
      kind: 'adopted',
      entry: { ...withoutTemplateDigest(prior), ...production, digest: actual, ownership: 'managed' },
    };
}
