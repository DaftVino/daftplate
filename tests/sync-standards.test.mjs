import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, linkSync,
  symlinkSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDir } from './helpers/make-repo.mjs';
import { walkFiles } from '../scripts/lib/fs.mjs';
import { scaffold } from '../scripts/scaffold.mjs';
import {
  classify, fileDigest, readProvenance, writeProvenance, validateProvenance, MAX_PROVENANCE_SCHEMA,
} from '../scripts/lib/provenance.mjs';
import {
  syncStandards, isSafeRelPath, formatSyncSummary,
} from '../scripts/sync-standards.mjs';

// ---------------------------------------------------------------------------
// classify() — the pure decision function (Session 6a.1)
// ---------------------------------------------------------------------------

// A record shaped exactly like the ones buildProvenance writes. The digest is
// built from a single character so fixtures read as "file a" / "file b" and two
// records differ iff their characters do.
const rec = (char, layer = 'base', mode = 'copied') =>
  ({ digest: `sha256:${char.repeat(64)}`, layer, mode });

const A = rec('a');
const B = rec('b');

test('classify updates a file the repo left alone when the template moved', () => {
  assert.deepEqual(
    classify(A, B, A.digest),
    { status: 'UPDATE', disposition: 'UPDATE' },
  );
});

test('classify leaves a file alone when it already equals the candidate', () => {
  assert.deepEqual(
    classify(A, A, A.digest),
    { status: 'CURRENT', disposition: 'NONE' },
  );
});

test("classify refuses a modified file even when it equals today's candidate", () => {
  // Convergence is not provenance: daftplate cannot vouch for how these bytes
  // got here, so it must not adopt them silently.
  assert.deepEqual(
    classify(A, B, B.digest),
    { status: 'MODIFIED', disposition: 'REFUSE' },
  );
});

test('classify offers to restore a recorded file that is absent', () => {
  assert.deepEqual(
    classify(A, A, null),
    { status: 'MISSING', disposition: 'OFFER_RESTORE' },
  );
});

test('classify updates an unedited appended file like any other', () => {
  // The whole-file digest matches, so the staged composition is safe to write
  // and no append offset is needed. A blanket APPENDED refusal would block this.
  const prior = rec('a', 'profile', 'appended');
  const candidate = rec('b', 'profile', 'appended');
  assert.deepEqual(
    classify(prior, candidate, prior.digest),
    { status: 'UPDATE', disposition: 'UPDATE' },
  );
});

test('classify treats an edited appended file as MODIFIED, not a mode of its own', () => {
  const prior = rec('a', 'profile', 'appended');
  const candidate = rec('b', 'profile', 'appended');
  assert.deepEqual(
    classify(prior, candidate, rec('c').digest),
    { status: 'MODIFIED', disposition: 'REFUSE' },
  );
});

test('classify refuses a base candidate over a prior profile override', () => {
  // The profile dropped its override. Removing it from the template is not
  // authority to push the base version into a repo running the override.
  const prior = rec('a', 'profile', 'overridden');
  assert.deepEqual(
    classify(prior, rec('b', 'base', 'copied'), prior.digest),
    { status: 'OVERRIDDEN', disposition: 'REFUSE' },
  );
});

test('classify lets an unchanged profile override receive a newer profile override', () => {
  // Narrower than "never touch an override": a profile that still overrides
  // propagates its update normally.
  const prior = rec('a', 'profile', 'overridden');
  assert.deepEqual(
    classify(prior, rec('b', 'profile', 'overridden'), prior.digest),
    { status: 'UPDATE', disposition: 'UPDATE' },
  );
});

test('classify offers a path absent from both manifest and disk as new', () => {
  // The dependabot.yml case: the template gained a file this repo never had.
  assert.deepEqual(
    classify(null, A, null),
    { status: 'NEW', disposition: 'OFFER_ADD' },
  );
});

test('classify refuses an unowned file at a newly-produced path', () => {
  assert.deepEqual(
    classify(null, A, B.digest),
    { status: 'COLLISION', disposition: 'REFUSE' },
  );
});

test('classify refuses an unowned file even when it equals the candidate', () => {
  // Same reasoning as MODIFIED: matching bytes are not evidence of ownership.
  assert.deepEqual(
    classify(null, A, A.digest),
    { status: 'COLLISION', disposition: 'REFUSE' },
  );
});

test('classify handles a null prior without dereferencing it', () => {
  // The OVERRIDDEN gate reads prior.mode, so ordering it ahead of the !prior
  // cases throws on exactly the dependabot.yml case this exists to serve.
  assert.doesNotThrow(() => classify(null, rec('a', 'profile', 'appended'), null));
  assert.doesNotThrow(() => classify(null, rec('a', 'profile', 'overridden'), B.digest));
});

test('classify never returns an APPENDED status', () => {
  // The eighth state was considered and rejected. This fails if it comes back.
  const modes = ['copied', 'appended', 'overridden'];
  const layers = ['base', 'profile'];
  const shapes = layers.flatMap((l) => modes.map((m) => [l, m]));
  const priors = [null, ...shapes.map(([l, m]) => rec('a', l, m))];
  // Candidates cover both a moved template ('b') and one that still matches the
  // prior ('a') — without the latter, CURRENT is unreachable and the sweep would
  // silently assert over six statuses while claiming to cover all seven.
  const candidates = shapes.flatMap(([l, m]) => [rec('a', l, m), rec('b', l, m)]);
  const actuals = [null, A.digest, B.digest, rec('c').digest];

  const seen = new Set();
  for (const prior of priors) {
    for (const candidate of candidates) {
      for (const actual of actuals) seen.add(classify(prior, candidate, actual).status);
    }
  }

  assert.equal(seen.has('APPENDED'), false);
  assert.deepEqual(
    [...seen].sort(),
    ['COLLISION', 'CURRENT', 'MISSING', 'MODIFIED', 'NEW', 'OVERRIDDEN', 'UPDATE'],
  );
});

// A divergent prior: daftplate measured this path at enrollment and does not own
// its bytes. `digest` baselines the repository file, `templateDigest` the composed
// candidate, and the two drift questions they answer are independent.
const C = rec('c');
const divergent = {
  digest: A.digest,
  templateDigest: B.digest,
  layer: 'base',
  mode: 'copied',
  ownership: 'diverged',
};

test('classify reports all six divergent repository and template drift combinations', () => {
  const unchangedTemplate = B;
  const changedTemplate = C;

  const cases = [
    [A.digest, unchangedTemplate, 'UNCHANGED', 'UNCHANGED'],
    [C.digest, unchangedTemplate, 'CHANGED', 'UNCHANGED'],
    [null, unchangedTemplate, 'MISSING', 'UNCHANGED'],
    [A.digest, changedTemplate, 'UNCHANGED', 'CHANGED'],
    [C.digest, changedTemplate, 'CHANGED', 'CHANGED'],
    [null, changedTemplate, 'MISSING', 'CHANGED'],
  ];

  for (const [actual, candidate, repoDrift, templateDrift] of cases) {
    assert.deepEqual(classify(divergent, candidate, actual), {
      status: 'DIVERGED',
      disposition: 'REPORT_ONLY',
      repoDrift,
      templateDrift,
    });
  }
});

test('byte convergence remains divergent', () => {
  // The repository happens to equal today's candidate. That is repository drift
  // away from the adopted baseline, not a grant of write authority -- the
  // existing classifier already says convergence is not provenance.
  assert.deepEqual(classify(divergent, B, B.digest), {
    status: 'DIVERGED',
    disposition: 'REPORT_ONLY',
    repoDrift: 'CHANGED',
    templateDrift: 'UNCHANGED',
  });
});

