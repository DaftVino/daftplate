// Editorial policy for the desk guides, validated before anything is discovered.
//
// The split this module defends: discovery owns what EXISTS, configuration owns
// what is worth PRINTING. A config that carries a source path, a frontmatter
// description or a profile's `verify` command has started shadowing the sources
// it was meant to compress, and the next drift is invisible again. So a
// discovery-owned field inside an editorial entry is a hard error rather than an
// ignored extra.
//
// Every rule here is strict on purpose. Adding a profile or selecting a skill
// costs a config edit before the generator will run, and that friction IS the
// drift detector this feature exists to be.
import { readFileSync } from 'node:fs';

export const SCHEMA_VERSION = 1;

/** The six pages, in printed order. The bundle is generated in this order too. */
export const PAGE_IDS = ['A1', 'A2', 'B', 'C', 'D', 'E'];

/** Top-level shape. An unlisted key is a misspelling of a listed one far more
 *  often than it is a new feature, and a validator that ignores it silently
 *  drops the policy the author thought they had written. */
const TOP_LEVEL = new Set([
  'schemaVersion', 'pages', 'profiles', 'selected', 'families', 'omitted',
  'workflow', 'release', 'destinations', 'layout',
]);

/** Fields an editorial entry may never carry, because discovery owns them.
 *  Named explicitly rather than checked as "anything unknown": the point is not
 *  that the field is unrecognised, it is that config is copying a source fact. */
const DISCOVERY_OWNED = new Set([
  'sourcePath', 'path', 'description', 'frontmatter', 'installed', 'enabled',
  'version', 'verify', 'test', 'deploy', 'command',
]);

const ENTRY_FIELDS = new Set(['key', 'label', 'page', 'group', 'summary', 'members']);
const OMISSION_FIELDS = new Set(['key', 'reason']);

/** Canonical key grammar. A segment may carry `@` because that is how Codex
 *  itself names a plugin -- `documents@openai-primary-runtime` -- and dropping
 *  the marketplace would collide two plugins of the same name from two sources. */
const SEGMENT = '[A-Za-z0-9_][A-Za-z0-9._@-]*';
const KEY_PATTERNS = [
  { tool: 'claude', re: new RegExp(`^claude:(${SEGMENT})$`), fields: ['skill'] },
  { tool: 'codex', re: new RegExp(`^codex:(${SEGMENT}):(${SEGMENT})$`), fields: ['plugin', 'skill'] },
  { tool: 'profile', re: new RegExp(`^profile:(${SEGMENT}):(${SEGMENT})$`), fields: ['profile', 'skill'] },
];

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const fail = (message) => { throw new ConfigError(message); };

/** Split a canonical key, or return null. Never throws: callers that want a
 *  refusal say so, and discovery uses this to decide whether a constructed key
 *  is well-formed before it becomes an identity. */
export function parseKey(key) {
  if (typeof key !== 'string') return null;
  for (const { tool, re, fields } of KEY_PATTERNS) {
    const m = key.match(re);
    if (!m) continue;
    const parsed = { tool, key };
    fields.forEach((name, i) => { parsed[name] = m[i + 1]; });
    return parsed;
  }
  return null;
}

function requireObject(value, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${where} must be an object`);
  }
  return value;
}

function requireArray(value, where) {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  return value;
}

function requireText(value, where, { max = Infinity } = {}) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${where} must be a non-empty string`);
  if (value.length > max) fail(`${where} is ${value.length} characters, over the ${max} allowed`);
  return value;
}

function rejectDiscoveryFields(entry, where) {
  for (const field of Object.keys(entry)) {
    if (DISCOVERY_OWNED.has(field)) {
      fail(`${where} carries the discovery-owned field '${field}'; configuration decides what prints, discovery decides what exists`);
    }
  }
}

function rejectUnknownFields(entry, allowed, where) {
  for (const field of Object.keys(entry)) {
    if (!allowed.has(field)) fail(`${where} has the unknown field '${field}'`);
  }
}

function readPages(raw) {
  const pages = requireArray(raw, 'pages');
  const ids = pages.map((page, i) => {
    requireObject(page, `pages[${i}]`);
    rejectUnknownFields(page, new Set(['id', 'title', 'subtitle', 'groups']), `pages[${i}]`);
    const id = requireText(page.id, `pages[${i}].id`);
    if (!PAGE_IDS.includes(id)) fail(`pages[${i}].id '${id}' is not one of ${PAGE_IDS.join(', ')}`);
    return id;
  });
  for (const wanted of PAGE_IDS) {
    if (!ids.includes(wanted)) fail(`pages is missing '${wanted}'`);
  }
  if (new Set(ids).size !== ids.length) fail('pages repeats a page id');

  return pages.map((page) => ({
    id: page.id,
    title: requireText(page.title, `pages.${page.id}.title`),
    subtitle: requireText(page.subtitle, `pages.${page.id}.subtitle`),
    groups: requireArray(page.groups, `pages.${page.id}.groups`).map((group, i) => {
      requireObject(group, `pages.${page.id}.groups[${i}]`);
      rejectUnknownFields(group, new Set(['id', 'title', 'note']), `pages.${page.id}.groups[${i}]`);
      return {
        id: requireText(group.id, `pages.${page.id}.groups[${i}].id`),
        title: requireText(group.title, `pages.${page.id}.groups[${i}].title`),
        note: group.note == null ? null : requireText(group.note, `pages.${page.id}.groups[${i}].note`, { max: 160 }),
      };
    }),
  }));
}

