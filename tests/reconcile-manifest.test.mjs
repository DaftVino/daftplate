import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDir } from './helpers/make-repo.mjs';
import { walkFiles } from '../scripts/lib/fs.mjs';
import { scaffold } from '../scripts/scaffold.mjs';
import { enrollRepo } from '../scripts/enroll-repo.mjs';
import { syncStandards } from '../scripts/sync-standards.mjs';
import {
  PROVENANCE_FILE, fileDigest, readProvenance, validateProvenance,
} from '../scripts/lib/provenance.mjs';
import {
  reconcileManifest, parseReconcileArgs, renderReconcileText, toReconcileJson,
} from '../scripts/reconcile-manifest.mjs';

// ---------------------------------------------------------------------------
// #119 (FORGE-201) Phase 8 -- --re-enroll, the full-manifest restatement
// ---------------------------------------------------------------------------

const TEMPLATES = fileURLToPath(new URL('..', import.meta.url));
const RIGHT = {
  YEAR: '2026',
  PROJECT_NAME: 'existing-repo',
  PROJECT_SUMMARY: 'Existing repository fixture.',
};
const WRONG = { ...RIGHT, PROJECT_SUMMARY: 'A summary nobody meant to type.' };

/** Every repository byte except the manifest itself and Git's own bookkeeping.
 *  The manifest is the one file this command is allowed to change, so leaving it
 *  in would make the comparison assert nothing. */
const contentOf = (root) => walkFiles(root)
  .filter(({ isDir, rel }) => !isDir && rel !== PROVENANCE_FILE && !rel.startsWith('.git/'))
  .map(({ rel }) => [rel, fileDigest(join(root, rel))]);

/** Wrong-baseline state (a): a repository enrolled with a `PROJECT_SUMMARY`
 *  nobody meant, so every token-bearing file reads as diverged in a manifest
 *  that is structurally valid and, under D9, permanently wrong. Nothing about
 *  the repository is wrong; the composition input was. */
const makeMisenrolledRepository = () => {
  const target = emptyDir();
  scaffold(TEMPLATES, 'web-app', target, { year: 2026, tokens: RIGHT });
  unlinkSync(join(target, PROVENANCE_FILE));
  execFileSync('git', ['init', target], { stdio: 'ignore' });

  const enrolled = enrollRepo(TEMPLATES, target, {
    profile: 'web-app', tokens: WRONG, write: true,
  });
  assert.ok(enrolled.diverged.length > 0, 'the fixture must actually produce divergence');

  return { target, spurious: enrolled.diverged.map(({ rel: r }) => r) };
};

const opts = (extra = {}) => ({ profile: 'web-app', tokens: RIGHT, ...extra });

test('re-enrollment with corrected tokens turns mass spurious divergence into managed entries', () => {
  const fixture = makeMisenrolledRepository();
  const before = contentOf(fixture.target);
  for (const r of fixture.spurious) {
    assert.equal(readProvenance(fixture.target).files[r].ownership, 'diverged');
  }

  const result = reconcileManifest(TEMPLATES, fixture.target, opts({
    accept: fixture.spurious, write: true,
  }));

  assert.equal(result.written, true);
  const manifest = readProvenance(fixture.target);
  for (const r of fixture.spurious) {
    const entry = manifest.files[r];
    assert.equal(entry.ownership, 'managed');
    assert.equal(entry.digest, fileDigest(join(fixture.target, r)));
    assert.equal('templateDigest' in entry, false);
  }
  assert.equal(manifest.tokens.PROJECT_SUMMARY, RIGHT.PROJECT_SUMMARY);
  // Not one repository byte. This writes the manifest and nothing else.
  assert.deepEqual(contentOf(fixture.target), before);

  // The exit is real only if the next sync agrees, so the round trip is
  // asserted rather than inferred from the write having succeeded.
  const after = syncStandards(TEMPLATES, fixture.target, { dryRun: true });
  for (const r of fixture.spurious) {
    assert.equal(after.reports.find((report) => report.rel === r).status, 'CURRENT');
  }
});