test('layer-only and mode-only movement count as template drift', () => {
  // Comparing layer and mode as well as the digest stops a byte-identical change
  // in production semantics from disappearing out of the report.
  for (const candidate of [
    { ...B, layer: 'profile' },
    { ...B, mode: 'appended' },
  ]) {
    const result = classify(divergent, candidate, A.digest);
    assert.equal(result.status, 'DIVERGED');
    assert.equal(result.disposition, 'REPORT_ONLY');
    assert.equal(result.templateDrift, 'CHANGED');
  }
});

test('divergent ownership precedes the overridden gate without weakening the null-prior gate', () => {
  assert.deepEqual(
    classify(
      {
        ...divergent,
        mode: 'overridden',
      },
      { ...B, layer: 'base' },
      A.digest,
    ),
    {
      status: 'DIVERGED',
      disposition: 'REPORT_ONLY',
      repoDrift: 'UNCHANGED',
      templateDrift: 'CHANGED',
    },
  );

  assert.deepEqual(classify(null, B, null), {
    status: 'NEW',
    disposition: 'OFFER_ADD',
  });
});

// A declined prior: an operator refused this path. `digest` is present only if
// the path held bytes when it was declined -- absent (declinedNew) means
// nothing was there; present (declinedCollision) means an unowned file was.
const declinedNew = {
  templateDigest: B.digest,
  layer: 'base',
  mode: 'copied',
  ownership: 'declined',
};
const declinedCollision = {
  digest: A.digest,
  templateDigest: B.digest,
  layer: 'base',
  mode: 'copied',
  ownership: 'declined',
};

test('classify reports repository state for a declined path with no baseline digest', () => {
  // A declined NEW entry never had bytes, so ABSENT means nothing showed up
  // where nothing was declared -- not that an absent value was matched.
  assert.deepEqual(classify(declinedNew, B, null), {
    status: 'DECLINED',
    disposition: 'REPORT_ONLY',
    repoState: 'ABSENT',
    templateDrift: 'UNCHANGED',
  });
  // A file has appeared where the operator declined one ever existing --
  // distinct from an unowned file being edited, which needs a baseline to
  // edit against.
  assert.deepEqual(classify(declinedNew, B, A.digest), {
    status: 'DECLINED',
    disposition: 'REPORT_ONLY',
    repoState: 'APPEARED',
    templateDrift: 'UNCHANGED',
  });
});

test('classify reports repository state for a declined path with a baseline digest', () => {
  const cases = [
    [A.digest, 'UNCHANGED'],
    [C.digest, 'CHANGED'],
    [null, 'MISSING'],
  ];

  for (const [actual, repoState] of cases) {
    assert.deepEqual(classify(declinedCollision, B, actual), {
      status: 'DECLINED',
      disposition: 'REPORT_ONLY',
      repoState,
      templateDrift: 'UNCHANGED',
    });
  }
});

test('template drift on a declined path fires on digest, layer, and mode movement', () => {
  // Comparing layer and mode as well as the digest stops a byte-identical
  // change in production semantics from disappearing out of the report --
  // the same reasoning D6 already applies to divergence.
  for (const candidate of [
    C,
    { ...B, layer: 'profile' },
    { ...B, mode: 'appended' },
  ]) {
    const result = classify(declinedCollision, candidate, A.digest);
    assert.equal(result.status, 'DECLINED');
    assert.equal(result.disposition, 'REPORT_ONLY');
    assert.equal(result.templateDrift, 'CHANGED');
  }
});

test('declined ownership precedes the overridden gate without weakening the null-prior gate', () => {
  // The gate-order guarantee (D6): a declined entry whose prior mode was
  // overridden, offered today's candidate at the base layer, must still
  // report DECLINED and never fall through to OVERRIDDEN.
  assert.deepEqual(
    classify(
      { ...declinedCollision, mode: 'overridden' },
      { ...B, layer: 'base' },
      A.digest,
    ),
    {
      status: 'DECLINED',
      disposition: 'REPORT_ONLY',
      repoState: 'UNCHANGED',
      templateDrift: 'CHANGED',
    },
  );

  assert.deepEqual(classify(null, B, null), {
    status: 'NEW',
    disposition: 'OFFER_ADD',
  });
});

// ---------------------------------------------------------------------------
// syncStandards() — the driver (Session 6a.2)
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKENS = { PROJECT_NAME: 'demo-app', PROJECT_SUMMARY: 'A demo.' };

/** A repo scaffolded from the real templates, exactly as a user would get it. */
function realTarget(type = 'web-app') {
  const dir = emptyDir();
  scaffold(ROOT, type, dir, { year: 2026, tokens: TOKENS });
  return dir;
}

const write = (root, rel, body) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body, 'utf8');
};

/**
 * A minimal synthetic templates root. The real templates cannot be edited
 * mid-test, so any scenario where the template moved, gained or dropped a file
 * needs a tree the test owns. `readme`, `extra` and `append` are the knobs.
 */
function makeTemplates({ readme = '# <PROJECT_NAME> v1\n', extra = null, append = 'dist/\n' } = {}) {
  const root = emptyDir();
  write(root, 'package.json', JSON.stringify({ version: '9.9.9' }));
  write(root, 'base/files/README.md', readme);
  write(root, 'base/files/CLAUDE.md', '# CLAUDE.md\n\n<PROJECT_SUMMARY> tested by <TEST_COMMAND>.\n');
  write(root, 'base/files/dot-gitignore', 'node_modules/\n');
  if (extra) write(root, `base/files/${extra.rel}`, extra.body);
  write(root, 'profiles/demo/profile.md', '```profile\nverify: v\ntest: t\ndeploy: d\ndocs-subdirs: designs\n```\n');
  if (append) write(root, 'profiles/demo/files/gitignore-append', append);
  return root;
}

const syntheticTarget = (templates) => {
  const dir = emptyDir();
  scaffold(templates, 'demo', dir, { year: 2026, tokens: TOKENS });
  return dir;
};

/** Every file under `root` as rel -> base64, for whole-tree byte comparison. */
function treeMap(root) {
  const out = {};
  for (const { isDir, rel } of walkFiles(root)) {
    if (!isDir) out[rel] = readFileSync(join(root, rel)).toString('base64');
  }
  return out;
}

const stagingDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('daftplate-sync-'));
const reportFor = (result, rel) => result.reports.find((r) => r.rel === rel);
const refusedLinkErrors = new Set(['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN']);

function trySymlink(target, path, type = 'file') {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (error) {
    if (refusedLinkErrors.has(error.code)) return false;
    throw error;
  }
}

test('sync reports a freshly scaffolded repo as entirely current', () => {
  // The strongest fidelity check there is: if candidate generation did not
  // reproduce the scaffold byte-for-byte, something here would be MODIFIED.
  const target = realTarget();
  const before = treeMap(target);

  const result = syncStandards(ROOT, target);

  assert.deepEqual(treeMap(target), before);
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.refused, []);
  // every() is true on an empty array, so the count is asserted first: without
  // it this whole test passes against a sync that classifies nothing at all.
  assert.equal(result.reports.length > 10, true);
  assert.equal(result.reports.every((r) => r.status === 'CURRENT'), true);
});

test('sync reproduces CLAUDE.md through fragment injection rather than raw base bytes', () => {
  // CLAUDE.md is base bytes plus three profile fragments plus tokens. Skipping
  // the injection replay would make it permanently MODIFIED.
  const target = realTarget();
  const text = readFileSync(join(target, 'CLAUDE.md'), 'utf8');

  assert.equal(text.includes('<!-- profile:'), false);
  assert.equal(reportFor(syncStandards(ROOT, target), 'CLAUDE.md').status, 'CURRENT');
});

test('sync renders profile commands from the profile.md it reads today', () => {
  // The manifest records no command tokens by design, so these can only have
  // come from parseProfileMeta reading the profile as it is now.
  const target = realTarget();
  const text = readFileSync(join(target, 'CLAUDE.md'), 'utf8');

  assert.equal(text.includes('npm run build'), true);
  assert.equal(reportFor(syncStandards(ROOT, target), 'CLAUDE.md').status, 'CURRENT');
});

