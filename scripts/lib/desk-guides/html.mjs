// Deterministic HTML for the six pages and for the bundle.
//
// Two rules shape everything here. Nothing consults the clock, the filesystem or
// the environment -- build metadata arrives as an argument -- so the same models
// produce the same bytes on any machine, and a diff of two runs is a diff of the
// sources. And every page-specific rule is scoped beneath its own page id, so the
// bundle can carry all six stylesheets without page B's `.stop-band` meaning
// something different from page D's. That collision is exactly why the
// hand-maintained set has no bundle.
//
// Text arriving from a source description or a configured summary is escaped and
// treated as data. A skill description is not markup and must never become any.
import { ROLES } from './pages.mjs';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape for text and attribute contexts alike. One function rather than two,
 *  because the failure of picking the wrong one is silent. */
export const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

/** Every text role and the floor it is held to, derived from the configured type
 *  contract. The browser checks COMPUTED style against the same numbers; this is
 *  the emitting half so there is one table, not two that drift. */
export function roleContract(layout) {
  return {
    title: { sizePt: layout.titlePt, lineHeight: layout.minLineHeight },
    heading: { sizePt: layout.headingPt, lineHeight: layout.minLineHeight },
    primary: { sizePt: layout.bodyPt, lineHeight: layout.minLineHeight + 0.01 },
    secondary: { sizePt: layout.minBodyPt, lineHeight: layout.minLineHeight + 0.02 },
    footer: { sizePt: layout.minFooterPt, lineHeight: layout.minLineHeight + 0.02 },
  };
}

/** Shared print contract. No condensed faces are named anywhere in the stack:
 *  the type contract forbids them, and a condensed fallback is how a page that
 *  measures clean still reads badly at three feet. */
export function sharedCss(layout) {
  const roles = roleContract(layout);
  const roleRules = ROLES.map((role) => {
    const { sizePt, lineHeight } = roles[role];
    return `[data-dg-role="${role}"] { font-size: ${sizePt}pt; line-height: ${lineHeight}; }`;
  }).join('\n');

  return `@page { size: letter landscape; margin: 0; }

:root {
  --ink: #111111;
  --ink-soft: #3d3d3d;
  --rule: #111111;
  --hair: #b8b8b8;
  --wash: #eeeeee;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: #ffffff;
  color: var(--ink);
  font-family: "Segoe UI", Calibri, "Helvetica Neue", Arial, sans-serif;
  font-variant-ligatures: none;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.dg-page {
  width: ${layout.pageWidthIn}in;
  height: ${layout.pageHeightIn}in;
  padding: ${layout.safeMarginIn}in;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  page-break-after: always;
  break-after: page;
}
.dg-page:last-child { page-break-after: auto; break-after: auto; }

${roleRules}

.dg-masthead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  border-bottom: 3px solid var(--rule);
  padding-bottom: 0.06in;
  margin-bottom: 0.13in;
  flex: none;
}
.dg-masthead h1 { font-weight: 700; letter-spacing: -0.01em; margin: 0; }
.dg-tag { font-weight: 600; color: var(--ink-soft); margin-left: 0.25in; white-space: nowrap; }

/* The content area clips, and that is deliberate. Without it, stacked sections
   that do not fit spill DOWNWARD over the footer while the page's own
   scrollHeight stays inside its box -- so nothing reports, and page B shipped a
   table printed across its own provenance line. Measured 2026-08-23. */
.dg-body { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; overflow: hidden; gap: 0.11in; }
/* Stacked sections take their natural height; only a grid absorbs slack. Letting
   flex shrink them instead produced 95px of clipped table on page B while every
   row was a single line -- the content fitted and the box did not. */
.dg-body > * { flex: 0 0 auto; }
.dg-body > .dg-grid { flex: 1 1 auto; }

.dg-card {
  border: 1.5pt solid var(--rule);
  padding: 0.08in 0.12in 0.07in;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.dg-card h2 { font-weight: 700; margin: 0 0 0.035in; }
.dg-note { color: var(--ink-soft); margin: 0 0 0.04in; }

.dg-entry { margin: 0 0 0.032in; }
.dg-entry:last-child { margin-bottom: 0; }
.dg-entry b { font-weight: 700; }

.dg-table { width: 100%; border-collapse: collapse; }
.dg-table th {
  text-align: left;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1.5pt solid var(--rule);
  padding: 0 0.06in 0.02in 0;
}
.dg-table td { padding: 0.026in 0.06in 0.026in 0; vertical-align: top; border-bottom: 1pt solid var(--hair); }
.dg-table tr:last-child td { border-bottom: none; }
.dg-strong { font-weight: 700; }

.dg-band {
  background: var(--ink);
  color: #ffffff;
  font-weight: 700;
  padding: 0.05in 0.09in;
  text-align: center;
}

.dg-footer {
  flex: none;
  margin-top: 0.09in;
  padding-top: 0.045in;
  border-top: 1pt solid var(--hair);
  color: var(--ink-soft);
  display: flex;
  justify-content: space-between;
  gap: 0.2in;
}
.dg-footer span:last-child { white-space: nowrap; }

code { font-family: Consolas, "Courier New", monospace; font-size: 0.92em; }
`;
}

