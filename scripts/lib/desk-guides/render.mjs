// PDF and PNG, and the tools that make them.
//
// Poppler is probed here rather than declared in `scripts/lib/toolchain.mjs`,
// and that boundary is the point: `tier` there means "a machine of yours is
// misconfigured without this", which is false for someone who cloned the public
// export to scaffold a repo. `pdfinfo` and `pdftoppm` are probed INDEPENDENTLY,
// because finding one is not evidence of the other -- they are separate binaries
// in the same package and a partial install is a real state.
//
// Nothing here installs anything. A missing tool is reported with the command
// that would install it and the run stops.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export class RenderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RenderError';
  }
}

const fail = (message) => { throw new RenderError(message); };

/** How much of a failing tool's stderr is worth reporting. Bounded on purpose:
 *  an unbounded dump buries the first line, which is the one that says what went
 *  wrong, and discarding it entirely leaves "render failed" and nothing else. */
const STDERR_LIMIT = 800;

/** The one place a child process is started. Executable plus argument array,
 *  `shell: false`, no command string ever built -- so a path containing a space
 *  or a semicolon is an argument, not syntax. */
export function runTool(executable, args, { run = defaultRun, allowNonZero = false } = {}) {
  const result = run(executable, args);
  if (result.error) {
    fail(`${executable} could not be run: ${result.error.code ?? result.error.message}`);
  }
  if (!allowNonZero && result.status !== 0) {
    const stderr = (result.stderr ?? '').trim().slice(0, STDERR_LIMIT);
    fail(`${executable} exited ${result.status}${stderr ? `: ${stderr}` : ' with no stderr'}`);
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

const defaultRun = (command, args) =>
  spawnSync(command, args, { shell: false, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });

const POPPLER_HINT = {
  win32: 'winget install oschwartz10612.Poppler   (then reopen the shell so PATH is picked up)',
  darwin: 'brew install poppler',
  linux: 'sudo apt install poppler-utils   (or the poppler package for your distribution)',
};

/** Probe one Poppler binary and capture its version for the manifest.
 *  `-v` writes to stderr on Poppler and exits non-zero on some builds, so the
 *  exit status is not the signal -- the version banner is. */
export function probePoppler(executable, { run = defaultRun } = {}) {
  const result = run(executable, ['-v']);
  if (result.error) {
    const hint = POPPLER_HINT[process.platform] ?? POPPLER_HINT.linux;
    fail(`${executable} is not on PATH. It ships with Poppler, which this generator needs to validate and preview PDFs and never installs for you.\n  Install: ${hint}`);
  }
  const banner = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const version = banner.match(/version\s+([0-9][0-9.]*)/i);
  if (!version) {
    fail(`${executable} answered \`-v\` with something this generator does not recognise as a version banner: ${banner.trim().slice(0, 200)}`);
  }
  return { executable, version: version[1] };
}

/** Both binaries, checked separately. Reporting them together would let a
 *  half-installed Poppler read as present until the run reached `pdftoppm`. */
export function findPoppler({ run = defaultRun } = {}) {
  return {
    pdfinfo: probePoppler('pdfinfo', { run }),
    pdftoppm: probePoppler('pdftoppm', { run }),
  };
}

/** Print one validated HTML file to PDF.
 *  Headers and footers off explicitly: the page carries its own provenance line,
 *  and a browser-drawn "file:///C:/Users/..." across the top would put a machine
 *  path on a printed page the design forbids one on. */
export function printToPdf({ browserPath, htmlPath, pdfPath, run = defaultRun, userDataDir = null }) {
  runTool(browserPath, [
    '--headless',
    ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
    '--disable-gpu',
    '--no-sandbox',
    '--no-pdf-header-footer',
    '--print-to-pdf-no-header',
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ], { run });
  if (!existsSync(pdfPath)) {
    fail(`${browserPath} reported success but wrote no PDF at ${pdfPath}`);
  }
  return pdfPath;
}

/** `pdfinfo` output, parsed strictly.
 *
 *  The page count is taken from the tool, never from a byte search of the PDF:
 *  `/Count` appears in page-tree nodes that a scan cannot tell apart, and the
 *  previous approximation in `desk-guides/README.md` is exactly that scan. */
export function parsePdfInfo(stdout) {
  const fields = new Map();
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][A-Za-z ]*?):\s+(.*)$/);
    if (m) fields.set(m[1].trim(), m[2].trim());
  }
  const pages = Number(fields.get('Pages'));
  if (!Number.isInteger(pages) || pages < 1) {
    fail(`\`pdfinfo\` reported no usable page count; the file may not be a PDF this tool can reopen. Output began: ${String(stdout).trim().slice(0, 200)}`);
  }
  const size = (fields.get('Page size') ?? '').match(/^([0-9.]+)\s*x\s*([0-9.]+)\s*pts/);
  if (!size) {
    fail(`\`pdfinfo\` reported no usable page size. Output began: ${String(stdout).trim().slice(0, 200)}`);
  }
  return { pages, widthPts: Number(size[1]), heightPts: Number(size[2]) };
}

