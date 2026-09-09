#!/usr/bin/env node
// Restates a whole .daftplate.json from corrected composition inputs, for the one
// wrong-baseline state no per-path selector can reach: a repository enrolled with
// the wrong profile or the wrong tokens, where the thing that is wrong is not any
// one baseline but the input every baseline was measured against. A wrong
// PROJECT_SUMMARY makes every token-bearing file read as diverged at once, in a
// manifest that is structurally valid and permanently wrong.
// See D12 and ruling R3 of docs/designs/2026-08-29-plan-sync.md, and D9 of
// docs/designs/2026-08-20-plan-enrolling-an-existing-repo.md.
//
// A THIRD ENTRY POINT, deliberately (R3). Not a flag on enroll-repo.mjs:
// enrollment's one-shot refusal is a safety property with a stated reason, and a
// --re-enroll beside it puts that property behind a branch error. Not a mode of
// sync-standards.mjs either: sync's write loop is about repository bytes, and
// this writes none. The maintenance cost of a third command is accepted
// knowingly. Enrollment's parser, composer, measurement and atomic writer are all
// imported rather than reimplemented; nothing in enroll-repo.mjs is modified.
//
// Usage:
//   node scripts/reconcile-manifest.mjs <templates-root> <target>
//     --profile=<profile>
//     --token=YEAR=<year>
//     --token=PROJECT_NAME=<name>
//     --token=PROJECT_SUMMARY=<summary>
//     [--accept=<path>]... [--write] [--json]
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { scaffold } from './scaffold.mjs';
import { writeAtomically } from './lib/atomic-write.mjs';
import { runCli } from './lib/cli.mjs';
import { parseEnrollArgs, buildEnrollmentProposal } from './enroll-repo.mjs';
import { isWithin, isSafeRelPath } from './sync-standards.mjs';
import { PROVENANCE_FILE, validateProvenance } from './lib/provenance.mjs';

const STAGING_PREFIX = 'daftplate-reconcile-';

const refuse = (detail) => new Error(`refusing to reconcile: ${detail}`);

/**
 * Enrollment's parser plus `--accept`, and nothing else.
 *
 * Delegating rather than restating it is the point: profile required and never
 * inferred, every token explicit, split at the first `=` only because a summary
 * is free text, duplicates refused rather than last-wins. A second parser here
 * would be a second thing to keep correct, and the failure it would produce is a
 * manifest composed from inputs the operator did not give.
 */
export function parseReconcileArgs(argv) {
  const args = argv.slice(2);
  // G5, and the same reasoning as --add-all. The whole of D12's tractability
  // answer is that the report prints the list for you to paste; a bulk flag
  // would make naming each entry not-a-decision, which is what D9 records.
  if (args.includes('--accept-all')) {
    throw new Error('there is no --accept-all: naming each entry is what makes re-baselining it a decision');
  }
  const parsed = parseEnrollArgs(argv);
  return {
    ...parsed,
    accept: args
      .filter((a) => a.startsWith('--accept='))
      .map((a) => a.slice('--accept='.length)),
  };
}

/** The five fields a composition determines, which is exactly what validateEntry
 *  governs and what buildEnrollmentProposal produces. */
const BASELINE_FIELDS = ['digest', 'templateDigest', 'layer', 'mode', 'ownership'];

/**
 * Do two entries say the same thing about provenance?
 *
 * Scoped to the composition-determined fields **on purpose**, and this is not the
 * looser comparison it looks like. A whole-record comparison would be wrong in
 * the one direction that matters: the entries this is checked against are built
 * fresh by buildEnrollmentProposal and carry nothing else, so a property a later
 * daftplate added to a real entry would read as a difference no composition can
 * ever reproduce — making every such entry permanently unrestatable and turning
 * one added field into a command that refuses every repository. Unknown
 * properties are preserved by the merge at the call site instead, which is where
 * preserving them belongs.
 */
const sameBaseline = (a, b) => {
  if (!a || !b) return a === b;
  return BASELINE_FIELDS.every((key) => a[key] === b[key]);
};

