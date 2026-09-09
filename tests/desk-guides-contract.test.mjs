import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo } from './helpers/make-repo.mjs';
import { buildInventory, writeHtml, renderSet } from '../scripts/build-desk-guides.mjs';
import { buildManifest } from '../scripts/lib/desk-guides/render.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const README = readFileSync(join(ROOT, 'desk-guides', 'README.md'), 'utf8');
const GITIGNORE = readFileSync(join(ROOT, '.gitignore'), 'utf8');
const SETUP = readFileSync(join(ROOT, 'docs', 'setup-guide.md'), 'utf8');

const LIB = [
  'config.mjs', 'discovery.mjs', 'model.mjs', 'pages.mjs', 'html.mjs',
  'browser.mjs', 'render.mjs', 'promote.mjs',
].map((name) => `scripts/lib/desk-guides/${name}`);

const TESTS = [
  'tests/desk-guides-inventory.test.mjs',
  'tests/desk-guides-html.test.mjs',
  'tests/desk-guides-render.test.mjs',
  'tests/desk-guides-contract.test.mjs',
];

// ---------------------------------------------------------------------------
// Task 4.1 -- the standalone command and its documentation
// ---------------------------------------------------------------------------

test('package.json maps desk-guides to the exact Node entry point', () => {
  // Mutation killed: the script points at generated HTML, or at a package that
  // would have to be installed. The command IS the interface the design promises
  // works without an agent, so its target is pinned exactly.
  assert.equal(PKG.scripts['desk-guides'], 'node scripts/build-desk-guides.mjs');
  assert.equal(existsSync(join(ROOT, 'scripts/build-desk-guides.mjs')), true);
});

test('the package manifest still declares no dependencies of any kind', () => {
  // Mutation killed: a renderer library is added -- Puppeteer, a PDF merger, a
  // YAML parser. CLAUDE.md #4 is the constraint, and this generator was the most
  // plausible reason yet to break it.
  assert.equal(Object.hasOwn(PKG, 'dependencies'), false);
  assert.equal(Object.hasOwn(PKG, 'devDependencies'), false);
  assert.equal(Object.hasOwn(PKG, 'peerDependencies'), false);
  assert.equal(Object.hasOwn(PKG, 'optionalDependencies'), false);
});

test('the documented command matches the package script exactly', () => {
  // Mutation killed: the README drifts to a direct `node ...` invocation with
  // different flags, so the documented command and the supported one diverge and
  // only one of them is tested.
  assert.match(README, /```\r?\nnpm run desk-guides\r?\n```/);
  for (const flag of ['--out', '--tool', '--html-only', '--check', '--verbose']) {
    assert.ok(README.includes(flag), `README does not document ${flag}`);
  }
  const usage = readFileSync(join(ROOT, 'scripts/build-desk-guides.mjs'), 'utf8');
  for (const flag of ['--out', '--tool', '--claude-skills', '--codex-skills', '--html-only', '--check', '--verbose']) {
    assert.ok(usage.includes(flag), `the CLI no longer accepts ${flag}`);
  }
});

test('generated output is ignored while the configuration and sources stay tracked', () => {
  // Mutation killed: a broad `desk-guides*` ignore. That hides
  // `desk-guides.config.json` -- the editorial policy, the one file a human
  // actually edits -- and the loss is silent until someone clones the repo.
  const lines = GITIGNORE.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  assert.ok(lines.includes('output/'), '.gitignore does not ignore generated output');
  assert.ok(lines.includes('tmp/'), '.gitignore does not ignore generated staging');
  for (const pattern of lines) {
    assert.equal(/^desk-guides/.test(pattern), false, `.gitignore hides source policy with '${pattern}'`);
  }
  // The tracked-ness of these is what the broad-ignore mutant would destroy.
  const tracked = spawnSync('git', ['ls-files', 'desk-guides.config.json', ...LIB, ...TESTS], {
    cwd: ROOT, encoding: 'utf8', shell: false,
  });
  const listed = tracked.stdout.split(/\r?\n/).filter(Boolean);
  for (const rel of ['desk-guides.config.json', ...LIB]) {
    assert.ok(listed.includes(rel), `${rel} is not tracked by git`);
  }
});

test('setup documentation presents the browser and Poppler as generator-specific and optional', () => {
  // Mutation killed: the prerequisites are written into the general machine
  // baseline. Someone who cloned the public export to scaffold a repo would then
  // be told their machine is misconfigured for lacking a PDF toolchain they will
  // never use.
  const section = SETUP.slice(SETUP.indexOf('### For the desk guides only'));
  assert.ok(section.length > 0, 'the setup guide has no desk-guides prerequisite section');
  assert.match(section, /prerequisites of one command/);
  assert.match(section, /npm run desk-guides/);
  assert.match(section, /Poppler/);
  assert.match(section, /Edge or Google Chrome/);
  // The claim that matters: they are outside the machine baseline, and the file
  // that would contradict it does not mention them.
  const toolchain = readFileSync(join(ROOT, 'scripts/lib/toolchain.mjs'), 'utf8');
  for (const tool of ['pdfinfo', 'pdftoppm', 'msedge', 'poppler', 'chromium']) {
    assert.equal(new RegExp(tool, 'i').test(toolchain), false,
      `${tool} was added to the machine toolchain manifest, where a missing tier means "your machine is broken"`);
  }
});

// ---------------------------------------------------------------------------
// Task 4.5 -- the wiring smoke contract
// ---------------------------------------------------------------------------