// ---------------------------------------------------------------------------
// Page-specific CSS. Every selector is rooted at `#page-<id>` so six stylesheets
// can share one document without colliding.
// ---------------------------------------------------------------------------

const PAGE_CSS = {
  // Five groups into three columns: three on a tall first row, two on a shorter
  // second row with the last card spanning the gap. Row proportions are explicit
  // because equal rows give the three-entry Ship card the same height as the
  // nine-entry Start card, and the tall one clips.
  A1: (id) => `
#${id} .dg-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: minmax(0, 2.4fr) minmax(0, 1fr);
  gap: 0.09in 0.12in;
  min-height: 0;
}
#${id} .dg-card { padding: 0.065in 0.1in 0.06in; }
#${id} .dg-entry { margin-bottom: 0.022in; }
#${id} .dg-grid > .dg-card:last-child:nth-child(3n + 2) { grid-column: span 2; }
`,
  A2: (id) => `
#${id} .dg-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: minmax(0, 1.35fr) minmax(0, 1fr);
  gap: 0.1in 0.12in;
  min-height: 0;
}
#${id} .dg-grid > .dg-card:last-child:nth-child(3n + 2) { grid-column: span 2; }
`,
  B: (id) => `
#${id} .dg-loop { display: flex; flex-wrap: wrap; gap: 0.05in; align-items: stretch; }
#${id} .dg-step {
  border: 1pt solid var(--rule);
  padding: 0.018in 0.042in;
  white-space: nowrap;
  background: #ffffff;
}
#${id} .dg-step.dg-start { background: var(--wash); font-weight: 700; }
#${id} .dg-callouts { display: flex; flex-wrap: wrap; gap: 0.015in 0.13in; margin: 0.03in 0 0; padding: 0; list-style: none; }
#${id} .dg-callouts li { font-weight: 700; }
/* Seventeen table rows plus a loop strip is the densest page in the set, so its
   rows are tightened rather than its type. The contract's own instruction when a
   page will not fit: cut words or space, never type size. */
#${id} .dg-body { gap: 0.05in; }
#${id} .dg-card { padding: 0.042in 0.09in 0.038in; }
#${id} .dg-card h2 { font-size: 17pt; margin-bottom: 0.02in; }
#${id} .dg-masthead { margin-bottom: 0.08in; padding-bottom: 0.04in; }
#${id} .dg-footer { margin-top: 0.05in; }
#${id} .dg-table th { padding-bottom: 0.012in; }
#${id} .dg-table td { padding: 0.007in 0.055in 0.007in 0; line-height: 1.18; }
#${id} .dg-scenarios td:first-child { width: 2.05in; }
#${id} .dg-overlaps td:first-child { width: 2.5in; }
#${id} .dg-overlaps td:nth-child(2) { width: 3.7in; }
#${id} .dg-closer { font-weight: 700; white-space: nowrap; }
`,
  // Rows size to content and the slack is shared between them, rather than four
  // equal rows. Equal rows give every card the height of the tallest, and the
  // tallest card -- app-monolith, the only one with five repo-scoped skills --
  // then clips the very field that makes it different. Measured: 80px lost.
  C: (id, model) => `
#${id} .dg-grid {
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: repeat(${model.grid.columns}, 1fr);
  grid-auto-rows: min-content;
  align-content: start;
  gap: 0.035in 0.11in;
  min-height: 0;
}
#${id} .dg-masthead { margin-bottom: 0.08in; }
#${id} .dg-footer { margin-top: 0.05in; }
#${id} .dg-card { padding: 0.032in 0.08in 0.03in; }
#${id} .dg-card h2 { font-size: 17pt; margin-bottom: 0.012in; }
#${id} .dg-entry { margin-bottom: 0.016in; }
#${id} .dg-meta { background: var(--wash); border-left: 2.5pt solid var(--rule); padding: 0.012in 0.045in; margin: 0 0 0.018in; }
#${id} .dg-field { margin: 0 0 0.009in; }
#${id} .dg-field .dg-lbl, #${id} .dg-meta .dg-lbl { font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
#${id} .dg-sep { color: var(--hair); }
#${id} .dg-rule-line { margin-top: auto; padding-top: 0.03in; border-top: 1pt solid var(--hair); }
`,
  D: (id) => `
#${id} .dg-grid { flex: 1 1 auto; display: grid; grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(2, minmax(0, 1fr)); gap: 0.1in 0.13in; min-height: 0; }
#${id} .dg-num { font-weight: 700; }
#${id} .dg-check { margin: 0 0 0.024in; }
#${id} .dg-cmd { display: block; background: var(--wash); border-left: 2.5pt solid var(--rule); padding: 0.02in 0.05in; margin: 0 0 0.02in; }
#${id} .dg-stop { font-weight: 700; margin-top: auto; padding-top: 0.03in; }
`,
  E: (id) => `
#${id} .dg-split { display: grid; grid-template-columns: 1fr 1.35fr; gap: 0.16in; flex: 1 1 auto; min-height: 0; }
#${id} .dg-path { margin: 0 0 0.045in; }
#${id} .dg-path .dg-home { font-weight: 700; }
#${id} .dg-rules { display: flex; flex-direction: column; gap: 0.05in; margin-top: 0.06in; }
`,
};

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