/**
 * Restate one manifest from corrected inputs.
 *
 * **The rule, and it is one rule.** An entry may be restated only where the
 * existing manifest is *reproducible from its own recorded inputs* against
 * today's templates and today's tree. Where it reproduces, the whole difference
 * is attributable to the composition inputs the operator is correcting, and
 * restating it is exactly what re-enrollment is for. Where it does not, something
 * other than those inputs put those bytes in the manifest — the template moved
 * upstream, the repository edited the file after enrolling, or somebody hand-
 * edited the manifest — and restating it would erase that. Those refuse, and the
 * report names them so they can be ported by hand.
 *
 * That single rule is D9's two standing prohibitions and nothing more: it never
 * refreshes `templateDigest` after template movement, and it never refreshes
 * `digest` for a repository-edited divergent path. Both fall out of "the old
 * inputs no longer explain what is recorded" rather than being separate special
 * cases that could drift apart.
 *
 * **Every ownership change must be named** by `--accept=<path>` (G5, D9).
 * Unnamed ones refuse the write and are listed. The report always renders,
 * including the paste-ready `--accept=` list, because a refusal thrown before the
 * operator can see that list would make the naming discipline an archaeology
 * exercise — which is the objection D12 answers, not one it accepts.
 *
 * **Declined entries are carried forward verbatim.** A decline is recorded
 * operator intent, not a measurement, and this command measures;
 * buildEnrollmentProposal cannot produce `declined` at all, so an entry left in
 * the comparison would be converted into whatever the measurement said. Paths the
 * new composition does not produce are carried forward for the same reason: no
 * measurement was taken, so there is nothing to restate.
 *
 * It writes exactly one file, and only with `--write`.
 */
