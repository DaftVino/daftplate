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
import { classify, readProvenance } from '../scripts/lib/provenance.mjs';
import { syncStandards, isSafeRelPath } from '../scripts/sync-standards.mjs';

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
  manifest.files['../escape.md'] = { digest: `sha256:${'a'.repeat(64)}`, layer: 'base', mode: 'copied' };
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
  manifest.files['README.md:evil'] = { digest: `sha256:${'a'.repeat(64)}`, layer: 'base', mode: 'copied' };
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