const role = (name) => `data-dg-role="${name}"`;

const masthead = (model) => `  <header class="dg-masthead">
    <h1 ${role('title')} data-dg-id="${model.id}-title">${esc(model.title)}</h1>
    <div class="dg-tag" ${role('primary')}>${esc(model.subtitle)}</div>
  </header>`;

const footer = (model, meta, right) => `  <footer class="dg-footer" ${role('footer')}>
    <span data-dg-id="${model.id}-provenance">Generated ${esc(meta.date)} - daftplate ${esc(meta.version)} - source ${esc(meta.commit)} - regenerate: npm run desk-guides</span>
    <span data-dg-id="${model.id}-counts">${esc(right)}</span>
  </footer>`;

function skillCardBody(model, lines) {
  const cards = model.groups.map((group) => `      <section class="dg-card">
        <h2 ${role('heading')}>${esc(group.title)}</h2>
${group.note ? `        <p class="dg-note" ${role('secondary')} data-dg-lines="${lines}">${esc(group.note)}</p>\n` : ''}${group.entries.map((entry) => `        <p class="dg-entry" ${role('primary')} data-dg-lines="${lines}" data-dg-id="${esc(entry.key)}"><b>${esc(entry.label)}</b> -- ${esc(entry.summary)}</p>`).join('\n')}
      </section>`).join('\n');
  return `    <div class="dg-grid">
${cards}
    </div>`;
}

