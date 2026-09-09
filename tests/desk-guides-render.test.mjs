import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, resolve, parse } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { makeRepo } from './helpers/make-repo.mjs';
import {
  runTool, probePoppler, findPoppler, parsePdfInfo, checkPdf, pngDimensions,
  checkPreview, buildManifest, digestInputs, MANIFEST_SCHEMA,
} from '../scripts/lib/desk-guides/render.mjs';
import {
  preflight, readPriorManifest, listTree, planPromotion, createStaging,
  markedForRun, removeOwnDirectory, promote, recoverInterrupted, MARKER,
} from '../scripts/lib/desk-guides/promote.mjs';
import { browserCandidates } from '../scripts/lib/desk-guides/browser.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAYOUT = { pageWidthIn: 11, pageHeightIn: 8.5, previewDpi: 150 };

/** Real `pdfinfo` output for a Letter-landscape single page, kept verbatim so the
 *  parser is tested against the format it will actually meet. */
const PDFINFO_OK = `Title:
Producer:       Skia/PDF m141
CreationDate:   Sun Aug 23 21:05:11 2026 GMT
Tagged:         no
Pages:          1
Encrypted:      no
Page size:      792 x 612 pts (letter)
Page rot:       0
File size:      55177 bytes
PDF version:    1.4
`;

/** A 1650x1275 PNG header: signature, IHDR length, IHDR, width, height. Enough
 *  bytes for the dimension reader, which is all it reads. */
function pngHeader(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** A stubbed process boundary that records what it was asked to run. */
function recorder(responses = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    const key = `${command} ${args[0] ?? ''}`.trim();
    return responses[key] ?? responses[command] ?? { stdout: '', stderr: '', status: 0 };
  };
  return { run, calls };
}

// ---------------------------------------------------------------------------
// Task 3.1 -- prerequisites, discovered and reported, never installed
// ---------------------------------------------------------------------------