test('sync reports a modified file and leaves the whole tree byte-identical', () => {
  const target = realTarget();
  writeFileSync(join(target, 'README.md'), 'hand-edited\n', 'utf8');
  const before = treeMap(target);

  const result = syncStandards(ROOT, target);

  assert.deepEqual(treeMap(target), before);
  assert.equal(reportFor(result, 'README.md').status, 'MODIFIED');
});

test('sync updates a file the repo left alone when the template moved', () => {
  const target = syntheticTarget(makeTemplates({ readme: '# <PROJECT_NAME> v1\n' }));

  const result = syncStandards(makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), target);

  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), '# demo-app v2\n');
  assert.equal(result.updated.includes('README.md'), true);
});

test('sync updates an unedited .gitignore by rewriting the whole composed file', () => {
  // mode: 'appended' gets no special case. A matching digest means the staged
  // base-plus-append composition is safe to write, offset or no offset.
  const target = syntheticTarget(makeTemplates({ append: 'dist/\n' }));

  const result = syncStandards(makeTemplates({ append: 'dist/\n.cache/\n' }), target);

  assert.equal(readFileSync(join(target, '.gitignore'), 'utf8'), 'node_modules/\ndist/\n.cache/\n');
  assert.equal(result.updated.includes('.gitignore'), true);
});

test('sync reports an edited .gitignore as MODIFIED and leaves every byte untouched', () => {
  const target = syntheticTarget(makeTemplates());
  writeFileSync(join(target, '.gitignore'), 'node_modules/\ndist/\n.idea/\n', 'utf8');
  const before = treeMap(target);

  const result = syncStandards(makeTemplates({ append: 'dist/\n.cache/\n' }), target);

  assert.deepEqual(treeMap(target), before);
  assert.equal(reportFor(result, '.gitignore').status, 'MODIFIED');
});

test('sync tells a MODIFIED appended path it is composed from a base copy plus an append', () => {
  // A bare "MODIFIED" gives the developer nothing to act on for a file that is
  // designed to accumulate lines from several sources.
  const target = syntheticTarget(makeTemplates());
  writeFileSync(join(target, '.gitignore'), 'node_modules/\ndist/\n.idea/\n', 'utf8');

  const { message } = reportFor(syncStandards(makeTemplates(), target), '.gitignore');

  assert.match(message, /MODIFIED/);
  assert.match(message, /base copy plus a profile append/);
});

test('sync offers a newly added template file and creates nothing without --add', () => {
  const target = syntheticTarget(makeTemplates());
  const v2 = makeTemplates({ extra: { rel: 'dot-github/dependabot.yml', body: 'version: 2\n' } });

  const result = syncStandards(v2, target);

  assert.equal(existsSync(join(target, '.github/dependabot.yml')), false);
  assert.equal(reportFor(result, '.github/dependabot.yml').status, 'NEW');
});

test('sync adds a new template file under --add and records its provenance', () => {
  const target = syntheticTarget(makeTemplates());
  const v2 = makeTemplates({ extra: { rel: 'dot-github/dependabot.yml', body: 'version: 2\n' } });

  const result = syncStandards(v2, target, { add: ['.github/dependabot.yml'] });
  const entry = readProvenance(target).files['.github/dependabot.yml'];

  assert.equal(readFileSync(join(target, '.github/dependabot.yml'), 'utf8'), 'version: 2\n');
  assert.equal(result.added.includes('.github/dependabot.yml'), true);
  assert.equal(entry.layer, 'base');
  assert.equal(entry.mode, 'copied');
  assert.match(entry.digest, /^sha256:[0-9a-f]{64}$/);
});

test('sync refuses an unowned file sitting at a newly produced path', () => {
  const target = syntheticTarget(makeTemplates());
  write(target, '.github/dependabot.yml', 'hand written\n');
  const before = treeMap(target);
  const v2 = makeTemplates({ extra: { rel: 'dot-github/dependabot.yml', body: 'version: 2\n' } });

  const result = syncStandards(v2, target, { add: ['.github/dependabot.yml'] });

  assert.deepEqual(treeMap(target), before);
  assert.equal(reportFor(result, '.github/dependabot.yml').status, 'COLLISION');
});

test('sync restores a missing recorded path only under --restore', () => {
  const target = syntheticTarget(makeTemplates());
  rmSync(join(target, 'README.md'));

  assert.equal(reportFor(syncStandards(makeTemplates(), target), 'README.md').status, 'MISSING');
  assert.equal(existsSync(join(target, 'README.md')), false);

  syncStandards(makeTemplates(), target, { restore: ['README.md'] });
  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), '# demo-app v1\n');
});

test('sync reports what it did, not what it decided, once an offer is taken up', () => {
  // Found by a CLI smoke run: a path that --restore had just rewritten still
  // printed "MISSING ... rerun with --restore", telling the operator to redo
  // work that had already happened.
  const target = syntheticTarget(makeTemplates());
  rmSync(join(target, 'README.md'));

  const result = syncStandards(makeTemplates(), target, { restore: ['README.md'] });
  const report = reportFor(result, 'README.md');

  assert.equal(report.status, 'MISSING');
  assert.equal(report.outcome, 'RESTORED');
  assert.match(report.message, /^RESTORED README\.md/);
  assert.equal(report.message.includes('--restore'), false);
});

test('sync updates provenance only for the paths it wrote', () => {
  const target = syntheticTarget(makeTemplates());
  const priorClaude = readProvenance(target).files['CLAUDE.md'];
  writeFileSync(join(target, 'CLAUDE.md'), 'hand-edited\n', 'utf8');

  syncStandards(makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), target);
  const after = readProvenance(target);

  assert.deepEqual(after.files['CLAUDE.md'], priorClaude);
  assert.notEqual(after.files['README.md'].digest, priorClaude.digest);
});

test('sync does not advance the daftplate version while a path is unresolved', () => {
  const target = syntheticTarget(makeTemplates());
  writeFileSync(join(target, 'CLAUDE.md'), 'hand-edited\n', 'utf8');

  const result = syncStandards(makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), target);

  assert.equal(result.versionAdvanced, false);
  assert.equal(readProvenance(target).daftplate, '9.9.9');
});

test('sync advances the daftplate version when nothing is left unresolved', () => {
  const target = syntheticTarget(makeTemplates());
  const stale = { ...readProvenance(target), daftplate: '0.0.1' };
  writeFileSync(join(target, '.daftplate.json'), `${JSON.stringify(stale, null, 2)}\n`, 'utf8');

  const result = syncStandards(makeTemplates(), target);

  assert.equal(result.versionAdvanced, true);
  assert.equal(readProvenance(target).daftplate, '9.9.9');
});

test('sync refuses an unsafe manifest path before touching the target', () => {
  const target = syntheticTarget(makeTemplates());
  const manifest = readProvenance(target);
  manifest.files['../escape.md'] = { digest: `sha256:${'a'.repeat(64)}`, layer: 'base', mode: 'copied', ownership: 'managed' };
  writeFileSync(join(target, '.daftplate.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const before = treeMap(target);

  assert.throws(
    () => syncStandards(makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), target),
    /unsafe path/,
  );
  assert.deepEqual(treeMap(target), before);
});

test('sync does not write through a hard link at a managed path', () => {
  // The #71 guard is lstat-based, and lstat cannot tell a hard link from a
  // regular file — so the escape it closed stayed open by a second mechanism,
  // and a more reachable one: on Windows linkSync needs no elevation while
  // symlinks need Developer Mode. Reproduced before this was fixed: the outside
  // file came back rewritten with the template's new bytes.
  //
  // The fix is the write mechanism rather than another detector. Replacing the
  // destination directory entry leaves the outside name bound to the old inode,
  // and covers the leaf-symlink case with the same stroke.
  const target = syntheticTarget(makeTemplates());
  const outside = join(emptyDir(), 'victim.md');
  const original = readFileSync(join(target, 'README.md'), 'utf8');
  writeFileSync(outside, original, 'utf8'); // matching bytes, so the digest still passes
  rmSync(join(target, 'README.md'));
  try {
    linkSync(outside, join(target, 'README.md'));
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error.code)) return;
    throw error;
  }

  const result = syncStandards(makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), target);

  assert.equal(readFileSync(outside, 'utf8'), original);
  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), '# demo-app v2\n');
  assert.equal(result.updated.includes('README.md'), true);
});