function workflowBody(model, lines) {
  const steps = model.loop.map((step, i) => `        <div class="dg-step${i === 0 ? ' dg-start' : ''}" ${role('primary')} data-dg-lines="1" data-dg-id="${model.id}-${step.id}">${esc(step.label)}</div>`).join('\n');
  const callouts = model.callouts.map((line) => `        <li ${role('primary')} data-dg-lines="1">${esc(line)}</li>`).join('\n');
  const scenarios = model.scenarios.map((row) => `          <tr>
            <td class="dg-strong" ${role('secondary')}>${esc(row.when)}</td>
            <td ${role('secondary')}>${esc(row.path)} <span class="dg-closer">${esc(row.closer)}</span></td>
          </tr>`).join('\n');
  const overlaps = model.overlaps.map((row) => `          <tr>
            <td ${role('secondary')}>${esc(row.overlap)}</td>
            <td class="dg-strong" ${role('secondary')}>${esc(row.winner)}</td>
            <td ${role('secondary')}>${esc(row.exception)}</td>
          </tr>`).join('\n');

  // Stacked, not side by side. Ten scenario paths are long strings, and a
  // half-width column turns each into three lines -- 188px of clipped table,
  // measured. Full width keeps almost every row on one line, which is also what
  // makes a scenario findable in the five seconds the acceptance check allows.
  return `    <section>
      <h2 ${role('heading')}>B1 core loop</h2>
      <div class="dg-loop">
${steps}
      </div>
      <ul class="dg-callouts">
${callouts}
      </ul>
    </section>
    <section class="dg-card">
      <h2 ${role('heading')}>B2 scenario quick map - if this, use this path, end at the bold closer</h2>
      <table class="dg-table dg-scenarios">
        <tbody>
${scenarios}
        </tbody>
      </table>
    </section>
    <section class="dg-card">
      <h2 ${role('heading')}>B3 editorial calls - overlap, bold winner, bounded exception</h2>
      <table class="dg-table dg-overlaps">
        <tbody>
${overlaps}
        </tbody>
      </table>
    </section>`;
}

function profileMapBody(model, lines) {
  const cards = model.profiles.map((profile) => `      <section class="dg-card" data-dg-id="profile-${esc(profile.name)}">
        <h2 ${role('heading')}>${esc(profile.name)}</h2>
        <p class="dg-entry" ${role('secondary')} data-dg-lines="${lines}">${esc(profile.summary)}</p>
        <p class="dg-meta" ${role('secondary')}><span class="dg-lbl">verify</span> <code>${esc(profile.verify)}</code> <span class="dg-lbl">test</span> <code>${esc(profile.test)}</code> <span class="dg-lbl">deploy</span> <code>${esc(profile.deploy)}</code></p>
        <p class="dg-field" ${role('secondary')}><span class="dg-lbl">adds</span> ${esc(profile.adds)}</p>
        <p class="dg-field" ${role('secondary')}><span class="dg-lbl">rule</span> ${esc(profile.rule)}</p>
${profile.skills.length ? `        <p class="dg-field dg-rule-line" ${role('secondary')}><span class="dg-lbl">skills</span> ${esc(profile.skills.join(', '))}</p>` : ''}
      </section>`).join('\n');
  return `    <div class="dg-grid">
${cards}
    </div>`;
}