/** Reopen a PDF and report what it actually is. Reopening IS the assertion: a
 *  browser can exit 0 having written a file no reader will accept. */
export function inspectPdf({ pdfinfo = 'pdfinfo', pdfPath, run = defaultRun }) {
  return parsePdfInfo(runTool(pdfinfo, [pdfPath], { run }).stdout);
}

/** Physical page validity, in points, with a tolerance for the fraction of a
 *  point Skia rounds to. Page count alone is not print validity: a one-page PDF
 *  at A4 portrait prints wrong on every one of these pages. */
export function checkPdf({ info, expectPages, layout, label }) {
  const problems = [];
  if (info.pages !== expectPages) {
    problems.push(`${label}: ${info.pages} page(s), expected exactly ${expectPages}`);
  }
  const wantW = layout.pageWidthIn * 72;
  const wantH = layout.pageHeightIn * 72;
  if (Math.abs(info.widthPts - wantW) > 1 || Math.abs(info.heightPts - wantH) > 1) {
    problems.push(`${label}: page is ${info.widthPts} x ${info.heightPts} pts, expected ${wantW} x ${wantH} (Letter landscape)`);
  }
  return problems;
}

/** PNG preview of page 1, at the configured preview resolution. */
export function renderPreview({ pdftoppm = 'pdftoppm', pdfPath, pngPathWithoutExt, dpi, run = defaultRun }) {
  runTool(pdftoppm, ['-png', '-r', String(dpi), '-f', '1', '-l', '1', '-singlefile', pdfPath, pngPathWithoutExt], { run });
  const png = `${pngPathWithoutExt}.png`;
  if (!existsSync(png)) fail(`\`pdftoppm\` reported success but wrote no PNG at ${png}`);
  return png;
}

/** Width and height from the PNG header, without a decoder.
 *
 *  Byte 0 is the signature and the IHDR chunk is required to be first, so width
 *  and height are at fixed offsets 16 and 20 as big-endian 32-bit integers. The
 *  signature is checked rather than assumed: a truncated or non-PNG file would
 *  otherwise yield two plausible-looking numbers from whatever bytes were there. */
export function pngDimensions(pathOrBuffer) {
  const buf = Buffer.isBuffer(pathOrBuffer) ? pathOrBuffer : readFileSync(pathOrBuffer);
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    fail(`${typeof pathOrBuffer === 'string' ? pathOrBuffer : 'the preview'} is not a PNG`);
  }
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') {
    fail('the preview PNG does not begin with an IHDR chunk');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Expected preview pixels, and landscape orientation as a separate assertion.
 *  A portrait preview with plausible pixel counts is the failure a non-zero
 *  check accepts. */
export function checkPreview({ dimensions, layout, dpi, label }) {
  const problems = [];
  const wantW = Math.round(layout.pageWidthIn * dpi);
  const wantH = Math.round(layout.pageHeightIn * dpi);
  if (Math.abs(dimensions.width - wantW) > 2 || Math.abs(dimensions.height - wantH) > 2) {
    problems.push(`${label}: preview is ${dimensions.width}x${dimensions.height}px, expected ${wantW}x${wantH} at ${dpi}dpi`);
  }
  if (dimensions.width <= dimensions.height) {
    problems.push(`${label}: preview is portrait (${dimensions.width}x${dimensions.height}); every guide is landscape`);
  }
  return problems;
}

export const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export const MANIFEST_SCHEMA = 1;

/**
 * The ownership record.
 *
 * It is not a log. Promotion may replace only the targets this file names, so
 * every generated file has to appear here -- HTML, inventory, PDFs, PNGs, the
 * bundle, and the manifest itself. A partial manifest is a promotion that either
 * refuses valid work or, worse, claims ownership of a file it did not write.
 */
export function buildManifest({ runId, meta, tools, targets, inputs, layout }) {
  return {
    schema: MANIFEST_SCHEMA,
    generator: 'scripts/build-desk-guides.mjs',
    runId,
    generatedOn: meta.date,
    daftplateVersion: meta.version,
    sourceCommit: meta.commit,
    tools,
    layout: { pageWidthIn: layout.pageWidthIn, pageHeightIn: layout.pageHeightIn, previewDpi: layout.previewDpi ?? null },
    inputs,
    targets: [...targets].sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
}

/** Digest of every input that decided the output, so a manifest can answer
 *  "would a rerun produce this?" without rerunning. */
export function digestInputs(repoRoot, relativePaths) {
  return relativePaths
    .filter((rel) => existsSync(join(repoRoot, rel)) && statSync(join(repoRoot, rel)).isFile())
    .sort()
    .map((rel) => ({ path: rel, sha256: sha256(join(repoRoot, rel)) }));
}
