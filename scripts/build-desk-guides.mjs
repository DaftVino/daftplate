#!/usr/bin/env node
// The desk-guide generator's front door. Thin on purpose: it parses the command
// line, decides where the roots are, and hands the work to focused modules. Every
// transformation worth testing lives under scripts/lib/desk-guides/ and takes
// explicit inputs, so the only thing that needs a real machine is this file.
//
// Nothing here writes over a previous output. A run builds into a staging
// directory it created itself, and promotion into `output/pdf/desk-guides/`
// happens only after the whole set validates.
//
// Exit codes are the contract the spec sets: 0 every requested guide is valid,
// 1 source/configuration/layout/render validation failed, 2 invalid usage or a
// missing required local executable.
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './lib/cli.mjs';
import { parseProfileMeta } from './verify-templates.mjs';
import { readConfigFile, ConfigError } from './lib/desk-guides/config.mjs';
import { discover, DiscoveryError } from './lib/desk-guides/discovery.mjs';
import { resolveInventory, serializeInventory, ModelError } from './lib/desk-guides/model.mjs';
import { buildPages, PageError } from './lib/desk-guides/pages.mjs';
import { renderPage, renderBundle, PAGE_FILES, BUNDLE_FILE } from './lib/desk-guides/html.mjs';
import { findBrowser, validatePage, typeContract, BrowserError } from './lib/desk-guides/browser.mjs';
import {
  findPoppler, printToPdf, inspectPdf, checkPdf, renderPreview, pngDimensions,
  checkPreview, buildManifest, digestInputs, sha256, RenderError,
} from './lib/desk-guides/render.mjs';
import {
  preflight, createStaging, planPromotion, promote, recoverInterrupted,
  removeOwnDirectory, listTree, MARKER, PromoteError,
} from './lib/desk-guides/promote.mjs';

export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_USAGE = 2;

const USAGE = `Usage: node scripts/build-desk-guides.mjs [options]

  --out <directory>        where the validated set is promoted (default output/pdf/desk-guides)
  --tool claude|codex|all  limit skill-card generation (default all); pages B-E always build
  --claude-skills <dir>    installed Claude skill root (default ~/.claude/skills)
  --codex-skills <dir>     personal Codex skill root (default ~/.codex/skills)
  --html-only              stop after HTML; a diagnostic escape when PDF tools are absent
  --check                  build and validate into a temporary directory, promote nothing
  --verbose                report each stage
`;

const FLAGS = new Set(['--html-only', '--check', '--verbose']);
const VALUES = new Set(['--out', '--tool', '--claude-skills', '--codex-skills']);

/** Parse argv into options, or return a usage error. Unknown options are a usage
 *  error rather than an ignored extra: a misspelled `--htmlonly` that silently
 *  did nothing would promote a set the operator believed was only inspected. */
export function parseArgs(argv) {
  const options = {
    out: null, tool: 'all', claudeSkills: null, codexSkills: null,
    htmlOnly: false, check: false, verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (FLAGS.has(arg)) {
      options[{ '--html-only': 'htmlOnly', '--check': 'check', '--verbose': 'verbose' }[arg]] = true;
      continue;
    }
    if (VALUES.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      i += 1;
      const field = { '--out': 'out', '--tool': 'tool', '--claude-skills': 'claudeSkills', '--codex-skills': 'codexSkills' }[arg];
      options[field] = value;
      continue;
    }
    return { error: `unknown option '${arg}'` };
  }
  if (!['claude', 'codex', 'all'].includes(options.tool)) {
    return { error: `--tool must be claude, codex or all, not '${options.tool}'` };
  }
  return { options };
}

/**
 * Discover, resolve, and write the inventory into a staging directory.
 *
 * Returns the staging path and the resolved inventory. Every filesystem root and
 * the process boundary are parameters, so a test drives this with a fixture tree
 * and fake command output instead of the maintainer's own installation.
 */