test('sync leaves no staging file behind in the target after an update', () => {
  // The replace-by-rename write stages inside the destination directory, so a
  // leaked temp file would land in someone else's repo and be committed by them.
  const target = syntheticTarget(makeTemplates());

  const result = syncStandards(makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), target);

  // The update is asserted first so this cannot pass by staging nothing at all.
  assert.equal(result.updated.includes('README.md'), true);
  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), '# demo-app v2\n');
  assert.deepEqual(readdirSync(target).filter((n) => n.includes('daftplate-tmp')), []);
});

test('isSafeRelPath refuses a colon anywhere in a manifest key', () => {
  // An NTFS alternate data stream. `README.md:evil` reaches lstat as one
  // component, so it is ENOENT rather than a symlink and the containment guard
  // returns ok — while a write to it follows the symlinked *base* and lands
  // outside the repo. Reproduced on Windows: the stream appeared on the outside
  // file. The drive-letter check only ever looked at the first two characters.
  assert.equal(isSafeRelPath('README.md:evil'), false);
  assert.equal(isSafeRelPath('docs/notes.md:$DATA'), false);
  assert.equal(isSafeRelPath('C:/etc/passwd'), false);
  // Still accepted: ordinary keys, including ones with dots and spaces.
  assert.equal(isSafeRelPath('README.md'), true);
  assert.equal(isSafeRelPath('.github/workflows/ci.yml'), true);
});

test('sync refuses a manifest key carrying an alternate data stream', () => {
  const target = syntheticTarget(makeTemplates());
  const manifest = readProvenance(target);
  manifest.files['README.md:evil'] = { digest: `sha256:${'a'.repeat(64)}`, layer: 'base', mode: 'copied', ownership: 'managed' };
  writeFileSync(join(target, '.daftplate.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const before = treeMap(target);

  assert.throws(() => syncStandards(makeTemplates(), target), /unsafe path/);
  assert.deepEqual(treeMap(target), before);
});

test('sync refuses an in-repo symlink at a tracked leaf', () => {
  const target = syntheticTarget(makeTemplates());
  const link = join(target, 'README.md');
  rmSync(link);
  if (!trySymlink(join(target, 'CLAUDE.md'), link)) return;

  const result = syncStandards(makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), target);
  const report = reportFor(result, 'README.md');

  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.deepEqual(
    report,
    {
      rel: 'README.md',
      status: 'UNSAFE_LINK',
      disposition: 'REFUSE',
      outcome: 'UNSAFE_LINK',
      message: 'REFUSED UNSAFE LINK README.md — README.md is a symbolic link or junction; left untouched',
    },
  );
  assert.deepEqual(result.refused, [{ rel: 'README.md', status: 'UNSAFE_LINK' }]);
  assert.equal(result.versionAdvanced, false);
});

test('sync refuses a symlinked ancestor before --add creates an external file', () => {
  const target = syntheticTarget(makeTemplates());
  const outside = emptyDir();
  const link = join(target, '.github');
  if (!trySymlink(outside, link, 'junction')) return;
  const v2 = makeTemplates({ extra: { rel: 'dot-github/dependabot.yml', body: 'version: 2\n' } });

  const result = syncStandards(v2, target, { add: ['.github/dependabot.yml'] });

  assert.equal(existsSync(join(outside, 'dependabot.yml')), false);
  assert.deepEqual(
    reportFor(result, '.github/dependabot.yml'),
    {
      rel: '.github/dependabot.yml',
      status: 'UNSAFE_LINK',
      disposition: 'REFUSE',
      outcome: 'UNSAFE_LINK',
      message: 'REFUSED UNSAFE LINK .github/dependabot.yml — .github is a symbolic link or junction; left untouched',
    },
  );
  assert.equal(result.versionAdvanced, false);
});

test('sync refuses a dangling symlink instead of restoring through it', () => {
  const target = syntheticTarget(makeTemplates());
  const link = join(target, 'README.md');
  rmSync(link);
  if (!trySymlink(join(emptyDir(), 'missing.md'), link)) return;

  const result = syncStandards(makeTemplates(), target, { restore: ['README.md'] });

  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(reportFor(result, 'README.md').status, 'UNSAFE_LINK');
  assert.equal(result.restored.includes('README.md'), false);
  assert.equal(result.versionAdvanced, false);
});

test('sync refuses a symlink swapped in during beforeWrite', () => {
  const target = syntheticTarget(makeTemplates());
  const outside = join(emptyDir(), 'README.md');
  writeFileSync(outside, 'outside\n', 'utf8');
  let manufactured = true;

  const result = syncStandards(makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), target, {
    hooks: {
      beforeWrite: (_rel, abs) => {
        rmSync(abs);
        manufactured = trySymlink(outside, abs);
      },
    },
  });
  if (!manufactured) return;

  assert.equal(readFileSync(outside, 'utf8'), 'outside\n');
  assert.equal(reportFor(result, 'README.md').status, 'UNSAFE_LINK');
  assert.equal(result.updated.includes('README.md'), false);
  assert.equal(result.versionAdvanced, false);
});

test('sync rejects a symlinked .daftplate.json before reading provenance', () => {
  const target = syntheticTarget(makeTemplates());
  const provenance = join(target, '.daftplate.json');
  const outside = join(emptyDir(), '.daftplate.json');
  const original = readFileSync(provenance, 'utf8');
  writeFileSync(outside, original, 'utf8');
  rmSync(provenance);
  if (!trySymlink(outside, provenance)) return;

  assert.throws(
    () => syncStandards(makeTemplates(), target),
    { message: 'refusing to sync: unsafe link in target path: .daftplate.json' },
  );
  assert.equal(readFileSync(outside, 'utf8'), original);
});

test('sync rechecks .daftplate.json immediately before writing provenance', () => {
  const target = syntheticTarget(makeTemplates());
  const provenance = join(target, '.daftplate.json');
  const outside = join(emptyDir(), '.daftplate.json');
  const original = readFileSync(provenance, 'utf8');
  writeFileSync(outside, original, 'utf8');
  let manufactured = true;
  let thrown;

  try {
    syncStandards(makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), target, {
      hooks: {
        beforeWrite: () => {
          rmSync(provenance);
          manufactured = trySymlink(outside, provenance);
        },
      },
    });
  } catch (error) {
    thrown = error;
  }
  if (!manufactured) return;

  assert.equal(thrown?.message, 'refusing to sync: unsafe link in target path: .daftplate.json');
  assert.equal(readFileSync(outside, 'utf8'), original);
});

test('sync stages under the OS temp directory, never inside the target repo', () => {
  const target = syntheticTarget(makeTemplates());

  const { staging } = syncStandards(makeTemplates(), target);

  assert.equal(staging.startsWith(tmpdir()), true);
  assert.equal(staging.startsWith(target), false);
});

test('sync removes its staging directory and nothing else', () => {
  const target = syntheticTarget(makeTemplates());
  const before = stagingDirs().length;
  const treeBefore = treeMap(target);

  syncStandards(makeTemplates(), target);

  assert.equal(stagingDirs().length, before);
  assert.deepEqual(treeMap(target), treeBefore);
});

