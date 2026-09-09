// Six explicit page models, built from the inventory and from editorial policy.
//
// The division is the one the design sets and it is not cosmetic: A1, A2 and C
// are built from DISCOVERED facts, so they change when the machine changes; B, D
// and E are built from CONFIGURED policy, so they change only when someone
// decides something. A page that mixed the two would be unfalsifiable -- you
// could not tell a stale summary from a removed skill.
//
// Nothing here renders. A model is data; html.mjs turns it into markup, and the
// browser measures what that markup does. Keeping them apart is what lets the
// layout gate blame a specific element.
export class PageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PageError';
  }
}

const fail = (message) => { throw new PageError(message); };

/** Card-grid shapes page C is allowed to use, by profile count.
 *
 *  Deliberately a closed table rather than an arithmetic guess. The hand-built
 *  page was a 2x4 grid for eight profiles and the type contract is the acceptance
 *  criterion, not the grid: a ninth profile squeezed into the same eight boxes
 *  either shrinks type below 12pt or clips. So an unapproved count fails with a
 *  content-density error and someone decides, rather than the generator quietly
 *  choosing which rule to break. */
const PROFILE_GRIDS = new Map([
  [4, { columns: 2, rows: 2 }],
  [6, { columns: 2, rows: 3 }],
  [8, { columns: 2, rows: 4 }],
  [9, { columns: 3, rows: 3 }],
  [10, { columns: 2, rows: 5 }],
  [12, { columns: 3, rows: 4 }],
]);

/** Text roles, and which floor each is held to. The browser measures computed
 *  style against these; html.mjs emits CSS from the same table. One source. */
export const ROLES = ['title', 'heading', 'primary', 'secondary', 'footer'];

const page = (config, id) => {
  const found = config.pages.find((p) => p.id === id);
  if (!found) fail(`configuration has no page '${id}'`);
  return found;
};

/** Entries a page prints, in configured order, grouped as configured.
 *  Reads `shown` dispositions from the inventory rather than re-deriving from
 *  discovery: the inventory is the accounting document, and a card built from a
 *  second pass over discovery could disagree with it. */
function cardsFor(config, inventory, pageId) {
  const spec = page(config, pageId);
  const shown = new Map(
    inventory.entries.filter((e) => e.disposition === 'shown' && e.page === pageId).map((e) => [e.key, e]),
  );
  const editorial = [...config.selected, ...config.families].filter((e) => e.page === pageId);

  const groups = spec.groups.map((group) => ({
    id: group.id,
    title: group.title,
    note: group.note,
    entries: editorial
      .filter((entry) => entry.group === group.id)
      .map((entry) => ({
        key: entry.key,
        label: entry.label,
        summary: entry.summary,
        members: entry.members,
      })),
  }));

  // Every configured placement must have survived resolution, and every resolved
  // `shown` entry must have found a group. Checked in both directions because
  // each direction fails differently: the first is a card printing something the
  // inventory does not account for, the second is an accounted entry that never
  // reached paper.
  const placed = new Set(groups.flatMap((g) => g.entries.map((e) => e.key)));
  for (const key of shown.keys()) {
    if (!placed.has(key)) fail(`${pageId}: '${key}' resolved as shown but no group on this page prints it`);
  }
  return { spec, groups, placed };
}

function buildSkillCard(config, inventory, pageId) {
  const { spec, groups } = cardsFor(config, inventory, pageId);
  if (groups.every((group) => group.entries.length === 0)) {
    fail(`${pageId}: every group is empty; a card with no entries is a blank page, not a guide`);
  }
  return { id: spec.id, kind: 'skill-card', title: spec.title, subtitle: spec.subtitle, groups };
}

/** A1 and A2 differ only in their footer arithmetic, and that difference matters:
 *  the counts must come from two different places. Deriving both from the printed
 *  list would make "shown 8 of 8" true by construction on a page whose whole
 *  purpose is to say how much it left out.
 *
 *  `eligibleOnly` exists because the two footers make different claims, and a
 *  count has to answer the sentence it sits in. A1 says "Claude skills found",
 *  which is a statement about discovery, so an ineligible entry still counts as
 *  found. A2 says "Installed and enabled" and names `codex plugin list` as the
 *  command to check it against -- so an entry discovery marked ineligible, being
 *  by definition not a plugin row, cannot appear in that total without making the
 *  page assert something the named command contradicts. */
function footerCounts(inventory, tool, groups, { eligibleOnly = false } = {}) {
  const shown = groups.reduce((total, group) => total + group.entries.length, 0);
  const discovered = inventory.entries.filter((entry) => entry.key.startsWith(`${tool}:`)
    && !(eligibleOnly && entry.eligibleForCard === false)).length;
  return { shown, discovered };
}

export function buildA1(config, inventory) {
  const model = buildSkillCard(config, inventory, 'A1');
  model.counts = footerCounts(inventory, 'claude', model.groups);
  model.countsLabel = `Core shown: ${model.counts.shown} - Claude skills found: ${model.counts.discovered} - full list: inventory.json`;
  return model;
}