test('Edge is preferred and Chrome is the documented fallback, not a hard-coded single browser', () => {
  // Mutation killed: the renderer names one browser. A machine with Chrome and
  // no Edge -- or the reverse -- then fails with "not found" for a browser it has.
  const win = browserCandidates('win32', { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86' });
  assert.ok(win.some((p) => /msedge\.exe$/.test(p)), 'no Edge candidate');
  assert.ok(win.some((p) => /chrome\.exe$/.test(p)), 'no Chrome fallback');
  assert.ok(win.findIndex((p) => /msedge/.test(p)) < win.findIndex((p) => /chrome/i.test(p)));
});

test('a missing pdfinfo names that executable and the command that installs it', () => {
  // Mutation killed: every Poppler failure collapses to "render failed". The
  // operator then has no idea which of two binaries is missing or how to get it.
  const missing = () => ({ error: Object.assign(new Error('nope'), { code: 'ENOENT' }) });
  assert.throws(() => probePoppler('pdfinfo', { run: missing }), (err) => {
    assert.match(err.message, /^pdfinfo is not on PATH/);
    assert.match(err.message, /Poppler/);
    assert.match(err.message, /Install: /);
    return true;
  });
});

test('pdftoppm is probed independently, so finding pdfinfo proves nothing about it', () => {
  // Mutation killed: one probe is treated as Poppler availability. A partial
  // install then passes discovery and fails three stages later, mid-render.
  const run = (command) => (command === 'pdfinfo'
    ? { stdout: 'pdfinfo version 25.07.0', stderr: '', status: 0 }
    : { error: Object.assign(new Error('nope'), { code: 'ENOENT' }) });
  assert.throws(() => findPoppler({ run }), (err) => {
    assert.match(err.message, /^pdftoppm is not on PATH/);
    return true;
  });
});

test('no prerequisite failure runs an installer', () => {
  // Mutation killed: the implementation shells out to winget, brew, apt or npm.
  // The design forbids it outright: a generator that installs system packages to
  // print a reference card has misjudged its own importance.
  const { run, calls } = recorder({ pdfinfo: { error: Object.assign(new Error('x'), { code: 'ENOENT' }) } });
  assert.throws(() => findPoppler({ run }));
  const attempted = calls.map((c) => c.command);
  for (const installer of ['winget', 'brew', 'apt', 'apt-get', 'choco', 'npm', 'scoop']) {
    assert.equal(attempted.includes(installer), false, `${installer} was invoked`);
  }
  assert.deepEqual(attempted, ['pdfinfo']);
});

test('every tool call passes an argument array with no shell', () => {
  // Mutation killed: paths are interpolated into a command string. The default
  // Poppler install path on Windows contains a space, so this breaks on the
  // ordinary case rather than an exotic one.
  const { run, calls } = recorder({ pdfinfo: { stdout: PDFINFO_OK, status: 0 } });
  runTool('pdfinfo', ['C:\\Program Files\\a file.pdf'], { run });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'pdfinfo');
  assert.deepEqual(calls[0].args, ['C:\\Program Files\\a file.pdf']);
  assert.equal(typeof calls[0].args, 'object');
});

test('a non-zero child exit reports the executable, the status, and bounded stderr', () => {
  // Mutation killed: the process error is discarded ("render failed"), or the
  // whole log is emitted. One hides the cause; the other buries it.
  const noisy = () => ({ status: 3, stdout: '', stderr: `first line matters\n${'x'.repeat(5000)}` });
  assert.throws(() => runTool('pdftoppm', ['a.pdf'], { run: noisy }), (err) => {
    assert.match(err.message, /^pdftoppm exited 3/);
    assert.match(err.message, /first line matters/);
    assert.ok(err.message.length < 1200, `stderr was not bounded: ${err.message.length} chars`);
    return true;
  });
});

test('tool versions are captured, not assumed, and reach the manifest', () => {
  // Mutation killed: the manifest records executable names or a hard-coded
  // version. A rendering difference between Poppler releases is then
  // unattributable after the fact.
  const run = (command) => ({ stdout: '', stderr: `${command} version 24.02.1\nCopyright...`, status: 0 });
  const tools = findPoppler({ run });
  assert.equal(tools.pdfinfo.version, '24.02.1');
  assert.equal(tools.pdftoppm.version, '24.02.1');

  const manifest = buildManifest({
    runId: 'abc123',
    meta: { date: '2026-08-23', version: '1.7.0', commit: 'deadbee' },
    tools: { browser: 'msedge', pdfinfo: tools.pdfinfo.version, pdftoppm: tools.pdftoppm.version },
    targets: [{ path: 'a.pdf', sha256: 'x' }],
    inputs: [],
    layout: LAYOUT,
  });
  assert.equal(manifest.tools.pdfinfo, '24.02.1');
  assert.equal(manifest.tools.pdftoppm, '24.02.1');
  assert.equal(manifest.schema, MANIFEST_SCHEMA);
});

// ---------------------------------------------------------------------------
// Task 3.2 -- what the artifacts actually are
// ---------------------------------------------------------------------------

test('a PDF that reports anything but exactly one page fails', () => {
  // Mutation killed: the renderer trusts the browser's exit status. Chromium
  // exits 0 having written a two-page PDF when content overflows the page box.
  assert.deepEqual(checkPdf({ info: parsePdfInfo(PDFINFO_OK), expectPages: 1, layout: LAYOUT, label: 'a1.pdf' }), []);
  const two = parsePdfInfo(PDFINFO_OK.replace('Pages:          1', 'Pages:          2'));
  const problems = checkPdf({ info: two, expectPages: 1, layout: LAYOUT, label: 'a1.pdf' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /2 page\(s\), expected exactly 1/);
});

test('the bundle must report exactly six pages', () => {
  // Mutation killed: the bundle is printed from one page model, or is a copy of
  // an individual file. Both produce a valid PDF with the wrong page count.
  const one = parsePdfInfo(PDFINFO_OK);
  assert.match(checkPdf({ info: one, expectPages: 6, layout: LAYOUT, label: 'desk-guides.pdf' })[0], /1 page\(s\), expected exactly 6/);
  const six = parsePdfInfo(PDFINFO_OK.replace('Pages:          1', 'Pages:          6'));
  assert.deepEqual(checkPdf({ info: six, expectPages: 6, layout: LAYOUT, label: 'desk-guides.pdf' }), []);
});

test('wrong physical page dimensions fail even when the page count is right', () => {
  // Mutation killed: page count alone is treated as print validity. A one-page
  // A4 portrait PDF satisfies a count check and prints wrong on every page.
  const portrait = parsePdfInfo(PDFINFO_OK.replace('792 x 612', '612 x 792'));
  const problems = checkPdf({ info: portrait, expectPages: 1, layout: LAYOUT, label: 'a1.pdf' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /612 x 792 pts, expected 792 x 612/);
});

test('malformed pdfinfo output fails closed rather than defaulting to zero', () => {
  // Mutation killed: the parser returns `{ pages: 0 }` or `{}` for unrecognised
  // output. A zero page count then compares unequal and reports a confusing
  // number instead of "this is not a PDF I can reopen".
  assert.throws(() => parsePdfInfo('Syntax Error: Couldn\'t find trailer dictionary\n'), /no usable page count/);
  assert.throws(() => parsePdfInfo(''), /no usable page count/);
  assert.throws(
    () => parsePdfInfo('Pages:          1\n'),
    /no usable page size/,
  );
});

test('wrong preview dimensions fail; existence is not the assertion', () => {
  // Mutation killed: the check is `existsSync(png)`. A preview rendered at the
  // wrong DPI, or of the wrong page, exists just as convincingly.
  const good = { width: 1650, height: 1275 };
  assert.deepEqual(checkPreview({ dimensions: good, layout: LAYOUT, dpi: 150, label: 'a1.png' }), []);
  const wrong = checkPreview({ dimensions: { width: 825, height: 638 }, layout: LAYOUT, dpi: 150, label: 'a1.png' });
  assert.equal(wrong.length, 1);
  assert.match(wrong[0], /825x638px, expected 1650x1275 at 150dpi/);
});

test('a portrait preview fails even when its pixel counts are plausible', () => {
  // Mutation killed: validation only checks that both dimensions are non-zero.
  // A portrait render of a landscape page has two perfectly plausible numbers.
  const problems = checkPreview({
    dimensions: { width: 1275, height: 1650 }, layout: LAYOUT, dpi: 150, label: 'a1.png',
  });
  assert.ok(problems.some((p) => /portrait/.test(p)), `portrait was not reported: ${problems.join('; ')}`);
});

test('the PNG reader refuses anything that is not a PNG', () => {
  // Additive rather than a regression: pins the header contract the preview
  // dimension checks above depend on.
  assert.deepEqual(pngDimensions(pngHeader(1650, 1275)), { width: 1650, height: 1275 });
  assert.throws(() => pngDimensions(Buffer.from('not a png at all, but long enough to read')), /is not a PNG/);
});

test('the manifest names every staged target with a digest, not a partial log', () => {
  // Mutation killed: the manifest records only the PDFs, or only what happened to
  // be interesting. Promotion replaces exactly what the manifest names, so a
  // partial manifest either refuses valid work or claims ownership it lacks.
  const targets = ['a1.html', 'a1.pdf', 'a1.png', 'desk-guides.html', 'desk-guides.pdf', 'inventory.json']
    .map((path) => ({ path, sha256: createHash('sha256').update(path).digest('hex') }));
  const manifest = buildManifest({
    runId: 'r1',
    meta: { date: '2026-08-23', version: '1.7.0', commit: 'deadbee' },
    tools: { browser: 'msedge', pdfinfo: '25.07.0', pdftoppm: '25.07.0' },
    targets: [...targets, { path: 'manifest.json', sha256: null }],
    inputs: digestInputs(ROOT, ['desk-guides.config.json', 'package.json']),
    layout: LAYOUT,
  });
  const named = manifest.targets.map((t) => t.path);
  for (const expected of ['a1.html', 'a1.pdf', 'a1.png', 'desk-guides.pdf', 'inventory.json', 'manifest.json']) {
    assert.ok(named.includes(expected), `manifest omits ${expected}`);
  }
  assert.deepEqual(named, [...named].sort(), 'manifest target order is unstable');
  assert.equal(manifest.inputs.length, 2);
  assert.ok(manifest.inputs.every((i) => /^[0-9a-f]{64}$/.test(i.sha256)));
});

// ---------------------------------------------------------------------------
// Task 3.3 -- ownership, refusal, rollback, recovery
// ---------------------------------------------------------------------------

const repoLike = () => makeRepo({ 'README.md': '# repo\n' });

test('the repository root is refused, and refused before anything is created', () => {
  // Mutation killed: the guard runs after staging begins. By then it has already
  // written into the directory it exists to protect.
  const repo = repoLike();
  const before = listTree(repo);
  assert.ok(preflight({ outputDir: repo, repoRoot: repo, home: homedir() })
    .some((p) => /is the repository root/.test(p)));
  assert.deepEqual(listTree(repo), before, 'preflight created something');
});

test('the home directory is refused', () => {
  // Mutation killed: only equality with the repository root is checked. `--out ~`
  // then promotes a directory rename over the user's home.
  const repo = repoLike();
  const home = makeRepo({ 'notes.txt': 'mine\n' });
  assert.ok(preflight({ outputDir: home, repoRoot: repo, home })
    .some((p) => /is your home directory/.test(p)));
});

test('a drive or filesystem root is refused, by that rule and not incidentally', () => {
  // Mutation killed: parent traversal permits a filesystem root. The refusal is
  // matched by REASON, not by "something was refused" -- a drive root is also an
  // ancestor of the repository, so a count-only assertion stays green with the
  // root rule deleted and only proves the other rule still works.
  const repo = repoLike();
  const root = parse(resolve(repo)).root;
  const problems = preflight({ outputDir: root, repoRoot: repo, home: homedir() });
  assert.ok(problems.some((p) => /is a filesystem root/.test(p)), `not refused as a root: ${problems.join('; ')}`);
});

test('an ancestor of the repository is refused, and the containment test is not reversed', () => {
  // Mutation killed: the comparison is written the other way round. That mutant
  // accepts every ancestor AND refuses the legitimate default output directory
  // inside the repo -- it fails open and closed at once.
  const repo = repoLike();
  const parent = resolve(repo, '..');
  assert.ok(preflight({ outputDir: parent, repoRoot: repo, home: homedir() })
    .some((p) => /is an ancestor of the repository/.test(p)));
  assert.deepEqual(preflight({ outputDir: join(repo, 'output', 'pdf', 'desk-guides'), repoRoot: repo, home: homedir() }), []);
});

test('an output path that exists as a file is refused', () => {
  const repo = repoLike();
  assert.ok(preflight({ outputDir: join(repo, 'README.md'), repoRoot: repo, home: homedir() })
    .some((p) => /exists and is not a directory/.test(p)));
});

test('an unknown pre-existing output file is neither overwritten nor deleted', () => {
  // Mutation killed: promotion treats the NEW manifest as ownership of OLD
  // content. Recursive names and bytes are compared, because an assertion naming
  // one known PDF would not notice an unrelated file being removed.
  const out = makeRepo({
    'manifest.json': JSON.stringify({ targets: [{ path: 'a1.pdf' }] }),
    'a1.pdf': 'old pdf\n',
    'holiday-photos.pdf': 'not ours\n',
  });
  const before = listTree(out).map((rel) => [rel, readFileSync(join(out, rel), 'utf8')]);
  assert.throws(
    () => planPromotion({ outputDir: out, stagedTargets: ['a1.pdf', 'manifest.json'] }),
    /did not write: holiday-photos\.pdf/,
  );
  assert.deepEqual(listTree(out).map((rel) => [rel, readFileSync(join(out, rel), 'utf8')]), before);
});

test('a missing or malformed prior manifest refuses without touching anything', () => {
  // Mutation killed: an existing directory is assumed generator-owned. Someone
  // else's directory at the output path is then emptied by a rename.
  const noManifest = makeRepo({ 'something.pdf': 'theirs\n' });
  const before = listTree(noManifest);
  assert.throws(() => planPromotion({ outputDir: noManifest, stagedTargets: [] }), /has no manifest\.json/);
  assert.deepEqual(listTree(noManifest), before);

  const broken = makeRepo({ 'manifest.json': '{ not json', 'a.pdf': 'x\n' });
  assert.throws(() => planPromotion({ outputDir: broken, stagedTargets: [] }), /not readable JSON/);

  const noTargets = makeRepo({ 'manifest.json': '{"schema":1}' });
  assert.throws(() => planPromotion({ outputDir: noTargets, stagedTargets: [] }), /no targets list/);
});

test('a set that fails revalidation after the rename leaves the prior output byte-identical', () => {
  // Mutation killed: output files are replaced before all validation completes,
  // or the post-rename check exists but never rolls back. A half-published set is
  // worse than no new set -- the reader cannot tell which pages are current.
  //
  // Recursive names AND bytes are compared. An assertion naming one known PDF
  // would not notice an unrelated file disappearing.
  const parent = makeRepo({});
  const out = join(parent, 'desk-guides');
  mkdirSync(out);
  writeFileSync(join(out, 'a1.pdf'), 'the previous good page\n');
  writeFileSync(join(out, 'notes.txt'), 'also previously here\n');
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ targets: [{ path: 'a1.pdf' }, { path: 'notes.txt' }] }));
  const snapshot = listTree(out).map((rel) => [rel, readFileSync(join(out, rel))]);

  const staging = createStaging({ parent: makeRepo({}), runId: 'run-1' });
  writeFileSync(join(staging, 'a1.pdf'), 'a new page that never validates\n');

  assert.throws(
    () => promote({
      staging,
      outputDir: out,
      runId: 'run-1',
      revalidate: () => ['a1.pdf: 2 page(s), expected exactly 1'],
    }),
    /failed revalidation and was rolled back/,
  );

  const after = listTree(out).filter((rel) => rel !== MARKER).map((rel) => [rel, readFileSync(join(out, rel))]);
  assert.deepEqual(after.map(([rel]) => rel), snapshot.map(([rel]) => rel));
  for (const [i, [rel, bytes]] of after.entries()) {
    assert.ok(bytes.equals(snapshot[i][1]), `${rel} changed`);
  }
});