test('sync removes the staging directory even when classification throws', () => {
  // A recorded path replaced by a directory makes fileDigest throw. Cleanup
  // outside a finally leaks the staging tree silently.
  const target = syntheticTarget(makeTemplates());
  rmSync(join(target, 'README.md'));
  mkdirSync(join(target, 'README.md'));
  const before = stagingDirs().length;

  assert.throws(() => syncStandards(makeTemplates(), target));
  assert.equal(stagingDirs().length, before);
});

test('sync re-checks the digest immediately before writing', () => {
  // The window between classify and write is real: something else can touch the
  // file. beforeWrite exists so that window is testable rather than assumed.
  const target = syntheticTarget(makeTemplates());

  const result = syncStandards(makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), target, {
    hooks: { beforeWrite: () => writeFileSync(join(target, 'README.md'), 'raced\n', 'utf8') },
  });

  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), 'raced\n');
  assert.equal(result.updated.includes('README.md'), false);
});

test('sync --dry-run writes neither files nor provenance', () => {
  const target = syntheticTarget(makeTemplates());
  const before = treeMap(target);

  const result = syncStandards(
    makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), target, { dryRun: true },
  );

  assert.deepEqual(treeMap(target), before);
  assert.equal(result.wouldUpdate.includes('README.md'), true);
  assert.deepEqual(result.updated, []);
});

test('sync accepts repeated --add paths in one run', () => {
  const target = syntheticTarget(makeTemplates());
  const v2 = makeTemplates({ extra: { rel: 'dot-github/dependabot.yml', body: 'version: 2\n' } });
  write(v2, 'base/files/SECURITY.md', 'report here\n');

  const result = syncStandards(v2, target, { add: ['.github/dependabot.yml', 'SECURITY.md'] });

  assert.deepEqual(result.added.sort(), ['.github/dependabot.yml', 'SECURITY.md']);
});

test('sync reports a path the template no longer produces without deleting it', () => {
  const target = syntheticTarget(makeTemplates({ extra: { rel: 'GONE.md', body: 'x\n' } }));

  const result = syncStandards(makeTemplates(), target);

  assert.equal(existsSync(join(target, 'GONE.md')), true);
  assert.equal(reportFor(result, 'GONE.md').status, 'RETAINED');
});

// ---------------------------------------------------------------------------
// Divergent paths through the engine (Phase 2, Task 2.3)
// ---------------------------------------------------------------------------

/** A target whose README.md is enrolled as divergent, plus a v2 template that
 *  moves a *managed* file. The managed move is the point: divergence must not
 *  block work on paths daftplate does own. */
const makeDivergentSyncFixture = () => {
  // makeTemplates() and syntheticTarget() are the supported way to get a mutable
  // template root. Deliberately NOT cpSync of the real checkout: that drags .git
  // in and pins the test to whatever profiles/ happens to hold today.
  const target = syntheticTarget(makeTemplates());
  const rel = 'README.md';

  const manifest = readProvenance(target);
  const templateBaseline = manifest.files[rel];
  writeFileSync(join(target, rel), '# repository-owned readme\n', 'utf8');
  manifest.files[rel] = {
    ...templateBaseline,
    digest: fileDigest(join(target, rel)),
    templateDigest: templateBaseline.digest,
    ownership: 'diverged',
  };
  writeProvenance(target, manifest);

  return {
    templates: makeTemplates({ append: 'dist/\n.cache/\n' }),
    target,
    rel,
    divergentBaseline: structuredClone(manifest.files[rel]),
  };
};

test('sync reports divergence without folding it into refused or offered work', () => {
  const fixture = makeDivergentSyncFixture();

  const result = syncStandards(fixture.templates, fixture.target);

  const report = reportFor(result, fixture.rel);
  assert.equal(report.status, 'DIVERGED');
  assert.equal(report.disposition, 'REPORT_ONLY');
  assert.equal(report.repoDrift, 'UNCHANGED');
  assert.equal(report.templateDrift, 'UNCHANGED');
  assert.match(report.message, /^DIVERGED README\.md/);
  assert.equal(result.refused.some(({ rel }) => rel === fixture.rel), false);
  assert.equal(result.offered.some(({ rel }) => rel === fixture.rel), false);
  assert.equal(result.updated.includes(fixture.rel), false);
  assert.equal(result.retained.includes(fixture.rel), false);

  // Divergence is an expected recorded condition, not a blanket failure: the
  // managed path still updates and the version still advances around it.
  assert.equal(result.updated.includes('.gitignore'), true);
  assert.equal(result.versionAdvanced, true);
});

test('sync never rewrites divergent bytes or either divergent baseline', () => {
  const fixture = makeDivergentSyncFixture();
  const beforeBytes = readFileSync(join(fixture.target, fixture.rel), 'utf8');

  syncStandards(fixture.templates, fixture.target);

  assert.equal(readFileSync(join(fixture.target, fixture.rel), 'utf8'), beforeBytes);
  assert.deepEqual(
    readProvenance(fixture.target).files[fixture.rel],
    fixture.divergentBaseline,
  );
});

test('--add naming a divergent entry refuses before any managed update', () => {
  const fixture = makeDivergentSyncFixture();
  const managedBefore = readFileSync(join(fixture.target, '.gitignore'), 'utf8');

  assert.throws(
    () => syncStandards(fixture.templates, fixture.target, { add: [fixture.rel] }),
    /--add cannot name divergent path.*README\.md/i,
  );

  // The ordering is the point: the same run carries a real managed update, and
  // discovering the bad selector after it landed would leave a partial sync.
  assert.equal(readFileSync(join(fixture.target, '.gitignore'), 'utf8'), managedBefore);
});

test('--restore naming a divergent entry refuses before any managed update', () => {
  const fixture = makeDivergentSyncFixture();
  const managedBefore = readFileSync(join(fixture.target, '.gitignore'), 'utf8');

  assert.throws(
    () => syncStandards(fixture.templates, fixture.target, { restore: [fixture.rel] }),
    /--restore cannot name divergent path.*README\.md/i,
  );

  assert.equal(readFileSync(join(fixture.target, '.gitignore'), 'utf8'), managedBefore);
});

test('sync returns divergence separately without changing outstanding or version advancement', () => {
  const fixture = makeDivergentSyncFixture();

  const result = syncStandards(fixture.templates, fixture.target);

  assert.deepEqual(result.diverged, [{
    rel: fixture.rel,
    repoDrift: 'UNCHANGED',
    templateDrift: 'UNCHANGED',
  }]);
  assert.equal(result.refused.some(({ rel }) => rel === fixture.rel), false);
  assert.equal(result.offered.some(({ rel }) => rel === fixture.rel), false);
  assert.equal(result.versionAdvanced, true);
});

// ---------------------------------------------------------------------------
// Declined paths through the engine (Phase 2)
// ---------------------------------------------------------------------------

/** A target with a standing decline of each shape D5 distinguishes:
 *  README.md declined NEW (never had bytes -- deleted after scaffold, no
 *  digest recorded) and CLAUDE.md declined COLLISION (an unowned file sat
 *  there when it was declined -- the scaffolded bytes are kept in place and
 *  recorded as the repository's own). .gitignore stays managed, so a v2
 *  template that moves it proves a decline does not block work on paths
 *  daftplate does own -- the same point makeDivergentSyncFixture makes for
 *  divergence. */