/** One index of every (page, group) pair, so an entry's placement is checked
 *  against the page it names rather than against any page that happens to have
 *  a group of that id. */
function groupIndex(pages) {
  const index = new Map();
  for (const page of pages) {
    const ids = new Set();
    for (const group of page.groups) {
      if (ids.has(group.id)) fail(`pages.${page.id} repeats the group id '${group.id}'`);
      ids.add(group.id);
    }
    index.set(page.id, ids);
  }
  return index;
}

function readEntry(raw, where, groups, { requireMembers = false } = {}) {
  requireObject(raw, where);
  rejectDiscoveryFields(raw, where);
  rejectUnknownFields(raw, ENTRY_FIELDS, where);

  const key = requireText(raw.key, `${where}.key`);
  if (!parseKey(key)) fail(`${where}.key '${key}' does not match the canonical key grammar`);
  const page = requireText(raw.page, `${where}.page`);
  if (!groups.has(page)) fail(`${where}.page '${page}' is not a configured page`);
  const group = requireText(raw.group, `${where}.group`);
  if (!groups.get(page).has(group)) fail(`${where}.group '${group}' is not a group on page ${page}`);

  const entry = {
    key,
    // What the card prints. Defaults to the key's own skill segment, which is
    // right for a real skill and wrong for a family: "gstack context family" is
    // an editorial name with no segment to derive it from.
    label: raw.label == null ? parseKey(key).skill : requireText(raw.label, `${where}.label`, { max: 44 }),
    page,
    group,
    summary: requireText(raw.summary, `${where}.summary`, { max: 160 }),
    members: [],
  };

  if (requireMembers) {
    const members = requireArray(raw.members, `${where}.members`);
    if (members.length === 0) fail(`${where}.members is empty; a family that absorbs nothing is a selection`);
    for (const [i, member] of members.entries()) {
      const text = requireText(member, `${where}.members[${i}]`);
      if (!parseKey(text)) fail(`${where}.members[${i}] '${text}' does not match the canonical key grammar`);
      entry.members.push(text);
    }
  } else if (raw.members !== undefined) {
    fail(`${where} is a plain selection and may not carry 'members'`);
  }

  return entry;
}

function readOmission(raw, where) {
  requireObject(raw, where);
  rejectDiscoveryFields(raw, where);
  rejectUnknownFields(raw, OMISSION_FIELDS, where);
  const key = requireText(raw.key, `${where}.key`);
  if (!parseKey(key)) fail(`${where}.key '${key}' does not match the canonical key grammar`);
  // An empty reason is the exact shape of a silent omission: the entry is in the
  // file, so it looks accounted for, and the inventory prints nothing about why.
  return { key, reason: requireText(raw.reason, `${where}.reason`, { max: 200 }) };
}

/** Editorial prose for pages B, D and E. Structure is checked here; the page
 *  models in phase 2 decide how it lays out. */
function readWorkflow(raw) {
  requireObject(raw, 'workflow');
  rejectUnknownFields(raw, new Set(['loop', 'callouts', 'scenarios', 'overlaps']), 'workflow');
  const loop = requireArray(raw.loop, 'workflow.loop');
  if (loop.length === 0) fail('workflow.loop is empty');
  const scenarios = requireArray(raw.scenarios, 'workflow.scenarios').map((row, i) => {
    requireObject(row, `workflow.scenarios[${i}]`);
    rejectUnknownFields(row, new Set(['when', 'path', 'closer']), `workflow.scenarios[${i}]`);
    return {
      when: requireText(row.when, `workflow.scenarios[${i}].when`, { max: 60 }),
      path: requireText(row.path, `workflow.scenarios[${i}].path`, { max: 160 }),
      // Every scenario ends at something observable. A row that stops at
      // "review" is the failure the spec named: it leaves the reader without a
      // finish line, which is what they came to the page for.
      closer: requireText(row.closer, `workflow.scenarios[${i}].closer`, { max: 40 }),
    };
  });
  const overlaps = requireArray(raw.overlaps, 'workflow.overlaps').map((row, i) => {
    requireObject(row, `workflow.overlaps[${i}]`);
    rejectUnknownFields(row, new Set(['overlap', 'winner', 'exception']), `workflow.overlaps[${i}]`);
    return {
      overlap: requireText(row.overlap, `workflow.overlaps[${i}].overlap`, { max: 60 }),
      winner: requireText(row.winner, `workflow.overlaps[${i}].winner`, { max: 80 }),
      exception: requireText(row.exception, `workflow.overlaps[${i}].exception`, { max: 90 }),
    };
  });
  return {
    loop: loop.map((step, i) => requireText(step, `workflow.loop[${i}]`, { max: 30 })),
    callouts: requireArray(raw.callouts, 'workflow.callouts')
      .map((line, i) => requireText(line, `workflow.callouts[${i}]`, { max: 90 })),
    scenarios,
    overlaps,
  };
}