test('an ownership change that was not named refuses the write and lists what it would change', () => {
  // G5 and D9. Naming each entry is what makes adopting it a decision, and the
  // refusal has to name the paths or the operator cannot act on it.
  const fixture = makeMisenrolledRepository();
  const manifestBefore = readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8');

  assert.throws(
    () => reconcileManifest(TEMPLATES, fixture.target, opts({ write: true })),
    (error) => {
      assert.match(error.message, /ownership change/i);
      for (const r of fixture.spurious) assert.equal(error.message.includes(r), true);
      return true;
    },
  );

  assert.equal(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'), manifestBefore);
});

test('naming some but not all of the ownership changes still refuses, and names only the rest', () => {
  // The partial case, which is the one an operator actually reaches: a pasted
  // list with a line missing must not write the ones that were named.
  const fixture = makeMisenrolledRepository();
  assert.ok(fixture.spurious.length > 1, 'this test needs more than one spurious divergence');
  const [named, ...rest] = fixture.spurious;
  const manifestBefore = readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8');

  assert.throws(
    () => reconcileManifest(TEMPLATES, fixture.target, opts({ accept: [named], write: true })),
    (error) => {
      for (const r of rest) assert.equal(error.message.includes(r), true);
      return true;
    },
  );

  assert.equal(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'), manifestBefore);
});

test('the report prints a paste-ready --accept line for every entry it would change', () => {
  // D12's tractability argument: naming each entry becomes a copy of a line the
  // tool wrote, rather than an archaeology exercise that pushes people back to
  // hand-editing the manifest.
  const fixture = makeMisenrolledRepository();

  const result = reconcileManifest(TEMPLATES, fixture.target, opts());
  const text = renderReconcileText(result).join('\n');

  for (const r of fixture.spurious) assert.match(text, new RegExp(`--accept=${r.replace(/\./g, '\\.')}`));
  // And the pasted line has to actually work.
  const pasted = text.match(/--accept=\S+/g).map((flag) => flag.slice('--accept='.length));
  const applied = reconcileManifest(TEMPLATES, fixture.target, opts({ accept: pasted, write: true }));
  assert.equal(applied.written, true);
});

test('re-enrollment refuses to restate a divergent path whose template moved', () => {
  // D9's standing prohibition, which this command does not relax. The recorded
  // templateDigest is evidence that a fix moved upstream; restating it away is
  // the silent-acceptance mechanism provenance exists to prevent.
  const fixture = makeMisenrolledRepository();
  const rel1 = fixture.spurious[0];
  // The template moves under the repository: the recorded templateDigest is now
  // reproducible from neither the old inputs nor the new ones.
  const manifest = JSON.parse(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'));
  manifest.files[rel1].templateDigest = `sha256:${'1'.repeat(64)}`;
  writeFileSync(join(fixture.target, PROVENANCE_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const manifestBefore = readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8');

  assert.throws(
    () => reconcileManifest(TEMPLATES, fixture.target, opts({
      accept: fixture.spurious, write: true,
    })),
    (error) => {
      assert.match(error.message, /cannot be restated/i);
      assert.equal(error.message.includes(rel1), true);
      return true;
    },
  );

  assert.equal(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'), manifestBefore);
});

test('re-enrollment refuses to restate a path the repository edited since enrollment', () => {
  // The other half of D9: `digest` on a divergent entry is the repository file
  // as adopted, and a repository edit since then is not explained by correcting
  // a composition input.
  const fixture = makeMisenrolledRepository();
  const rel1 = fixture.spurious[0];
  writeFileSync(join(fixture.target, rel1), '# the repository edited this after enrolling\n', 'utf8');
  const manifestBefore = readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8');

  assert.throws(
    () => reconcileManifest(TEMPLATES, fixture.target, opts({
      accept: fixture.spurious, write: true,
    })),
    (error) => {
      assert.match(error.message, /cannot be restated/i);
      assert.equal(error.message.includes(rel1), true);
      return true;
    },
  );

  // Its siblings all assert this and this one did not: a message is not evidence
  // about what would have been written.
  assert.equal(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'), manifestBefore);
});

test('re-enrollment without --write writes nothing', () => {
  const fixture = makeMisenrolledRepository();
  const before = readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8');

  const result = reconcileManifest(TEMPLATES, fixture.target, opts({ accept: fixture.spurious }));

  assert.equal(result.written, false);
  assert.equal(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'), before);
  // A report run is complete, not partial: it measured everything it would record.
  assert.equal(result.ownershipChanged.length, fixture.spurious.length);
});

test('the manifest a report run returns holds only the changes that were named', () => {
  // `manifest` is output, not scratch: --json prints it, and it is documented as
  // the manifest exactly as it would be written. A report run that showed
  // unaccepted ownership changes in it would be describing a write that is not
  // going to happen.
  //
  // This is the only place the accept gate on the entry itself is observable.
  // On the --write path the run refuses before publishing, so a mutant that
  // takes the new entry regardless of --accept changes nothing there and
  // survives; it dies here.
  const fixture = makeMisenrolledRepository();
  assert.ok(fixture.spurious.length > 1);
  const [named, ...rest] = fixture.spurious;

  const result = reconcileManifest(TEMPLATES, fixture.target, opts({ accept: [named] }));

  const existing = readProvenance(fixture.target);
  assert.equal(result.manifest.files[named].ownership, 'managed');
  for (const r of rest) {
    assert.equal(result.manifest.files[r].ownership, 'diverged');
    assert.deepEqual(result.manifest.files[r], existing.files[r]);
  }
});

test('re-enrollment refuses a target with no manifest and points at enrollment', () => {
  // The inverse of enrollment's one-shot refusal, and the pair that keeps the
  // two commands from being interchangeable.
  const target = emptyDir();
  scaffold(TEMPLATES, 'web-app', target, { year: 2026, tokens: RIGHT });
  unlinkSync(join(target, PROVENANCE_FILE));

  assert.throws(
    () => reconcileManifest(TEMPLATES, target, opts()),
    /has no \.daftplate\.json.*enroll/is,
  );
});

test('enrollRepo still refuses every existing manifest', () => {
  // The guard this phase sits next to and did not weaken. Enrollment's one-shot
  // refusal is a safety property with a stated reason, which is exactly why the
  // reconciliation path is a third script rather than a flag beside it (R3).
  const fixture = makeMisenrolledRepository();

  assert.throws(
    () => enrollRepo(TEMPLATES, fixture.target, { profile: 'web-app', tokens: RIGHT, write: true }),
    /already has \.daftplate\.json.*one-shot/is,
  );

  const invalid = makeMisenrolledRepository();
  writeFileSync(join(invalid.target, PROVENANCE_FILE), '{ not json', 'utf8');
  assert.throws(
    () => enrollRepo(TEMPLATES, invalid.target, { profile: 'web-app', tokens: RIGHT, write: true }),
    /is invalid.*not daftplate's to replace/is,
  );
});

test('a declined entry is carried forward verbatim and never restated', () => {
  // A decline is recorded operator intent, not a measurement, and this command
  // measures. buildEnrollmentProposal cannot produce `declined` at all, so an
  // entry left in the comparison would be silently converted into whatever the
  // measurement said.
  const fixture = makeMisenrolledRepository();
  const manifest = JSON.parse(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'));
  const declinedRel = 'SECURITY.md';
  const baseline = manifest.files[declinedRel] ?? manifest.files[Object.keys(manifest.files)[0]];
  const chosen = manifest.files[declinedRel] ? declinedRel : Object.keys(manifest.files)[0];
  manifest.files[chosen] = {
    digest: baseline.digest,
    templateDigest: baseline.templateDigest ?? baseline.digest,
    layer: baseline.layer,
    mode: baseline.mode,
    ownership: 'declined',
  };
  writeFileSync(join(fixture.target, PROVENANCE_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const declinedBefore = readProvenance(fixture.target).files[chosen];

  const accept = fixture.spurious.filter((r) => r !== chosen);
  const result = reconcileManifest(TEMPLATES, fixture.target, opts({ accept, write: true }));

  assert.deepEqual(readProvenance(fixture.target).files[chosen], declinedBefore);
  assert.equal(result.carried.some(({ rel: r }) => r === chosen), true);
});

test('an entry for a path the new composition does not produce is carried forward verbatim', () => {
  const fixture = makeMisenrolledRepository();
  const manifest = JSON.parse(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'));
  manifest.files['docs/gone-upstream.md'] = {
    digest: `sha256:${'2'.repeat(64)}`, layer: 'base', mode: 'copied', ownership: 'managed',
  };
  writeFileSync(join(fixture.target, PROVENANCE_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const result = reconcileManifest(TEMPLATES, fixture.target, opts({
    accept: fixture.spurious, write: true,
  }));

  const after = readProvenance(fixture.target).files['docs/gone-upstream.md'];
  assert.equal(after.digest, `sha256:${'2'.repeat(64)}`);
  assert.equal(result.carried.some(({ rel: r }) => r === 'docs/gone-upstream.md'), true);
});

test('the restated manifest passes the gate every read goes through', () => {
  const fixture = makeMisenrolledRepository();

  const result = reconcileManifest(TEMPLATES, fixture.target, opts({
    accept: fixture.spurious, write: true,
  }));

  assert.doesNotThrow(() => validateProvenance(result.manifest));
  const onDisk = JSON.parse(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'));
  assert.doesNotThrow(() => validateProvenance(onDisk));
  assert.equal(onDisk.profile, 'web-app');
});

test('a restatement preserves properties a later daftplate added, top-level and per-entry', () => {
  // validateProvenance() states the guarantee for reads: "Unknown properties
  // survive under a known schema, so a field a later daftplate adds is preserved
  // rather than silently dropped by a round trip." This is the one command that
  // rewrites every entry, so it is the one most able to break that.
  const fixture = makeMisenrolledRepository();
  const manifest = JSON.parse(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'));
  const refreshed = Object.keys(manifest.files)
    .find((r) => manifest.files[r].ownership !== 'diverged');
  manifest.futureTopLevel = 'a key this daftplate has never heard of';
  manifest.files[refreshed].futureEntryKey = 'likewise';
  writeFileSync(join(fixture.target, PROVENANCE_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const result = reconcileManifest(TEMPLATES, fixture.target, opts({
    accept: fixture.spurious, write: true,
  }));

  const after = JSON.parse(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'));
  assert.equal(after.futureTopLevel, 'a key this daftplate has never heard of');
  assert.equal(after.files[refreshed].futureEntryKey, 'likewise');
  // The fields the restatement is actually for still move.
  assert.equal(after.tokens.PROJECT_SUMMARY, RIGHT.PROJECT_SUMMARY);
  assert.equal(result.written, true);
});

test('an ownership change takes the measured entry whole, dropping the baseline it no longer has', () => {
  // The limit of the merge above, and why it is scoped to same-ownership rows: a
  // divergent entry carries `templateDigest` and a managed one may not, so
  // merging on an adoption would write an entry validateProvenance() refuses.
  const fixture = makeMisenrolledRepository();

  reconcileManifest(TEMPLATES, fixture.target, opts({ accept: fixture.spurious, write: true }));

  for (const r of fixture.spurious) {
    const entry = readProvenance(fixture.target).files[r];
    assert.equal(entry.ownership, 'managed');
    assert.equal('templateDigest' in entry, false);
  }
});

test('parseReconcileArgs demands every composition input and collects --accept', () => {
  const argv = ['node', 'reconcile', 'templates', 'target', '--profile=web-app',
    '--token=YEAR=2026', '--token=PROJECT_NAME=n', '--token=PROJECT_SUMMARY=a=b',
    '--accept=README.md', '--accept=CLAUDE.md', '--write'];

  const parsed = parseReconcileArgs(argv);

  assert.equal(parsed.profile, 'web-app');
  // Split at the FIRST '=' only, exactly as enrollment does: a summary is free
  // text and routinely contains more of them.
  assert.equal(parsed.tokens.PROJECT_SUMMARY, 'a=b');
  assert.deepEqual(parsed.accept, ['README.md', 'CLAUDE.md']);
  assert.equal(parsed.write, true);

  assert.throws(
    () => parseReconcileArgs(['node', 'reconcile', 't', 'x', '--token=YEAR=2026']),
    /--profile is required/,
  );
  assert.throws(
    () => parseReconcileArgs(['node', 'reconcile', 't', 'x', '--profile=web-app']),
    /missing token/,
  );
});

test('there is no --accept-all', () => {
  // The whole of D12's naming discipline, and the same reasoning as --add-all.
  assert.throws(
    () => parseReconcileArgs(['node', 'reconcile', 't', 'x', '--profile=web-app',
      '--token=YEAR=2026', '--token=PROJECT_NAME=n', '--token=PROJECT_SUMMARY=s', '--accept-all']),
    /no --accept-all/,
  );
});

test('an --accept naming a path with no ownership change refuses rather than passing silently', () => {
  // The lesson #235 taught the sync selectors: a selector that matched nothing
  // read exactly like one that matched, and the operator believed a typo had
  // worked.
  const fixture = makeMisenrolledRepository();

  assert.throws(
    () => reconcileManifest(TEMPLATES, fixture.target, opts({
      accept: [...fixture.spurious, 'docs/not-a-path.md'], write: true,
    })),
    /--accept cannot name docs\/not-a-path\.md/,
  );
});

test('a path the manifest never recorded is an ownership claim, and the report still renders', () => {
  // The `before === null` row: the composition produces a path, a file is already
  // at it, and the manifest has no entry. Unnamed, the key must be OMITTED from
  // the restatement -- carrying `null` forward is not "leave it as it was", it is
  // an entry validateProvenance() refuses, and it threw out of the whole call
  // before the report could render. On a dry run, which writes nothing, and for
  // the one class of ownership change where the operator most needs the list.
  const fixture = makeMisenrolledRepository();
  const manifest = JSON.parse(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'));
  const orphan = Object.keys(manifest.files).find((r) => !fixture.spurious.includes(r));
  delete manifest.files[orphan];
  writeFileSync(join(fixture.target, PROVENANCE_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const result = reconcileManifest(TEMPLATES, fixture.target, opts());

  assert.equal(result.ownershipChanged.some(({ rel: r, from }) => r === orphan && from === 'none'), true);
  assert.equal(orphan in result.manifest.files, false);
  assert.doesNotThrow(() => validateProvenance(result.manifest));
  // And the operator gets the line they need, rather than a schema error.
  assert.match(renderReconcileText(result).join('\n'), new RegExp(`--accept=${orphan.replace(/[.\\/]/g, '\\$&')}`));
});

test('naming that path adopts it, and the entry is a real one', () => {
  const fixture = makeMisenrolledRepository();
  const manifest = JSON.parse(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'));
  const orphan = Object.keys(manifest.files).find((r) => !fixture.spurious.includes(r));
  delete manifest.files[orphan];
  writeFileSync(join(fixture.target, PROVENANCE_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  reconcileManifest(TEMPLATES, fixture.target, opts({
    accept: [...fixture.spurious, orphan], write: true,
  }));

  const entry = readProvenance(fixture.target).files[orphan];
  assert.equal(entry.ownership, 'managed');
  assert.equal(entry.digest, fileDigest(join(fixture.target, orphan)));
});

test('an unrestatable entry names why the recorded inputs failed, not a guess', () => {
  // The bare catch around the second composition used to report every failure as
  // "declares no composition inputs", which would send whoever debugs a genuine
  // defect at the manifest instead of at the stack.
  const fixture = makeMisenrolledRepository();
  const manifest = JSON.parse(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'));
  manifest.profile = 'a-profile-that-was-renamed';
  writeFileSync(join(fixture.target, PROVENANCE_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const result = reconcileManifest(TEMPLATES, fixture.target, opts());

  assert.ok(result.unexplained.length > 0);
  for (const { why } of result.unexplained) {
    assert.match(why, /do not compose today/);
    // The real reason, carried from the error rather than assumed.
    assert.match(why, /unknown profile type: a-profile-that-was-renamed/);
  }
});

test('a manifest carrying an unsafe key refuses rather than being republished', () => {
  // /sync-standards refuses such a manifest outright, so restating it would
  // rewrite a file nothing can use. validateProvenance checks entry values and
  // never key safety, so nothing else catches it.
  const fixture = makeMisenrolledRepository();
  const manifest = JSON.parse(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'));
  manifest.files['../escaped.md'] = {
    digest: `sha256:${'3'.repeat(64)}`, layer: 'base', mode: 'copied', ownership: 'managed',
  };
  writeFileSync(join(fixture.target, PROVENANCE_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const before = readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8');

  assert.throws(
    () => reconcileManifest(TEMPLATES, fixture.target, opts({ accept: fixture.spurious, write: true })),
    /unsafe path in \.daftplate\.json: \.\.\/escaped\.md/,
  );

  assert.equal(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'), before);
});

test('the rendered report labels each category, and says why an entry is unrestatable', () => {
  // These lines are what main() prints verbatim, so they are the surface the
  // operator reads. Asserting only the result arrays leaves every one of them
  // free to say the wrong thing.
  const fixture = makeMisenrolledRepository();
  const manifest = JSON.parse(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'));
  const declinedRel = Object.keys(manifest.files).find((r) => !fixture.spurious.includes(r));
  const baseline = manifest.files[declinedRel];
  manifest.files[declinedRel] = {
    digest: baseline.digest,
    templateDigest: baseline.templateDigest ?? baseline.digest,
    layer: baseline.layer,
    mode: baseline.mode,
    ownership: 'declined',
  };
  manifest.files[fixture.spurious[0]].templateDigest = `sha256:${'4'.repeat(64)}`;
  writeFileSync(join(fixture.target, PROVENANCE_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const text = renderReconcileText(reconcileManifest(TEMPLATES, fixture.target, opts())).join('\n');

  assert.match(text, new RegExp(`^CARRIED ${declinedRel.replace(/[.\\/]/g, '\\$&')} — .*standing decline`, 'm'));
  assert.match(text, new RegExp(`^UNRESTATABLE ${fixture.spurious[0].replace(/[.\\/]/g, '\\$&')} — .*erase that`, 'm'));
  assert.match(text, /^OWNERSHIP .* — diverged → managed$/m);
  assert.match(text, /^unchanged \d+, baseline refreshed \d+, ownership changed \d+, carried \d+, unrestatable \d+$/m);
});

// ---------------------------------------------------------------------------
// #244 (FORGE-318) -- two report lines that are true and are not the one the
// operator needs. Neither changes what is written.
// ---------------------------------------------------------------------------

/** A path safe to drop into a `RegExp` after a manifest key. */
const esc = (rel) => rel.replace(/[.\\/]/g, '\\$&');

/** Makes one already-spurious entry unrestatable: what the manifest records is
 *  no longer what its own recorded inputs produce, so the one rule refuses it
 *  whatever any selector says. */
const makeUnrestatable = (target, rel) => {
  const path = join(target, PROVENANCE_FILE);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.files[rel].templateDigest = `sha256:${'4'.repeat(64)}`;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
};

test('--accept naming an unrestatable path is reported rather than silently doing nothing', () => {
  // The inert-selector check deliberately stands aside for an unrestatable path,
  // so that a selector complaint does not hide the real problem. But nothing
  // downstream applies `accept` to an unrestatable entry -- it always takes
  // `before` -- and neither the text nor the JSON said so. The operator named a
  // path, got no error and got no acknowledgement, which reads exactly like
  // acceptance.
  const fixture = makeMisenrolledRepository();
  const stuck = fixture.spurious[0];
  makeUnrestatable(fixture.target, stuck);

  const result = reconcileManifest(TEMPLATES, fixture.target, opts({ accept: [stuck] }));

  // Still not inert: naming it is a real request about a real ownership change.
  assert.equal(result.unexplained.some(({ rel }) => rel === stuck), true);
  assert.deepEqual(result.acceptedUnrestatable, [stuck]);
  assert.deepEqual(toReconcileJson(result).acceptedUnrestatable, [stuck]);

  // Said next to the reason it could not be taken, which is the line that
  // explains it -- not in a separate paragraph the operator has to join up.
  const text = renderReconcileText(result).join('\n');
  assert.match(text, new RegExp(`^UNRESTATABLE ${esc(stuck)} — .*--accept cannot take this`, 'm'));
});

test('an --accept that was taken is not reported as one that could not be', () => {
  const fixture = makeMisenrolledRepository();
  const stuck = fixture.spurious[0];
  const taken = fixture.spurious[1];
  assert.notEqual(taken, undefined, 'the fixture must produce more than one spurious path');
  makeUnrestatable(fixture.target, stuck);

  const result = reconcileManifest(TEMPLATES, fixture.target, opts({ accept: [stuck, taken] }));

  assert.deepEqual(result.acceptedUnrestatable, [stuck]);
  const text = renderReconcileText(result).join('\n');
  assert.match(text, new RegExp(`^OWNERSHIP ${esc(taken)} — .*\\(accepted\\)$`, 'm'));
  assert.doesNotMatch(text, new RegExp(`^OWNERSHIP ${esc(taken)} — .*cannot take`, 'm'));
});

test('the write refusal names the --accept it could not take, beside the reason', () => {
  const fixture = makeMisenrolledRepository();
  const stuck = fixture.spurious[0];
  makeUnrestatable(fixture.target, stuck);
  const before = readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8');

  assert.throws(
    () => reconcileManifest(TEMPLATES, fixture.target, opts({
      accept: fixture.spurious, write: true,
    })),
    (error) => {
      assert.match(error.message, /cannot be restated from these inputs/);
      assert.match(error.message, new RegExp(`--accept named .*${esc(stuck)}`));
      assert.match(error.message, /the entry is the obstacle, not the selector/);
      return true;
    },
  );

  // The refusal is still complete and still precedes mutation.
  assert.equal(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'), before);
});

test('a declined path the new composition no longer produces reports the decline first', () => {
  // Both statements are true and the behaviour is identical either way -- carry
  // forward verbatim -- so this is message selection. The decline is the more
  // informative fact, because it is a recorded operator decision rather than a
  // property of today's template, and the template's shape is said as well
  // rather than instead.
  const fixture = makeMisenrolledRepository();
  const path = join(fixture.target, PROVENANCE_FILE);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const gone = 'docs/gone-upstream.md';
  const baseline = manifest.files[Object.keys(manifest.files)[0]];
  manifest.files[gone] = {
    templateDigest: baseline.templateDigest ?? baseline.digest,
    layer: 'base',
    mode: 'copied',
    ownership: 'declined',
  };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const goneBefore = readProvenance(fixture.target).files[gone];

  const result = reconcileManifest(TEMPLATES, fixture.target, opts({
    accept: fixture.spurious, write: true,
  }));

  const carried = result.carried.find(({ rel }) => rel === gone);
  assert.match(carried.why, /standing decline/);
  assert.match(carried.why, /does not produce this path/);
  // Nothing about what is written changes.
  assert.deepEqual(readProvenance(fixture.target).files[gone], goneBefore);
});

test('a declined path the composition still produces says only the decline', () => {
  const fixture = makeMisenrolledRepository();
  const path = join(fixture.target, PROVENANCE_FILE);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const stillProduced = Object.keys(manifest.files).find((r) => !fixture.spurious.includes(r));
  const baseline = manifest.files[stillProduced];
  manifest.files[stillProduced] = {
    digest: baseline.digest,
    templateDigest: baseline.templateDigest ?? baseline.digest,
    layer: baseline.layer,
    mode: baseline.mode,
    ownership: 'declined',
  };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const result = reconcileManifest(TEMPLATES, fixture.target, opts({ accept: fixture.spurious }));

  const carried = result.carried.find(({ rel }) => rel === stillProduced);
  assert.match(carried.why, /standing decline/);
  assert.doesNotMatch(carried.why, /does not produce/);
});