export function buildInventory({
  repoRoot,
  configPath = join(repoRoot, 'desk-guides.config.json'),
  installedClaudeRoot,
  codexPersonalRoot,
  codexRepoRoot,
  stagingRoot,
  staging: given = null,
  runId = null,
  run,
  includeCodex = true,
  buildMeta = null,
}) {
  const config = readConfigFile(configPath);
  const discovery = discover({
    repoRoot,
    installedClaudeRoot,
    codexPersonalRoot,
    codexRepoRoot,
    parseProfileMeta,
    run,
    includeCodex,
  });
  const inventory = resolveInventory({ config, discovery });

  const staging = given ?? createStaging({ parent: stagingRoot, runId: runId ?? newRunId() });
  writeFileSync(join(staging, 'inventory.json'), serializeInventory(inventory, buildMeta), 'utf8');
  return { config, discovery, inventory, staging };
}

/** Unguessable, so a staging or rollback directory cannot be confused with one
 *  another process happened to name the same way. */
export const newRunId = () => randomBytes(6).toString('hex');

/**
 * Six page files and the bundle, written into the staging directory.
 *
 * The bundle is rendered from the same six models, not from the six files, so it
 * cannot become a second copy that has to be re-synced by hand. That second copy
 * is the whole reason the hand-maintained set never got a bundle.
 */
export function writeHtml({ config, inventory, meta, staging }) {
  const models = buildPages({ config, inventory });
  const written = models.map((model) => {
    const html = renderPage(model, { layout: config.layout, meta });
    const path = join(staging, `${PAGE_FILES[model.id]}.html`);
    writeFileSync(path, html, 'utf8');
    return { id: model.id, path, html };
  });
  const bundleHtml = renderBundle(models, { layout: config.layout, meta });
  const bundlePath = join(staging, `${BUNDLE_FILE}.html`);
  writeFileSync(bundlePath, bundleHtml, 'utf8');
  return { models, pages: written, bundle: { id: 'bundle', path: bundlePath, html: bundleHtml } };
}

/** Measure every individual page in a real browser. The bundle is not measured
 *  here: its six page boxes are the same boxes, and its own contract -- exactly
 *  six printed pages -- is a PDF fact that phase 3 checks with `pdfinfo`. */
export function validateHtml({ pages, layout, browserPath, run, budgetMs, userDataDir, workDir }) {
  const contract = typeContract(layout);
  mkdirSync(workDir, { recursive: true });
  return pages.flatMap(({ id, path, html }) => validatePage({
    browserPath,
    htmlPath: path,
    html,
    // Instrumented copies live in the run's work directory, never beside the
    // deliverables. Anything left in staging is promoted, and a page carrying a
    // measurement script is not something to pin to a cork board.
    probePath: join(workDir, `${basename(path, '.html')}.probe.html`),
    contract,
    layout,
    run,
    budgetMs,
    userDataDir,
  }).map((finding) => ({ ...finding, page: finding.page === '?' ? id : finding.page })));
}

/**
 * PDFs, previews, the bundle, and the manifest -- all inside staging.
 *
 * Every artifact is reopened after it is written. A browser exits 0 having
 * produced a file no reader accepts, and `pdfinfo` is the authority on whether
 * the thing on disk is a one-page Letter-landscape PDF. Nothing is inferred from
 * the browser's status or from a byte search of the file.
 */