const makeDeclinedSyncFixture = () => {
  const target = syntheticTarget(makeTemplates());
  const newRel = 'README.md';
  const collisionRel = 'CLAUDE.md';

  const manifest = readProvenance(target);
  const newBaseline = manifest.files[newRel];
  const collisionBaseline = manifest.files[collisionRel];

  rmSync(join(target, newRel));
  manifest.files[newRel] = {
    templateDigest: newBaseline.digest,
    layer: newBaseline.layer,
    mode: newBaseline.mode,
    ownership: 'declined',
  };
  manifest.files[collisionRel] = {
    digest: collisionBaseline.digest,
    templateDigest: collisionBaseline.digest,
    layer: collisionBaseline.layer,
    mode: collisionBaseline.mode,
    ownership: 'declined',
  };
  writeProvenance(target, manifest);

  return {
    templates: makeTemplates({ append: 'dist/\n.cache/\n' }),
    target,
    newRel,
    collisionRel,
    newBaseline: structuredClone(manifest.files[newRel]),
    collisionBaseline: structuredClone(manifest.files[collisionRel]),
  };
};

test('--decline on a NEW path writes a declined entry with templateDigest and no digest', () => {
  const target = syntheticTarget(makeTemplates());
  // An unrelated hand-edit keeps this run's version from advancing on its
  // own, so manifestChanged is the only thing that can make the write land --
  // isolating it from versionAdvanced, which the mutation-1 drill requires.
  writeFileSync(join(target, '.gitignore'), 'hand-edited\n', 'utf8');
  const v2 = makeTemplates({ extra: { rel: 'dot-github/dependabot.yml', body: 'version: 2\n' } });

  const result = syncStandards(v2, target, { decline: ['.github/dependabot.yml'] });

  assert.equal(result.versionAdvanced, false);
  const entry = readProvenance(target).files['.github/dependabot.yml'];
  assert.equal(entry.ownership, 'declined');
  assert.equal('digest' in entry, false);
  assert.match(entry.templateDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(existsSync(join(target, '.github/dependabot.yml')), false);
  assert.equal(reportFor(result, '.github/dependabot.yml').outcome, 'DECLINED_RECORDED');
});

test('--decline on a COLLISION path writes both digests', () => {
  const target = syntheticTarget(makeTemplates());
  write(target, '.github/dependabot.yml', 'operator-owned\n');
  // Same isolation as the NEW-path record test above.
  writeFileSync(join(target, '.gitignore'), 'hand-edited\n', 'utf8');
  const v2 = makeTemplates({ extra: { rel: 'dot-github/dependabot.yml', body: 'version: 2\n' } });

  const result = syncStandards(v2, target, { decline: ['.github/dependabot.yml'] });

  assert.equal(result.versionAdvanced, false);
  const entry = readProvenance(target).files['.github/dependabot.yml'];
  assert.equal(entry.ownership, 'declined');
  assert.match(entry.digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(entry.templateDigest, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(entry.digest, entry.templateDigest);
  assert.equal(readFileSync(join(target, '.github/dependabot.yml'), 'utf8'), 'operator-owned\n');
});

test('recording a decline in a run with nothing else outstanding still advances the version', () => {
  // D7's case applied to the recording run itself, not just a later run
  // reporting a standing decline: a fresh decline never wanted a write, so it
  // must not hold the version back any more than a standing one does.
  const target = syntheticTarget(makeTemplates());
  const v2 = makeTemplates({ extra: { rel: 'dot-github/dependabot.yml', body: 'version: 2\n' } });

  const result = syncStandards(v2, target, { decline: ['.github/dependabot.yml'] });

  assert.equal(result.versionAdvanced, true);
  assert.equal(readProvenance(target).daftplate, '9.9.9');
});

test('--decline under --dry-run writes nothing and reports WOULD DECLINE', () => {
  const target = syntheticTarget(makeTemplates());
  const before = readFileSync(join(target, '.daftplate.json'), 'utf8');
  const v2 = makeTemplates({ extra: { rel: 'dot-github/dependabot.yml', body: 'version: 2\n' } });

  const result = syncStandards(v2, target, { decline: ['.github/dependabot.yml'], dryRun: true });

  assert.equal(readFileSync(join(target, '.daftplate.json'), 'utf8'), before);
  assert.equal(existsSync(join(target, '.github/dependabot.yml')), false);
  const report = reportFor(result, '.github/dependabot.yml');
  assert.equal(report.outcome, 'WOULD_DECLINE');
  assert.match(report.message, /^WOULD DECLINE/);
});

test('re-declining an already-declined path writes no manifest at all', () => {
  const fixture = makeDeclinedSyncFixture();
  // An unrelated unresolved path so this run's version cannot advance for any
  // other reason either -- the only thing left that could trigger a write is
  // manifestChanged, and re-declining an already-declined path must leave it
  // false.
  writeFileSync(join(fixture.target, '.gitignore'), 'hand-edited\n', 'utf8');
  const before = readFileSync(join(fixture.target, '.daftplate.json'), 'utf8');

  const result = syncStandards(fixture.templates, fixture.target, { decline: [fixture.newRel] });

  assert.equal(reportFor(result, '.gitignore').status, 'MODIFIED');
  assert.equal(result.versionAdvanced, false);
  assert.equal(readFileSync(join(fixture.target, '.daftplate.json'), 'utf8'), before);
});

test('--decline and --add on the same path refuses as contradictory', () => {
  // A NEW path, not a managed one: the managed-entry refusal above would
  // otherwise fire first and the test would prove the wrong thing.
  const target = syntheticTarget(makeTemplates());
  const v2 = makeTemplates({ extra: { rel: 'dot-github/dependabot.yml', body: 'version: 2\n' } });

  assert.throws(
    () => syncStandards(v2, target, {
      add: ['.github/dependabot.yml'], decline: ['.github/dependabot.yml'],
    }),
    /--decline and --add cannot both name.*dependabot\.yml/i,
  );
});

test('--decline naming a managed entry refuses before any managed write lands', () => {
  const target = syntheticTarget(makeTemplates());
  const before = readFileSync(join(target, 'README.md'), 'utf8');

  assert.throws(
    () => syncStandards(makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), target, { decline: ['.gitignore'] }),
    /--decline cannot name managed path.*\.gitignore/i,
  );

  // The ordering is the point: the same run carries a real managed update
  // (README.md's template moved), and discovering the bad selector after it
  // landed would leave a partial sync.
  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), before);
});

test('--decline naming a divergent entry refuses before any managed write lands', () => {
  const fixture = makeDivergentSyncFixture();
  const managedBefore = readFileSync(join(fixture.target, '.gitignore'), 'utf8');

  assert.throws(
    () => syncStandards(fixture.templates, fixture.target, { decline: [fixture.rel] }),
    /--decline cannot name divergent path.*README\.md/i,
  );

  assert.equal(readFileSync(join(fixture.target, '.gitignore'), 'utf8'), managedBefore);
});

test('--decline naming a path the template does not produce refuses before any write', () => {
  const target = syntheticTarget(makeTemplates());
  const before = readFileSync(join(target, 'README.md'), 'utf8');

  assert.throws(
    () => syncStandards(makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), target, { decline: ['NOPE.md'] }),
    /--decline cannot name NOPE\.md/i,
  );

  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), before);
});

test('--restore naming a declined entry refuses before any managed write lands', () => {
  const fixture = makeDeclinedSyncFixture();
  const managedBefore = readFileSync(join(fixture.target, '.gitignore'), 'utf8');

  assert.throws(
    () => syncStandards(fixture.templates, fixture.target, { restore: [fixture.newRel] }),
    /--restore cannot name declined path.*README\.md/i,
  );

  assert.equal(readFileSync(join(fixture.target, '.gitignore'), 'utf8'), managedBefore);
});

test('sync reports a standing decline and keeps it out of refused, offered, and retained', () => {
  const fixture = makeDeclinedSyncFixture();

  const result = syncStandards(fixture.templates, fixture.target);

  for (const rel of [fixture.newRel, fixture.collisionRel]) {
    const report = reportFor(result, rel);
    assert.equal(report.status, 'DECLINED');
    assert.equal(report.disposition, 'REPORT_ONLY');
    assert.match(report.message, /^DECLINED /);
    assert.equal(result.refused.some((r) => r.rel === rel), false);
    assert.equal(result.offered.some((r) => r.rel === rel), false);
    assert.equal(result.retained.includes(rel), false);
  }

  // A decline is an expected recorded condition, not a blanket failure: the
  // managed path still updates and the version still advances around it.
  assert.equal(result.updated.includes('.gitignore'), true);
  assert.equal(result.versionAdvanced, true);
});