test('a failed second rename restores the previous output', () => {
  // Mutation killed: the rollback directory is created but never used. The
  // previous set is then lost to a failure that was supposed to be survivable.
  const parent = makeRepo({});
  const out = join(parent, 'desk-guides');
  mkdirSync(out);
  writeFileSync(join(out, 'a1.pdf'), 'previous\n');
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ targets: [{ path: 'a1.pdf' }] }));
  const snapshot = listTree(out).map((rel) => [rel, readFileSync(join(out, rel), 'utf8')]);

  const staging = createStaging({ parent: makeRepo({}), runId: 'run-2' });
  writeFileSync(join(staging, 'a1.pdf'), 'new\n');

  let renames = 0;
  const rename = (from, to) => {
    renames += 1;
    if (renames === 2) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    renameSync(from, to);
  };
  assert.throws(
    () => promote({ staging, outputDir: out, runId: 'run-2', rename }),
    /previous output was restored unchanged/,
  );
  assert.deepEqual(
    listTree(out).map((rel) => [rel, readFileSync(join(out, rel), 'utf8')]).filter(([r]) => r !== MARKER),
    snapshot,
  );
});

test('cleanup removes this run\'s marked staging directory and nothing beside it', () => {
  // Mutation killed: cleanup globs `run-*` and removes siblings. Another run's
  // staging directory is another run's evidence, and on a shared temp root it may
  // not even be ours.
  const parent = makeRepo({});
  const mine = createStaging({ parent, runId: 'run-mine' });
  const theirs = createStaging({ parent, runId: 'run-theirs' });
  writeFileSync(join(theirs, 'a1.pdf'), 'theirs\n');

  assert.equal(removeOwnDirectory({ dir: mine, parent, runId: 'run-mine', kind: 'staging' }).removed, true);
  assert.equal(existsSync(mine), false);
  assert.equal(existsSync(theirs), true);
  assert.equal(readFileSync(join(theirs, 'a1.pdf'), 'utf8'), 'theirs\n');

  // Containment is its own gate. A correctly marked directory somewhere else on
  // the filesystem is still not this run's to remove -- the marker says who made
  // it, and the parent says where we agreed to work.
  const elsewhere = createStaging({ parent: makeRepo({}), runId: 'run-mine' });
  const refused = removeOwnDirectory({ dir: elsewhere, parent, runId: 'run-mine', kind: 'staging' });
  assert.equal(refused.removed, false);
  assert.match(refused.reason, /outside the approved parent/);
  assert.equal(existsSync(elsewhere), true);
});

