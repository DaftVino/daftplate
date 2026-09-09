#!/usr/bin/env node
// Brings a repository daftplate never scaffolded under management, by measuring
// the real scaffold composition against what the repository already holds and
// recording the result as a new .daftplate.json. See ADR 0003's 2026-08-20
// amendment and docs/designs/2026-08-20-plan-enrolling-an-existing-repo.md.
//
// It is not a synchronization flag. Synchronization consumes an ownership record
// and may update many managed files; enrollment creates that record and may write
// exactly one file. Combining them would put the larger write surface behind one
// branch error.
//
// Usage:
//   node scripts/enroll-repo.mjs <templates-root> <target>
//     --profile=<profile>
//     --token=YEAR=<year>
//     --token=PROJECT_NAME=<name>
//     --token=PROJECT_SUMMARY=<summary>
//     [--write] [--json]
import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { scaffold, SCAFFOLD_INPUT_TOKENS } from './scaffold.mjs';
import { canonical } from './lib/fs.mjs';
import { writeAtomically } from './lib/atomic-write.mjs';
import { runCli } from './lib/cli.mjs';
import { PROVENANCE_FILE, fileDigest, validateProvenance } from './lib/provenance.mjs';
// The synchronization guards, imported rather than reimplemented. They answer two
// different questions -- isSafeRelPath proves a manifest KEY stays inside the
// target, inspectTargetPath proves the FILESYSTEM does -- and a second copy here
// would be a second thing to keep correct.
import { isSafeRelPath, inspectTargetPath, isWithin } from './sync-standards.mjs';

const VENDORED_STANDARDS = 'engineering-standards';

/**
 * Every composition input, stated on the command line and never guessed.
 *
 * The profile is required rather than inferred: there is no manifest to read it
 * from, and inferring it from the tree would make the one irreversible decision
 * enrollment records a guess. Tokens are required for the same reason — a wrong
 * PROJECT_SUMMARY makes every token-bearing file read as diverged, in a manifest
 * that is structurally valid and, under D9, permanently so (#119).
 *
 * Refusals happen here, before composition, so the engine downstream receives a
 * complete deterministic token map. Profile existence and layer collisions stay
 * with the real scaffold() call rather than a parallel composer that could drift.
 */
export function parseEnrollArgs(argv) {
  const args = argv.slice(2);
  const [templatesRoot, targetRoot] = args.filter((a) => !a.startsWith('--'));

  const profile = args
    .filter((a) => a.startsWith('--profile='))
    .map((a) => a.slice('--profile='.length))
    .at(-1);
  if (!profile) throw new Error('--profile is required: enrollment never infers the profile');

  const tokens = {};
  for (const arg of args.filter((a) => a.startsWith('--token='))) {
    const pair = arg.slice('--token='.length);
    // Split at the FIRST '=' only: a summary is free text and routinely contains
    // more of them. Splitting on every '=' silently truncates the value.
    const at = pair.indexOf('=');
    const name = at === -1 ? pair : pair.slice(0, at);
    const value = at === -1 ? '' : pair.slice(at + 1);

    if (!SCAFFOLD_INPUT_TOKENS.includes(name)) {
      throw new Error(`unknown token ${name}: enrollment accepts ${SCAFFOLD_INPUT_TOKENS.join(', ')}`);
    }
    // A duplicate is refused rather than last-wins, because the two values are a
    // contradiction the operator has to resolve; picking one silently records a
    // baseline nobody chose.
    if (name in tokens) throw new Error(`duplicate token ${name}: name each token once`);
    tokens[name] = value;
  }

  const missing = SCAFFOLD_INPUT_TOKENS.filter((name) => !(name in tokens));
  if (missing.length) {
    throw new Error(`missing token(s): ${missing.join(', ')} — every composition input is explicit`);
  }

  return {
    templatesRoot,
    targetRoot,
    profile,
    tokens,
    write: args.includes('--write'),
    json: args.includes('--json'),
  };
}

// Git through an argument array and never a shell: a target path containing a
// space, an ampersand or a quote is one argv entry here and a parsing accident
// under a shell. Every call carries `-C <target>` so nothing depends on the
// directory the command happened to be run from.
const runGit = (execFile, targetRoot, args) => execFile('git', ['-C', targetRoot, ...args]);

const defaultExecFile = (command, args) => execFileSync(command, args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});