test('result.declined carries rel, repoState and templateDrift', () => {
  const fixture = makeDeclinedSyncFixture();

  const result = syncStandards(fixture.templates, fixture.target);

  assert.deepEqual(
    result.declined.find((d) => d.rel === fixture.newRel),
    { rel: fixture.newRel, repoState: 'ABSENT', templateDrift: 'UNCHANGED' },
  );
  assert.deepEqual(
    result.declined.find((d) => d.rel === fixture.collisionRel),
    { rel: fixture.collisionRel, repoState: 'UNCHANGED', templateDrift: 'UNCHANGED' },
  );
});

test('template drift on a declined path reports CHANGED and refreshes neither baseline', () => {
  const fixture = makeDeclinedSyncFixture();
  const movedTemplates = makeTemplates({ readme: '# <PROJECT_NAME> v2\n' });

  const result = syncStandards(movedTemplates, fixture.target);

  const report = reportFor(result, fixture.newRel);
  assert.equal(report.status, 'DECLINED');
  assert.equal(report.templateDrift, 'CHANGED');
  assert.deepEqual(readProvenance(fixture.target).files[fixture.newRel], fixture.newBaseline);
});

test('a file appearing at a declined-NEW path reports APPEARED and is not written', () => {
  const fixture = makeDeclinedSyncFixture();
  writeFileSync(join(fixture.target, fixture.newRel), 'someone wrote this\n', 'utf8');

  const result = syncStandards(fixture.templates, fixture.target);

  const report = reportFor(result, fixture.newRel);
  assert.equal(report.status, 'DECLINED');
  assert.equal(report.repoState, 'APPEARED');
  assert.equal(readFileSync(join(fixture.target, fixture.newRel), 'utf8'), 'someone wrote this\n');
  assert.deepEqual(readProvenance(fixture.target).files[fixture.newRel], fixture.newBaseline);
});

test('an absent declined path reports ABSENT, distinct from an unchanged declined file', () => {
  const fixture = makeDeclinedSyncFixture();

  const result = syncStandards(fixture.templates, fixture.target);

  assert.equal(reportFor(result, fixture.newRel).repoState, 'ABSENT');
  assert.equal(reportFor(result, fixture.collisionRel).repoState, 'UNCHANGED');
});

test('standing declines leave outstanding 0 and versionAdvanced true alongside a real managed update', () => {
  const fixture = makeDeclinedSyncFixture();

  const result = syncStandards(fixture.templates, fixture.target);

  const outstanding = result.refused.length + result.offered.length;
  assert.equal(outstanding, 0);
  assert.equal(result.versionAdvanced, true);
  assert.equal(result.updated.includes('.gitignore'), true);
});

test('a repo whose every offer is declined still advances its version', () => {
  const fixture = makeDeclinedSyncFixture();

  // Same templates the target was originally scaffolded from: nothing here
  // moves, so every path in this run is either CURRENT or a standing decline
  // -- D7's explicit case, with no managed update riding along to help it.
  const result = syncStandards(makeTemplates(), fixture.target);

  const outstanding = result.refused.length + result.offered.length;
  assert.equal(outstanding, 0);
  assert.equal(result.versionAdvanced, true);
  assert.deepEqual(result.updated, []);
});

test("a declined path's bytes are never written and its manifest entry never changes", () => {
  const fixture = makeDeclinedSyncFixture();
  const before = readProvenance(fixture.target).files;

  syncStandards(fixture.templates, fixture.target);

  assert.equal(existsSync(join(fixture.target, fixture.newRel)), false);
  const after = readProvenance(fixture.target).files;
  assert.deepEqual(after[fixture.newRel], before[fixture.newRel]);
  assert.deepEqual(after[fixture.collisionRel], before[fixture.collisionRel]);
});

test('--add on a declined NEW path adopts it and replaces the entry with a managed one', () => {
  const fixture = makeDeclinedSyncFixture();

  const result = syncStandards(fixture.templates, fixture.target, { add: [fixture.newRel] });

  assert.equal(result.added.includes(fixture.newRel), true);
  assert.equal(existsSync(join(fixture.target, fixture.newRel)), true);
  const report = reportFor(result, fixture.newRel);
  assert.match(report.message, /the recorded decline is lifted/);
  const entry = readProvenance(fixture.target).files[fixture.newRel];
  assert.equal(entry.ownership, 'managed');
});

test('--add on a declined COLLISION path refuses as COLLISION and the declined entry survives', () => {
  const fixture = makeDeclinedSyncFixture();
  const beforeEntry = readProvenance(fixture.target).files[fixture.collisionRel];

  const result = syncStandards(fixture.templates, fixture.target, { add: [fixture.collisionRel] });

  assert.equal(result.added.includes(fixture.collisionRel), false);
  assert.equal(reportFor(result, fixture.collisionRel).status, 'COLLISION');
  assert.deepEqual(readProvenance(fixture.target).files[fixture.collisionRel], beforeEntry);
});

test('formatSyncSummary emits the declined term and omits it at zero', () => {
  const withDeclines = {
    updated: [],
    wouldUpdate: [],
    added: [],
    restored: [],
    retained: [],
    refused: [],
    offered: [],
    diverged: [],
    declined: [
      { rel: 'a.md', repoState: 'ABSENT', templateDrift: 'UNCHANGED' },
      { rel: 'b.md', repoState: 'UNCHANGED', templateDrift: 'CHANGED' },
    ],
  };

  assert.equal(
    formatSyncSummary(withDeclines, false),
    'updated 0, added 0, restored 0, retained 0, declined 2 (1 with template drift), outstanding 0',
  );
  assert.doesNotMatch(formatSyncSummary({ ...withDeclines, declined: [] }, false), /declined/);
});

/** Downgrades a freshly-synthesized target's manifest to a legacy schema
 *  shape (1: no schema key, no entry carries explicit ownership; 2: explicit
 *  `schema: 2`, entries keep the explicit `ownership: 'managed'`
 *  buildProvenance() already gave them, which schema 2 requires anyway), and
 *  unwinds README.md back to a NEW offer. Preflight A refuses --decline
 *  naming a managed entry, so a fresh NEW path is the only way to decline
 *  anything against either shape. */
const makeLegacySchemaFixture = (schemaNum) => {
  const target = syntheticTarget(makeTemplates());
  const manifestPath = join(target, '.daftplate.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (schemaNum === 1) {
    delete manifest.schema;
    for (const entry of Object.values(manifest.files)) delete entry.ownership;
  } else {
    manifest.schema = schemaNum;
  }
  delete manifest.files['README.md'];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  rmSync(join(target, 'README.md'));
  return { target, manifestPath };
};

for (const schemaNum of [1, 2]) {
  test(`declining a path in a schema ${schemaNum} manifest writes a manifest that reads back`, () => {
    const { target, manifestPath } = makeLegacySchemaFixture(schemaNum);

    syncStandards(makeTemplates(), target, { decline: ['README.md'] });

    // A schema 1 or 2 manifest cannot legally carry `ownership: 'declined'`
    // (Phase 1 gated it to schema >= 3) -- without the bump this throws
    // "unknown ownership: declined" on exactly the read the next sync makes,
    // bricking the manifest this run just wrote.
    assert.doesNotThrow(() => readProvenance(target));
    const written = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(written.schema, MAX_PROVENANCE_SCHEMA);
    assert.equal(written.files['README.md'].ownership, 'declined');
  });
}

