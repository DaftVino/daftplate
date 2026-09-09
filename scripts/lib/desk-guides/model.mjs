// Policy applied to discovery, producing the accounting document.
//
// The contract this module exists to keep: every discovery leaves here with
// exactly one terminal disposition, and no discovery leaves without one. A skill
// may be printed, absorbed into a printed family, or deliberately left off -- but
// "left off" is a recorded decision with a reason, never a filter applied before
// anyone was counting. That is what makes `inventory.json` evidence rather than a
// summary of whatever survived.
import { ConfigError } from './config.mjs';

export class ModelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelError';
  }
}

const fail = (message) => { throw new ModelError(message); };

/** The reason attached to a discovery no editorial entry mentions. Rule-derived
 *  rather than configured, because the installed Claude root alone runs to
 *  eighty-odd directories and a config that had to name every one of them would
 *  be abandoned within a month -- and an abandoned config omits silently again. */
const UNSELECTED_REASON =
  'not selected for a page; the full set is in this inventory and on disk';

/**
 * Resolve discovery against configuration.
 *
 * Order matters and is not an implementation detail: discovery completes, then
 * duplicates are already refused by the registry, and only then are configured
 * keys resolved. Resolving earlier would let a selection decide which of two
 * colliding discoveries is the real one.
 */
export function resolveInventory({ config, discovery }) {
  const found = new Map(discovery.entries.map((entry) => [entry.key, entry]));
  const disposition = new Map();

  const claim = (key, record) => {
    if (disposition.has(key)) {
      fail(`'${key}' would be recorded as both ${disposition.get(key).disposition} and ${record.disposition}`);
    }
    disposition.set(key, record);
  };

  const mustResolve = (key, where) => {
    if (!found.has(key)) {
      fail(`${where} names '${key}', which discovery did not find. Either the source is gone or the key is misspelled; configuration may not print what does not exist`);
    }
    return found.get(key);
  };

  for (const [i, entry] of config.selected.entries()) {
    mustResolve(entry.key, `selected[${i}]`);
    claim(entry.key, {
      disposition: 'shown',
      page: entry.page,
      group: entry.group,
      summary: entry.summary,
    });
  }

  for (const [i, family] of config.families.entries()) {
    // A family name is an editorial label -- "gstack context family" is not a
    // skill on disk -- so it is exempt from mustResolve. When it does happen to
    // match a real discovery, that discovery is the printed representative.
    if (found.has(family.key)) {
      claim(family.key, {
        disposition: 'shown',
        page: family.page,
        group: family.group,
        summary: family.summary,
        family: family.key,
      });
    }
    for (const [j, member] of family.members.entries()) {
      mustResolve(member, `families[${i}].members[${j}]`);
      claim(member, {
        disposition: 'grouped',
        page: family.page,
        group: family.group,
        family: family.key,
        familyTitle: family.summary,
      });
    }
  }

  for (const [i, omission] of config.omitted.entries()) {
    mustResolve(omission.key, `omitted[${i}]`);
    claim(omission.key, { disposition: 'omitted', reason: omission.reason });
  }

  // Everything discovery found that policy never mentioned. This loop is the one
  // that must not be replaced by a filter: it is where an unconfigured skill gets
  // counted instead of dropped.
  for (const key of found.keys()) {
    if (disposition.has(key)) continue;
    claim(key, { disposition: 'omitted', reason: UNSELECTED_REASON });
  }

  const profiles = resolveProfiles({ config, discovery });

  const entries = [...found.values()]
    .map((entry) => ({ ...entry, ...disposition.get(entry.key) }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));

  const counts = { shown: 0, grouped: 0, omitted: 0 };
  for (const entry of entries) counts[entry.disposition] += 1;
  if (counts.shown + counts.grouped + counts.omitted !== entries.length) {
    fail('an entry left resolution without a disposition');
  }

  return {
    entries,
    profiles,
    sources: discovery.sources,
    counts,
    families: config.families.map((family) => ({
      key: family.key,
      page: family.page,
      group: family.group,
      summary: family.summary,
      members: [...family.members].sort(),
    })),
  };
}

/** Exactly one configured summary per discovered profile, in both directions.
 *
 *  This is the assertion a new profile trips. Adding `profiles/<type>/` with
 *  valid metadata and no config edit fails here by name, which is the whole
 *  mechanism: page C claims to show every profile, and the only way to keep that
 *  claim true is to make the omission loud. */
function resolveProfiles({ config, discovery }) {
  const configured = new Set(Object.keys(config.profiles));
  const discovered = discovery.profiles.map((profile) => profile.name);

  const missing = discovered.filter((name) => !configured.has(name)).sort();
  if (missing.length) {
    fail(`profiles/ has ${missing.length} profile(s) with no summary in ${config.source}: ${missing.join(', ')}. Page C prints every profile, so a new one needs a "choose this for" line before the generator will run`);
  }

  const stale = [...configured].filter((name) => !discovered.includes(name)).sort();
  if (stale.length) {
    fail(`${config.source} summarises ${stale.length} profile(s) that no longer exist: ${stale.join(', ')}`);
  }

  return discovery.profiles
    .map((profile) => ({ ...profile, ...config.profiles[profile.name] }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Serialize deterministically: keys sorted at every depth, two-space indent, one
 *  trailing newline. Frozen inputs must produce byte-identical output, so nothing
 *  here may consult the clock -- build metadata is passed in or absent. */
export function serializeInventory(inventory, buildMeta = null) {
  const payload = buildMeta ? { build: buildMeta, ...inventory } : inventory;
  return `${JSON.stringify(sortDeep(payload), null, 2)}\n`;
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
  return out;
}

/** Both failure classes read the same to an operator, and both mean "fix the
 *  configuration or the source, then run again" -- so the CLI reports them
 *  together rather than making the caller know which module threw. */
export const isPolicyError = (err) => err instanceof ModelError || err instanceof ConfigError;
