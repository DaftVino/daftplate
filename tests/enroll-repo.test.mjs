import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, symlinkSync, unlinkSync, existsSync, readFileSync, linkSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import {
  parseEnrollArgs, inspectEnrollmentTarget, buildEnrollmentProposal, summarizeNonCandidates,
  enrollRepo, renderEnrollmentText, toEnrollmentJson,
} from '../scripts/enroll-repo.mjs';
import {
  PROVENANCE_FILE, MAX_PROVENANCE_SCHEMA, buildProvenance, fileDigest, readProvenance,
} from '../scripts/lib/provenance.mjs';
import { scaffold } from '../scripts/scaffold.mjs';
import { walkFiles } from '../scripts/lib/fs.mjs';

const gitInit = () => {
  const root = emptyDir();
  execFileSync('git', ['init', root], { stdio: 'ignore' });
  return root;
};

/** Link creation needs Developer Mode or elevation on Windows; a machine
 *  without it skips rather than reporting a guard as broken. */
const linkOrSkip = (t, target, path, type) => {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip('link creation is unavailable on this machine');
      return false;
    }
    throw error;
  }
};

// The three tokens scaffold() cannot derive from profile.md, and therefore the
// three an operator must supply. Everything else -- VERIFY_COMMAND,
// TEST_COMMAND, DEPLOY_COMMAND -- comes from the profile metadata.
const base = [
  'node',
  'enroll-repo.mjs',
  'X:/templates',
  'X:/target',
  '--profile=web-app',
  '--token=YEAR=2026',
  '--token=PROJECT_NAME=x',
  '--token=PROJECT_SUMMARY=summary',
];

test('parseEnrollArgs requires an explicit profile and every scaffold input token', () => {
  assert.throws(
    () => parseEnrollArgs([
      'node', 'enroll-repo.mjs', 'X:/templates', 'X:/target', '--token=YEAR=2026',
    ]),
    /--profile.*required/i,
  );

  assert.throws(
    () => parseEnrollArgs([
      'node', 'enroll-repo.mjs', 'X:/templates', 'X:/target',
      '--profile=web-app', '--token=YEAR=2026', '--token=PROJECT_NAME=x',
    ]),
    /missing token.*PROJECT_SUMMARY/i,
  );
});

test('parseEnrollArgs splits token values at the first equals sign', () => {
  const result = parseEnrollArgs([
    'node', 'enroll-repo.mjs', 'X:/templates', 'X:/target',
    '--profile=web-app',
    '--token=YEAR=2026',
    '--token=PROJECT_NAME=a=b',
    '--token=PROJECT_SUMMARY=uses=x=y',
    '--write',
    '--json',
  ]);

  assert.equal(result.tokens.PROJECT_NAME, 'a=b');
  assert.equal(result.tokens.PROJECT_SUMMARY, 'uses=x=y');
  assert.equal(result.write, true);
  assert.equal(result.json, true);
});

test('parseEnrollArgs defaults to a dry run and text output', () => {
  const result = parseEnrollArgs(base);

  assert.equal(result.write, false);
  assert.equal(result.json, false);
  assert.equal(result.profile, 'web-app');
  assert.equal(result.templatesRoot, 'X:/templates');
  assert.equal(result.targetRoot, 'X:/target');
});

test('parseEnrollArgs refuses duplicate and unknown token names', () => {
  assert.throws(
    () => parseEnrollArgs([...base, '--token=YEAR=2027']),
    /duplicate token.*YEAR/i,
  );
  assert.throws(
    () => parseEnrollArgs([...base, '--token=EXTRA=value']),
    /unknown token.*EXTRA/i,
  );
});

// ---------------------------------------------------------------------------
// The repository boundary (Phase 3, Task 3.2). Everything here runs before a
// single digest is read: enrollment must not measure a tree it has already
// decided it cannot record.
// ---------------------------------------------------------------------------

test('inspectEnrollmentTarget refuses a non-repository and a nested target', () => {
  assert.throws(() => inspectEnrollmentTarget(emptyDir(), []), /not the root of a Git work tree/i);

  // Below the root the manifest would sit in a subdirectory of a repo it claims
  // to describe, and every path in it would be relative to the wrong place.
  const nested = join(gitInit(), 'nested');
  mkdirSync(nested);

  assert.throws(() => inspectEnrollmentTarget(nested, []), /not the root of a Git work tree/i);
});