export function reconcileManifest(templatesRoot, targetRoot, opts = {}) {
  const {
    profile, tokens, accept = [], write = false, hooks = {},
  } = opts;

  const manifestPath = join(targetRoot, PROVENANCE_FILE);
  if (!existsSync(manifestPath)) {
    throw refuse(
      `${targetRoot} has no ${PROVENANCE_FILE}. This command restates a manifest that `
      + 'already exists; creating the first one is enrollment — use /enroll',
    );
  }
  let existing;
  try {
    existing = validateProvenance(JSON.parse(readFileSync(manifestPath, 'utf8')));
  } catch (error) {
    throw refuse(
      `the existing ${PROVENANCE_FILE} is invalid (${error.message}). Repair it by hand `
      + 'first — a restatement of a manifest nothing can read is a guess',
    );
  }

  // Sync's guard, for sync's reason, on the manifest this command is about to
  // rewrite. validateProvenance() checks entry VALUES and never key safety, so an
  // absolute path, a `..` or an NTFS stream name in a key survives a read — and
  // sync refuses such a manifest outright. Nothing here joins one of these keys
  // to the target, so this is not closing a live traversal in this file; it stops
  // this command from republishing a key it knows the next reader will refuse,
  // which is the one thing a restatement must not do quietly.
  const unsafe = Object.keys(existing.files ?? {}).find((rel) => !isSafeRelPath(rel));
  if (unsafe) {
    throw refuse(
      `unsafe path in ${PROVENANCE_FILE}: ${unsafe}. /sync-standards refuses this manifest `
      + 'outright, so restating it would rewrite a file nothing can use; remove the entry by hand',
    );
  }

  // Sync's and enrollment's guard, for their reason: TMPDIR pointing inside the
  // target would write a full scaffold into the repository being reconciled.
  const tempRoot = resolve(tmpdir());
  if (isWithin(targetRoot, tempRoot)) {
    throw refuse(
      `the OS temp root is inside the target (${tempRoot}); `
      + 'staging would be written into the repository being reconciled',
    );
  }
  const staging = mkdtempSync(join(tempRoot, STAGING_PREFIX));
  try {
    // Two compositions, and the second one is the whole safety argument. Composing
    // from the manifest's OWN recorded profile and tokens is what separates "this
    // baseline is wrong because the input was wrong" from "this baseline records
    // something real that a restatement would erase". Without it the two are
    // indistinguishable, and D9's prohibitions cannot be enforced without also
    // refusing the case this command exists for.
    const composed = scaffold(templatesRoot, profile, join(staging, 'next'), {
      year: tokens.YEAR,
      tokens: { PROJECT_NAME: tokens.PROJECT_NAME, PROJECT_SUMMARY: tokens.PROJECT_SUMMARY },
    });
    const proposal = buildEnrollmentProposal({ composed, targetRoot });

    let recorded = null;
    let recordedFailure = null;
    if (existing.profile && Object.keys(existing.tokens ?? {}).length) {
      try {
        const asRecorded = scaffold(templatesRoot, existing.profile, join(staging, 'recorded'), {
          year: existing.tokens.YEAR,
          tokens: {
            PROJECT_NAME: existing.tokens.PROJECT_NAME,
            PROJECT_SUMMARY: existing.tokens.PROJECT_SUMMARY,
          },
        });
        recorded = buildEnrollmentProposal({ composed: asRecorded, targetRoot });
      } catch (error) {
        // A manifest whose own inputs no longer compose — a profile that was
        // renamed, a token the gate now requires — explains nothing, so every
        // entry it holds is unrestatable. That is reported per entry below rather
        // than thrown here, because the operator still deserves the whole report,
        // and because refusing every entry is the conservative answer either way.
        //
        // The REASON is carried rather than assumed. Reporting every failure here
        // as "the manifest declares no composition inputs" would disguise a
        // genuine defect — an I/O error, a bug in composition — as an input
        // problem, and send whoever debugs it at the manifest instead of at the
        // stack. That is the class of false statement #221 (FORGE-292) was filed
        // about, in a different spelling.
        recordedFailure = error.message;
        recorded = null;
      }
    }

    const unchanged = [];
    const refreshed = [];
    const ownershipChanged = [];
    const carried = [];
    const unexplained = [];
    const files = {};

    const paths = [...new Set([
      ...Object.keys(existing.files ?? {}),
      ...Object.keys(proposal.manifest.files),
    ])].sort();

    for (const rel of paths) {
      const before = existing.files?.[rel] ?? null;
      const after = proposal.manifest.files[rel] ?? null;

      // A decline is intent, not measurement. See the function docstring.
      //
      // Checked BEFORE "the new composition does not produce this path" —
      // #244 (FORGE-318). Both are true of a declined path the template has since
      // dropped, and the outcome is identical either way, so this is message
      // selection rather than correctness. The decline is the more informative of
      // the two: it is a recorded operator decision, where the other is a property
      // of today's template that may change again next release. The template's
      // shape is said as WELL rather than instead, because an operator deciding
      // whether the decline still means anything needs to know the offer is gone.
      if (before?.ownership === 'declined') {
        files[rel] = before;
        carried.push({
          rel,
          why: after
            ? 'the manifest records a standing decline'
            : 'the manifest records a standing decline, and the new composition does not '
              + 'produce this path either',
        });
        continue;
      }

      // Nothing was measured for this path under the new inputs — the template
      // no longer produces it, or the file is absent — so there is nothing to
      // restate and the entry stands as it is. Deleting it here would be this
      // command claiming a path stopped existing, which is not what it measured.
      if (!after) {
        files[rel] = before;
        carried.push({ rel, why: 'the new composition does not produce this path' });
        continue;
      }

      if (!before) {
        // A file exists at a path the new composition produces and the manifest
        // had no record of it: an ownership claim, and G5 says the operator names
        // every one of those.
        ownershipChanged.push({ rel, from: 'none', to: after.ownership });
        // Unnamed, the key is OMITTED — not set to `before`. There was no entry,
        // so `null` is not "leave it as it was": it is an entry
        // validateProvenance() refuses, and it threw out of the call below before
        // the report could render at all. That defeated this function's own
        // guarantee that the operator always sees the paste-ready --accept list,
        // on a dry run as much as on a write, and it did it for the one class of
        // ownership change where they most need it.
        if (accept.includes(rel)) files[rel] = after;
        continue;
      }

      if (sameBaseline(before, after)) {
        unchanged.push(rel);
        files[rel] = before;
        continue;
      }

      // The one rule. `recorded` is the manifest the recorded inputs would
      // produce against today's templates and today's tree; if the existing entry
      // is not that entry, the difference is not the operator's to correct here.
      if (!sameBaseline(before, recorded?.manifest.files[rel] ?? null)) {
        unexplained.push({
          rel,
          why: recorded
            ? 'what the manifest records is not what its own recorded profile and tokens '
              + 'produce today — the template has moved, or the repository has edited this '
              + 'path since enrolling, and restating it would erase that'
            : `the manifest's own recorded profile and tokens do not compose today (${
              recordedFailure ?? 'it declares none'
            }), so nothing can establish what its baselines were measured against`,
        });
        files[rel] = before;
        continue;
      }

      if (before.ownership !== after.ownership) {
        ownershipChanged.push({ rel, from: before.ownership, to: after.ownership });
        files[rel] = accept.includes(rel) ? after : before;
        continue;
      }

      refreshed.push(rel);
      // Merged rather than replaced, so a property a later daftplate added to
      // this entry survives the restatement — the guarantee validateProvenance()
      // states for reads, applied to the one command that rewrites every entry.
      // Safe only because the ownership is unchanged: on an ownership change the
      // measured entry is authoritative and merging would carry a templateDigest
      // into a managed entry, which is invalid.
      files[rel] = { ...before, ...after };
    }

    // A selector that matched nothing refuses the run — #235's lesson, applied to
    // the one selector this command has. An --accept that named a path nothing
    // would change read exactly like one that worked.
    //
    // An unrestatable path is deliberately NOT inert. Naming one is not a typo:
    // the operator is looking at an ownership change this run would otherwise
    // make, and the reason it is not making it is the entry rather than the
    // selector. Refusing here would tell them their selector is wrong and hide
    // the real problem, which the refusal below states in full.
    const inert = accept.find((rel) => !ownershipChanged.some((change) => change.rel === rel)
      && !unexplained.some((entry) => entry.rel === rel));
    if (inert) {
      throw refuse(
        `--accept cannot name ${inert}; this run changes no ownership for that path`,
      );
    }

    // ...and standing aside is not the same as saying nothing — #244 (FORGE-318).
    // Nothing downstream applies `accept` to an unrestatable entry: the one rule
    // takes `before` whatever the selector says. So the operator named a path,
    // got no error and got no acknowledgement, and "I accepted it and the tool
    // said nothing" reads exactly like acceptance. These are named in the report,
    // beside the line that explains why they could not be taken.
    const acceptedUnrestatable = unexplained
      .filter(({ rel }) => accept.includes(rel))
      .map(({ rel }) => rel);

    const unnamed = ownershipChanged
      .filter(({ rel }) => !accept.includes(rel))
      .map(({ rel }) => rel);

    // `existing` first so a top-level key a later daftplate added survives; the
    // proposal then overrides every field this command is restating — profile,
    // tokens, daftplate version, schema — and `files` overrides its own.
    const manifest = validateProvenance({ ...existing, ...proposal.manifest, files });
    const result = {
      profile,
      tokens,
      unchanged,
      refreshed,
      ownershipChanged,
      carried,
      unexplained,
      accepted: [...accept],
      acceptedUnrestatable,
      unnamed,
      manifest,
      written: false,
    };

    if (!write) return result;

    // Refusal precedes mutation (G1), and it is complete: both reasons are
    // collected and reported together, because an operator who has one path to
    // reconcile by hand and three to name wants to learn that once.
    if (unexplained.length || unnamed.length) {
      throw refuse([
        'nothing was written.',
        ...(unexplained.length
          ? ['', `${unexplained.length} entr${unexplained.length === 1 ? 'y' : 'ies'} cannot be restated from these inputs:`,
            ...unexplained.map(({ rel, why }) => `  ${rel} — ${why}`),
            ...(acceptedUnrestatable.length
              ? [`  --accept named ${acceptedUnrestatable.join(', ')}, and this run cannot take `
                + 'it: the entry is the obstacle, not the selector']
              : []),
            '  port these by hand, or resolve them per path with sync-standards --rebaseline=<path>']
          : []),
        ...(unnamed.length
          ? ['', `${unnamed.length} ownership change${unnamed.length === 1 ? '' : 's'} not named by --accept:`,
            ...unnamed.map((rel) => `  ${rel}`),
            '  rerun naming each one:',
            `  ${unnamed.map((rel) => `--accept=${rel}`).join(' ')}`]
          : []),
      ].join('\n'));
    }

    hooks.beforeWrite?.();
    // replace: true, not enrollment's link branch. This replaces a manifest it
    // first read, which is the case the create-only branch exists to refuse.
    const refusal = writeAtomically(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { replace: true },
    );
    if (refusal) throw refuse(refusal);

    return { ...result, written: true };
  } finally {
    // Only ever a directory this process made with mkdtempSync, under the temp
    // root captured at creation rather than tmpdir() read again here.
    if (!staging.startsWith(tempRoot + sep) || !staging.includes(STAGING_PREFIX)) {
      throw new Error(`refusing to remove a staging path outside ${tempRoot}: ${staging}`);
    }
    rmSync(staging, { recursive: true, force: true });
  }
}