function releaseBody(model, lines) {
  const cards = model.sections.map((section) => `      <section class="dg-card" data-dg-id="release-${section.number}">
        <h2 ${role('heading')}><span class="dg-num">${section.number}.</span> ${esc(section.title)}</h2>
        <p class="dg-note" ${role('primary')} data-dg-lines="${lines}">${esc(section.lead)}</p>
${section.items.map((item) => `        <p class="dg-check" ${role('secondary')}>&#9633; ${esc(item)}</p>`).join('\n')}
${section.commands.map((cmd) => `        <code class="dg-cmd" ${role('secondary')}>${esc(cmd)}</code>`).join('\n')}
${section.stop ? `        <p class="dg-stop" ${role('secondary')}>${esc(section.stop)}</p>` : ''}
      </section>`).join('\n');
  return `    <div class="dg-grid">
${cards}
    </div>
    <div class="dg-band" ${role('secondary')} data-dg-id="D-stop-band">${esc(model.stopBand)}</div>`;
}

function destinationsBody(model, lines) {
  const path = model.decisionPath.map((step) => `        <p class="dg-path" ${role('primary')} data-dg-lines="${lines}">${esc(step.question)} &rarr; <span class="dg-home">${esc(step.home)}</span></p>`).join('\n');
  const rows = model.rows.map((row) => `          <tr>
            <td ${role('secondary')}>${esc(row.information)}</td>
            <td class="dg-strong" ${role('secondary')}>${esc(row.home)}</td>
          </tr>`).join('\n');
  return `    <div class="dg-split">
      <section class="dg-card">
        <h2 ${role('heading')}>Decision path</h2>
${path}
        <div class="dg-rules">
          <div class="dg-band" ${role('secondary')} data-dg-id="E-docs-rule">${esc(model.docsRule)}</div>
          <div class="dg-band" ${role('secondary')} data-dg-id="E-stop-rule">${esc(model.stopRule)}</div>
        </div>
      </section>
      <section class="dg-card">
        <h2 ${role('heading')}>One home each</h2>
        <table class="dg-table">
          <thead><tr><th ${role('footer')}>Information</th><th ${role('footer')}>Canonical home</th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </section>
    </div>`;
}

const BODIES = {
  'skill-card': skillCardBody,
  workflow: workflowBody,
  'profile-map': profileMapBody,
  release: releaseBody,
  destinations: destinationsBody,
};

/** One page's markup, as it appears both standalone and inside the bundle. There
 *  is exactly one producer, so the bundle cannot become a second copy that drifts. */
export function renderPageBody(model, meta, layout) {
  const build = BODIES[model.kind];
  if (!build) throw new Error(`no renderer for page kind '${model.kind}'`);
  const right = model.countsLabel ?? model.footnote ?? '';
  const lines = layout.maxLines[model.id];
  return `<div class="dg-page" id="page-${model.id}" data-dg-page="${model.id}">
${masthead(model)}
  <div class="dg-body">
${build(model, lines)}
  </div>
${footer(model, meta, right)}
</div>`;
}

export function pageCss(model) {
  const build = PAGE_CSS[model.id];
  return build ? build(`page-${model.id}`, model).trim() : '';
}

function document_(title, css, bodies) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
${css}
</style>
</head>
<body>
${bodies.join('\n')}
</body>
</html>
`;
}

/** A single page as a self-contained file. */
export function renderPage(model, { layout, meta }) {
  return document_(
    `${model.title} - daftplate desk guide ${model.id}`,
    [sharedCss(layout), pageCss(model)].filter(Boolean).join('\n'),
    [renderPageBody(model, meta, layout)],
  );
}

/** All six, in A1 A2 B C D E order, from the same models and the same bodies. */
export function renderBundle(models, { layout, meta }) {
  return document_(
    'daftplate desk guides',
    [sharedCss(layout), ...models.map(pageCss).filter(Boolean)].join('\n'),
    models.map((model) => renderPageBody(model, meta, layout)),
  );
}

/** Basenames the output set uses, keyed by page id. Stable, lower-case, and
 *  independent of page titles so a retitled page does not silently orphan the
 *  previous file under its old name. */
export const PAGE_FILES = {
  A1: 'a1-claude-skill-card',
  A2: 'a2-codex-skill-card',
  B: 'b-coding-workflow',
  C: 'c-profile-map',
  D: 'd-ship-release-publish',
  E: 'e-work-and-decisions-map',
};

export const BUNDLE_FILE = 'desk-guides';