test('inspectEnrollmentTarget permits dirt and reports it', () => {
  const root = gitInit();
  writeFileSync(join(root, 'app.mjs'), 'export default 1;\n', 'utf8');

  const result = inspectEnrollmentTarget(root, []);

  // Dirt is a warning, not a refusal: enrollment writes one new file, and
  // requiring a clean tree first would block the repos most in need of it.
  assert.equal(result.dirty, true);
  assert.deepEqual(result.gitVisible, ['app.mjs']);
});

test('inspectEnrollmentTarget refuses every root engineering-standards entry type', (t) => {
  for (const kind of ['file', 'directory']) {
    const root = gitInit();
    const entry = join(root, 'engineering-standards');
    if (kind === 'file') writeFileSync(entry, 'vendored\n', 'utf8');
    else mkdirSync(entry);

    assert.throws(() => inspectEnrollmentTarget(root, []), /vendors engineering-standards/i);
  }

  const root = gitInit();
  if (!linkOrSkip(t, emptyDir(), join(root, 'engineering-standards'), 'junction')) return;

  assert.throws(() => inspectEnrollmentTarget(root, []), /vendors engineering-standards/i);
});

test('inspectEnrollmentTarget refuses links on candidate and manifest paths only', (t) => {
  const outside = makeRepo({ 'ci.yml': 'outside\n' });

  const root = gitInit();
  if (!linkOrSkip(t, join(outside, 'ci.yml'), join(root, 'ci.yml'), 'file')) return;
  assert.throws(
    () => inspectEnrollmentTarget(root, ['ci.yml']),
    /unsafe link in candidate path: ci\.yml/i,
  );

  const linkedManifest = gitInit();
  symlinkSync(join(outside, 'ci.yml'), join(linkedManifest, PROVENANCE_FILE), 'file');
  assert.throws(
    () => inspectEnrollmentTarget(linkedManifest, []),
    /unsafe link in target path: \.daftplate\.json/i,
  );

  // A link daftplate will never write through is a name in the report and
  // nothing more. Refusing it would block enrollment on a repo's own business.
  const nonCandidate = gitInit();
  symlinkSync(join(outside, 'ci.yml'), join(nonCandidate, 'application-link'), 'file');
  assert.doesNotThrow(() => inspectEnrollmentTarget(nonCandidate, []));
});