function readRelease(raw) {
  requireObject(raw, 'release');
  rejectUnknownFields(raw, new Set(['sections', 'stopBand', 'footnote']), 'release');
  const sections = requireArray(raw.sections, 'release.sections');
  if (sections.length !== 4) fail(`release.sections has ${sections.length} entries; page D is four numbered sections`);
  return {
    sections: sections.map((section, i) => {
      requireObject(section, `release.sections[${i}]`);
      rejectUnknownFields(section, new Set(['title', 'lead', 'items', 'commands', 'stop']), `release.sections[${i}]`);
      return {
        title: requireText(section.title, `release.sections[${i}].title`, { max: 40 }),
        lead: requireText(section.lead, `release.sections[${i}].lead`, { max: 120 }),
        items: requireArray(section.items, `release.sections[${i}].items`)
          .map((item, j) => requireText(item, `release.sections[${i}].items[${j}]`, { max: 110 })),
        commands: requireArray(section.commands ?? [], `release.sections[${i}].commands`)
          .map((cmd, j) => requireText(cmd, `release.sections[${i}].commands[${j}]`, { max: 90 })),
        stop: section.stop == null ? null : requireText(section.stop, `release.sections[${i}].stop`, { max: 90 }),
      };
    }),
    stopBand: requireText(raw.stopBand, 'release.stopBand', { max: 200 }),
    footnote: requireText(raw.footnote, 'release.footnote', { max: 120 }),
  };
}

function readDestinations(raw) {
  requireObject(raw, 'destinations');
  rejectUnknownFields(raw, new Set(['decisionPath', 'rows', 'docsRule', 'stopRule', 'footnote']), 'destinations');
  return {
    decisionPath: requireArray(raw.decisionPath, 'destinations.decisionPath').map((step, i) => {
      requireObject(step, `destinations.decisionPath[${i}]`);
      rejectUnknownFields(step, new Set(['question', 'home']), `destinations.decisionPath[${i}]`);
      return {
        question: requireText(step.question, `destinations.decisionPath[${i}].question`, { max: 70 }),
        home: requireText(step.home, `destinations.decisionPath[${i}].home`, { max: 30 }),
      };
    }),
    rows: requireArray(raw.rows, 'destinations.rows').map((row, i) => {
      requireObject(row, `destinations.rows[${i}]`);
      rejectUnknownFields(row, new Set(['information', 'home']), `destinations.rows[${i}]`);
      return {
        information: requireText(row.information, `destinations.rows[${i}].information`, { max: 70 }),
        home: requireText(row.home, `destinations.rows[${i}].home`, { max: 70 }),
      };
    }),
    docsRule: requireText(raw.docsRule, 'destinations.docsRule', { max: 200 }),
    stopRule: requireText(raw.stopRule, 'destinations.stopRule', { max: 200 }),
    footnote: requireText(raw.footnote, 'destinations.footnote', { max: 120 }),
  };
}

function readLayout(raw) {
  requireObject(raw, 'layout');
  rejectUnknownFields(raw, new Set([
    'pageWidthIn', 'pageHeightIn', 'safeMarginIn', 'titlePt', 'headingPt',
    'bodyPt', 'minBodyPt', 'minFooterPt', 'minLineHeight', 'overflowTolerancePx',
    'maxLines', 'previewDpi',
  ]), 'layout');

  const number = (value, where, { min = 0 } = {}) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= min) {
      fail(`layout.${where} must be a finite number greater than ${min}`);
    }
    return value;
  };

  const maxLines = requireObject(raw.maxLines, 'layout.maxLines');
  for (const page of Object.keys(maxLines)) {
    if (!PAGE_IDS.includes(page)) fail(`layout.maxLines has the unknown page '${page}'`);
    number(maxLines[page], `maxLines.${page}`);
  }

  return {
    pageWidthIn: number(raw.pageWidthIn, 'pageWidthIn'),
    pageHeightIn: number(raw.pageHeightIn, 'pageHeightIn'),
    safeMarginIn: number(raw.safeMarginIn, 'safeMarginIn'),
    titlePt: number(raw.titlePt, 'titlePt'),
    headingPt: number(raw.headingPt, 'headingPt'),
    bodyPt: number(raw.bodyPt, 'bodyPt'),
    minBodyPt: number(raw.minBodyPt, 'minBodyPt'),
    minFooterPt: number(raw.minFooterPt, 'minFooterPt'),
    minLineHeight: number(raw.minLineHeight, 'minLineHeight'),
    overflowTolerancePx: number(raw.overflowTolerancePx, 'overflowTolerancePx', { min: -1 }),
    // The PNG preview resolution. Configured rather than fixed because the
    // expected pixel dimensions are derived from it, and a preview whose size is
    // asserted against an assumption proves nothing.
    previewDpi: number(raw.previewDpi, 'previewDpi'),
    maxLines: { ...maxLines },
  };
}