const samePath = (a, b) => {
  const [x, y] = [resolve(canonical(a)), resolve(canonical(b))];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

const refuse = (detail) => new Error(`refusing to enroll: ${detail}`);

/**
 * Everything that must hold before a single digest is read (G9: refusal precedes
 * mutation, and measurement is the step after which a refusal starts costing).
 *
 * Returns the Git-visible path list the non-candidate report is bounded from, and
 * whether the tree is dirty. Dirt is reported and never refused: enrollment adds
 * one file, and demanding a clean tree first would block exactly the repositories
 * that need enrolling most.
 *
 * Four refusals:
 *
 *  - **Not the exact Git root.** Below the root, the manifest would sit in a
 *    subdirectory of the repository it claims to describe and every path in it
 *    would be relative to the wrong place. Both sides are canonicalized before
 *    comparison, because git answers in forward slashes and a Windows temp path
 *    can differ in form without differing in identity.
 *  - **A link at the manifest path.** That is the one file enrollment writes.
 *  - **Root-level vendored standards.** ADR 0001 makes engineering-standards
 *    canonical in daftplate and forbids copying it out. Enrolling a repository
 *    whose CLAUDE.md pointer is contradicted by a snapshot sitting beside it
 *    records a relationship that is already false, and the manifest would certify
 *    it. `lstatSync` so a junction or symlink is caught without being followed:
 *    a linked vendored tree is still a vendored tree.
 *  - **A link anywhere in a candidate path.** Those are the paths daftplate would
 *    later write through.
 *
 * A link that is NOT on a candidate path is left alone. Daftplate will never write
 * through it, so it is a name in the report and nothing more; refusing it would
 * block enrollment over the repository's own business.
 */
export function inspectEnrollmentTarget(targetRoot, candidateRels, opts = {}) {
  const execFile = opts.execFile ?? defaultExecFile;

  let toplevel;
  try {
    toplevel = runGit(execFile, targetRoot, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    throw refuse(`${targetRoot} is not the root of a Git work tree`);
  }
  if (!toplevel || !samePath(targetRoot, toplevel)) {
    throw refuse(
      `${targetRoot} is not the root of a Git work tree; its root is ${toplevel}`,
    );
  }

  const manifest = inspectTargetPath(targetRoot, PROVENANCE_FILE);
  if (!manifest.ok) {
    throw refuse(`unsafe link in target path: ${PROVENANCE_FILE}`);
  }

  let vendored = null;
  try {
    vendored = lstatSync(join(targetRoot, VENDORED_STANDARDS));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (vendored) {
    throw refuse(
      `${targetRoot} vendors ${VENDORED_STANDARDS}; standards are canonical in `
      + 'daftplate and are never copied out (ADR 0001). De-vendor it, then enroll',
    );
  }

  for (const rel of candidateRels) {
    if (!isSafeRelPath(rel)) throw refuse(`unsafe path in candidate set: ${rel}`);
    const inspected = inspectTargetPath(targetRoot, rel);
    if (!inspected.ok) {
      throw refuse(
        `unsafe link in candidate path: ${rel} — ${inspected.linkRel} is a `
        + 'symbolic link or junction',
      );
    }
  }

  // --cached --others --exclude-standard is what Git itself considers visible:
  // tracked plus untracked-and-not-ignored. -z because a repository is entitled to
  // a filename with a newline in it, and splitting on one would invent two paths.
  const gitVisible = runGit(execFile, targetRoot, [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z',
  ]).split('\0').filter(Boolean).sort();

  const dirty = runGit(execFile, targetRoot, ['status', '--porcelain']).trim() !== '';

  return { gitVisible, dirty };
}

/**
 * Measure the composed candidate set against what the repository already holds.
 *
 * Three outcomes and deliberately no fourth:
 *
 *   bytes match      -> MATCHED  / MANAGED   daftplate produced these, so it owns them
 *   bytes differ     -> DIVERGED / RECORDED  measured, not owned; both baselines kept
 *   path is absent   -> ABSENT   / UNOWNED   reported, and given no manifest entry
 *
 * An absent candidate gets no entry because inventing one would record provenance
 * for bytes that are not there, and the next sync would read it as a file the
 * repository deleted and offer to restore something it never had.
 *
 * A divergent entry keeps `digest` for the repository file as adopted and
 * `templateDigest` for the candidate as composed right now. Those are the two
 * baselines D6 measures drift against, and neither can be reconstructed later.
 *
 * `snapshot` is the first-pass existence and digest of every candidate, which
 * Task 3.5 re-measures before publishing: a manifest describing a tree that
 * changed underneath the measurement is wrong the moment it is written.
 *
 * Pure apart from reads, and deterministic: candidate keys are walked sorted, so
 * two runs over an unchanged tree return deeply equal proposals. Link safety on
 * candidate paths belongs to inspectEnrollmentTarget() and is not re-checked with
 * something looser here.
 */
export function buildEnrollmentProposal({ composed, targetRoot }) {
  const candidates = composed.provenance.files;
  const adopted = [];
  const diverged = [];
  const absent = [];
  const reports = [];
  const files = {};
  const snapshot = {};

  for (const rel of Object.keys(candidates).sort()) {
    const candidate = candidates[rel];
    const abs = join(targetRoot, rel);
    const exists = existsSync(abs);
    const digest = exists ? fileDigest(abs) : null;
    snapshot[rel] = { exists, digest };

    let status;
    let disposition;
    if (!exists) {
      [status, disposition] = ['ABSENT', 'UNOWNED'];
      absent.push({ rel, status, disposition });
    } else if (digest === candidate.digest) {
      [status, disposition] = ['MATCHED', 'MANAGED'];
      adopted.push({ rel, status, disposition });
      files[rel] = { ...candidate };
    } else {
      [status, disposition] = ['DIVERGED', 'RECORDED'];
      diverged.push({ rel, status, disposition });
      files[rel] = {
        digest,
        templateDigest: candidate.digest,
        layer: candidate.layer,
        mode: candidate.mode,
        ownership: 'diverged',
      };
    }
    reports.push({ rel, status, disposition });
  }

  // Validated here rather than trusted: the manifest enrollment proposes must
  // pass the same gate synchronization reads it through, and finding out at the
  // next sync instead is finding out in the wrong repository.
  const manifest = validateProvenance({ ...composed.provenance, files });

  return { manifest, adopted, diverged, absent, reports, snapshot };
}

/** Text output shows at most this many example paths. A repository can hold
 *  thousands of files daftplate does not manage, and a report that prints all of
 *  them is a report nobody reads — G10. */
export const NON_CANDIDATE_EXAMPLES = 20;

/**
 * What the repository holds that enrollment will not manage, aggregated from the
 * names Git already listed. Nothing here traverses the target or opens a file, so
 * a non-candidate symlink stays a name and is never followed.
 *
 * The count and the first-component grouping are always complete — the operator
 * learns the true size of the unmanaged surface even when the examples are
 * truncated, which is the difference between a bounded report and a misleading
 * one. Grouping by first path component is what makes 900 files legible as
 * "src 812, docs 74, scripts 14".
 *
 * The full list appears only under `json: true`. Text is for a person reading a
 * terminal; JSON is for a program that asked for everything.
 */
export function summarizeNonCandidates(gitVisible, candidateRels, opts = {}) {
  const candidates = new Set(candidateRels);
  const paths = gitVisible.filter((rel) => !candidates.has(rel)).sort();

  const byFirstComponent = {};
  for (const rel of paths) {
    const head = rel.split('/')[0];
    byFirstComponent[head] = (byFirstComponent[head] ?? 0) + 1;
  }

  const summary = {
    total: paths.length,
    byFirstComponent,
    examples: paths.slice(0, NON_CANDIDATE_EXAMPLES),
  };
  return opts.json ? { ...summary, paths } : summary;
}

const STAGING_PREFIX = 'daftplate-enroll-';

// Only ever called on a directory this process made with mkdtempSync, under the
// temp root CAPTURED AT CREATION — not tmpdir() read again here, which is what
// this used to do. Reading it again lets an environment change between staging and
// cleanup turn a legitimate removal into a refusal, or validate a path against a
// root that no longer holds it. Guarded rather than assumed because CLAUDE.md #5
// makes "nothing deletes what it did not create" absolute, and a recursive delete
// is the one operation where being wrong is unrecoverable.
function removeStaging(staging, root) {
  if (!staging.startsWith(root + sep) || !staging.includes(STAGING_PREFIX)) {
    throw new Error(`refusing to remove a staging path outside ${root}: ${staging}`);
  }
  rmSync(staging, { recursive: true, force: true });
}

/**
 * Enroll one repository: compose, preflight, measure twice, publish once.
 *
 * The order is the design. Nothing is composed until the one-shot refusal has
 * passed, nothing is measured until the boundary checks have passed, and nothing
 * is published until the second measurement agrees with the first (G9: refusal
 * precedes mutation).
 *
 * **One-shot (D9).** Any existing `.daftplate.json` refuses, at the same daftplate
 * version and at a later one. A valid manifest and an unparseable one get
 * different messages and identical treatment: neither is replaced. Re-measuring
 * would supply facts but not the authority to overwrite baselines, and repeating
 * the command until warnings disappear is precisely the silent-acceptance
 * mechanism provenance exists to prevent. Correcting a manifest enrolled with
 * wrong inputs needs the reconciliation path recorded in issue #119.
 *
 * **Measured twice.** A manifest describing a tree that moved underneath the
 * measurement is wrong the moment it is written, and it would be wrong in the
 * file that decides what daftplate may overwrite later. The two passes bracket
 * the composition, and any difference in existence or digest refuses the run.
 *
 * **Published, not written.** The manifest goes through the create-only branch of
 * the shared atomic writer, which publishes by hard link and refuses on EEXIST.
 * The existence check just below `beforeInstall` is a cheap early refusal with a
 * better message; it is NOT the guarantee. A rival landing after that check still
 * loses, because the kernel refuses the link — which is the whole reason
 * publication is not a checked rename.
 *
 * The only file this function may create in the target is `.daftplate.json` (G5).
 */
export function enrollRepo(templatesRoot, targetRoot, opts = {}) {
  const {
    profile, tokens, write = false, json = false, hooks = {}, link, execFile,
  } = opts;

  const manifestPath = join(targetRoot, PROVENANCE_FILE);
  if (existsSync(manifestPath)) {
    let existing;
    try {
      existing = validateProvenance(JSON.parse(readFileSync(manifestPath, 'utf8')));
    } catch (error) {
      throw refuse(
        `the existing ${PROVENANCE_FILE} is invalid (${error.message}). It is still not `
        + 'daftplate\'s to replace — repair or remove it by hand, then enroll',
      );
    }
    throw refuse(
      `${targetRoot} already has ${PROVENANCE_FILE}, written by daftplate `
      + `${existing.daftplate}. Enrollment is one-shot; use /sync-standards`,
    );
  }

  // Captured once, before staging exists, and used for both creation and the
  // cleanup guard — sync's shape, for sync's reason. Enrollment never had this
  // check: TMPDIR=<target> wrote a full scaffold, second .daftplate.json included,
  // into the repository being enrolled. It also corrupted the report without
  // needing to be interrupted, because inspectEnrollmentTarget runs after
  // composition and its `git ls-files --others` then saw the staging tree and
  // counted daftplate's own scaffold as files the repository owns. This closes
  // that too, with no reordering: staging can no longer be inside the target.
  const tempRoot = resolve(tmpdir());
  if (isWithin(targetRoot, tempRoot)) {
    throw refuse(
      `the OS temp root is inside the target (${tempRoot}); `
      + 'staging would be written into the repository being enrolled',
    );
  }
  const staging = mkdtempSync(join(tempRoot, STAGING_PREFIX));
  try {
    // The real scaffold, never a relaxed composer for existing repositories (D4).
    // Reimplementing its four steps would drift, and drift here means every
    // token-bearing file reads as diverged forever. Two side effects on the
    // staging tree are ignored: it writes a .daftplate.json there (never read) and
    // runs verifyRepo over it (meaningless for a throwaway composition).
    const composed = scaffold(templatesRoot, profile, staging, {
      year: tokens.YEAR,
      tokens: {
        PROJECT_NAME: tokens.PROJECT_NAME,
        PROJECT_SUMMARY: tokens.PROJECT_SUMMARY,
      },
    });
    const candidateRels = Object.keys(composed.provenance.files);

    const { gitVisible, dirty } = inspectEnrollmentTarget(targetRoot, candidateRels, { execFile });

    const proposal = buildEnrollmentProposal({ composed, targetRoot });
    hooks.beforeStabilityCheck?.();
    const recheck = buildEnrollmentProposal({ composed, targetRoot });
    if (JSON.stringify(recheck.snapshot) !== JSON.stringify(proposal.snapshot)) {
      throw refuse('the target changed during measurement; rerun enrollment');
    }

    const unmanaged = summarizeNonCandidates(gitVisible, candidateRels, { json });

    let written = false;
    if (write) {
      hooks.beforeInstall?.();
      if (existsSync(manifestPath)) {
        throw refuse(`${PROVENANCE_FILE} appeared during enrollment; it was left untouched`);
      }

      const refusal = writeAtomically(
        manifestPath,
        `${JSON.stringify(proposal.manifest, null, 2)}\n`,
        { replace: false, link },
      );
      if (refusal) {
        // Which refusal it was is answered by the filesystem rather than by
        // matching on the message: if a manifest is there now, someone published
        // one and it is not ours to touch; if there is none, publication itself
        // failed and the reason travels up verbatim.
        throw refuse(existsSync(manifestPath)
          ? `${PROVENANCE_FILE} appeared during enrollment; it was left untouched`
          : refusal);
      }
      written = true;
    }

    return {
      profile,
      tokens,
      candidateCount: candidateRels.length,
      adopted: proposal.adopted,
      diverged: proposal.diverged,
      absent: proposal.absent,
      unmanaged,
      dirty,
      manifest: proposal.manifest,
      written,
      reports: proposal.reports,
    };
  } finally {
    removeStaging(staging, tempRoot);
  }
}

const USAGE = 'usage: node scripts/enroll-repo.mjs <templates-root> <target> '
  + '--profile=<profile> --token=YEAR=<year> --token=PROJECT_NAME=<name> '
  + '--token=PROJECT_SUMMARY=<summary> [--write] [--json]';

/**
 * The result as a person reads it.
 *
 * Token values are JSON-escaped rather than printed bare: PROJECT_NAME=a=b and a
 * summary containing a quote are exactly the inputs an operator needs to see
 * echoed unambiguously, because a wrong one produces a manifest that is
 * structurally valid and, under D9, permanent.
 *
 * The unmanaged section states the total and the grouping in full and shows at
 * most twenty examples (G10). It also says outright that those paths were neither
 * recorded nor touched — a list of a repository's own files printed by a tool
 * that just wrote provenance invites exactly the wrong inference.
 */
export function renderEnrollmentText(result) {
  const lines = [];
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  lines.push(`profile: ${result.profile}`);
  for (const name of SCAFFOLD_INPUT_TOKENS) {
    lines.push(`  ${name} = ${JSON.stringify(result.tokens?.[name] ?? null)}`);
  }
  lines.push('');

  for (const { rel, status, disposition } of result.reports ?? []) {
    lines.push(`${status} ${rel} — ${disposition.toLowerCase()}`);
  }
  if (result.reports?.length) lines.push('');

  lines.push(
    `${plural(result.candidateCount, 'candidate')}: `
    + `matched ${result.adopted.length}, `
    + `diverged ${result.diverged.length}, `
    + `absent ${result.absent.length}`,
  );

  const { unmanaged } = result;
  if (unmanaged.total) {
    const grouped = Object.entries(unmanaged.byFirstComponent)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([head, count]) => `${head} ${count}`)
      .join(', ');
    lines.push(
      `${plural(unmanaged.total, 'other Git-visible path')} daftplate does not manage `
      + `(${grouped}) — neither recorded nor touched`,
    );
    for (const rel of unmanaged.examples) lines.push(`  ${rel}`);
    if (unmanaged.total > unmanaged.examples.length) {
      lines.push(`  … and ${unmanaged.total - unmanaged.examples.length} more; --json lists them all`);
    }
  }

  if (result.dirty) {
    lines.push('');
    lines.push(
      'the target has uncommitted changes — dirty is allowed, but the manifest '
      + 'records the bytes as they are right now',
    );
  }

  lines.push('');
  lines.push(result.written
    ? `wrote ${PROVENANCE_FILE} — the only file enrollment created`
    : `dry run: nothing was written. Rerun with --write to create ${PROVENANCE_FILE}`);

  return lines;
}

/** The same result for a program, which asked for everything: the complete
 *  unmanaged path list rather than the twenty-example bound, and the manifest
 *  exactly as it would be written. */
export function toEnrollmentJson(result) {
  return {
    profile: result.profile,
    tokens: result.tokens,
    candidateCount: result.candidateCount,
    adopted: result.adopted,
    diverged: result.diverged,
    absent: result.absent,
    unmanaged: result.unmanaged,
    dirty: result.dirty,
    written: result.written,
    manifest: result.manifest,
  };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseEnrollArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    return 2;
  }
  if (!parsed.templatesRoot || !parsed.targetRoot) {
    console.error(USAGE);
    return 2;
  }

  let result;
  try {
    result = enrollRepo(parsed.templatesRoot, parsed.targetRoot, {
      profile: parsed.profile,
      tokens: parsed.tokens,
      write: parsed.write,
      json: parsed.json,
    });
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  if (parsed.json) console.log(JSON.stringify(toEnrollmentJson(result), null, 2));
  else for (const line of renderEnrollmentText(result)) console.log(line);

  return 0;
}

export { main };
runCli(import.meta.url, main);