test('a controlled end-to-end build names every artifact the manifest claims', () => {
  // Mutation killed: a wiring error in which every lower-level unit passes but
  // the CLI omits a page, a preview, the bundle, the inventory or the manifest.
  // Only an end-to-end assertion catches that, and only if it lists the expected
  // names rather than counting them -- a count passes when one file is swapped
  // for another.
  //
  // Both process boundaries are controlled: the browser and Poppler are stubs
  // that write plausible artifacts, so this runs identically on a machine with
  // neither installed.
  const fixture = makeRepo({
    // Four profiles, because page C's card grid is a closed table of approved
    // shapes and one profile is not one of them. The fixture has to be a repo the
    // generator would actually accept.
    ...Object.fromEntries(['alpha', 'beta', 'gamma', 'delta'].map((name) => [
      `profiles/${name}/profile.md`,
      `# ${name}\n\n\`\`\`profile\nverify: npm test\ntest: npm test\ndeploy: n/a\ndocs-subdirs: designs, adr\nroadmap: optional\n\`\`\`\n`,
    ])),
    'skills/orient/SKILL.md': '---\nname: orient\ndescription: Session-start brief.\n---\n',
    'skills/codex/SKILL.md': '---\nname: codex\ndescription: An independent second opinion.\n---\n',
  });
  const config = JSON.parse(readFileSync(join(ROOT, 'desk-guides.config.json'), 'utf8'));
  config.profiles = Object.fromEntries(['alpha', 'beta', 'gamma', 'delta']
    .map((name) => [name, { summary: `Choose ${name}.`, adds: `${name} step.`, rule: `${name} rule.` }]));
  // Every page must print something; A2 is fed from the fixture too, because a
  // card with no entries is refused and that refusal is correct.
  config.selected = [
    { key: 'claude:orient', page: 'A1', group: 'start', summary: 'Use when starting.' },
    { key: 'claude:codex', label: '/codex', page: 'A2', group: 'code', summary: 'An independent second opinion.' },
  ];
  config.families = [];
  config.omitted = [];
  const configPath = join(fixture, 'desk-guides.config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  const staging = join(fixture, 'staged');
  mkdirSync(staging, { recursive: true });
  const built = buildInventory({
    repoRoot: fixture,
    configPath,
    installedClaudeRoot: null,
    codexPersonalRoot: null,
    codexRepoRoot: null,
    staging,
    includeCodex: false,
  });
  const meta = { date: '2026-08-23', version: '0.0.0', commit: 'aaaaaaa' };
  const { pages, bundle } = writeHtml({ ...built, meta, staging });

  // The stubbed boundary: a browser that writes a PDF, a pdfinfo that describes
  // it, and a pdftoppm that writes a PNG of the right size.
  const PDFINFO = (n) => `Pages:          ${n}\nPage size:      792 x 612 pts (letter)\n`;
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(1650, 16);
  png.writeUInt32BE(1275, 20);

  const pageCount = new Map();
  const run = (command, args) => {
    if (command === 'stub-browser') {
      const out = args.find((a) => a.startsWith('--print-to-pdf='))?.slice('--print-to-pdf='.length);
      writeFileSync(out, '%PDF-1.4 stub\n');
      pageCount.set(out, /desk-guides\.pdf$/.test(out.replaceAll('\\', '/')) ? 6 : 1);
      return { stdout: '', stderr: '', status: 0 };
    }
    if (command === 'pdfinfo') return { stdout: PDFINFO(pageCount.get(args[0]) ?? 1), stderr: '', status: 0 };
    if (command === 'pdftoppm') {
      writeFileSync(`${args[args.length - 1]}.png`, png);
      return { stdout: '', stderr: '', status: 0 };
    }
    throw new Error(`unexpected command ${command}`);
  };

  const { problems, targets } = renderSet({
    staging,
    pages,
    bundle,
    layout: built.config.layout,
    browserPath: 'stub-browser',
    tools: { pdfinfo: { executable: 'pdfinfo', version: '0' }, pdftoppm: { executable: 'pdftoppm', version: '0' } },
    run,
  });
  assert.deepEqual(problems, []);

  const manifest = buildManifest({
    runId: 'smoke',
    meta,
    tools: { browser: 'stub-browser', pdfinfo: '0', pdftoppm: '0' },
    targets: [...targets, { path: 'manifest.json', sha256: null }],
    inputs: [],
    layout: built.config.layout,
  });

  assert.deepEqual(manifest.targets.map((t) => t.path), [
    'a1-claude-skill-card.html', 'a1-claude-skill-card.pdf', 'a1-claude-skill-card.png',
    'a2-codex-skill-card.html', 'a2-codex-skill-card.pdf', 'a2-codex-skill-card.png',
    'b-coding-workflow.html', 'b-coding-workflow.pdf', 'b-coding-workflow.png',
    'c-profile-map.html', 'c-profile-map.pdf', 'c-profile-map.png',
    'd-ship-release-publish.html', 'd-ship-release-publish.pdf', 'd-ship-release-publish.png',
    'desk-guides.html', 'desk-guides.pdf',
    'e-work-and-decisions-map.html', 'e-work-and-decisions-map.pdf', 'e-work-and-decisions-map.png',
    'inventory.json', 'manifest.json',
  ]);

  // The bundle's page count is a separate claim from its presence.
  const bundleTarget = manifest.targets.find((t) => t.path === 'desk-guides.pdf');
  assert.equal(bundleTarget.pages, 6);
  assert.equal(manifest.targets.find((t) => t.path === 'a1-claude-skill-card.pdf').pages, 1);
  assert.equal(manifest.targets.find((t) => t.path === 'a1-claude-skill-card.png').width, 1650);
});