const USAGE = 'usage: node scripts/reconcile-manifest.mjs <templates-root> <target> '
  + '--profile=<profile> --token=YEAR=<year> --token=PROJECT_NAME=<name> '
  + '--token=PROJECT_SUMMARY=<summary> [--accept=<path>]... [--write] [--json]';

/**
 * The result as a person reads it.
 *
 * The `--accept` line is printed in full and ready to paste, which is D12's
 * whole answer to the mass case: naming each entry becomes a copy of a line the
 * tool wrote — the operator still sees each path and takes each one on purpose —
 * rather than an archaeology exercise that pushes people back to hand-editing
 * the manifest.
 */
export function renderReconcileText(result) {
  const lines = [`profile: ${result.profile}`];
  for (const [name, value] of Object.entries(result.tokens)) {
    lines.push(`  ${name} = ${JSON.stringify(value)}`);
  }
  lines.push('');

  for (const { rel, from, to } of result.ownershipChanged) {
    lines.push(`OWNERSHIP ${rel} — ${from} → ${to}${result.accepted.includes(rel) ? ' (accepted)' : ''}`);
  }
  for (const rel of result.refreshed) lines.push(`BASELINE ${rel} — re-measured from the corrected inputs`);
  for (const { rel, why } of result.carried) lines.push(`CARRIED ${rel} — ${why}; left exactly as it is`);
  for (const { rel, why } of result.unexplained) {
    // The acknowledgement goes HERE and not in a paragraph of its own: the reason
    // an --accept could not be taken is this line, and separating the two would
    // leave the operator to join them up — #244 (FORGE-318).
    const named = result.acceptedUnrestatable.includes(rel) ? ' (--accept cannot take this)' : '';
    lines.push(`UNRESTATABLE ${rel} — ${why}${named}`);
  }
  lines.push('');

  lines.push(
    `unchanged ${result.unchanged.length}, baseline refreshed ${result.refreshed.length}, `
    + `ownership changed ${result.ownershipChanged.length}, carried ${result.carried.length}, `
    + `unrestatable ${result.unexplained.length}`,
  );

  if (result.unnamed.length) {
    lines.push('');
    lines.push(`${result.unnamed.length} ownership change(s) need naming — paste this back:`);
    lines.push(`  ${result.unnamed.map((rel) => `--accept=${rel}`).join(' ')}`);
  }

  lines.push('');
  lines.push(result.written
    ? `wrote ${PROVENANCE_FILE} — the only file this command changes`
    : `dry run: nothing was written. Rerun with --write to replace ${PROVENANCE_FILE}`);

  return lines;
}

/** The same result for a program, which asked for everything. */
export function toReconcileJson(result) {
  return {
    profile: result.profile,
    tokens: result.tokens,
    unchanged: result.unchanged,
    refreshed: result.refreshed,
    ownershipChanged: result.ownershipChanged,
    carried: result.carried,
    unexplained: result.unexplained,
    accepted: result.accepted,
    acceptedUnrestatable: result.acceptedUnrestatable,
    unnamed: result.unnamed,
    written: result.written,
    manifest: result.manifest,
  };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseReconcileArgs(argv);
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
    result = reconcileManifest(parsed.templatesRoot, parsed.targetRoot, {
      profile: parsed.profile,
      tokens: parsed.tokens,
      accept: parsed.accept,
      write: parsed.write,
    });
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  if (parsed.json) console.log(JSON.stringify(toReconcileJson(result), null, 2));
  else for (const line of renderReconcileText(result)) console.log(line);

  return 0;
}

export { main };
runCli(import.meta.url, main);