test('Git commands receive a spaced target as one execFile argument', () => {
  const seen = [];
  const target = 'X:/Projects/repo with spaces';
  const execFile = (command, args) => {
    seen.push([command, args]);
    if (args.includes('--show-toplevel')) return `${target}\n`;
    return '';
  };

  inspectEnrollmentTarget(target, [], { execFile });

  assert.ok(seen.length > 0, 'git was actually invoked');
  assert.equal(seen.every(([command]) => command === 'git'), true);
  assert.equal(
    seen.every(([, args]) => {
      const index = args.indexOf('-C');
      return index >= 0 && args[index + 1] === target;
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// Candidate measurement (Phase 3, Task 3.3). Three outcomes and no fourth:
// the bytes match, they differ, or the path is not there at all.
// ---------------------------------------------------------------------------

test('buildEnrollmentProposal records matched, divergent, and absent candidates', () => {
  const candidateRoot = makeRepo({
    'matched.md': 'same\n',
    'diverged.md': 'template\n',
    'absent.md': 'template only\n',
  });
  const targetRoot = makeRepo({
    'matched.md': 'same\n',
    'diverged.md': 'repository\n',
  });
  const composed = {
    provenance: buildProvenance({
      root: candidateRoot,
      version: '1.5.0',
      profile: 'web-app',
      tokens: { YEAR: '2026', PROJECT_NAME: 'measured', PROJECT_SUMMARY: 'Measurement fixture.' },
      files: [
        { rel: 'matched.md', layer: 'base', mode: 'copied' },
        { rel: 'diverged.md', layer: 'profile', mode: 'overridden' },
        { rel: 'absent.md', layer: 'base', mode: 'copied' },
      ],
    }),
  };

  const proposal = buildEnrollmentProposal({ composed, targetRoot });

  assert.deepEqual(proposal.adopted, [{ rel: 'matched.md', status: 'MATCHED', disposition: 'MANAGED' }]);
  assert.deepEqual(proposal.diverged, [{ rel: 'diverged.md', status: 'DIVERGED', disposition: 'RECORDED' }]);
  assert.deepEqual(proposal.absent, [{ rel: 'absent.md', status: 'ABSENT', disposition: 'UNOWNED' }]);

  assert.equal(proposal.manifest.files['matched.md'].ownership, 'managed');
  assert.deepEqual(proposal.manifest.files['diverged.md'], {
    digest: fileDigest(join(targetRoot, 'diverged.md')),
    templateDigest: fileDigest(join(candidateRoot, 'diverged.md')),
    layer: 'profile',
    mode: 'overridden',
    ownership: 'diverged',
  });

  // An absent path gets a report and no entry. Recording one would invent
  // provenance for bytes that are not there.
  assert.equal('absent.md' in proposal.manifest.files, false);
});

test('buildEnrollmentProposal sorts reports and manifest keys deterministically', () => {
  const files = { 'z.md': 'z\n', 'a.md': 'a\n' };
  const candidateRoot = makeRepo(files);
  const targetRoot = makeRepo(files);
  const composed = {
    provenance: buildProvenance({
      root: candidateRoot,
      version: '1.5.0',
      profile: 'web-app',
      tokens: {},
      files: [
        { rel: 'z.md', layer: 'base', mode: 'copied' },
        { rel: 'a.md', layer: 'base', mode: 'copied' },
      ],
    }),
  };

  const first = buildEnrollmentProposal({ composed, targetRoot });
  const second = buildEnrollmentProposal({ composed, targetRoot });

  assert.deepEqual(first.reports.map(({ rel }) => rel), ['a.md', 'z.md']);
  assert.deepEqual(Object.keys(first.manifest.files), ['a.md', 'z.md']);
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// The non-candidate report (Phase 3, Task 3.4). Pure aggregation over the names
// Git already listed: nothing here traverses the target or opens a file.
// ---------------------------------------------------------------------------

test('summarizeNonCandidates excludes candidates and groups target-only paths', () => {
  const summary = summarizeNonCandidates(
    ['README.md', 'src/a.mjs', 'src/b.mjs', 'docs/custom/a.md'],
    ['README.md'],
  );

  assert.equal(summary.total, 3);
  assert.deepEqual(summary.byFirstComponent, { docs: 1, src: 2 });
  assert.deepEqual(summary.examples, ['docs/custom/a.md', 'src/a.mjs', 'src/b.mjs']);
  assert.equal('paths' in summary, false);
});

test('summarizeNonCandidates limits text examples to twenty', () => {
  const paths = Array.from({ length: 25 }, (_, i) => `src/${String(i).padStart(2, '0')}.mjs`);

  const summary = summarizeNonCandidates(paths, []);

  assert.equal(summary.total, 25);
  assert.equal(summary.examples.length, 20);
  assert.deepEqual(summary.examples, [...paths].sort().slice(0, 20));
});

test('summarizeNonCandidates exposes the complete sorted set only for JSON', () => {
  // Reversed on the way in, so a summary that merely echoed its input would fail.
  const paths = Array.from({ length: 25 }, (_, i) => `src/${String(24 - i).padStart(2, '0')}.mjs`);

  const summary = summarizeNonCandidates(paths, [], { json: true });

  assert.equal(summary.examples.length, 20);
  assert.deepEqual(summary.paths, [...paths].sort());
});

// ---------------------------------------------------------------------------
// Orchestration (Phase 3, Task 3.5). Composition, preflight, two measurement
// passes, and one publication that either lands whole or not at all.
// ---------------------------------------------------------------------------

/** A repository that daftplate could have produced but did not manage: scaffolded
 *  for its content, then stripped of its manifest and given a fresh Git history.
 *  This is the shape enrollment exists for. */
const makeEnrollableRepository = () => {
  const templates = fileURLToPath(new URL('..', import.meta.url));
  const target = emptyDir();

  scaffold(templates, 'web-app', target, {
    year: 2026,
    tokens: { PROJECT_NAME: 'existing-repo', PROJECT_SUMMARY: 'Existing repository fixture.' },
  });
  unlinkSync(join(target, PROVENANCE_FILE));
  execFileSync('git', ['init', target], { stdio: 'ignore' });

  return {
    templates,
    target,
    opts: {
      profile: 'web-app',
      tokens: {
        YEAR: '2026',
        PROJECT_NAME: 'existing-repo',
        PROJECT_SUMMARY: 'Existing repository fixture.',
      },
    },
  };
};

const contentOf = (root) => walkFiles(root)
  .filter(({ isDir }) => !isDir)
  .map(({ rel }) => [rel, fileDigest(join(root, rel))]);

test('enrollRepo defaults to a complete dry run that writes nothing', () => {
  const fixture = makeEnrollableRepository();
  const before = contentOf(fixture.target);

  const result = enrollRepo(fixture.templates, fixture.target, fixture.opts);

  assert.equal(result.written, false);
  assert.equal(existsSync(join(fixture.target, PROVENANCE_FILE)), false);
  assert.deepEqual(contentOf(fixture.target), before);
  // A dry run is complete, not partial: it measured everything it would record.
  assert.ok(result.candidateCount > 0);
  assert.ok(result.adopted.length > 0);
});

test('enrollRepo --write creates only a validated manifest', () => {
  const fixture = makeEnrollableRepository();
  const before = new Map(contentOf(fixture.target));

  const result = enrollRepo(fixture.templates, fixture.target, { ...fixture.opts, write: true });
  const manifest = readProvenance(fixture.target);

  assert.equal(result.written, true);
  assert.equal(manifest.schema, MAX_PROVENANCE_SCHEMA);
  assert.equal(
    Object.values(manifest.files).every(({ ownership }) => ownership === 'managed'),
    true,
  );

  for (const [rel, digest] of before) {
    assert.equal(fileDigest(join(fixture.target, rel)), digest, rel);
  }
  assert.deepEqual(
    contentOf(fixture.target).map(([rel]) => rel).filter((rel) => !before.has(rel)),
    [PROVENANCE_FILE],
  );
});

test('enrollRepo refuses a target mutation between measurement passes', () => {
  const fixture = makeEnrollableRepository();

  assert.throws(
    () => enrollRepo(fixture.templates, fixture.target, {
      ...fixture.opts,
      write: true,
      hooks: {
        beforeStabilityCheck: () => {
          writeFileSync(join(fixture.target, 'README.md'), '# changed concurrently\n', 'utf8');
        },
      },
    }),
    /target changed during measurement; rerun/i,
  );
  assert.equal(existsSync(join(fixture.target, PROVENANCE_FILE)), false);
});

test('enrollRepo distinguishes valid and invalid existing manifests without replacement', () => {
  const valid = makeEnrollableRepository();
  enrollRepo(valid.templates, valid.target, { ...valid.opts, write: true });
  const validBytes = readFileSync(join(valid.target, PROVENANCE_FILE), 'utf8');

  assert.throws(
    () => enrollRepo(valid.templates, valid.target, valid.opts),
    /already has \.daftplate\.json.*sync-standards/is,
  );
  assert.equal(readFileSync(join(valid.target, PROVENANCE_FILE), 'utf8'), validBytes);

  const invalid = makeEnrollableRepository();
  writeFileSync(join(invalid.target, PROVENANCE_FILE), '{"schema":', 'utf8');

  assert.throws(
    () => enrollRepo(invalid.templates, invalid.target, invalid.opts),
    /existing \.daftplate\.json is invalid/i,
  );
  // A manifest daftplate cannot parse is still not daftplate's to replace.
  assert.equal(readFileSync(join(invalid.target, PROVENANCE_FILE), 'utf8'), '{"schema":');
});

test('enrollRepo never overwrites a manifest that appears before installation', () => {
  const fixture = makeEnrollableRepository();
  const winner = '{"winner":true}\n';

  assert.throws(
    () => enrollRepo(fixture.templates, fixture.target, {
      ...fixture.opts,
      write: true,
      hooks: {
        beforeInstall: () => {
          writeFileSync(join(fixture.target, PROVENANCE_FILE), winner, 'utf8');
        },
      },
    }),
    /\.daftplate\.json appeared during enrollment/i,
  );
  assert.equal(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'), winner);
});

test('enrollRepo never overwrites a manifest that appears DURING installation', () => {
  // The test above proves the pre-install check fires. It cannot prove the race
  // is closed, because beforeInstall runs before staging: a rival landing after
  // that hook and before publication would still pass it. The only seam that
  // observes the real window is the publisher, so the rival is injected there.
  // Under a checked-rename design this test fails; under linkSync publication it
  // passes because the kernel refuses, not because enrollment looked again.
  const fixture = makeEnrollableRepository();
  const winner = '{"winner":true}\n';

  assert.throws(
    () => enrollRepo(fixture.templates, fixture.target, {
      ...fixture.opts,
      write: true,
      link: (from, to) => {
        writeFileSync(to, winner, 'utf8');
        linkSync(from, to);
      },
    }),
    /\.daftplate\.json appeared during enrollment/i,
  );
  assert.equal(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'), winner);
});

test('an interrupted install leaves no manifest at all, partial or otherwise', () => {
  const fixture = makeEnrollableRepository();

  assert.throws(() => enrollRepo(fixture.templates, fixture.target, {
    ...fixture.opts,
    write: true,
    hooks: { beforeInstall: () => { throw new Error('power cut'); } },
  }), /power cut/);

  assert.equal(existsSync(join(fixture.target, PROVENANCE_FILE)), false);
  // Nothing daftplate staged survives in the target either (CLAUDE.md #5).
  assert.deepEqual(walkFiles(fixture.target).filter(({ rel }) => rel.includes('daftplate-')), []);
});

test('re-enrollment refuses at the same version and at a later one', () => {
  const fixture = makeEnrollableRepository();
  enrollRepo(fixture.templates, fixture.target, { ...fixture.opts, write: true });
  const first = readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8');

  for (const version of ['same', 'later']) {
    if (version === 'later') {
      const bumped = { ...JSON.parse(first), daftplate: '99.0.0' };
      writeFileSync(join(fixture.target, PROVENANCE_FILE), `${JSON.stringify(bumped, null, 2)}\n`, 'utf8');
    }
    const before = readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8');

    assert.throws(
      () => enrollRepo(fixture.templates, fixture.target, { ...fixture.opts, write: true }),
      /already has \.daftplate\.json|already enrolled|one-shot/i,
      version,
    );
    assert.equal(readFileSync(join(fixture.target, PROVENANCE_FILE), 'utf8'), before, version);
  }
});

// ---------------------------------------------------------------------------
// The renderers (Phase 3, Task 3.6). Pure, so they get direct unit tests; the
// command itself is tested by running it, in enroll-repo.cli.test.mjs.
// ---------------------------------------------------------------------------

const enrollmentResult = {
  profile: 'web-app',
  tokens: { YEAR: '2026', PROJECT_NAME: 'a=b', PROJECT_SUMMARY: 'summary' },
  candidateCount: 3,
  adopted: [{ rel: 'CLAUDE.md', status: 'MATCHED', disposition: 'MANAGED' }],
  diverged: [{ rel: '.github/workflows/ci.yml', status: 'DIVERGED', disposition: 'RECORDED' }],
  absent: [{ rel: 'docs/quick-ref-workflow.md', status: 'ABSENT', disposition: 'UNOWNED' }],
  unmanaged: {
    total: 25,
    byFirstComponent: { src: 25 },
    examples: Array.from({ length: 20 }, (_, i) => `src/${i}.mjs`),
    paths: Array.from({ length: 25 }, (_, i) => `src/${i}.mjs`),
  },
  dirty: true,
  manifest: { schema: MAX_PROVENANCE_SCHEMA, files: {} },
  written: false,
  reports: [],
};

test('renderEnrollmentText reports inputs and bounded outcome counts', () => {
  const lines = renderEnrollmentText(enrollmentResult);

  assert.equal(lines.some((line) => /profile: web-app/i.test(line)), true);
  // JSON-escaped, so a value containing '=' or a quote is unambiguous in the
  // echo of what the operator actually supplied.
  assert.equal(lines.some((line) => /PROJECT_NAME.*"a=b"/.test(line)), true);
  assert.equal(lines.some((line) => /matched 1/i.test(line)), true);
  assert.equal(lines.some((line) => /diverged 1/i.test(line)), true);
  assert.equal(lines.some((line) => /absent 1/i.test(line)), true);
  assert.equal(lines.some((line) => /dirty/i.test(line)), true);
  assert.equal(lines.filter((line) => /^  src\//.test(line)).length, 20);
});

test('toEnrollmentJson retains every Git-visible non-candidate path', () => {
  const json = toEnrollmentJson(enrollmentResult);

  assert.equal(json.unmanaged.total, 25);
  assert.equal(json.unmanaged.paths.length, 25);
  assert.equal(json.diverged[0].status, 'DIVERGED');
  assert.equal(json.manifest.schema, MAX_PROVENANCE_SCHEMA);
});