export function buildA2(config, inventory) {
  const model = buildSkillCard(config, inventory, 'A2');
  // Eligibility is settled in discovery and recorded in the inventory; this only
  // refuses to print anything that failed it. The leak this catches is a Codex
  // entry that reached a `shown` disposition without being installed and enabled.
  const eligible = new Map(inventory.entries.map((entry) => [entry.key, entry]));
  for (const group of model.groups) {
    for (const entry of group.entries) {
      const found = eligible.get(entry.key);
      if (found && found.eligibleForCard === false) {
        fail(`A2: '${entry.key}' is not an installed and enabled plugin row, so it may not print as one`);
      }
    }
  }
  model.counts = footerCounts(inventory, 'codex', model.groups, { eligibleOnly: true });
  model.countsLabel = `Installed and enabled: ${model.counts.discovered} - shown: ${model.counts.shown} - verify: codex plugin list`;
  return model;
}

export function buildB(config) {
  const spec = page(config, 'B');
  const { loop, callouts, scenarios, overlaps } = config.workflow;
  // Named individually rather than as one message: "workflow policy is
  // incomplete" tells the operator to open the file, and this tells them which
  // line of it. An empty list renders as a heading over blank space.
  for (const [name, list] of Object.entries({
    'workflow.loop': loop,
    'workflow.callouts': callouts,
    'workflow.scenarios': scenarios,
    'workflow.overlaps': overlaps,
  })) {
    if (!list.length) fail(`B: ${name} is empty; page B would print a heading over blank space`);
  }
  for (const [i, row] of overlaps.entries()) {
    // The section exists to remove choice. A row with a winner and no exception
    // reads as a neutral pair of options, which is the thing it replaces.
    if (!row.winner || !row.exception) fail(`B: overlaps[${i}] needs both a winner and a bounded exception`);
  }
  return {
    id: 'B',
    kind: 'workflow',
    title: spec.title,
    subtitle: spec.subtitle,
    // Each label is its own text-bearing element so an occlusion finding can name
    // the step that lost ink. The shipped bug rendered "Orient" as "Orien"; a
    // single string for the whole strip could not have said which cell did it.
    loop: loop.map((label, index) => ({ index, label, id: `loop-${index}` })),
    callouts,
    scenarios,
    overlaps,
  };
}

export function buildC(config, inventory) {
  const spec = page(config, 'C');
  const profiles = inventory.profiles;
  const grid = PROFILE_GRIDS.get(profiles.length);
  if (!grid) {
    fail(`C: ${profiles.length} profiles has no approved card grid (${[...PROFILE_GRIDS.keys()].join(', ')}). Adding one needs a layout variant that still meets the type contract, not a smaller font`);
  }
  const skills = new Map();
  for (const entry of inventory.entries) {
    if (entry.tool !== 'profile' || entry.disposition === 'omitted') continue;
    if (!skills.has(entry.profile)) skills.set(entry.profile, []);
    skills.get(entry.profile).push(entry.skill);
  }
  return {
    id: 'C',
    kind: 'profile-map',
    title: spec.title,
    subtitle: `C - ${profiles.length} profiles - pick one at scaffold time`,
    grid,
    // The six fields the spec names, in one place: three configured judgements
    // and three values the profile parser returned.
    profiles: profiles.map((profile) => ({
      name: profile.name,
      summary: profile.summary,
      adds: profile.adds,
      rule: profile.rule,
      verify: profile.verify,
      test: profile.test,
      deploy: profile.deploy,
      docsSubdirs: profile.docsSubdirs,
      skills: (skills.get(profile.name) ?? []).sort(),
    })),
    footnote: config.destinations.docsRule,
  };
}

export function buildD(config) {
  const spec = page(config, 'D');
  const { sections, stopBand, footnote } = config.release;
  if (sections.length !== 4) fail('D: page D is four numbered sections');
  // The two steps `/ship` does not take are the page's reason to exist. They are
  // print-acceptance items, so they are asserted in the model rather than left to
  // whether someone happened to write them into a list.
  const release = sections[1];
  const text = release.items.join(' | ');
  if (!/tag/i.test(text) || !/github release/i.test(text)) {
    fail('D: the release section must name the annotated tag and the GitHub Release explicitly; /ship creates neither');
  }
  return {
    id: 'D',
    kind: 'release',
    title: spec.title,
    subtitle: spec.subtitle,
    sections: sections.map((section, index) => ({ ...section, number: index + 1 })),
    stopBand,
    footnote,
  };
}

export function buildE(config) {
  const spec = page(config, 'E');
  const { decisionPath, rows, docsRule, stopRule, footnote } = config.destinations;
  if (!decisionPath.length || !rows.length) {
    fail('E: destination policy is incomplete; the decision path and the routing table are both required');
  }
  return {
    id: 'E',
    kind: 'destinations',
    title: spec.title,
    subtitle: spec.subtitle,
    decisionPath,
    rows,
    docsRule,
    stopRule,
    footnote,
  };
}

/** The six models, always in printed order. The bundle is generated from this
 *  same array, so its order cannot drift from the individual pages'. */
export function buildPages({ config, inventory }) {
  return [
    buildA1(config, inventory),
    buildA2(config, inventory),
    buildB(config),
    buildC(config, inventory),
    buildD(config),
    buildE(config),
  ];
}
