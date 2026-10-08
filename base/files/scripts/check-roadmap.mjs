#!/usr/bin/env node
// Checks a repository's ROADMAP.md against repo-standards §6.6.
//
// Zero dependencies, node: built-ins only (CLAUDE.md #4). It ships into
// scaffolded repos as base/files/scripts/check-roadmap.mjs, byte-identical, so it
// must import NOTHING from daftplate — not even scripts/lib/cli.mjs, which does
// not exist in a scaffolded repo. `violation` and `reportViolations` below are
// deliberate copies of that module's, for that reason and no other; the plan's
// instruction to import them could not survive contact with where this file runs.
//
// What it establishes, and what it refuses to, is §6.6.1. The fourth admission is
// the load-bearing one: this proves a rung was NAMED. It cannot prove it was
// earned, and a green run here is evidence of a well-formed roadmap, never of a
// true one. Do not cite a passing check as evidence that work is done.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROADMAP_FILE = 'ROADMAP.md';
export const MANIFEST_FILE = '.daftplate.json';

/** §6.6's evidence ladder, in order. A rung outside this set closes nothing. */
export const RUNGS = [
  'specified', 'unit-tested', 'persisted', 'wired',
  'real-provider-proven', 'journey-accepted', 'beta-ready',
];

export const TABLE_HEADER = '| Item | Closes when | Rung |';

export const REQUIRED_SECTIONS = ['## Now', '## Next'];

// The classification from repo-standards §6.6, embedded rather than read.
//
// A scaffolded repo has a `.daftplate.json` naming its profile but no
// `profiles/` tree to read the profile's `roadmap:` out of — that lives in
// daftplate, which this script cannot reach and CI certainly cannot. So the
// table travels with the checker.
//
// Two sources of truth is the obvious objection, and the answer is the same one
// G5 gives for the two ci.yml files: daftplate carries a test asserting this map
// equals what parseProfileMeta reads from all eight profile.md files, so drift is
// a red suite in the repo that owns both, not a wrong answer in a repo that owns
// neither.
export const ROADMAP_BY_PROFILE = {
  'app-monolith': 'required',
  'content-library': 'optional',
  'design-vault': 'optional',
  'gas-webapp': 'required',
  'local-tool': 'optional',
  'office-automation': 'optional',
  userscript: 'required',
  'web-app': 'required',
};

export const violation = (rule, path, message) => ({ rule, path, message });

export function reportViolations(violations) {
  for (const v of violations) console.error(`${v.rule}: ${v.path} — ${v.message}`);
  console.log(violations.length ? `${violations.length} violation(s)` : 'clean');
  return violations.length ? 1 : 0;
}

/**
 * Whether this repository must keep a ROADMAP.md, and how that was decided.
 *
 * D8: an absent manifest, a manifest that will not parse, a manifest with no
 * `profile`, and a profile this checker does not know all resolve to `optional`.
 * daftplate's own checkout has no manifest and enrolment is one-shot and opt-in,
 * so an unenrolled repository is the common case rather than the broken one. The
 * checker never fails a repo for not being enrolled — but it always says which
 * branch it took, because a silent `optional` is indistinguishable from a check
 * that did not run.
 */
export function resolveRequirement(dir) {
  const manifest = join(dir, MANIFEST_FILE);
  if (!existsSync(manifest)) {
    return { roadmap: 'optional', reason: `no ${MANIFEST_FILE}; this repo is not enrolled` };
  }
  let profile;
  try {
    profile = JSON.parse(readFileSync(manifest, 'utf8')).profile;
  } catch (err) {
    return { roadmap: 'optional', reason: `${MANIFEST_FILE} could not be read (${err.message})` };
  }
  if (typeof profile !== 'string' || !profile) {
    return { roadmap: 'optional', reason: `${MANIFEST_FILE} names no profile` };
  }
  const roadmap = ROADMAP_BY_PROFILE[profile];
  if (!roadmap) {
    return { roadmap: 'optional', reason: `profile "${profile}" is not one this checker knows` };
  }
  return { roadmap, reason: `profile "${profile}" declares roadmap: ${roadmap}` };
}