export function renderSet({
  staging, pages, bundle, layout, browserPath, tools, run, userDataDir = null,
}) {
  const problems = [];
  const targets = [];
  const dpi = layout.previewDpi;

  const record = (path, extra = {}) => targets.push({
    path: path.replace(/\\/g, '/'), sha256: sha256(join(staging, path)), ...extra,
  });

  for (const { id, path } of pages) {
    const base = PAGE_FILES[id];
    const pdf = join(staging, `${base}.pdf`);
    printToPdf({ browserPath, htmlPath: path, pdfPath: pdf, run, userDataDir });
    const info = inspectPdf({ pdfinfo: tools.pdfinfo.executable, pdfPath: pdf, run });
    problems.push(...checkPdf({ info, expectPages: 1, layout, label: `${base}.pdf` }));

    const png = renderPreview({
      pdftoppm: tools.pdftoppm.executable,
      pdfPath: pdf,
      pngPathWithoutExt: join(staging, base),
      dpi,
      run,
    });
    const dimensions = pngDimensions(png);
    problems.push(...checkPreview({ dimensions, layout, dpi, label: `${base}.png` }));

    record(`${base}.html`);
    record(`${base}.pdf`, { pages: info.pages, widthPts: info.widthPts, heightPts: info.heightPts });
    record(`${base}.png`, { width: dimensions.width, height: dimensions.height });
  }

  const bundlePdf = join(staging, `${BUNDLE_FILE}.pdf`);
  printToPdf({ browserPath, htmlPath: bundle.path, pdfPath: bundlePdf, run, userDataDir });
  const bundleInfo = inspectPdf({ pdfinfo: tools.pdfinfo.executable, pdfPath: bundlePdf, run });
  problems.push(...checkPdf({ info: bundleInfo, expectPages: pages.length, layout, label: `${BUNDLE_FILE}.pdf` }));
  record(`${BUNDLE_FILE}.html`);
  record(`${BUNDLE_FILE}.pdf`, {
    pages: bundleInfo.pages, widthPts: bundleInfo.widthPts, heightPts: bundleInfo.heightPts,
  });
  record('inventory.json');

  return { problems, targets };
}

/** Build metadata, gathered once at the boundary and passed in as data.
 *  The local calendar date rather than a timestamp: it covers installed
 *  Claude/Codex changes that happen without a commit, while the commit identifies
 *  the repository state. The exact instant belongs in the manifest, not on paper. */
export function buildMetaFor(repoRoot, now = new Date()) {
  const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repoRoot, shell: false, encoding: 'utf8', windowsHide: true,
  });
  const commit = git.status === 0 ? git.stdout.trim() : 'unknown';
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return { date, version, commit };
}