test('a staging-shaped directory with no marker survives untouched', () => {
  // Mutation killed: the filename pattern is treated as proof of ownership. This
  // is the single most dangerous available mistake in the module -- `run-` is a
  // prefix anyone might use, and the temp root is shared.
  const parent = makeRepo({});
  const lookalike = join(parent, 'run-abcdef');
  mkdirSync(lookalike);
  writeFileSync(join(lookalike, 'important.txt'), 'not ours\n');

  const result = removeOwnDirectory({ dir: lookalike, parent, runId: 'run-mine', kind: 'staging' });
  assert.equal(result.removed, false);
  assert.match(result.reason, /no marker/);
  assert.equal(readFileSync(join(lookalike, 'important.txt'), 'utf8'), 'not ours\n');
  assert.equal(markedForRun(lookalike, 'run-mine'), false);
});

test('an interrupted marked rollback is recovered without touching unknown neighbours', () => {
  // Mutation killed: startup performs a broad recursive cleanup of anything that
  // looks like leftovers. The two-rename transaction has a real crash window;
  // what closes it is a recognisable artifact, not a wider delete.
  const parent = makeRepo({});
  const out = join(parent, 'desk-guides');
  const rollback = join(parent, 'desk-guides.rollback-run-3');
  mkdirSync(rollback);
  writeFileSync(join(rollback, 'a1.pdf'), 'the last good page\n');
  writeFileSync(join(rollback, MARKER), JSON.stringify({ runId: 'run-3', kind: 'rollback' }));

  const stranger = join(parent, 'desk-guides.rollback-someone-else');
  mkdirSync(stranger);
  writeFileSync(join(stranger, 'keep.txt'), 'no marker, not ours\n');

  const result = recoverInterrupted({ outputDir: out, parent });
  assert.equal(result.recovered, true);
  assert.equal(readFileSync(join(out, 'a1.pdf'), 'utf8'), 'the last good page\n');
  // The unmarked neighbour is not merely left alone -- it was never a candidate.
  // Asserting only that it survived stays green when the marker filter is
  // dropped, because the marked directory still happens to sort first.
  assert.deepEqual(result.found, [rollback]);
  assert.equal(existsSync(stranger), true, 'an unmarked neighbour was touched');
  assert.equal(readFileSync(join(stranger, 'keep.txt'), 'utf8'), 'no marker, not ours\n');
});