/** The body rows of the first table following `heading`, as arrays of cells.
 *  Returns null when the heading is absent, and [] when it is present but is not
 *  followed by a table — two different failures that must not collapse. */
export function sectionTable(text, heading) {
  const lines = text.split(/\r?\n/);
  // Prefix match: the template's headings carry a trailing `— <outcome>`, and a
  // repo is expected to replace that text rather than delete it.
  const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} `));
  if (start === -1) return null;

  const rows = [];
  let header = null;
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) break;              // next section; this one had no table
    if (!trimmed.startsWith('|')) {
      if (header) break;                               // the table ended
      continue;                                        // prose before it
    }
    if (!header) { header = trimmed; continue; }
    if (/^\|[\s|:-]+\|$/.test(trimmed)) continue;      // the |---|---| separator
    rows.push(trimmed.slice(1, -1).split('|').map((cell) => cell.trim()));
  }
  return { header, rows };
}

/** §6.5.1's short name: a lowercase slug. */
export const SHORT_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The Linear `Board:` paragraph's short name and team key, or null when the
 * repo's board is not Linear. The paragraph runs from the `Board:` line to the
 * next blank line, because a real one wraps — the team key can open the line
 * after `team`.
 *
 * A copy, not an import: this file ships into scaffolded CI and imports nothing.
 * The launch-pad validator and the dressing helper parse the same line, and a
 * parity test in daftplate holds the three to one answer.
 */
export function linearBoard(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('Board:'));
  if (start === -1) return null;
  const paragraph = [];
  for (const line of lines.slice(start)) {
    if (line.trim() === '') break;
    paragraph.push(line);
  }
  const joined = paragraph.join(' ');
  if (!/\bLinear\b/.test(joined)) return null;
  const link = /\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(joined);
  return {
    shortName: link ? link[1].trim() : null,
    teamKey: /\bteam\s+`([A-Z][A-Z0-9]*)`/.exec(joined)?.[1] ?? null,
  };
}

export function checkRoadmap(dir) {
  const { roadmap, reason } = resolveRequirement(dir);
  const path = join(dir, ROADMAP_FILE);

  if (!existsSync(path)) {
    // Rule 1. Under `optional` this is not a failure — it is the correct first
    // act for a repo with no product surface (§6.6, D6).
    return {
      roadmap,
      reason,
      violations: roadmap === 'required'
        ? [violation('roadmap-missing', ROADMAP_FILE, `${reason}, so this repository must keep a ${ROADMAP_FILE} (repo-standards §6.6)`)]
        : [],
    };
  }

  const text = readFileSync(path, 'utf8');
  const violations = [];

  for (const heading of REQUIRED_SECTIONS) {
    const table = sectionTable(text, heading);

    // Rule 2.
    if (table === null) {
      violations.push(violation('roadmap-section', ROADMAP_FILE, `no \`${heading}\` section`));
      continue;
    }
    // Rule 3.
    if (table.header !== TABLE_HEADER) {
      violations.push(violation(
        'roadmap-table',
        ROADMAP_FILE,
        `\`${heading}\` must be followed by a table headed \`${TABLE_HEADER}\`, got ${table.header ? `\`${table.header}\`` : 'no table'}`,
      ));
      continue;
    }
    for (const cells of table.rows) {
      const [item, closesWhen, rung] = cells;
      // Rule 5. An empty cell is the failure this rule exists for: a row that
      // names no evidence is a row that cannot be closed on evidence.
      if (!closesWhen) {
        violations.push(violation(
          'roadmap-evidence',
          ROADMAP_FILE,
          `row "${item}" under \`${heading}\` names no evidence in its "Closes when" cell`,
        ));
      }
      // Rule 4. Backticks are part of the rule, not decoration: an unbackticked
      // word is prose that happens to match, and the column is a controlled
      // vocabulary or it is nothing.
      const match = (rung ?? '').match(/^`([^`]+)`$/);
      if (!match || !RUNGS.includes(match[1])) {
        violations.push(violation(
          'roadmap-rung',
          ROADMAP_FILE,
          `row "${item}" under \`${heading}\` has rung ${rung ? `\`${rung}\`` : '(empty)'}; expected exactly one backticked rung from: ${RUNGS.join(', ')}`,
        ));
      }
    }
  }

  // Rule 6. The template ships two board blocks and instructs the adopter to
  // delete one, so a fresh copy fails here on purpose until a human chooses.
  const boards = text.split(/\r?\n/).filter((line) => line.startsWith('Board:')).length;
  if (boards !== 1) {
    violations.push(violation(
      'roadmap-board',
      ROADMAP_FILE,
      boards === 0
        ? 'no line beginning `Board:` — keep one of the two blocks the template ships (§6.5 or §6.5.1)'
        : `${boards} lines begin \`Board:\`; keep exactly one and delete the other (§6.6)`,
    ));
  }

  // Rule 8. A Linear board's project link text is the repo's short name, and
  // every issue the repo names is `<short>-<N>` (§6.5.1, ADR 0014), so it has to
  // be a slug a reader can type and a validator can match. A display name such as
  // `Daft Plate` would make the form unwritable. Placeholders are rule 7's, and
  // reported there only under `required`, so they are skipped here rather than
  // given two owners.
  if (boards === 1) {
    const board = linearBoard(text);
    if (board && !/^<[^<>]*>$/.test(board.shortName ?? '')) {
      if (board.shortName === null || !SHORT_NAME.test(board.shortName)) {
        violations.push(violation(
          'roadmap-short-name',
          ROADMAP_FILE,
          board.shortName === null
            ? 'the Linear `Board:` line has no `[name](url)` project link; its link text is the repo\'s short name (§6.5.1)'
            : `the Linear \`Board:\` line's project link text \`${board.shortName}\` is not a lowercase slug; it is the repo's short name, written in every \`<short>-<N>\` (§6.5.1)`,
        ));
      }
      if (board.teamKey === null) {
        violations.push(violation(
          'roadmap-short-name',
          ROADMAP_FILE,
          'the Linear `Board:` line names no backticked team key (team `KEY`); the launch-pad validator reads it to refuse Linear keys in prose',
        ));
      }
    }
  }

  // Rule 7. Only under `required`: an `optional` repo may keep the skeleton or
  // delete the file, and failing it for keeping an unfilled copy would punish the
  // repo that did nothing wrong.
  if (roadmap === 'required') {
    // Lowercase only, deliberately. `PROJECT_NAME` and the other uppercase
    // scaffold tokens are verify-repo's to report — the angle brackets are
    // omitted here because this file is mirrored into the scaffold template and
    // substitution would rewrite them (#191) — and re-reporting them here would
    // give one fault two owners.
    const placeholders = [...new Set(text.match(/<[a-z][^<>\n]*>/g) ?? [])];
    if (placeholders.length) {
      violations.push(violation(
        'roadmap-skeleton',
        ROADMAP_FILE,
        `unfilled placeholder(s) ${placeholders.join(', ')} — ${reason}, so the skeleton must be filled in`,
      ));
    }
    if (text.includes('| #N Title |')) {
      violations.push(violation(
        'roadmap-skeleton',
        ROADMAP_FILE,
        'the shipped example row `| #N Title | … |` is still present; replace it with real work or delete it',
      ));
    }
  }

  return { roadmap, reason, violations };
}

function main(argv) {
  const dir = argv.slice(2).find((a) => !a.startsWith('--')) ?? '.';
  const { roadmap, reason, violations } = checkRoadmap(dir);
  console.log(`roadmap: ${roadmap} — ${reason}`);
  return reportViolations(violations);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