/** Parse and validate editorial policy. Returns a deeply frozen model, because a
 *  later stage that mutates policy in place would make the same config produce
 *  two different inventories depending on call order. */
export function loadConfig(text, { source = 'desk-guides.config.json' } = {}) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    fail(`${source} is not valid JSON: ${err.message}`);
  }
  requireObject(raw, source);

  for (const field of Object.keys(raw)) {
    if (!TOP_LEVEL.has(field)) fail(`${source} has the unknown top-level field '${field}'`);
  }
  for (const field of TOP_LEVEL) {
    if (raw[field] === undefined) fail(`${source} is missing the required field '${field}'`);
  }

  if (raw.schemaVersion !== SCHEMA_VERSION) {
    fail(`${source} declares schemaVersion ${JSON.stringify(raw.schemaVersion)}; this generator understands ${SCHEMA_VERSION}`);
  }

  const pages = readPages(raw.pages);
  const groups = groupIndex(pages);

  // Three editorial lines per profile, because page C's card is a six-field
  // contract and three of those fields are parsed from `profile.md`. A summary
  // alone leaves half the card blank and the other half unexplained: what the
  // profile ADDS to the default path, and the one rule that most often trips
  // someone up, are judgements no parser can derive.
  const profilesRaw = requireObject(raw.profiles, 'profiles');
  const profiles = {};
  for (const name of Object.keys(profilesRaw).sort()) {
    const entry = requireObject(profilesRaw[name], `profiles.${name}`);
    rejectDiscoveryFields(entry, `profiles.${name}`);
    rejectUnknownFields(entry, new Set(['summary', 'adds', 'rule']), `profiles.${name}`);
    profiles[name] = {
      summary: requireText(entry.summary, `profiles.${name}.summary`, { max: 90 }),
      adds: requireText(entry.adds, `profiles.${name}.adds`, { max: 90 }),
      rule: requireText(entry.rule, `profiles.${name}.rule`, { max: 90 }),
    };
  }

  const selected = requireArray(raw.selected, 'selected')
    .map((entry, i) => readEntry(entry, `selected[${i}]`, groups));
  const families = requireArray(raw.families, 'families')
    .map((entry, i) => readEntry(entry, `families[${i}]`, groups, { requireMembers: true }));
  const omitted = requireArray(raw.omitted, 'omitted')
    .map((entry, i) => readOmission(entry, `omitted[${i}]`));

  // One key, one terminal disposition. Checked across all four populations at
  // once -- selections, family names, family members and omissions -- because a
  // key that is both `shown` and `omitted` makes the inventory's accounting a lie
  // whichever way the resolver happens to iterate.
  const seen = new Map();
  const claim = (key, where) => {
    if (seen.has(key)) {
      fail(`'${key}' is claimed twice: ${seen.get(key)} and ${where}. One discovery gets exactly one disposition`);
    }
    seen.set(key, where);
  };
  selected.forEach((entry, i) => claim(entry.key, `selected[${i}]`));
  families.forEach((entry, i) => {
    claim(entry.key, `families[${i}]`);
    entry.members.forEach((member, j) => claim(member, `families[${i}].members[${j}]`));
  });
  omitted.forEach((entry, i) => claim(entry.key, `omitted[${i}]`));

  return deepFreeze({
    source,
    schemaVersion: SCHEMA_VERSION,
    pages,
    profiles,
    selected,
    families,
    omitted,
    workflow: readWorkflow(raw.workflow),
    release: readRelease(raw.release),
    destinations: readDestinations(raw.destinations),
    layout: readLayout(raw.layout),
    /** Every key the config claims, mapped to where it claims it. */
    claimed: Object.fromEntries([...seen].sort(([a], [b]) => (a < b ? -1 : 1))),
  });
}

export function readConfigFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    fail(`${path} could not be read: ${err.code ?? err.message}`);
  }
  return loadConfig(text, { source: path });
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