test('an interrupted rollback beside a live output set is reported, never guessed', () => {
  // Mutation killed: recovery overwrites whichever set it finds first. Choosing
  // between two plausible sets is not a decision a generator gets to make
  // silently, and the wrong choice destroys the one the user wanted.
  const parent = makeRepo({});
  const out = join(parent, 'desk-guides');
  mkdirSync(out);
  writeFileSync(join(out, 'a1.pdf'), 'current\n');
  const rollback = join(parent, 'desk-guides.rollback-run-4');
  mkdirSync(rollback);
  writeFileSync(join(rollback, 'a1.pdf'), 'previous\n');
  writeFileSync(join(rollback, MARKER), JSON.stringify({ runId: 'run-4', kind: 'rollback' }));

  const result = recoverInterrupted({ outputDir: out, parent });
  assert.equal(result.recovered, false);
  assert.match(result.message, /Both a current set and a rollback exist/);
  assert.equal(readFileSync(join(out, 'a1.pdf'), 'utf8'), 'current\n');
  assert.equal(readFileSync(join(rollback, 'a1.pdf'), 'utf8'), 'previous\n');
});

test('two interrupted runs are reported, not silently chosen between', () => {
  // The sibling of the test above, one layer in. With a single rollback and no
  // current set, recovery is unambiguous and restores it. With TWO rollbacks and
  // no current set the same code path picked `found[0]` -- an arbitrary set, in
  // whatever order the filesystem happened to return -- and reported it as *the*
  // previous output. The module's own doctrine is that choosing between two
  // plausible sets is not a decision a generator makes silently, and this was
  // that decision.
  //
  // Mutation: delete the `found.length > 1` branch. Observable: `recovered`
  // becomes true and `desk-guides/a1.pdf` holds run-5's set -- one of the two
  // candidates, restored and announced as the previous set. Observed red.
  const parent = makeRepo({});
  const out = join(parent, 'desk-guides');
  for (const runId of ['run-5', 'run-6']) {
    const body = `the set left by ${runId}`;
    const rollback = join(parent, `desk-guides.rollback-${runId}`);
    mkdirSync(rollback);
    writeFileSync(join(rollback, 'a1.pdf'), body);
    writeFileSync(join(rollback, MARKER), JSON.stringify({ runId, kind: 'rollback' }));
  }

  const result = recoverInterrupted({ outputDir: out, parent });

  assert.equal(result.recovered, false);
  assert.equal(result.found.length, 2);
  assert.match(result.message, /is not something this can know/);
  // Neither was moved, and the output directory was not created.
  assert.equal(existsSync(out), false, 'a set was restored from an arbitrary candidate');
  assert.equal(readFileSync(join(parent, 'desk-guides.rollback-run-5', 'a1.pdf'), 'utf8'), 'the set left by run-5');
  assert.equal(readFileSync(join(parent, 'desk-guides.rollback-run-6', 'a1.pdf'), 'utf8'), 'the set left by run-6');
});

test('promotion into an absent output directory needs no prior manifest', () => {
  // Additive: the first-ever run has nothing to own, and must not be blocked by
  // the ownership rules written for every run after it.
  const parent = makeRepo({});
  const out = join(parent, 'desk-guides');
  assert.deepEqual(readPriorManifest(out), { state: 'absent', owned: new Set() });
  const staging = createStaging({ parent: makeRepo({}), runId: 'run-5' });
  writeFileSync(join(staging, 'a1.pdf'), 'first\n');
  planPromotion({ outputDir: out, stagedTargets: ['a1.pdf'] });
  promote({ staging, outputDir: out, runId: 'run-5' });
  assert.equal(readFileSync(join(out, 'a1.pdf'), 'utf8'), 'first\n');
});