export function main(argv) {
  const { options, error } = parseArgs(argv.slice(2));
  if (error) {
    console.error(`build-desk-guides: ${error}`);
    console.error(USAGE);
    return EXIT_USAGE;
  }

  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const home = homedir();
  const outputDir = resolve(options.out ?? join(repoRoot, 'output', 'pdf', 'desk-guides'));
  const stagingRoot = join(repoRoot, 'tmp', 'pdfs', 'desk-guides');
  const runId = newRunId();
  let staging = null;

  // Before anything is created. A guard that runs after the first mkdir has
  // already written into the place it was meant to protect.
  const refusals = preflight({ outputDir, repoRoot, home });
  if (refusals.length) {
    for (const line of refusals) console.error(`  ${line}`);
    console.error('build-desk-guides: refusing that output directory; nothing was created');
    return EXIT_USAGE;
  }

  const interrupted = recoverInterrupted({ outputDir });
  if (interrupted.message) console.log(`recovery: ${interrupted.message}`);

  try {
    const built = buildInventory({
      repoRoot,
      installedClaudeRoot: options.claudeSkills ?? join(home, '.claude', 'skills'),
      codexPersonalRoot: options.codexSkills ?? join(home, '.codex', 'skills'),
      codexRepoRoot: join(repoRoot, '.codex', 'skills'),
      stagingRoot,
      runId,
      includeCodex: options.tool !== 'claude',
    });
    const { config, inventory } = built;
    staging = built.staging;

    const { shown, grouped, omitted } = inventory.counts;
    console.log(`inventory: ${shown} shown, ${grouped} grouped, ${omitted} omitted across ${inventory.profiles.length} profiles`);
    if (options.verbose) {
      for (const source of inventory.sources) {
        console.log(`  ${source.id}: ${source.found} found${source.path && !source.present ? ' (root absent)' : ''}`);
      }
    }

    const meta = buildMetaFor(repoRoot);
    const { pages, bundle } = writeHtml({ config, inventory, meta, staging });
    console.log(`html: ${pages.length} pages + bundle in ${staging}`);

    // `--html-only` means "stop before PDF", not "skip layout validation". A page
    // nobody measured is a page that prints wrong, which is the state this
    // generator replaced.
    const browserPath = findBrowser();
    if (options.verbose) console.log(`browser: ${browserPath}`);
    const workDir = join(staging, 'work');
    const findings = validateHtml({
      pages, layout: config.layout, browserPath, workDir,
      userDataDir: join(workDir, 'browser'),
    });
    if (findings.length) {
      for (const finding of findings) {
        console.error(`  ${finding.page} ${finding.type} ${finding.id}: ${finding.message}`);
      }
      console.error(`build-desk-guides: ${findings.length} layout finding(s); the previous output set is untouched`);
      return EXIT_INVALID;
    }
    console.log('layout: clean (geometry, type, line count, overflow, occlusion)');

    if (options.htmlOnly) {
      // Retained, not cleaned. `--html-only` exists so someone can open the
      // pages and print them from the browser when PDF tooling is absent;
      // deleting them on the way out would defeat the whole flag.
      console.log(`staged: ${staging}`);
      staging = null;
      return EXIT_OK;
    }

    const tools = findPoppler();
    if (options.verbose) {
      console.log(`poppler: pdfinfo ${tools.pdfinfo.version}, pdftoppm ${tools.pdftoppm.version}`);
    }

    const { problems, targets } = renderSet({
      staging, pages, bundle, layout: config.layout, browserPath, tools,
      userDataDir: join(workDir, 'browser'),
    });
    if (problems.length) {
      for (const line of problems) console.error(`  ${line}`);
      console.error(`build-desk-guides: ${problems.length} render finding(s); the previous output set is untouched`);
      return EXIT_INVALID;
    }
    console.log(`render: ${pages.length} one-page PDFs, ${pages.length} previews, and a ${pages.length}-page bundle`);

    const manifest = buildManifest({
      runId,
      meta,
      tools: {
        browser: browserPath,
        pdfinfo: tools.pdfinfo.version,
        pdftoppm: tools.pdftoppm.version,
      },
      targets: [...targets, { path: 'manifest.json', sha256: null }],
      inputs: digestInputs(repoRoot, ['desk-guides.config.json', 'package.json']),
      layout: config.layout,
    });
    writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    if (options.check) {
      console.log(`check: the committed configuration and current sources produce a clean set (${staging})`);
      console.log('check: nothing was promoted; the previous output set is untouched');
      staging = null;                     // retained for inspection, as --html-only is
      return EXIT_OK;
    }

    // Everything below only runs once the whole set has validated.
    //
    // The work directory and the run marker are removed first: after promotion
    // the staging directory IS the output directory, so anything still in it is
    // published. Both were created by this invocation, which is the only reason
    // removing them is permitted at all.
    rmSync(workDir, { recursive: true, force: true });
    rmSync(join(staging, MARKER), { force: true });
    planPromotion({ outputDir, stagedTargets: listTree(staging) });
    promote({ staging, outputDir, runId });
    staging = null;                       // promoted; the directory is the output now
    console.log(`promoted: ${outputDir}`);
    return EXIT_OK;
  } catch (err) {
    if (err instanceof ConfigError || err instanceof DiscoveryError
      || err instanceof ModelError || err instanceof PageError || err instanceof BrowserError
      || err instanceof RenderError || err instanceof PromoteError) {
      console.error(`build-desk-guides: ${err.message}`);
      // A missing local executable is a machine problem, not a bad configuration,
      // and the operator needs the two apart to know whether to edit a file or
      // install a tool.
      return /is not on PATH|no Chromium-family browser/.test(err.message) ? EXIT_USAGE : EXIT_INVALID;
    }
    throw err;
  } finally {
    // Only this invocation's own marked staging directory, and only if it was
    // not promoted. Nothing else in `tmp/pdfs/desk-guides/` is touched -- a
    // sibling from another run is another run's evidence.
    if (staging) removeOwnDirectory({ dir: staging, parent: stagingRoot, runId, kind: 'staging' });
  }
}

runCli(import.meta.url, main);
