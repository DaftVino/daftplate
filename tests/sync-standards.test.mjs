import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, linkSync,
  symlinkSync, lstatSync, statSync, renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDir, withOwnedTempRoot } from './helpers/make-repo.mjs';
import { walkFiles } from '../scripts/lib/fs.mjs';
import { scaffold } from '../scripts/scaffold.mjs';
import {
  classify, fileDigest, readProvenance, writeProvenance, validateProvenance, MAX_PROVENANCE_SCHEMA,
} from '../scripts/lib/provenance.mjs';
import {
  syncStandards, isSafeRelPath, formatSyncSummary, isWithin, main, unifiedDiff, DIFF_LINE_CAP,
} from '../scripts/sync-standards.mjs';
import { EXIT_CODES } from '../scripts/lib/cli.mjs';

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

test('classify treats an edited appended file as MODIFIED, and says which part changed', () => {
  // #271 (FORGE-332) AC 2. Still a refusal, and it now names the part: for an
  // appended path "MODIFIED" alone reads as "you edited our file" when the far
  // more common cause is the opposite, and the run has just established which.
  const prior = rec('a', 'profile', 'appended');
  const candidate = rec('b', 'profile', 'appended');
  assert.deepEqual(
    classify(prior, candidate, rec('c').digest),
    { status: 'MODIFIED', disposition: 'REFUSE', part: 'appended-segment' },
  );
});