test('a run recording no decline against a schema 1 target still writes schema 1', () => {
  // The line between #123 and #125: the bump is scoped to manifestChanged,
  // not to "the manifest got written at all". A real managed update forces
  // the write for an unrelated reason, so this cannot pass by accident.
  const target = syntheticTarget(makeTemplates());
  const manifestPath = join(target, '.daftplate.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete manifest.schema;
  for (const entry of Object.values(manifest.files)) delete entry.ownership;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const result = syncStandards(makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), target);

  assert.equal(result.updated.includes('README.md'), true);
  const written = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Absence IS schema 1 -- a manifest written before the field existed has no
  // schema key -- so the sharper form of the same claim is that the key never
  // appeared. #125 strengthened this rather than replacing it: the ownership
  // half is the addition, because the schema half alone passed against the very
  // hybrid it sits beside, asserting the number while saying nothing about the
  // field that contradicted it.
  assert.equal('schema' in written, false);
  assert.deepEqual(
    Object.entries(written.files).filter(([, e]) => 'ownership' in e).map(([rel]) => rel),
    [],
  );
});

test('#125 seam: a decline-only run against a schema 1 target writes a manifest that reads back cleanly', () => {
  const target = syntheticTarget(makeTemplates());
  const manifestPath = join(target, '.daftplate.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Downgrade to a genuine schema 1 shape: no top-level schema key, and no
  // entry carries an explicit ownership field. README.md is unwound back to a
  // NEW offer -- a schema 1 manifest never carried provenance for an absent
  // path either, and preflight A refuses --decline naming a managed entry, so
  // a fresh NEW path is the only way to decline anything here at all.
  delete manifest.schema;
  for (const entry of Object.values(manifest.files)) delete entry.ownership;
  delete manifest.files['README.md'];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  rmSync(join(target, 'README.md'));

  syncStandards(makeTemplates(), target, { decline: ['README.md'] });

  const written = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // The property, not the number: whichever way #125 eventually resolves the
  // schema-1-in/schema-2-shape-out mismatch on an UNCHANGED run, a decline-
  // only run must produce a manifest that reads back at all -- not merely one
  // that is internally uniform in some weaker sense.
  assert.doesNotThrow(() => validateProvenance(written));
});

test('formatSyncSummary counts only template-moving divergence as actionable detail', () => {
  const result = {
    updated: [],
    wouldUpdate: [],
    added: [],
    restored: [],
    retained: ['old.md'],
    refused: [],
    offered: [],
    diverged: [
      { rel: 'unchanged.md', repoDrift: 'CHANGED', templateDrift: 'UNCHANGED' },
      { rel: 'changed.md', repoDrift: 'UNCHANGED', templateDrift: 'CHANGED' },
    ],
  };

  assert.equal(
    formatSyncSummary(result, false),
    'updated 0, added 0, restored 0, retained 1, '
      + 'diverged 2 (1 with template drift), outstanding 0',
  );
});

test('formatSyncSummary drops the diverged term when there is none', () => {
  // The common case by far. A permanent "diverged 0" would train the eye to skip
  // the one term that means someone has a file to port by hand.
  const clean = {
    updated: ['a.md'], wouldUpdate: [], added: [], restored: [], retained: [],
    refused: [], offered: [], diverged: [],
  };

  assert.equal(
    formatSyncSummary(clean, false),
    'updated 1, added 0, restored 0, retained 0, outstanding 0',
  );
  assert.match(formatSyncSummary(clean, true), /^would update 0/);
});

// ---------------------------------------------------------------------------
// #125 -- a manifest sync writes is valid at the schema it declares, and a run
// that changes nothing leaves it byte-identical.

/** A target whose manifest is downgraded to a genuine older shape: schema 1
 *  states no schema key and no ownership; `tokens` is dropped for the pre-gate
 *  variant, which is the shape that acquires `"tokens": {}` without the fix. */
const legacyTarget = (templates, { schema = 1, tokens = true } = {}) => {
  const target = syntheticTarget(templates);
  const manifestPath = join(target, '.daftplate.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (schema === 1) {
    delete manifest.schema;
    for (const entry of Object.values(manifest.files)) delete entry.ownership;
  } else {
    manifest.schema = schema;
  }
  if (!tokens) delete manifest.tokens;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { target, manifestPath };
};

for (const schema of [1, 2, 3]) {
  test(`a no-op sync against a schema ${schema} target leaves the manifest byte-identical`, () => {
    // Schema 2 and 3 are the controls and passed before this fix: normalization
    // is the identity for them, so nobody noticed it round-tripping to disk.
    const templates = makeTemplates();
    const { target, manifestPath } = legacyTarget(templates, { schema });
    const before = readFileSync(manifestPath, 'utf8');

    const result = syncStandards(templates, target);

    assert.deepEqual([result.updated, result.added, result.restored], [[], [], []]);
    assert.equal(result.versionAdvanced, true);
    assert.equal(readFileSync(manifestPath, 'utf8'), before);
  });
}

test('a no-op sync leaves a manifest predating the tokens gate byte-identical', () => {
  // The third normalization, and the one #125 does not name. `tokens` is not
  // schema-versioned -- absent reads as {} at every schema -- so a fix scoped to
  // the schema key and ownership passes every other test here and still writes
  // `"tokens": {}` over every manifest old enough to lack one.
  //
  // The templates carry no placeholders on purpose. A manifest that states no
  // tokens composes from none, and sync spreads `{ PROJECT_NAME, PROJECT_SUMMARY }`
  // off an absent map (sync-standards.mjs:311), so a substituting template would
  // recompose different bytes and the run would stop being the no-op under test.
  const templates = emptyDir();
  write(templates, 'package.json', JSON.stringify({ version: '9.9.9' }));
  write(templates, 'base/files/README.md', '# a fixed readme\n');
  write(templates, 'base/files/CLAUDE.md', '# CLAUDE.md\n\nno placeholders here.\n');
  write(templates, 'base/files/dot-gitignore', 'node_modules/\n');
  write(templates, 'profiles/demo/profile.md', '```profile\nverify: v\ntest: t\ndeploy: d\ndocs-subdirs: designs\n```\n');
  write(templates, 'profiles/demo/files/gitignore-append', 'dist/\n');

  const { target, manifestPath } = legacyTarget(templates, { schema: 1, tokens: false });
  const before = readFileSync(manifestPath, 'utf8');
  assert.equal(before.includes('"tokens"'), false);

  syncStandards(templates, target);

  assert.equal(readFileSync(manifestPath, 'utf8'), before);
});

test('a real managed update against a schema 1 target writes a true schema 1 manifest', () => {
  // The case #125's title excludes and the larger half of the bug: the hybrid
  // ships on every write against a schema 1 target, not only on the no-op run
  // where it is the only thing in the diff.
  const templates = makeTemplates();
  const { target, manifestPath } = legacyTarget(templates, { schema: 1 });

  const result = syncStandards(makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), target);

  assert.equal(result.updated.includes('README.md'), true);
  const written = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal('schema' in written, false);
  assert.deepEqual(
    Object.entries(written.files).filter(([, e]) => 'ownership' in e).map(([rel]) => rel),
    [],
  );
  assert.doesNotThrow(() => readProvenance(target));
});

test('a real managed update against a schema 3 target keeps ownership on every entry', () => {
  // The other half of the same rule. Valid-at-the-schema-it-declares cuts both
  // ways: schema 3 states ownership, so stripping it there would be the same
  // bug wearing the opposite sign.
  const templates = makeTemplates();
  const { target, manifestPath } = legacyTarget(templates, { schema: 3 });

  syncStandards(makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), target);

  const written = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(written.schema, 3);
  const entries = Object.values(written.files);
  assert.equal(entries.length > 0, true);
  assert.equal(entries.every((e) => e.ownership === 'managed'), true);
});