test('#271 (FORGE-332) — classify without texts still refuses, so the default is the safe one', () => {
  // `texts` is optional and every non-appended caller omits it. A caller that
  // omits it for an appended path too must get the old answer rather than a
  // silent pass: the extension branch is an ADDITIONAL question asked before
  // refusing, never a weakening of the refusal.
  const prior = rec('a', 'profile', 'appended');
  const candidate = rec('b', 'profile', 'appended');
  assert.equal(classify(prior, candidate, rec('c').digest).status, 'MODIFIED');
  assert.equal(classify(prior, candidate, rec('c').digest, null).status, 'MODIFIED');
  // And a text pair that does NOT contain the candidate refuses too.
  assert.equal(
    classify(prior, candidate, rec('c').digest, { candidate: 'ours\n', actual: 'theirs\n' }).status,
    'MODIFIED',
  );
  // Containment is what flips it, and only for an appended prior.
  assert.equal(
    classify(prior, candidate, rec('c').digest, { candidate: 'ours\n', actual: 'ours\ntheirs\n' }).status,
    'APPENDED_EXTENDED',
  );
  assert.equal(
    classify(rec('a', 'profile', 'copied'), candidate, rec('c').digest,
      { candidate: 'ours\n', actual: 'ours\ntheirs\n' }).status,
    'MODIFIED',
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
  write(root, 'profiles/demo/profile.md', '```profile\nverify: v\ntest: t\ndeploy: d\ndocs-subdirs: designs\nroadmap: optional\n```\n');
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

// Takes the root to look in rather than reading tmpdir() — #231 (FORGE-301).
// The callers below pass a root they own, so what this returns is the residue of
// the run under test and never a leftover belonging to the machine.
const stagingDirs = (root) => readdirSync(root).filter((n) => n.startsWith('daftplate-sync-'));
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

test('#271 (FORGE-332) — a MODIFIED appended path says daftplate\'s own lines changed', () => {
  // Restated by #271 (FORGE-332). The fixture used to add lines BELOW
  // daftplate's, which is now EXTENDED and not a refusal at all — that is the
  // defect this issue fixes, and a test asserting the old answer was asserting
  // it. So the edit here is a genuine one: daftplate wrote `node_modules/` and
  // the repository changed that line.
  //
  // The message changes with it. The old note apologised that "which lines were
  // daftplate's cannot be told from the file", which is no longer true at this
  // point — the run has just checked, and reaching MODIFIED is the answer. An
  // apology for a question the run can now answer is worse than no note.
  const target = syntheticTarget(makeTemplates());
  writeFileSync(join(target, '.gitignore'), 'node_modules_renamed_by_the_repo/\n', 'utf8');

  const { message } = reportFor(syncStandards(makeTemplates(), target), '.gitignore');

  assert.match(message, /MODIFIED/);
  assert.match(message, /lines daftplate appended are no longer in the file/);
  assert.match(message, /left untouched/);
});

test('#271 (FORGE-332) — an appended file the repo added to is EXTENDED, not refused forever', () => {
  // AC 1, and the whole point. daftplate writes `.gitignore`; the repository then
  // ignores something of its own, which is the normal thing for a repository to
  // do to its own `.gitignore`. Under one whole-file digest that was REFUSED
  // MODIFIED permanently, and --rebaseline was no exit — it applies only when the
  // bytes already equal today's candidate, i.e. exactly when the repository has
  // added nothing.
  const target = syntheticTarget(makeTemplates({ append: 'dist/\n' }));
  const scaffolded = readFileSync(join(target, '.gitignore'), 'utf8');
  writeFileSync(join(target, '.gitignore'), `${scaffolded}.env.local\ncoverage/\n`, 'utf8');
  const before = treeMap(target);

  const result = syncStandards(makeTemplates({ append: 'dist/\n' }), target);

  const report = reportFor(result, '.gitignore');
  assert.equal(report.status, 'APPENDED_EXTENDED');
  assert.match(report.message, /^APPENDED CONTENT INTACT /);
  // The ordinary case names itself. Normalised containment cannot always say what
  // accounts for the remaining bytes, but here it can — the text is strictly
  // longer than daftplate's — and the message that hedges when it does not have
  // to is the one that told an operator their repository had misbehaved by
  // working normally.
  assert.match(report.message, /this repo has added its own below them/);
  assert.doesNotMatch(report.message, /line endings are the whole difference/);
  assert.doesNotMatch(report.message, /REFUSED/);
  // Reported, and touched by nothing.
  assert.deepEqual(treeMap(target), before, 'an extended appended file was rewritten');
  assert.equal(result.refused.some((r) => r.rel === '.gitignore'), false);
  assert.deepEqual(result.extended, [{ rel: '.gitignore' }]);
  // It is not a decline and not a divergence, so it goes in neither bucket — a
  // caller must never have to infer which condition it is from a message.
  assert.equal(result.declined.some((r) => r.rel === '.gitignore'), false);
  assert.equal(result.diverged.some((r) => r.rel === '.gitignore'), false);
});

test('appended containment treats LF and CRLF as the same text without claiming an extension', () => {
  // unifiedDiff already rules that line endings are not a content difference an
  // operator can act on. Containment has to ask the same textual question or a
  // Windows editor can turn an intact appended segment into a permanent refusal.
  // The digest remains byte-exact: this fixture must therefore be report-only
  // and byte-identical after the run, not CURRENT and not rewritten.
  //
  // The first case has no repository additions; the second is the same CRLF
  // re-save with one below daftplate's segment. Both prove the content survives,
  // and they are asserted TOGETHER on that and SEPARATELY on what each one says —
  // because the two are distinguishable and a message that hedged across both
  // would lose the ordinary case its own sentence.
  for (const [repositoryText, tail, forbidden] of [
    ['', /line endings are the whole difference/, /this repo has added/],
    ['mine/\r\n', /this repo has added its own below them/, /line endings are the whole difference/],
  ]) {
    const templates = makeTemplates({ append: 'dist/\n' });
    const target = syntheticTarget(templates);
    const scaffolded = readFileSync(join(target, '.gitignore'), 'utf8');
    const actual = scaffolded.replaceAll('\n', '\r\n') + repositoryText;
    writeFileSync(join(target, '.gitignore'), actual, 'utf8');
    const before = treeMap(target);

    const result = syncStandards(templates, target);

    const report = reportFor(result, '.gitignore');
    assert.equal(report.status, 'APPENDED_EXTENDED');
    assert.equal(report.disposition, 'REPORT_ONLY');
    assert.match(report.message, /^APPENDED CONTENT INTACT /);
    assert.match(report.message, tail);
    assert.doesNotMatch(report.message, forbidden);
    assert.doesNotMatch(report.message, /REFUSED/);
    assert.deepEqual(treeMap(target), before, 'a CRLF difference was rewritten');
    assert.equal(result.refused.some((r) => r.rel === '.gitignore'), false);
  }
});

test('#271 (FORGE-332) — an extended appended file keeps its manifest entry untouched', () => {
  // It is a standing condition, not a rebaseline. Recording the extended bytes
  // as daftplate's would claim authorship of the repository's lines and let a
  // later run overwrite them; dropping the entry would lose the provenance
  // entirely. `nextFiles` starts as a copy of the prior, so leaving it out is
  // what keeps it exactly as it was.
  const templates = makeTemplates({ append: 'dist/\n' });
  const target = syntheticTarget(templates);
  const scaffolded = readFileSync(join(target, '.gitignore'), 'utf8');
  const beforeManifest = readFileSync(join(target, '.daftplate.json'), 'utf8');
  writeFileSync(join(target, '.gitignore'), `${scaffolded}mine/\n`, 'utf8');

  syncStandards(templates, target);

  assert.equal(readFileSync(join(target, '.daftplate.json'), 'utf8'), beforeManifest,
    'an extended appended file rewrote its own provenance');
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
  const templates = makeTemplates();
  const treeBefore = treeMap(target);

  // Every fixture is built before the swap, so the only thing that ever writes
  // into `owned` is the run itself.
  const owned = withOwnedTempRoot(() => { syncStandards(templates, target); });

  assert.deepEqual(stagingDirs(owned), []);
  assert.deepEqual(treeMap(target), treeBefore);
});

test('sync removes the staging directory even when the run throws mid-flight', () => {
  // Retargeted: this used to make fileDigest throw EISDIR by putting a directory
  // at a recorded path, which #72 turned into an ordinary DIRECTORY refusal that
  // no longer throws at all. The subject was never the EISDIR — it is that
  // cleanup lives in a finally, so an injected write-time failure tests it just
  // as well and keeps testing it after the next such refusal is added.
  const target = syntheticTarget(makeTemplates());
  const templates = makeTemplates({ readme: '# <PROJECT_NAME> v2\n' });

  const owned = withOwnedTempRoot(() => {
    assert.throws(
      () => syncStandards(templates, target, {
        hooks: { beforeWrite: () => { throw new Error('injected mid-run failure'); } },
      }),
      /injected mid-run failure/,
    );
  });
  assert.deepEqual(stagingDirs(owned), []);
});

test('a directory at a newly produced path is refused without aborting the report', () => {
  // The whole run used to throw EISDIR out of the classification loop, so no
  // COLLISION line printed and every path sorted after it never classified —
  // one unowned directory cost the operator the entire report.
  const target = syntheticTarget(makeTemplates());
  mkdirSync(join(target, 'docs', 'guide.md'), { recursive: true });
  const identity = lstatSync(join(target, 'docs', 'guide.md')).isDirectory();

  const result = syncStandards(
    makeTemplates({ extra: { rel: 'docs/guide.md', body: '# guide\n' } }),
    target,
  );

  const report = result.reports.find((r) => r.rel === 'docs/guide.md');
  assert.equal(report.status, 'DIRECTORY');
  assert.equal(report.disposition, 'REFUSE');
  assert.match(report.message, /REFUSED DIRECTORY docs\/guide\.md/);
  assert.equal(lstatSync(join(target, 'docs', 'guide.md')).isDirectory(), identity);
  // The load-bearing half: a later path still classified.
  assert.equal(result.reports.some((r) => r.rel === 'README.md' && r.status === 'CURRENT'), true);
});

test('a directory at a recorded path is refused even when --restore names it', () => {
  const target = syntheticTarget(makeTemplates());
  rmSync(join(target, 'README.md'));
  mkdirSync(join(target, 'README.md'));

  const result = syncStandards(makeTemplates(), target, { restore: ['README.md'] });

  assert.equal(result.reports.find((r) => r.rel === 'README.md').status, 'DIRECTORY');
  assert.equal(result.restored.includes('README.md'), false);
  assert.equal(lstatSync(join(target, 'README.md')).isDirectory(), true);
  assert.equal(result.versionAdvanced, false);
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

// ---------------------------------------------------------------------------
// #237 (FORGE-305) -- three report lines that were not true.

/** Templates whose `docs/moved.md` is produced by the base layer, or by the
 *  profile layer, from byte-identical content. The bytes never change, so the
 *  path classifies CURRENT across the move and only its production differs. */
const movedProductionTemplates = (layer, body = '# stable bytes\n') => {
  const root = makeTemplates();
  write(root, `${layer === 'base' ? 'base/files' : 'profiles/demo/files'}/docs/moved.md`, body);
  return root;
};

test('a file deleted between classification and write is reported as vanished, not modified', () => {
  // The else at the write site covered two different things -- the digest moved,
  // and the file is gone -- and reported the first for both. "on-disk digest
  // differs" about a path with no bytes on disk is not a description of anything
  // that happened, and it points the operator at reconciling an edit nobody made.
  const templates = makeTemplates();
  const target = syntheticTarget(templates);
  const v2 = makeTemplates({ readme: '# <PROJECT_NAME> v2\n' });

  const result = syncStandards(v2, target, {
    hooks: { beforeWrite: (rel) => { if (rel === 'README.md') rmSync(join(target, 'README.md')); } },
  });

  const report = reportFor(result, 'README.md');
  assert.equal(report.outcome, 'VANISHED');
  assert.doesNotMatch(report.message, /on-disk digest differs/);
  assert.match(report.message, /--restore=README\.md/);
  assert.deepEqual(result.refused, [{ rel: 'README.md', status: 'VANISHED' }]);
});

test('a managed CURRENT entry whose production moved is refreshed in layer and mode only', () => {
  const target = syntheticTarget(movedProductionTemplates('base'));
  const before = readProvenance(target).files['docs/moved.md'];
  assert.deepEqual([before.layer, before.mode], ['base', 'copied']);

  const result = syncStandards(movedProductionTemplates('profile'), target);

  const after = readProvenance(target).files['docs/moved.md'];
  assert.equal(after.layer, 'profile');
  // Metadata only. The bytes never moved, so neither may the digest, and the
  // repository's ownership of the path is not this run's business.
  assert.equal(after.digest, before.digest);
  assert.equal(after.ownership, before.ownership);
  assert.equal(readFileSync(join(target, 'docs/moved.md'), 'utf8'), '# stable bytes\n');
  // The run says it did it, rather than changing the manifest silently.
  assert.match(reportFor(result, 'docs/moved.md').message, /layer/);
});

test('a path whose bytes also moved is an update, not a metadata refresh', () => {
  // The refresh is reached only through disposition NONE, and this is the case
  // that proves the guard is load-bearing rather than decorative. A dry run does
  // not act, so a condition keyed on "did not act" alone would catch a path whose
  // bytes moved as well as its layer, and report a metadata refresh for a file
  // that is genuinely out of date.
  const target = syntheticTarget(movedProductionTemplates('base'));
  const moved = movedProductionTemplates('profile', '# stable bytes, revised\n');

  const result = syncStandards(moved, target, { dryRun: true });

  const report = reportFor(result, 'docs/moved.md');
  assert.equal(report.outcome, 'WOULD_UPDATE');
  assert.equal(result.wouldUpdate.includes('docs/moved.md'), true);
});

test('a divergent path whose production moved is still not refreshed', () => {
  // G2, and the reason the refresh is scoped to managed entries. Divergence
  // already reports layer and mode movement as templateDrift; adopting it here
  // would silently take over a baseline the repository is meant to port by hand.
  const fixture = makeDivergentSyncFixture();
  const moved = makeTemplates({ append: 'dist/\n.cache/\n' });
  write(moved, 'profiles/demo/files-override/README.md', '# <PROJECT_NAME> v1\n');
  const before = readProvenance(fixture.target).files[fixture.rel];

  syncStandards(moved, fixture.target);

  assert.deepEqual(readProvenance(fixture.target).files[fixture.rel], before);
});

test('the appended-file refusal does not promise a report line that does not exist', () => {
  const templates = makeTemplates();
  const target = syntheticTarget(templates);
  // Restated by #271 (FORGE-332): the old fixture added `dist/` and `mine/`
  // below daftplate's line, which is now EXTENDED rather than a refusal. To keep
  // asserting what a REFUSAL promises, the fixture has to be a real edit of
  // daftplate's own line.
  writeFileSync(join(target, '.gitignore'), 'node_modules_renamed/\nmine/\n', 'utf8');

  const result = syncStandards(makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), target);

  const report = reportFor(result, '.gitignore');
  // The actionable half stays, and is sharper than it was: the run has checked
  // whether daftplate's own lines survive, so the refusal says they do not
  // rather than apologising that it cannot tell.
  assert.match(report.message, /lines daftplate appended are no longer in the file/);
  // The half that was never true stays gone. No report line carries template
  // bytes, and the staging tree that held them is deleted before a caller sees
  // this.
  assert.doesNotMatch(report.message, /in the report/);
});


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

// ---------------------------------------------------------------------------
// #235 (FORGE-304) -- a selector that matched nothing refuses the run, and an
// offer taken up under --dry-run reports what it would do.

test('--add naming a path daftplate does not produce refuses the run', () => {
  // Silent today, in every observable: no refusal, no report line, and a summary
  // reading `outstanding 0`. An operator who names five paths and mistypes one
  // reads a clean run and believes all five were adopted.
  const templates = makeTemplates();
  const target = syntheticTarget(templates);

  assert.throws(
    () => syncStandards(templates, target, { add: ['does/not/exist.md'] }),
    /does\/not\/exist\.md/,
  );
});

test('--add naming a managed, current path refuses and names the status it got', () => {
  // The reason the predicate cannot be --decline's. README.md IS produced by the
  // template, so "daftplate produces this path" accepts it -- and it is still not
  // something --add can adopt, because it was never offered.
  const templates = makeTemplates();
  const target = syntheticTarget(templates);

  assert.throws(
    () => syncStandards(templates, target, { add: ['README.md'] }),
    /CURRENT/,
  );
});

test('--restore naming a path that is present refuses', () => {
  const templates = makeTemplates();
  const target = syntheticTarget(templates);

  assert.throws(
    () => syncStandards(templates, target, { restore: ['README.md'] }),
    /README\.md/,
  );
});

test('--dry-run --add reports WOULD ADD rather than telling you to pass the flag you passed', () => {
  const templates = makeTemplates();
  const target = syntheticTarget(templates);
  const v2 = makeTemplates({ extra: { rel: 'docs/added.md', body: '# added\n' } });

  const result = syncStandards(v2, target, { add: ['docs/added.md'], dryRun: true });

  const report = reportFor(result, 'docs/added.md');
  assert.equal(report.outcome, 'WOULD_ADD');
  assert.doesNotMatch(report.message, /rerun with/);
  assert.deepEqual(result.wouldAdd, ['docs/added.md']);
  assert.equal(existsSync(join(target, 'docs/added.md')), false);
});

test('--dry-run --restore reports WOULD RESTORE', () => {
  const templates = makeTemplates();
  const target = syntheticTarget(templates);
  rmSync(join(target, 'README.md'));

  const result = syncStandards(templates, target, { restore: ['README.md'], dryRun: true });

  const report = reportFor(result, 'README.md');
  assert.equal(report.outcome, 'WOULD_RESTORE');
  assert.doesNotMatch(report.message, /rerun with/);
  assert.deepEqual(result.wouldRestore, ['README.md']);
  assert.equal(existsSync(join(target, 'README.md')), false);
});

test('a dry run with --add reports the same counts the real run produces', () => {
  // The whole point of a dry run. An offer the operator has already resolved is
  // not outstanding -- exactly the reasoning WOULD_DECLINE already follows.
  const templates = makeTemplates();
  const v2 = makeTemplates({ extra: { rel: 'docs/added.md', body: '# added\n' } });

  const dry = syncStandards(v2, syntheticTarget(templates), { add: ['docs/added.md'], dryRun: true });
  const real = syncStandards(v2, syntheticTarget(templates), { add: ['docs/added.md'] });

  assert.equal(
    formatSyncSummary(dry, true).replace(/^would update/, 'updated'),
    formatSyncSummary(real, false),
  );
});


test('a selector naming a path the report already accounts for does not refuse the run', () => {
  // The deliberate narrowing of D8, and the reason it is narrow. The defect is
  // SILENCE, not "the disposition was not an offer": a COLLISION reaches the
  // operator as its own report line, with its status, counted in `outstanding`.
  // Refusing the whole run for it would trade a complete report for an early
  // exit, and would break four behaviours this repository already ships.
  const templates = makeTemplates();
  const target = syntheticTarget(templates);
  const v2 = makeTemplates({ extra: { rel: 'docs/added.md', body: '# added\n' } });
  write(target, 'docs/added.md', '# mine, not daftplate\n');

  const result = syncStandards(v2, target, { add: ['docs/added.md'] });

  assert.deepEqual(result.refused, [{ rel: 'docs/added.md', status: 'COLLISION' }]);
  assert.equal(readFileSync(join(target, 'docs/added.md'), 'utf8'), '# mine, not daftplate\n');
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

// ---------------------------------------------------------------------------
// #242 (FORGE-316) -- the bump follows what the entries need, not the fact that
// a write happened.
//
// `manifestChanged` stopped meaning "a decline was just recorded" two phases
// ago: #237 (FORGE-305)'s CURRENT metadata refresh sets it, and so does every
// `--rebaseline` row from #119 (FORGE-201) P6/P7. Neither writes an entry that
// needs anything schema 1 cannot express, and docs/architecture.md's rule is
// that "the number advances when an entry needs a value the current number
// cannot express -- never because a write happened for some other reason".
// ---------------------------------------------------------------------------

/** A genuine schema 1 shape, in place: absence IS schema 1, so no schema key and
 *  no entry states its ownership. */
const downgradeToSchema1 = (target) => {
  const manifestPath = join(target, '.daftplate.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete manifest.schema;
  for (const entry of Object.values(manifest.files)) delete entry.ownership;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifestPath;
};

test('--rebaseline against a schema 1 target leaves it schema 1', () => {
  const fixture = makeConvergedSyncFixture();
  const manifestPath = downgradeToSchema1(fixture.target);

  const result = syncStandards(fixture.templates, fixture.target, { rebaseline: [fixture.rel] });

  // The row was written -- the assertion is about the number beside it, not
  // about whether anything happened.
  assert.equal(result.rebaselined.includes(fixture.rel), true);
  const written = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Absence is the sharper form of the claim: a manifest never states schema 1,
  // so asserting the key is gone catches a hybrid that declares 1 and carries
  // another shape as well as one that declares 3.
  assert.equal('schema' in written, false);
  assert.deepEqual(
    Object.entries(written.files).filter(([, e]) => 'ownership' in e).map(([rel]) => rel),
    [],
  );
  // And the repo an older checkout could read before the run can still read it.
  assert.doesNotThrow(() => readProvenance(fixture.target));
});

test('a CURRENT metadata refresh against a schema 1 target leaves it schema 1', () => {
  const target = syntheticTarget(movedProductionTemplates('base'));
  const manifestPath = downgradeToSchema1(target);

  const result = syncStandards(movedProductionTemplates('profile'), target);

  assert.match(reportFor(result, 'docs/moved.md').message, /layer/);
  const written = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(written.files['docs/moved.md'].layer, 'profile');
  assert.equal('schema' in written, false);
  assert.deepEqual(
    Object.entries(written.files).filter(([, e]) => 'ownership' in e).map(([rel]) => rel),
    [],
  );
});

/** A schema 3 target carrying exactly one declined entry, on a NEW path so
 *  `--add` can lift it. Two would make "the last decline" untestable. */
const makeSingleDeclineFixture = () => {
  const target = syntheticTarget(makeTemplates());
  const rel = 'CLAUDE.md';
  const manifest = readProvenance(target);
  const baseline = manifest.files[rel];
  rmSync(join(target, rel));
  manifest.files[rel] = {
    templateDigest: baseline.digest,
    layer: baseline.layer,
    mode: baseline.mode,
    ownership: 'declined',
  };
  writeProvenance(target, manifest);
  return { templates: makeTemplates(), target, rel };
};

test('a schema 3 manifest whose last decline is lifted stays schema 3', () => {
  // The bump never runs backwards. A rule expressed as "write what the entries
  // need" and nothing else would compute 1 here and hand an older checkout a
  // manifest this daftplate had already migrated -- the same class of surprise
  // as bumping too far, in the other direction.
  const fixture = makeSingleDeclineFixture();
  const manifestPath = join(fixture.target, '.daftplate.json');
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).schema, MAX_PROVENANCE_SCHEMA);

  const result = syncStandards(fixture.templates, fixture.target, { add: [fixture.rel] });

  assert.equal(result.added.includes(fixture.rel), true);
  const written = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(
    Object.values(written.files).some((e) => e.ownership === 'declined'),
    false,
    'the last decline really was lifted',
  );
  assert.equal(written.schema, MAX_PROVENANCE_SCHEMA);
});

test('a schema 3 manifest with a standing decline stays schema 3 through an unrelated update', () => {
  // The decline is on a path this run does not touch, so the number is required
  // by an entry the run never looked at. A rule reading only the entries it
  // wrote would drop to 1 and brick the manifest on the next read.
  const fixture = makeSingleDeclineFixture();
  const manifestPath = join(fixture.target, '.daftplate.json');

  const result = syncStandards(makeTemplates({ readme: '# <PROJECT_NAME> v2\n' }), fixture.target);

  assert.equal(result.updated.includes('README.md'), true);
  const written = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(written.files[fixture.rel].ownership, 'declined');
  assert.equal(written.schema, MAX_PROVENANCE_SCHEMA);
  assert.doesNotThrow(() => readProvenance(fixture.target));
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
  write(templates, 'profiles/demo/profile.md', '```profile\nverify: v\ntest: t\ndeploy: d\ndocs-subdirs: designs\nroadmap: optional\n```\n');
  write(templates, 'profiles/demo/files/gitignore-append', 'dist/\n');

  const { target, manifestPath } = legacyTarget(templates, { schema: 1, tokens: false });
  const before = readFileSync(manifestPath, 'utf8');
  assert.equal(before.includes('"tokens"'), false);

  syncStandards(templates, target);

  assert.equal(readFileSync(manifestPath, 'utf8'), before);
});

// ---------------------------------------------------------------------------
// #221 (FORGE-292) -- a manifest predating the tokens gate composes from nothing,
// and the substitution site refuses instead of writing `undefined`.

test('a sync against a manifest with no tokens refuses instead of writing `undefined` into a token-bearing file', () => {
  // The templates substitute, which the no-op above avoids on purpose (:1544).
  // That is the defect: sync destructures a token map that is not there, every
  // value is `undefined`, and the corrupted candidate differs from the recorded
  // digest while the file on disk still matches it -- so classify() returns
  // UPDATE, the one disposition that writes with no selector. The manifest is
  // then refreshed with the corrupted digests and the next run reports the repo
  // CURRENT, so there is no later run that finds it.
  const templates = makeTemplates({
    extra: { rel: 'LICENSE', body: 'Copyright (c) <YEAR> Someone\n' },
  });
  const { target } = legacyTarget(templates, { schema: 1, tokens: false });
  const before = treeMap(target);
  assert.match(readFileSync(join(target, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 Someone/);

  let thrown = null;
  try {
    syncStandards(templates, target);
  } catch (error) {
    thrown = error;
  }

  // Bytes first, and over the composed tree rather than over the inputs: a gate
  // that silently left `<YEAR>` unsubstituted removes the string `undefined` and
  // keeps the bug, because the candidate still differs from the recorded digest
  // and still gets written over the correct file.
  assert.deepEqual(treeMap(target), before);
  for (const [rel, b64] of Object.entries(treeMap(target))) {
    assert.equal(
      Buffer.from(b64, 'base64').toString('utf8').includes('undefined'), false,
      `${rel} carries a substituted undefined`,
    );
  }
  assert.ok(thrown, 'the sync composed from an absent token map without refusing');
  assert.match(thrown.message, /YEAR|PROJECT_NAME|PROJECT_SUMMARY/);
});

test('a sync against a manifest missing one token refuses and names the token that is missing', () => {
  // The partial case. A manifest short one key is not a different bug -- it is the
  // same one arriving one key at a time, which is why sync builds its map from
  // SCAFFOLD_INPUT_TOKENS rather than destructuring the two names it happens to
  // know about today. PROJECT_NAME is the one withheld because makeTemplates puts
  // it in README.md, which the composition reaches last: the refusal has to name
  // the token that is actually missing, not the first one it walked past.
  const templates = makeTemplates({
    extra: { rel: 'LICENSE', body: 'Copyright (c) <YEAR> Someone\n' },
  });
  const { target, manifestPath } = legacyTarget(templates, { schema: 1 });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.tokens = { YEAR: '2026', PROJECT_SUMMARY: 'A demo.' };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const before = treeMap(target);

  assert.throws(() => syncStandards(templates, target), /<PROJECT_NAME>/);
  assert.throws(() => syncStandards(templates, target), /README\.md/);

  assert.deepEqual(treeMap(target), before);
});

test('a manifest spelling a token `null` refuses exactly as an absent one does', () => {
  // `.daftplate.json` is JSON, which has no `undefined` -- `null` is the only way
  // a manifest can spell "declared, no value", and it reaches the substitution
  // site as a live own property. Left ungated it composes the string "null",
  // which is the same corruption in four letters instead of nine.
  const templates = makeTemplates({
    extra: { rel: 'LICENSE', body: 'Copyright (c) <YEAR> Someone\n' },
  });
  const { target, manifestPath } = legacyTarget(templates, { schema: 1 });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.tokens = { YEAR: null, PROJECT_NAME: 'demo-app', PROJECT_SUMMARY: 'A demo.' };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  assert.equal(readFileSync(manifestPath, 'utf8').includes('"YEAR": null'), true);
  const before = treeMap(target);

  assert.throws(() => syncStandards(templates, target), /<YEAR>/);

  assert.deepEqual(treeMap(target), before);
});

test('the refusal names the manifest that omitted the token and the route back', () => {
  // D2, the sync half. fillPlaceholders knows the token and the file; only sync
  // knows which manifest declared nothing and what an operator does about it.
  const templates = makeTemplates({
    extra: { rel: 'LICENSE', body: 'Copyright (c) <YEAR> Someone\n' },
  });
  const { target } = legacyTarget(templates, { schema: 1, tokens: false });

  assert.throws(() => syncStandards(templates, target), (error) => {
    assert.match(error.message, /\.daftplate\.json/);
    assert.match(error.message, /tokens/);
    return true;
  });
});

test('a manifest hand-repaired with a wrong token value still writes it, so recovery is not a guessing game', () => {
  // D3 says a wrong value is safe because every token-bearing file classifies
  // MODIFIED / REFUSE. Measured against this code, that holds only for a repo
  // already corrupted and restored from Git -- there the manifest records the
  // corrupted digests, so the restored file no longer matches its prior and
  // nothing is written. On a legacy repo that was never synced, the file on disk
  // still matches its prior digest, so classify() returns UPDATE and the wrong
  // value lands. This test pins the behaviour that is real, and the recovery note
  // says which of the two situations an operator is in.
  const templates = makeTemplates();
  const { target, manifestPath } = legacyTarget(templates, { schema: 1 });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.tokens = { YEAR: '2026', PROJECT_NAME: 'wrong-name', PROJECT_SUMMARY: 'Wrong.' };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const result = syncStandards(templates, target);

  assert.deepEqual(result.updated, ['CLAUDE.md', 'README.md']);
  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), '# wrong-name v1\n');
});

test('a corrupted repo restored from Git refuses every token-bearing file until it is re-baselined', () => {
  // The recovery path D3 is actually about, and the reason the note in
  // skills/sync-standards/SKILL.md cannot stop at "restore from Git". Simulate the
  // manifest a corrupted run left behind -- digests of the `undefined` bytes --
  // over files restored to their correct content.
  const templates = makeTemplates({
    extra: { rel: 'LICENSE', body: 'Copyright (c) <YEAR> Someone\n' },
  });
  const { target, manifestPath } = legacyTarget(templates, { schema: 1 });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.tokens = { YEAR: '2026', PROJECT_NAME: 'demo-app', PROJECT_SUMMARY: 'A demo.' };
  for (const rel of ['LICENSE', 'README.md', 'CLAUDE.md']) {
    manifest.files[rel].digest = `sha256:${'0'.repeat(64)}`;
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const before = treeMap(target);

  const result = syncStandards(templates, target);

  assert.deepEqual(result.updated, []);
  assert.deepEqual(
    result.refused.map((r) => r.rel).sort(),
    ['CLAUDE.md', 'LICENSE', 'README.md'],
  );
  assert.deepEqual(treeMap(target), before);
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

// --- staging can never be created inside the target (#72) --------------------

test('staging containment rejects a temp root equal to the target', () => {
  assert.equal(isWithin('/a/repo', '/a/repo'), true);
});

test('staging containment rejects a temp root below the target', () => {
  assert.equal(isWithin('/a/repo', '/a/repo/tmp'), true);
});

test('staging containment does not confuse a sibling for a child', () => {
  // A bare startsWith makes repo-other look like a child of repo, which would
  // refuse a perfectly legitimate sibling temp root.
  assert.equal(isWithin('/a/repo', '/a/repo-other'), false);
  assert.equal(isWithin('/a/repo', '/a'), false);
});

test('staging containment folds case on win32, where the filesystem does', { skip: process.platform !== 'win32' && 'win32 only' }, () => {
  // A drive letter in the other case names the same directory and defeated the
  // containment refusal outright. samePath() in enroll-repo.mjs has folded since
  // it was written; isWithin() answers the neighbouring question about the same
  // filesystem and did not.
  assert.equal(isWithin('X:/Projects/repo', 'x:/Projects/repo/tmp'), true);
  assert.equal(isWithin('x:/Projects/repo', 'X:/Projects/repo'), true);
  // The fold must not become a startsWith: a sibling is still not a child, in
  // either case.
  assert.equal(isWithin('X:/Projects/repo', 'x:/Projects/repo-other'), false);
});

test('staging containment does not fold case off win32, where the filesystem does not', { skip: process.platform === 'win32' && 'non-win32 only' }, () => {
  // The fold is platform-conditional for a reason: on a case-sensitive
  // filesystem /a/REPO and /a/repo are two directories, and folding everywhere
  // would refuse a legitimate temp root that merely spells a sibling similarly.
  assert.equal(isWithin('/a/repo', '/a/REPO/tmp'), false);
});

test('sync refuses before staging when the OS temp root is inside the target', () => {
  // TMPDIR=<target> used to put a full scaffold — a second .daftplate.json
  // included — inside the user's repository, then recursively remove it. Kill the
  // process before the finally and it stayed there.
  const templates = makeTemplates();
  const target = syntheticTarget(templates);
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  try {
    process.env.TMPDIR = target;
    process.env.TEMP = target;
    process.env.TMP = target;

    assert.throws(
      () => syncStandards(templates, target),
      /refusing to sync: the OS temp root is inside the target/,
    );
    assert.deepEqual(readdirSync(target).filter((n) => n.startsWith('daftplate-sync-')), []);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('staging cleanup uses the root captured at creation, not one read again later', () => {
  // Reading tmpdir() again inside removeStaging lets an environment change
  // between staging and cleanup turn a legitimate removal into a refusal.
  //
  // The whole point is which of two roots the staging is removed FROM, so both
  // are directories this test owns and both are measured — #231 (FORGE-301).
  // The old shape counted the process-wide root before the run and the MOVED
  // root after it, so it held only while the machine's temp root happened to
  // contain zero `daftplate-sync-*` entries; two of them turned correct code red.
  const templates = makeTemplates({ readme: '# <PROJECT_NAME> v2\n' });
  const target = syntheticTarget(makeTemplates());
  const moved = emptyDir();

  const owned = withOwnedTempRoot(() => {
    syncStandards(templates, target, {
      hooks: {
        beforeWrite: () => {
          process.env.TMPDIR = moved;
          process.env.TEMP = moved;
          process.env.TMP = moved;
        },
      },
    });
  });

  // Removed from the root captured at creation, which the environment no longer
  // names, and never created in the one it now names.
  assert.deepEqual(stagingDirs(owned), []);
  assert.deepEqual(stagingDirs(moved), []);
});

test('a fully current run leaves .daftplate.json untouched', () => {
  // versionAdvanced means "the sync resolved everything, so the version is
  // ENTITLED to advance" and is true on every clean run. Using it as the write
  // condition truncated and rewrote a byte-identical manifest every time —
  // harmless on an ordinary filesystem, an exception on a read-only one.
  const templates = makeTemplates();
  const target = syntheticTarget(templates);
  const manifestPath = join(target, '.daftplate.json');
  const before = statSync(manifestPath, { bigint: true });
  const bytes = readFileSync(manifestPath, 'utf8');

  const result = syncStandards(templates, target);
  const after = statSync(manifestPath, { bigint: true });

  assert.deepEqual(result.updated, []);
  assert.equal(readFileSync(manifestPath, 'utf8'), bytes);
  assert.equal(after.mtimeNs, before.mtimeNs);
  // ino is 0n on some Windows filesystems; assert identity only where it is real.
  if (before.ino !== 0n) assert.equal(after.ino, before.ino);
});

// --- a failed sync rolls back what it landed (#72) ---------------------------
//
// Rollback-safe for handled synchronous failures. NOT atomic across process
// termination or a hostile filesystem race: nothing here survives a kill -9
// between two writes, and the tests below inject failures rather than claiming
// otherwise.

/** Templates whose base layer writes two extra managed files, so a sync has more
 *  than one write to land and a failure can fall between them. */
const twoWriteTemplates = (version) => {
  const root = makeTemplates({ readme: `# <PROJECT_NAME> ${version}\n` });
  write(root, 'base/files/docs/one.md', `# one ${version}\n`);
  write(root, 'base/files/docs/two.md', `# two ${version}\n`);
  return root;
};

test('a failure before the second write restores the first write and original manifest', () => {
  const target = syntheticTarget(twoWriteTemplates('v1'));
  const before = treeMap(target);
  let seen = 0;

  assert.throws(
    () => syncStandards(twoWriteTemplates('v2'), target, {
      hooks: {
        beforeWrite: () => {
          seen += 1;
          if (seen === 2) throw new Error('injected failure before the second write');
        },
      },
    }),
    /injected failure before the second write/,
  );

  assert.deepEqual(treeMap(target), before);
  // The load-bearing half: the next sync must not classify the rolled-back
  // attempt's writes as MODIFIED, which is unrecoverable without hand-editing.
  const again = syncStandards(twoWriteTemplates('v2'), target);
  assert.deepEqual(again.refused, []);
});

test('a failure immediately before provenance restores every landed target write', () => {
  const templates = twoWriteTemplates('v1');
  const target = syntheticTarget(templates);
  const before = treeMap(target);
  let writes = 0;

  assert.throws(
    () => syncStandards(twoWriteTemplates('v2'), target, {
      hooks: {
        beforeWrite: () => { writes += 1; },
        // Fires only after every file write has landed, so this kills the
        // mutation that rolls back only failures raised inside the path loop.
        afterProvenance: () => { throw new Error('injected failure after provenance'); },
      },
    }),
    /injected failure after provenance/,
  );

  assert.ok(writes >= 1, 'the fixture never reached a write');
  assert.deepEqual(treeMap(target), before);
});

test('a failure after provenance restores both the files and the prior manifest', () => {
  const target = syntheticTarget(twoWriteTemplates('v1'));
  const manifestBytes = readFileSync(join(target, '.daftplate.json'), 'utf8');

  assert.throws(
    () => syncStandards(twoWriteTemplates('v2'), target, {
      hooks: { afterProvenance: () => { throw new Error('injected post-provenance failure'); } },
    }),
    /injected post-provenance failure/,
  );

  // Restoring files while leaving new provenance behind would leave the repo
  // describing a state it is no longer in.
  assert.equal(readFileSync(join(target, '.daftplate.json'), 'utf8'), manifestBytes);
});

test('rollback of an added path removes only the file this sync created', () => {
  const target = syntheticTarget(makeTemplates());
  // A sibling the sync never touches, in the directory the added path lives in.
  mkdirSync(join(target, 'docs'), { recursive: true });
  writeFileSync(join(target, 'docs', 'sentinel.md'), '# mine\n', 'utf8');
  const before = treeMap(target);

  assert.throws(
    () => syncStandards(makeTemplates({ extra: { rel: 'docs/added.md', body: '# added\n' } }), target, {
      add: ['docs/added.md'],
      hooks: { afterProvenance: () => { throw new Error('injected failure after the add') } },
    }),
    /injected failure after the add/,
  );

  assert.equal(existsSync(join(target, 'docs', 'added.md')), false);
  // Kills the mutation that removes a parent directory or cleans by location.
  assert.equal(readFileSync(join(target, 'docs', 'sentinel.md'), 'utf8'), '# mine\n');
  assert.deepEqual(treeMap(target), before);
});

// ---------------------------------------------------------------------------
// #222 (FORGE-293) -- the manifest is published atomically and journalled before
// it is written, and rollback stops calling a file already in its pre-run state
// a file somebody changed.

const epermRename = () => Object.assign(new Error('busy'), { code: 'EPERM' });

test('the manifest write is journalled before it can land, so a failure the instant after it restores the prior manifest', () => {
  // The window the old ordering left open, and the only one that mattered: the
  // write HAS landed and nothing records it. The backup copy, its mkdirSync and a
  // fileDigest of the freshly written path all sat between the write and the
  // journal push, and each of them throws into the state the comment above them
  // claimed was prevented -- files restored, new provenance left beside them.
  //
  // Injected by publishing for real and then failing, because that is the shape
  // of the failure. A refusal is not enough: nothing landed, so every ordering
  // looks correct.
  const target = syntheticTarget(twoWriteTemplates('v1'));
  const before = treeMap(target);

  assert.throws(
    () => syncStandards(twoWriteTemplates('v2'), target, {
      hooks: {
        renameProvenance: (from, to) => {
          renameSync(from, to);
          throw new Error('injected failure the instant the manifest landed');
        },
      },
    }),
    /injected failure the instant the manifest landed/,
  );

  assert.deepEqual(treeMap(target), before);
});

test('a manifest write refused by the atomic writer restores every file and leaves the prior manifest', () => {
  const target = syntheticTarget(twoWriteTemplates('v1'));
  const before = treeMap(target);

  let error;
  assert.throws(
    () => syncStandards(twoWriteTemplates('v2'), target, {
      hooks: { renameProvenance: () => { throw epermRename(); } },
    }),
    (err) => { error = err; return true; },
  );

  // Journalling the manifest BEFORE the write makes one new state reachable: the
  // entry exists and the write never landed. Rollback has to read that as nothing
  // to undo -- reading it as "changed after this sync wrote it" would escalate a
  // clean, fully-recoverable failure into the retained-staging AggregateError
  // path, which tells the operator to reconcile by hand for no reason.
  assert.equal(error instanceof AggregateError, false, error.message);
  assert.match(error.message, /\.daftplate\.json/);
  assert.doesNotMatch(error.message, /changed after this sync wrote it/);
  assert.deepEqual(treeMap(target), before);

  // The load-bearing half, as everywhere else in this section: the next sync must
  // not classify the rolled-back attempt's writes as MODIFIED.
  const again = syncStandards(twoWriteTemplates('v2'), target);
  assert.deepEqual(again.refused, []);
});

test('rollback treats a file already equal to its backup as nothing to undo', () => {
  // D5, independent of the manifest. Somebody reverts a landed write to its
  // pre-run bytes and the run then fails. The file is already in the state
  // rollback exists to put it in, so there is nothing to undo -- but the digest
  // check sees bytes that are not what this sync wrote and refuses, which is a
  // frightening message about a file nobody harmed and an AggregateError nobody
  // needs.
  const target = syntheticTarget(twoWriteTemplates('v1'));
  const original = readFileSync(join(target, 'docs/one.md'), 'utf8');
  const before = treeMap(target);
  let seen = 0;

  let error;
  assert.throws(
    () => syncStandards(twoWriteTemplates('v2'), target, {
      hooks: {
        beforeWrite: (rel) => {
          seen += 1;
          if (seen === 3) {
            writeFileSync(join(target, 'docs/one.md'), original, 'utf8');
            throw new Error('injected failure after an outside revert');
          }
          return rel;
        },
      },
    }),
    (err) => { error = err; return true; },
  );

  assert.ok(seen >= 3, 'the fixture never reached the third write');
  assert.equal(error instanceof AggregateError, false, error.message);
  assert.match(error.message, /injected failure after an outside revert/);
  assert.deepEqual(treeMap(target), before);
});

test('rollback refuses to overwrite a path changed after the sync wrote it', () => {
  const target = syntheticTarget(twoWriteTemplates('v1'));
  let seen = 0;

  let error;
  assert.throws(
    () => syncStandards(twoWriteTemplates('v2'), target, {
      hooks: {
        beforeWrite: (rel) => {
          seen += 1;
          if (seen === 2) {
            // Somebody else edits the FIRST landed path, then the run fails.
            writeFileSync(join(target, 'README.md'), 'someone else\n', 'utf8');
            throw new Error('injected failure after an intervening edit');
          }
          return rel;
        },
      },
    }),
    (err) => { error = err; return err instanceof AggregateError; },
  );

  // The intervening bytes survive: overwriting them is the one outcome worse
  // than leaving the sync half-applied.
  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), 'someone else\n');
  assert.match(error.message, /could not be fully rolled back/);
  assert.match(error.message, /changed after this sync wrote it/);
  assert.match(error.message, /recovery material retained at/);
  assert.match(error.message, /no further overwrite or deletion was attempted/);

  // Staging is retained as evidence. Remove only the exact directory this
  // invocation named, after confirming it is one.
  const retained = error.message.match(/recovery material retained at (.+)/)[1].trim();
  assert.equal(retained.includes('daftplate-sync-'), true);
  rmSync(retained, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// #119 (FORGE-201) Phase 6 -- --rebaseline, byte-converged managed entries only
// ---------------------------------------------------------------------------

/** A target scaffolded from v1 whose README.md holds exactly the bytes v2
 *  produces, while the manifest still records v1's digest.
 *
 *  This is the tail of #221's recovery procedure -- tokens repaired by hand,
 *  files restored from Git, and a manifest left describing bytes that are no
 *  longer there. classify() reads it as MODIFIED and refuses, on this run and
 *  on every run after it, because matching bytes are not evidence of where they
 *  came from. --rebaseline is the one act that ends it. */
const makeConvergedSyncFixture = () => {
  const v2 = makeTemplates({ readme: '# <PROJECT_NAME> v2\n' });
  const target = syntheticTarget(makeTemplates());
  const rel = 'README.md';
  // Taken from a real composition rather than spelled out here, so the fixture
  // cannot drift from what scaffold() actually substitutes.
  const candidatePath = join(syntheticTarget(v2), rel);
  writeFileSync(join(target, rel), readFileSync(candidatePath, 'utf8'), 'utf8');
  return {
    templates: v2,
    target,
    rel,
    converged: readFileSync(candidatePath, 'utf8'),
    candidateDigest: fileDigest(candidatePath),
    priorDigest: readProvenance(target).files[rel].digest,
  };
};

test('a managed path whose bytes already equal the candidate is refused until it is re-baselined', () => {
  const fixture = makeConvergedSyncFixture();

  // The state this phase exists to end: reported, permanent, and holding the
  // version back on a path no ordinary run can ever resolve.
  const before = syncStandards(fixture.templates, fixture.target, { dryRun: true });
  assert.equal(reportFor(before, fixture.rel).outcome, 'MODIFIED');
  assert.equal(before.versionAdvanced, false);

  const result = syncStandards(fixture.templates, fixture.target, { rebaseline: [fixture.rel] });

  const entry = readProvenance(fixture.target).files[fixture.rel];
  assert.equal(entry.digest, fileDigest(join(fixture.target, fixture.rel)));
  assert.notEqual(entry.digest, fixture.priorDigest);
  // Ownership is not this run's answer to give, and a managed entry carrying a
  // templateDigest is invalid (validateEntry in provenance.mjs).
  assert.equal(entry.ownership, 'managed');
  assert.equal('templateDigest' in entry, false);
  assert.equal(readFileSync(join(fixture.target, fixture.rel), 'utf8'), fixture.converged);

  assert.equal(reportFor(result, fixture.rel).outcome, 'REBASELINED');
  assert.deepEqual(result.rebaselined, [fixture.rel]);
  assert.equal(result.refused.length + result.offered.length, 0);
  assert.equal(result.versionAdvanced, true);

  // A transition that produces a manifest the next read refuses is worse than
  // the dead end it replaced, so the round trip is asserted here rather than
  // inferred from the write having succeeded.
  const after = syncStandards(fixture.templates, fixture.target, { dryRun: true });
  assert.equal(reportFor(after, fixture.rel).outcome, 'CURRENT');
});

test('--rebaseline refuses a managed path whose bytes still differ from the candidate', () => {
  // The row that must never write. Convergence is what makes the safe rows
  // safe: recording ownership over bytes that still differ would claim
  // daftplate authored what it did not.
  //
  // Same shape as the divergent twin, for the same reason: the interesting
  // failure is a run that succeeds and records something, not one that throws
  // the wrong message.
  const fixture = makeConvergedSyncFixture();
  writeFileSync(join(fixture.target, fixture.rel), '# neither one nor the other\n', 'utf8');
  const manifestBefore = readFileSync(join(fixture.target, '.daftplate.json'), 'utf8');
  const onDisk = fileDigest(join(fixture.target, fixture.rel));
  let thrown = null;
  try {
    syncStandards(fixture.templates, fixture.target, { rebaseline: [fixture.rel] });
  } catch (error) {
    thrown = error;
  }

  assert.equal(readFileSync(join(fixture.target, '.daftplate.json'), 'utf8'), manifestBefore);
  assert.equal(readFileSync(join(fixture.target, fixture.rel), 'utf8'), '# neither one nor the other\n');
  assert.notEqual(thrown, null);
  assert.match(thrown.message, /--rebaseline cannot name README\.md/);
  // Both digests, because the operator's next question is which is which.
  assert.equal(thrown.message.includes(onDisk), true);
  assert.equal(thrown.message.includes(fixture.candidateDigest), true);
});

test('--rebaseline refuses a managed path whose file is absent and points at --restore', () => {
  const fixture = makeConvergedSyncFixture();
  rmSync(join(fixture.target, fixture.rel));

  assert.throws(
    () => syncStandards(fixture.templates, fixture.target, { rebaseline: [fixture.rel] }),
    /--rebaseline cannot name README\.md; the file is absent.*--restore=README\.md/s,
  );
});

test('--rebaseline writes no repository bytes', () => {
  const fixture = makeConvergedSyncFixture();
  const before = treeMap(fixture.target);
  const mtimeBefore = statSync(join(fixture.target, fixture.rel)).mtimeMs;

  syncStandards(fixture.templates, fixture.target, { rebaseline: [fixture.rel] });

  const after = treeMap(fixture.target);
  // The manifest is the only thing this run is entitled to change, and it did.
  assert.notEqual(after['.daftplate.json'], before['.daftplate.json']);
  delete before['.daftplate.json'];
  delete after['.daftplate.json'];
  assert.deepEqual(after, before);
  // Bytes alone would not catch a rewrite with identical content, which is
  // still a write, and still G2.
  assert.equal(statSync(join(fixture.target, fixture.rel)).mtimeMs, mtimeBefore);
});

test('--dry-run --rebaseline reports WOULD REBASELINE and writes nothing', () => {
  const fixture = makeConvergedSyncFixture();
  const before = readFileSync(join(fixture.target, '.daftplate.json'), 'utf8');

  const result = syncStandards(fixture.templates, fixture.target, {
    rebaseline: [fixture.rel], dryRun: true,
  });

  assert.equal(readFileSync(join(fixture.target, '.daftplate.json'), 'utf8'), before);
  const report = reportFor(result, fixture.rel);
  assert.equal(report.outcome, 'WOULD_REBASELINE');
  assert.match(report.message, /^WOULD REBASELINE/);
  assert.deepEqual(result.wouldRebaseline, [fixture.rel]);
  assert.deepEqual(result.rebaselined, []);
  // The same rule --dry-run --add follows: the operator has decided, so the
  // counts a dry run prints are the counts the real run will produce.
  assert.equal(result.refused.length + result.offered.length, 0);
});

test('an overridden path whose profile dropped the override can be re-baselined onto base', () => {
  // D11's row 13. classify()'s OVERRIDDEN gate sits above the digest checks, so
  // this path never reaches MODIFIED -- and it costs the same equality check,
  // which is why it ships here rather than in Phase 7.
  const overriding = makeTemplates();
  write(overriding, 'profiles/demo/files-override/README.md', '# <PROJECT_NAME> override\n');
  const target = syntheticTarget(overriding);
  const beforeEntry = readProvenance(target).files['README.md'];
  assert.deepEqual([beforeEntry.layer, beforeEntry.mode], ['profile', 'overridden']);

  // The profile drops its override, and the repository already holds the base
  // bytes, so there is nothing left to port.
  const base = makeTemplates();
  writeFileSync(
    join(target, 'README.md'),
    readFileSync(join(syntheticTarget(base), 'README.md'), 'utf8'),
    'utf8',
  );
  assert.equal(reportFor(syncStandards(base, target, { dryRun: true }), 'README.md').outcome, 'OVERRIDDEN');

  const result = syncStandards(base, target, { rebaseline: ['README.md'] });

  const entry = readProvenance(target).files['README.md'];
  assert.deepEqual([entry.layer, entry.mode], ['base', 'copied']);
  assert.equal(entry.digest, fileDigest(join(target, 'README.md')));
  assert.equal(reportFor(result, 'README.md').outcome, 'REBASELINED');
});

test('--rebaseline on a path that is already current changes nothing and is not silent', () => {
  // Not a refusal: the predicate holds, because the bytes do equal the
  // candidate. There is simply nothing to record that is not already recorded,
  // so the run reports CURRENT and leaves the manifest byte-identical.
  const templates = makeTemplates();
  const target = syntheticTarget(templates);
  const before = readFileSync(join(target, '.daftplate.json'), 'utf8');

  const result = syncStandards(templates, target, { rebaseline: ['README.md'] });

  assert.equal(reportFor(result, 'README.md').outcome, 'CURRENT');
  assert.deepEqual(result.rebaselined, []);
  assert.equal(readFileSync(join(target, '.daftplate.json'), 'utf8'), before);
});

test('the summary counts re-baselined paths, and omits the term when there are none', () => {
  const fixture = makeConvergedSyncFixture();

  const dry = syncStandards(fixture.templates, fixture.target, {
    rebaseline: [fixture.rel], dryRun: true,
  });
  assert.match(formatSyncSummary(dry, true), /would re-baseline 1/);

  const real = syncStandards(fixture.templates, fixture.target, { rebaseline: [fixture.rel] });
  assert.match(formatSyncSummary(real, false), /re-baselined 1/);

  // A permanent "re-baselined 0" would train the eye past the one term that
  // means an ownership baseline moved -- the rule diverged and declined follow.
  const quiet = syncStandards(fixture.templates, fixture.target);
  assert.doesNotMatch(formatSyncSummary(quiet, false), /re-baselined/);
});

// ---------------------------------------------------------------------------
// #119 (FORGE-201) Phase 7 -- --rebaseline across the remaining ownerships
// ---------------------------------------------------------------------------

/** makeDivergentSyncFixture, with the repository-owned README.md replaced by
 *  exactly the bytes today's template produces. The drift is gone and measured,
 *  which is the whole of what separates this from the alternative D9 rejected. */
const makeConvergedDivergentFixture = () => {
  const fixture = makeDivergentSyncFixture();
  const candidatePath = join(syntheticTarget(fixture.templates), fixture.rel);
  writeFileSync(join(fixture.target, fixture.rel), readFileSync(candidatePath, 'utf8'), 'utf8');
  return { ...fixture, candidateDigest: fileDigest(candidatePath) };
};

test('a divergent path whose bytes equal the candidate is adopted as managed', () => {
  // R1. Not the case D9 rejected: D9's objection is about turning unported
  // template drift into "unchanged", and here the difference must be gone,
  // measured, at the moment of the write. There is no drift to launder.
  const fixture = makeConvergedDivergentFixture();
  const before = readFileSync(join(fixture.target, fixture.rel), 'utf8');

  const result = syncStandards(fixture.templates, fixture.target, { rebaseline: [fixture.rel] });

  const entry = readProvenance(fixture.target).files[fixture.rel];
  assert.equal(entry.ownership, 'managed');
  assert.equal(entry.digest, fileDigest(join(fixture.target, fixture.rel)));
  // A managed entry carrying a templateDigest is invalid, so adoption must drop
  // it rather than leave it as a fossil.
  assert.equal('templateDigest' in entry, false);
  assert.equal(readFileSync(join(fixture.target, fixture.rel), 'utf8'), before);
  assert.equal(reportFor(result, fixture.rel).outcome, 'REBASELINED_ADOPTED');
  assert.deepEqual(result.rebaselined, [fixture.rel]);
  assert.deepEqual(result.diverged, []);

  // The manifest the next read gets must be one it accepts, and the path must
  // now behave like any other managed path.
  const after = syncStandards(fixture.templates, fixture.target, { dryRun: true });
  assert.equal(reportFor(after, fixture.rel).outcome, 'CURRENT');
});

test('a divergent path whose bytes still differ is refused, and says why', () => {
  // The boundary. This is D9's objection exactly, and it still stands.
  //
  // Deliberately NOT written as assert.throws. The mutant this test exists to
  // kill -- dropping the convergence condition on the divergent row -- does not
  // throw at all: it adopts. A test that asserts only the exception would report
  // a missing throw and never look at what got written, so the claim that
  // matters is checked first and on the manifest itself.
  const fixture = makeDivergentSyncFixture();
  let thrown = null;
  try {
    syncStandards(fixture.templates, fixture.target, { rebaseline: [fixture.rel] });
  } catch (error) {
    thrown = error;
  }

  assert.deepEqual(readProvenance(fixture.target).files[fixture.rel], fixture.divergentBaseline);
  assert.notEqual(thrown, null);
  assert.match(thrown.message, /--rebaseline cannot name README\.md/);
  assert.match(thrown.message, /still differ/);
  // D9 is named, because the operator's next move is to port the drift by hand.
  assert.match(thrown.message, /without a port or review/);
  assert.equal(thrown.message.includes(fileDigest(join(fixture.target, fixture.rel))), true);
});

test('a declined path holding the template bytes becomes managed', () => {
  // R2, the converged half. CLAUDE.md was declined while holding exactly the
  // bytes the template produces, which is the mistaken-decline case.
  const fixture = makeDeclinedSyncFixture();
  const rel = fixture.collisionRel;
  const before = readFileSync(join(fixture.target, rel), 'utf8');

  const result = syncStandards(fixture.templates, fixture.target, { rebaseline: [rel] });

  const entry = readProvenance(fixture.target).files[rel];
  assert.equal(entry.ownership, 'managed');
  assert.equal(entry.digest, fileDigest(join(fixture.target, rel)));
  assert.equal('templateDigest' in entry, false);
  assert.equal(readFileSync(join(fixture.target, rel), 'utf8'), before);
  assert.equal(reportFor(result, rel).outcome, 'REBASELINED_ADOPTED');
  assert.equal(result.declined.some((d) => d.rel === rel), false);

  const after = syncStandards(fixture.templates, fixture.target, { dryRun: true });
  assert.equal(reportFor(after, rel).outcome, 'CURRENT');
});

test('a declined path holding different bytes becomes diverged with both baselines', () => {
  // R2, the unconverged half -- and the one row of D11 that does NOT require
  // convergence, because `diverged` is what is measurably true of a path
  // holding bytes daftplate did not write. It still writes none.
  const fixture = makeDeclinedSyncFixture();
  const rel = fixture.collisionRel;
  writeFileSync(join(fixture.target, rel), '# the repository wrote this\n', 'utf8');
  const candidateDigest = fileDigest(join(syntheticTarget(fixture.templates), rel));

  const result = syncStandards(fixture.templates, fixture.target, { rebaseline: [rel] });

  const entry = readProvenance(fixture.target).files[rel];
  assert.equal(entry.ownership, 'diverged');
  assert.equal(entry.digest, fileDigest(join(fixture.target, rel)));
  assert.equal(entry.templateDigest, candidateDigest);
  assert.notEqual(entry.digest, entry.templateDigest);
  assert.equal(readFileSync(join(fixture.target, rel), 'utf8'), '# the repository wrote this\n');
  assert.equal(reportFor(result, rel).outcome, 'REBASELINED_DIVERGED');

  // Round trip: the next run must read it as the divergence it now is, with
  // neither baseline drifting.
  const after = syncStandards(fixture.templates, fixture.target, { dryRun: true });
  const report = reportFor(after, rel);
  assert.equal(report.outcome, 'DIVERGED');
  assert.equal(report.repoDrift, 'UNCHANGED');
  assert.equal(report.templateDrift, 'UNCHANGED');
});

test('a declined path with no file is refused and points at --add', () => {
  // D2 of #123 already lifts a decline on a path with nothing at it, and it is
  // the selector that writes the file rather than one that records around it.
  const fixture = makeDeclinedSyncFixture();

  assert.throws(
    () => syncStandards(fixture.templates, fixture.target, { rebaseline: [fixture.newRel] }),
    /--rebaseline cannot name README\.md; .*no file.*--add=README\.md/s,
  );
});

test('--rebaseline still refuses an unrecorded and an unproduced path', () => {
  // What is left of Phase 6's boundary marker after Phase 7 moved the line. The
  // divergent and declined rows above used to live here; these two do not move.
  const fresh = syntheticTarget(makeTemplates());
  const gained = makeTemplates({ extra: { rel: 'dot-github/dependabot.yml', body: 'version: 2\n' } });
  assert.throws(
    () => syncStandards(gained, fresh, { rebaseline: ['.github/dependabot.yml'] }),
    /--rebaseline cannot name \.github\/dependabot\.yml; .*no provenance/s,
  );

  assert.throws(
    () => syncStandards(makeTemplates(), syntheticTarget(makeTemplates()), { rebaseline: ['docs/nope.md'] }),
    /--rebaseline cannot name docs\/nope\.md; daftplate does not produce this path today/,
  );
});

test('a divergent path with no file is refused without pointing at --restore', () => {
  // --restore refuses a divergent selector outright (preflight A), so naming it
  // here would send the operator to a command that cannot help them.
  const fixture = makeDivergentSyncFixture();
  rmSync(join(fixture.target, fixture.rel));

  assert.throws(
    () => syncStandards(fixture.templates, fixture.target, { rebaseline: [fixture.rel] }),
    (error) => {
      assert.match(error.message, /--rebaseline cannot name README\.md; the file is absent/);
      assert.doesNotMatch(error.message, /--restore/);
      return true;
    },
  );
});

test('--rebaseline across every ownership writes no repository bytes', () => {
  // G2 over the rows Phase 7 adds, not just Phase 6's. The declined fixture's
  // template also moves a MANAGED .gitignore -- deliberately, so a decline does
  // not block work on paths daftplate owns -- so the claim under test is not
  // "this run wrote nothing" but "this run wrote nothing it did not report as an
  // ordinary write". A blanket tree comparison would assert the weaker thing and
  // pass for the wrong reason.
  for (const build of [makeConvergedDivergentFixture, makeDeclinedSyncFixture]) {
    const fixture = build();
    const rel = fixture.rel ?? fixture.collisionRel;
    const before = treeMap(fixture.target);
    const mtimeBefore = statSync(join(fixture.target, rel)).mtimeMs;

    const result = syncStandards(fixture.templates, fixture.target, { rebaseline: [rel] });

    const after = treeMap(fixture.target);
    const changed = Object.keys({ ...before, ...after })
      .filter((path) => before[path] !== after[path])
      .sort();
    assert.deepEqual(changed, ['.daftplate.json', ...result.updated].sort());
    assert.equal(changed.includes(rel), false);
    assert.equal(after[rel], before[rel]);
    assert.equal(statSync(join(fixture.target, rel)).mtimeMs, mtimeBefore);
  }
});

test('--dry-run reports the adoption it would make and writes nothing', () => {
  const fixture = makeConvergedDivergentFixture();
  const before = readFileSync(join(fixture.target, '.daftplate.json'), 'utf8');

  const result = syncStandards(fixture.templates, fixture.target, {
    rebaseline: [fixture.rel], dryRun: true,
  });

  assert.equal(readFileSync(join(fixture.target, '.daftplate.json'), 'utf8'), before);
  const report = reportFor(result, fixture.rel);
  assert.equal(report.outcome, 'WOULD_REBASELINE_ADOPTED');
  assert.match(report.message, /^WOULD REBASELINE/);
  assert.deepEqual(result.wouldRebaseline, [fixture.rel]);
  // Still reported as the divergence it is until the real run changes it.
  assert.equal(readProvenance(fixture.target).files[fixture.rel].ownership, 'diverged');
});

test('--rebaseline and --add cannot both name the same path', () => {
  // --add lifts a decline and writes the template bytes; --rebaseline records
  // the bytes already there. Naming both is a contradiction, not a selection,
  // and it is refused rather than arbitrarily resolved.
  const fixture = makeDeclinedSyncFixture();

  assert.throws(
    () => syncStandards(fixture.templates, fixture.target, {
      rebaseline: [fixture.collisionRel], add: [fixture.collisionRel],
    }),
    /--rebaseline and --add cannot both name CLAUDE\.md/,
  );
});

test('--dry-run reports the divergence it would record, and writes nothing', () => {
  // The one (kind, dryRun) pair with no coverage. Collapse the diverged pair in
  // REBASELINE_OUTCOMES to its real-run slot and a dry run then claims
  // .daftplate.json "now records it as diverged" while writing nothing at all.
  const fixture = makeDeclinedSyncFixture();
  const rel = fixture.collisionRel;
  writeFileSync(join(fixture.target, rel), '# the repository wrote this\n', 'utf8');
  const before = readFileSync(join(fixture.target, '.daftplate.json'), 'utf8');

  const result = syncStandards(fixture.templates, fixture.target, {
    rebaseline: [rel], dryRun: true,
  });

  assert.equal(readFileSync(join(fixture.target, '.daftplate.json'), 'utf8'), before);
  assert.equal(readProvenance(fixture.target).files[rel].ownership, 'declined');
  const report = reportFor(result, rel);
  assert.equal(report.outcome, 'WOULD_REBASELINE_DIVERGED');
  assert.match(report.message, /^WOULD REBASELINE/);
  assert.match(report.message, /would be recorded as diverged/);
  assert.doesNotMatch(report.message, /now records/);
  assert.deepEqual(result.wouldRebaseline, [rel]);
});

test('--rebaseline cannot be combined with --restore or --decline either', () => {
  // The contradiction preflight loops over three selectors and only the --add arm
  // was exercised. Shrink the loop to --add alone and both of these run on.
  const fixture = makeConvergedSyncFixture();
  assert.throws(
    () => syncStandards(fixture.templates, fixture.target, {
      rebaseline: [fixture.rel], restore: [fixture.rel],
    }),
    /--rebaseline and --restore cannot both name README\.md/,
  );

  // A declined prior, so this reaches the contradiction check rather than the
  // earlier "--decline cannot name a managed path" guard.
  const declined = makeDeclinedSyncFixture();
  assert.throws(
    () => syncStandards(declined.templates, declined.target, {
      rebaseline: [declined.collisionRel], decline: [declined.collisionRel],
    }),
    /--rebaseline and --decline cannot both name CLAUDE\.md/,
  );
});

test('each re-baseline prints a line that says what it did and that nothing was written', () => {
  // result.reports[].message is what main() prints verbatim, so it is the surface
  // the operator reads. Asserting only .outcome leaves every one of these three
  // messages free to say the wrong thing -- including that a file was written.
  const managed = makeConvergedSyncFixture();
  const managedLine = reportFor(
    syncStandards(managed.templates, managed.target, { rebaseline: [managed.rel] }),
    managed.rel,
  ).message;
  assert.match(managedLine, /^REBASELINED README\.md — on-disk bytes already equal/);
  assert.match(managedLine, /no file was written/);
  assert.doesNotMatch(managedLine, /managed|diverged/);

  const adopted = makeConvergedDivergentFixture();
  const adoptedLine = reportFor(
    syncStandards(adopted.templates, adopted.target, { rebaseline: [adopted.rel] }),
    adopted.rel,
  ).message;
  assert.match(adoptedLine, /^REBASELINED README\.md — /);
  assert.match(adoptedLine, /records the path as managed/);
  assert.match(adoptedLine, /no file was written/);

  const toDiverged = makeDeclinedSyncFixture();
  writeFileSync(join(toDiverged.target, toDiverged.collisionRel), '# repository bytes\n', 'utf8');
  const divergedLine = reportFor(
    syncStandards(toDiverged.templates, toDiverged.target, { rebaseline: [toDiverged.collisionRel] }),
    toDiverged.collisionRel,
  ).message;
  assert.match(divergedLine, /^REBASELINED CLAUDE\.md — /);
  assert.match(divergedLine, /records it as diverged/);
  assert.match(divergedLine, /no file was written/);

  // The three are distinguishable from each other, which is the whole reason
  // there are three of them.
  assert.equal(new Set([managedLine, adoptedLine, divergedLine]).size, 3);
});

// ---------------------------------------------------------------------------
// #269 (FORGE-330) — an exit code that means something, and --json
// ---------------------------------------------------------------------------

/** Runs the real `main`, capturing both streams. The exit code is the whole
 *  subject here, so it is read from the value `runCli` would hand to
 *  `process.exit` rather than inferred from what was printed. */
function runMain(args, { silent = true } = {}) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (l) => out.push(String(l));
  console.error = (l) => err.push(String(l));
  try {
    const code = main(['node', 'sync-standards.mjs', ...args]);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
    if (!silent) { /* streams already restored */ }
  }
}

test('#269 (FORGE-330) — a run that refused a path exits non-zero, a clean one exits 0', () => {
  // The defect: a sync that refused a path exited 0, indistinguishable from a
  // clean one to any caller — which is what blocks a fleet-wide batch driver,
  // since the only way to learn a path was left untouched was to read English.
  const templates = makeTemplates();
  const clean = syntheticTarget(templates);
  assert.equal(runMain([templates, clean]).code, 0, 'a clean sync did not exit 0');

  // A genuine refusal: the repository edited a file daftplate owns.
  const refusing = syntheticTarget(templates);
  writeFileSync(join(refusing, 'README.md'), '# edited by the repo\n', 'utf8');
  const run = runMain([templates, refusing]);
  assert.match(run.out, /REFUSED MODIFIED README\.md/);
  assert.equal(run.code, EXIT_CODES.REFUSED, 'a sync that refused a path reported success');
  assert.notEqual(run.code, 0);
});

test('#269 (FORGE-330) — an offer is not a refusal, and does not fail the run', () => {
  // The narrowing that matters. NEW and MISSING are the command telling an
  // operator it found work it may not do unasked, and a first sync against a
  // repository that has drifted legitimately reports several. Exiting non-zero
  // for those would make the normal case look like a failure — and a caller that
  // learned to ignore the code there would ignore it for refusals too.
  const templates = makeTemplates();
  const target = syntheticTarget(templates);
  const v2 = makeTemplates({ extra: { rel: 'dot-github/dependabot.yml', body: 'version: 2\n' } });

  const run = runMain([v2, target]);

  assert.match(run.out, /NEW \.github\/dependabot\.yml/);
  assert.match(run.out, /outstanding 1/);
  assert.equal(run.code, 0, 'an offer was reported as a failed run');
});

test('#269 (FORGE-330) — --json emits every row the prose emits, and no others', () => {
  // AC 3 and AC 4. The two renderings are asserted to agree on the ROW SET rather
  // than compared field by field, because the failure this guards against is a
  // driver reading a machine surface that has silently stopped describing the
  // same run as the prose one.
  const templates = makeTemplates();
  const target = syntheticTarget(templates);
  writeFileSync(join(target, 'README.md'), '# edited by the repo\n', 'utf8');
  const v2 = makeTemplates({ extra: { rel: 'dot-github/dependabot.yml', body: 'version: 2\n' } });

  const prose = runMain([v2, target]);
  const json = runMain([v2, target, '--json']);

  const parsed = JSON.parse(json.out);
  assert.equal(json.code, prose.code, 'the two renderings disagree about the exit code');
  assert.equal(json.code, EXIT_CODES.REFUSED);

  // Every prose line except the summary is a report row's message, so the row
  // set is recoverable from both and must match.
  const proseRows = prose.out.split('\n').filter((l) => l && l !== parsed.summary);
  assert.deepEqual(parsed.reports.map((r) => r.message), proseRows,
    '--json and the prose report describe different rows');

  // And each row carries its disposition, which is the field a driver branches
  // on and the one prose only implies.
  for (const row of parsed.reports) {
    assert.equal(typeof row.rel, 'string');
    assert.equal(typeof row.status, 'string');
    assert.equal(typeof row.disposition, 'string');
  }
  // The summary is the one line the prose prints that is not a row, and the JSON
  // carries it under its own key rather than losing it or smuggling it into the
  // row set. Compared against the prose's own last line, so the two cannot drift.
  assert.equal(parsed.summary, prose.out.split('\n').filter(Boolean).at(-1));
  assert.match(parsed.summary, /outstanding 2/);
  assert.equal(parsed.outstanding, 2, 'the refusal and the offer were not both counted');
  assert.equal(parsed.dryRun, false);
});

test('#269 (FORGE-330) — --json prints JSON and nothing else on stdout', () => {
  // A driver parses stdout whole. One stray prose line and JSON.parse throws,
  // which is exactly the failure the flag exists to remove — so the prose branch
  // and the JSON branch are exclusive rather than additive.
  const templates = makeTemplates();
  const target = syntheticTarget(templates);

  const { out } = runMain([templates, target, '--json']);

  assert.doesNotThrow(() => JSON.parse(out), 'stdout was not parseable as one JSON document');
  assert.doesNotMatch(out, /^updated /m, 'the prose summary was printed alongside the JSON');
});

// ---------------------------------------------------------------------------
// #270 (FORGE-331) — an operator can diff a refused path, and nothing is kept
// ---------------------------------------------------------------------------

test('#270 (FORGE-331) — unifiedDiff shows what changed, and nothing when nothing did', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n'), null, 'identical text produced a diff');

  const diff = unifiedDiff('keep\nold\ntail\n', 'keep\nnew\ntail\n');
  assert.match(diff, /^ {3}keep$/m);
  assert.match(diff, /^ {2}-old$/m);
  assert.match(diff, /^ {2}\+new$/m);
  assert.match(diff, /^ {3}tail$/m);
  // A pure addition is + lines only, so an operator is not shown their own
  // unchanged file as though it had been rewritten.
  assert.doesNotMatch(unifiedDiff('a\n', 'a\nb\n'), /^ {2}-/m);
  // CRLF is the same text as LF for this purpose: the diff is about content, and
  // showing every line as changed because of a line ending would bury the one
  // that did.
  assert.equal(unifiedDiff('a\r\nb\r\n', 'a\nb\n'), null);
});

test('#270 (FORGE-331) — an oversized file reports the cap rather than truncating', () => {
  // Silent truncation is the failure mode that matters: a diff that stops
  // half-way looks complete and is not.
  const huge = `${Array.from({ length: DIFF_LINE_CAP }, (_, i) => `line ${i}`).join('\n')}\n`;
  const diff = unifiedDiff(huge, `${huge}one more\n`);
  assert.match(diff, /diff not shown/);
  assert.match(diff, new RegExp(`${DIFF_LINE_CAP}-line cap`));
});

test('#270 (FORGE-331) — a refused path the operator named carries its diff', () => {
  // AC 2. The bytes the template would have written are in staging during the
  // run and deleted at the end of it, so the comparison is computed while they
  // exist rather than the bytes retained for the operator to compare later.
  const templates = makeTemplates();
  const target = syntheticTarget(templates);
  writeFileSync(join(target, 'README.md'), '# the repo rewrote this\n', 'utf8');

  const result = syncStandards(templates, target, { diff: ['README.md'] });

  const report = reportFor(result, 'README.md');
  assert.equal(report.status, 'MODIFIED');
  assert.match(report.diff, /^ {2}-# the repo rewrote this$/m, 'the on-disk line is not shown as removed');
  assert.match(report.diff, /^ {2}\+/m, 'the template own line is not shown as added');
});

test('#270 (FORGE-331) — the diff is opt-in per path, not per run', () => {
  // A whole-run flag would put every managed file's contents into a report, and
  // into whatever CI log collects it, to answer a question about one of them.
  const templates = makeTemplates({ extra: { rel: 'dot-github/dependabot.yml', body: 'version: 2\n' } });
  const target = syntheticTarget(templates);
  writeFileSync(join(target, 'README.md'), '# the repo rewrote this\n', 'utf8');
  writeFileSync(join(target, '.github/dependabot.yml'), 'version: 9\n', 'utf8');

  const asked = syncStandards(templates, target, { diff: ['README.md'] });
  assert.ok(reportFor(asked, 'README.md').diff, 'the named path carries no diff');
  assert.equal(reportFor(asked, '.github/dependabot.yml').diff, undefined,
    'a path nobody named carried its contents into the report anyway');

  const none = syncStandards(templates, syntheticTarget(templates));
  for (const row of none.reports) {
    assert.equal(row.diff, undefined, `${row.rel} carried a diff with no --diff`);
  }
});

test('#270 (FORGE-331) — a path already written carries no diff, and a dry run shows what would change', () => {
  // Content decides, not the disposition. A `disposition === 'REFUSE'` guard was
  // written first and measured almost inert: by the time an UPDATE row is
  // reported the file has been written, so the two texts are equal and there is
  // nothing to show — the mutant removing that guard killed nothing. It was
  // deleted rather than kept as decoration (#294 (FORGE-345)'s rule), and this
  // pins both halves of what replaced it.
  const templates = makeTemplates();
  const v2 = makeTemplates({ readme: '# <PROJECT_NAME> v2\n' });

  // Written: the update landed, so on-disk and staged agree and no diff is shown.
  const written = syncStandards(v2, syntheticTarget(templates), { diff: ['README.md'] });
  const applied = reportFor(written, 'README.md');
  assert.equal(applied.disposition, 'UPDATE');
  assert.equal(applied.diff, undefined, 'a file that was just written was diffed against itself');

  // Dry run: nothing was written, so the diff is exactly what the operator asked
  // for — the case the discarded guard actively suppressed.
  const planned = syncStandards(v2, syntheticTarget(templates), { diff: ['README.md'], dryRun: true });
  const would = reportFor(planned, 'README.md');
  assert.equal(would.outcome, 'WOULD_UPDATE');
  assert.match(would.diff, /^ {2}\+# .* v2$/m, 'a dry run did not show what the update would do');
});

test('#270 (FORGE-331) — staging is removed on every ordinary exit, refusals included', () => {
  // AC 3, as an exit matrix rather than one happy path. The staging tree lives
  // under the OS temp root, and the run is the only thing that may create or
  // remove one — so "was it cleaned up" is asked by counting what is left behind.
  const stagingDirs = (root) => readdirSync(root).filter((n) => n.startsWith('daftplate-sync-'));

  withOwnedTempRoot((tempRoot) => {
    const templates = makeTemplates();

    // 1. a clean run
    syncStandards(templates, syntheticTarget(templates));
    assert.deepEqual(stagingDirs(tempRoot), [], 'a clean run left its staging tree behind');

    // 2. a run that REFUSED — the exit this issue is about
    const refusing = syntheticTarget(templates);
    writeFileSync(join(refusing, 'README.md'), '# edited\n', 'utf8');
    const refused = syncStandards(templates, refusing);
    assert.equal(refused.refused.length > 0, true, 'the fixture did not actually refuse');
    assert.deepEqual(stagingDirs(tempRoot), [], 'a run that refused a path left its staging tree behind');

    // 3. a run that refused AND was asked for a diff, which is the new path
    const diffed = syntheticTarget(templates);
    writeFileSync(join(diffed, 'README.md'), '# edited\n', 'utf8');
    const withDiff = syncStandards(templates, diffed, { diff: ['README.md'] });
    assert.ok(reportFor(withDiff, 'README.md').diff);
    assert.deepEqual(stagingDirs(tempRoot), [],
      'computing a diff kept the staging tree alive after the run');

    // 4. a dry run, which writes nothing and still stages
    syncStandards(templates, syntheticTarget(templates), { dryRun: true });
    assert.deepEqual(stagingDirs(tempRoot), [], 'a dry run left its staging tree behind');
  });
});

test('#270 (FORGE-331) — no staged byte outlives the run, so nothing has to be cleaned up later', () => {
  // AC 4, met by construction rather than by a cleanup that has to be trusted:
  // the comparison is computed during the run and only the RESULT survives it.
  // The one exception is deliberate and predates this — a rollback that could not
  // finish retains staging and names it, because it then holds the only copies of
  // bytes that could not be restored. That is evidence, not debris, and it is
  // recorded here rather than left for a reader to discover as an inconsistency.
  const templates = makeTemplates();
  const target = syntheticTarget(templates);
  writeFileSync(join(target, 'README.md'), '# edited\n', 'utf8');

  const result = syncStandards(templates, target, { diff: ['README.md'] });

  assert.equal(existsSync(result.staging), false, 'the staging tree survived a run nobody asked to keep');
  assert.ok(reportFor(result, 'README.md').diff, 'the diff did not survive the tree it was computed from');
});

test('#270 (FORGE-331) — a path that changed under the write still carries its diff', () => {
  // The second report site, and it needed its own test: the ordinary MODIFIED
  // refusal is reported at the loop's terminus, while a file whose digest moved
  // BETWEEN classification and the write is reported from the write site. A
  // mutant removing the diff there killed nothing until this existed.
  //
  // The race is the one case where an operator most needs the comparison — the
  // run was about to write, something changed underneath it, and the bytes it
  // was holding are gone the moment it exits.
  const templates = makeTemplates();
  const target = syntheticTarget(templates);
  const v2 = makeTemplates({ readme: '# <PROJECT_NAME> v2\n' });

  const result = syncStandards(v2, target, {
    diff: ['README.md'],
    hooks: {
      beforeWrite: (rel) => {
        if (rel === 'README.md') writeFileSync(join(target, 'README.md'), '# changed under the run\n', 'utf8');
      },
    },
  });

  const report = reportFor(result, 'README.md');
  assert.equal(report.outcome, 'MODIFIED');
  assert.match(report.diff, /^ {2}-# changed under the run$/m,
    'the bytes that appeared under the run were not shown');
  assert.match(report.diff, /^ {2}\+# .* v2$/m, 'the bytes the template would have written were not shown');
});
