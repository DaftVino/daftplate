import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo } from './helpers/make-repo.mjs';
import { parseProfileMeta } from '../scripts/verify-templates.mjs';
import { loadConfig, parseKey, SCHEMA_VERSION } from '../scripts/lib/desk-guides/config.mjs';
import {
  discover, discoverProfiles, parseCodexPluginList, runCodexPluginList, readFrontmatter,
} from '../scripts/lib/desk-guides/discovery.mjs';
import { resolveInventory, serializeInventory } from '../scripts/lib/desk-guides/model.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMMITTED = readFileSync(join(ROOT, 'desk-guides.config.json'), 'utf8');

// ---------------------------------------------------------------------------
// Fixtures. Every root is a temp tree and the process boundary is a stub, so
// nothing here passes or fails on which machine ran it -- the maintainer's own
// installed skills and Codex plugins are never consulted.
// ---------------------------------------------------------------------------

const skill = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

const profileMd = (name) => `# ${name}\n\n\`\`\`profile\nverify: npm run build\ntest: npm test\ndeploy: n/a\ndocs-subdirs: designs, adr\nroadmap: optional\n\`\`\`\n`;

/** The smallest configuration the loader accepts, as a plain object so a test can
 *  mutate exactly one field and leave the rest valid. */
function baseConfig(overrides = {}) {
  const config = {
    schemaVersion: SCHEMA_VERSION,
    pages: [
      { id: 'A1', title: 'Claude', subtitle: 'A1', groups: [{ id: 'start', title: 'Start' }, { id: 'build', title: 'Build' }] },
      { id: 'A2', title: 'Codex', subtitle: 'A2', groups: [{ id: 'docs', title: 'Docs' }] },
      { id: 'B', title: 'Workflow', subtitle: 'B', groups: [{ id: 'loop', title: 'Loop' }] },
      { id: 'C', title: 'Profiles', subtitle: 'C', groups: [{ id: 'cards', title: 'Cards' }] },
      { id: 'D', title: 'Release', subtitle: 'D', groups: [{ id: 'gates', title: 'Gates' }] },
      { id: 'E', title: 'Work', subtitle: 'E', groups: [{ id: 'routes', title: 'Routes' }] },
    ],
    profiles: { alpha: { summary: 'Choose this for alpha things.', adds: 'One extra step.', rule: 'One rule.' } },
    selected: [{ key: 'claude:orient', page: 'A1', group: 'start', summary: 'Use when starting.' }],
    families: [],
    omitted: [],
    workflow: {
      loop: ['Orient', 'plan'],
      callouts: ['No code before a failing test.'],
      scenarios: [{ when: 'Bug', path: '/investigate -> fix ->', closer: '/ship' }],
      overlaps: [{ overlap: 'Debugging', winner: '/investigate', exception: 'No second pass' }],
    },
    release: {
      sections: [1, 2, 3, 4].map((n) => ({
        title: `Section ${n}`, lead: 'Do the thing.', items: ['One'], commands: [], stop: null,
      })),
      stopBand: 'No tag without a GitHub Release',
      footnote: 'Checklist only.',
    },
    destinations: {
      decisionPath: [{ question: 'Tracked and closed?', home: 'Issue' }],
      rows: [{ information: 'Bug', home: 'GitHub Issue' }],
      docsRule: 'docs/ is flat except designs/, adr/, records/.',
      stopRule: 'No second task tracker.',
      footnote: 'One artifact, one home.',
    },
    layout: {
      pageWidthIn: 11, pageHeightIn: 8.5, safeMarginIn: 0.4, titlePt: 27, headingPt: 18,
      bodyPt: 13, minBodyPt: 12, minFooterPt: 9.5, minLineHeight: 1.18,
      overflowTolerancePx: 2, previewDpi: 150, maxLines: { A1: 2 },
    },
  };
  return JSON.stringify({ ...config, ...overrides });
}

/** A repo tree with one profile and one repo-owned skill, plus whatever else the
 *  caller adds. Roots are returned so each test names the ones it cares about. */
function fixtureRepo(extra = {}) {
  const dir = makeRepo({
    'profiles/alpha/profile.md': profileMd('alpha'),
    'skills/orient/SKILL.md': skill('orient', 'Session-start brief.'),
    ...extra,
  });
  return {
    repoRoot: dir,
    profilesRoot: join(dir, 'profiles'),
    skillsRoot: join(dir, 'skills'),
  };
}

const CODEX_LIST = `Marketplace \`openai-primary-runtime\`
C:\\cache\\marketplace.json

PLUGIN                      STATUS               VERSION   PATH
documents@primary           installed, enabled   1.0.0     PLUGIN_ROOT
retired@primary             installed, disabled  1.0.0     PLUGIN_ROOT
shelf@primary               not installed                  PLUGIN_ROOT
`;

/** A stubbed process boundary returning fixture stdout. */
const codexRun = (stdout, { status = 0, error = null } = {}) => () => ({ stdout, status, error, stderr: '' });

function discoverWith(roots, { stdout = null, includeCodex = false, run } = {}) {
  return discover({
    repoRoot: roots.repoRoot,
    installedClaudeRoot: roots.installedClaudeRoot ?? null,
    codexPersonalRoot: roots.codexPersonalRoot ?? null,
    codexRepoRoot: roots.codexRepoRoot ?? null,
    parseProfileMeta,
    includeCodex,
    run: run ?? (stdout === null ? undefined : codexRun(stdout)),
  });
}

// ---------------------------------------------------------------------------
// Task 1.1 -- the editorial configuration is validated before discovery runs
// ---------------------------------------------------------------------------

test('the committed configuration loads and returns a normalized, immutable model', () => {
  // Mutation killed: `loadConfig` returns `JSON.parse(text)` unchanged. The raw
  // object is neither frozen nor indexed, so both assertions below distinguish it
  // from the validated model rather than merely proving a value came back.
  const config = loadConfig(COMMITTED, { source: 'desk-guides.config.json' });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.selected[0]), true);
  assert.equal(config.pages.map((page) => page.id).join(','), 'A1,A2,B,C,D,E');
  // `claimed` exists only after validation; raw JSON has no such field.
  assert.equal(typeof config.claimed['claude:orient'], 'string');
});

test('an unsupported schema version is refused by number, not by truthiness', () => {
  // Mutation killed: the comparison becomes `if (!raw.schemaVersion)`. Version 2
  // is truthy, so the mutant accepts a file this generator cannot read.
  assert.throws(
    () => loadConfig(baseConfig({ schemaVersion: SCHEMA_VERSION + 1 })),
    /declares schemaVersion 2; this generator understands 1/,
  );
});

test('the same canonical key selected into two groups is refused and both sites are named', () => {
  // Mutation killed: selections accumulate into a Set, so the duplicate is
  // absorbed silently and one of the two placements simply never prints.
  const text = baseConfig({
    selected: [
      { key: 'claude:orient', page: 'A1', group: 'start', summary: 'Use when starting.' },
      { key: 'claude:orient', page: 'A1', group: 'build', summary: 'Use when building.' },
    ],
  });
  assert.throws(() => loadConfig(text), (err) => {
    assert.match(err.message, /'claude:orient' is claimed twice/);
    assert.match(err.message, /selected\[0\].*selected\[1\]/);
    return true;
  });
});

test('an omission with an empty reason is refused', () => {
  // Mutation killed: the truthiness check on `reason` is dropped. A blank reason
  // then reads as accounted-for while the inventory explains nothing -- the exact
  // shape of the silent omission this whole feature exists to prevent.
  assert.throws(
    () => loadConfig(baseConfig({ omitted: [{ key: 'claude:brief', reason: '   ' }] })),
    /omitted\[0\]\.reason must be a non-empty string/,
  );
});

test('an unknown top-level field and an unknown page identifier are both refused', () => {
  // Mutation killed: the unknown-field loops are removed. A misspelled policy key
  // is then ignored, and the author believes they configured something they did not.
  assert.throws(() => loadConfig(baseConfig({ selections: [] })), /unknown top-level field 'selections'/);
  assert.throws(
    () => loadConfig(baseConfig({ selected: [{ key: 'claude:orient', page: 'A3', group: 'start', summary: 'x' }] })),
    /selected\[0\]\.page 'A3' is not a configured page/,
  );
});

test('an editorial entry carrying a discovery-owned field is refused by name', () => {
  // Mutation killed: `rejectDiscoveryFields` is deleted. `sourcePath` is named
  // explicitly rather than asserted as "some extra field": the defect is not that
  // the field is unrecognised, it is that configuration has begun copying a fact
  // discovery owns, which is how the two drift apart again.
  const text = baseConfig({
    selected: [{
      key: 'claude:orient', page: 'A1', group: 'start', summary: 'Use when starting.',
      sourcePath: 'skills/orient/SKILL.md',
    }],
  });
  assert.throws(() => loadConfig(text), /carries the discovery-owned field 'sourcePath'/);
});

// ---------------------------------------------------------------------------
// Task 1.2 -- discovery, canonical keys, and the Codex row grammar
// ---------------------------------------------------------------------------

test('profile discovery enumerates a newly added directory and returns its parsed commands', () => {
  // Mutation killed: the profile list is hard-coded, or `parseProfileMeta` is
  // bypassed for an inline regex. A ninth directory added at runtime is invisible
  // to the first mutant, and `verify`/`test`/`deploy` come back undefined for the
  // second.
  const { profilesRoot } = fixtureRepo({ 'profiles/zulu/profile.md': profileMd('zulu') });
  const profiles = discoverProfiles({ profilesRoot, parseProfileMeta });
  assert.deepEqual(profiles.map((p) => p.name), ['alpha', 'zulu']);
  assert.equal(profiles[1].verify, 'npm run build');
  assert.equal(profiles[1].test, 'npm test');
  assert.equal(profiles[1].deploy, 'n/a');
});

test('malformed profile metadata fails through the existing parser rather than a second one', () => {
  // Mutation killed: a permissive fallback parser is introduced, so a profile with
  // no `profile` block yields partial metadata instead of a refusal -- two
  // definitions of valid profile metadata, which is how they drift.
  const { profilesRoot } = fixtureRepo({ 'profiles/broken/profile.md': '# broken\n\nno metadata block\n' });
  assert.throws(
    () => discoverProfiles({ profilesRoot, parseProfileMeta }),
    /profiles\/broken\/profile\.md has no parseable ```profile metadata block/,
  );
});

test('a repo-owned Claude skill becomes claude:<skill>, keyed by name and not by path', () => {
  // Mutation killed: the source path becomes the identity. The key then carries a
  // temp directory, so it can never match a configured selection.
  const roots = fixtureRepo();
  const { entries } = discoverWith(roots);
  const orient = entries.find((entry) => entry.key === 'claude:orient');
  assert.ok(orient, 'claude:orient was not discovered');
  assert.equal(orient.origin, 'repo');
  assert.deepEqual(parseKey(orient.key), { tool: 'claude', key: 'claude:orient', skill: 'orient' });
});

test('a profile-scoped skill keeps its profile namespace, so equal names cannot collide', () => {
  // Mutation killed: the profile segment is dropped and the key becomes
  // `claude:<skill>`. Two profiles each shipping `feature-flow` then produce one
  // key from two paths, and one of the two silently disappears.
  const roots = fixtureRepo({
    'profiles/alpha/files/dot-claude/skills/feature-flow/SKILL.md': skill('feature-flow', 'Trace a feature.'),
    'profiles/beta/profile.md': profileMd('beta'),
    'profiles/beta/files/dot-claude/skills/feature-flow/SKILL.md': skill('feature-flow', 'Trace a feature.'),
  });
  const keys = discoverWith(roots).entries.map((entry) => entry.key);
  assert.ok(keys.includes('profile:alpha:feature-flow'));
  assert.ok(keys.includes('profile:beta:feature-flow'));
});

test('an installed and enabled Codex skill becomes codex:<plugin>:<skill>', () => {
  // Mutation killed: the plugin or the skill namespace is omitted. Either shortens
  // the key to something no configured selection resolves against.
  const plugin = makeRepo({ 'skills/documents/SKILL.md': skill('documents', 'Edit Word files.') });
  const roots = fixtureRepo();
  const { entries } = discoverWith(roots, {
    includeCodex: true,
    stdout: CODEX_LIST.replaceAll('PLUGIN_ROOT', plugin),
  });
  assert.ok(entries.some((entry) => entry.key === 'codex:documents@primary:documents'));
});

test('an installed but disabled Codex row is ineligible for the card', () => {
  // Mutation killed: the eligibility test becomes `if (row.installed)`. The
  // disabled plugin then prints on a page whose entire claim is that it lists what
  // is live.
  const rows = parseCodexPluginList(CODEX_LIST);
  const retired = rows.find((row) => row.plugin === 'retired@primary');
  assert.equal(retired.installed, true);
  assert.equal(retired.enabled, false);
});

test('an enabled but not installed marketplace row is ineligible for the card', () => {
  // Mutation killed: the eligibility test becomes `if (row.enabled)`. A row that is
  // enabled in configuration but was never installed then prints as active.
  const rows = parseCodexPluginList(`${CODEX_LIST}available@primary           enabled                        PLUGIN_ROOT\n`);
  const available = rows.find((row) => row.plugin === 'available@primary');
  assert.equal(available.enabled, true);
  assert.equal(available.installed, false);
});

test('an unparseable `codex plugin list` line is fatal rather than skipped', () => {
  // Mutation killed: unknown lines are `continue`d. The parser then returns a
  // shorter list that looks complete, which is worse than no card at all.
  assert.throws(
    () => parseCodexPluginList(`${CODEX_LIST}odd@primary                 half-installed       1.0.0     PLUGIN_ROOT\n`),
    /unrecognised status 'half-installed'/,
  );
  assert.throws(
    () => parseCodexPluginList('PLUGIN  STATUS  VERSION  PATH\nnonsense without an at sign\n'),
    /not a plugin row and not a recognised header/,
  );
});

test('an unavailable `codex` command fails page A2 with install and verify guidance', () => {
  // Mutation killed: the ENOENT branch falls back to scanning a plugin cache, or
  // returns '' so A2 renders empty. Both claim "nothing is installed" on evidence
  // that says only "the question was never asked".
  const missing = () => ({ error: Object.assign(new Error('nope'), { code: 'ENOENT' }) });
  assert.throws(() => runCodexPluginList(missing), (err) => {
    assert.match(err.message, /`codex` is not on PATH/);
    assert.match(err.message, /codex plugin install <name>/);
    assert.match(err.message, /codex plugin list/);
    return true;
  });
});

test('a duplicate canonical key from two source paths is fatal and names both paths', () => {
  // Mutation killed: the registry does `byKey.set(key, record)` with no existence
  // check. The later write wins, one real skill vanishes, and the inventory still
  // claims to account for everything.
  const a = makeRepo({ 'skills/documents/SKILL.md': skill('documents', 'One.') });
  const b = makeRepo({ 'skills/documents/SKILL.md': skill('documents', 'Two.') });
  const twice = CODEX_LIST
    .replace('documents@primary           installed, enabled   1.0.0     PLUGIN_ROOT',
      `documents@primary           installed, enabled   1.0.0     ${a}\ndocuments@primary           installed, enabled   1.0.0     ${b}`)
    .replaceAll('PLUGIN_ROOT', a);
  assert.throws(
    () => discoverWith(fixtureRepo(), { includeCodex: true, stdout: twice }),
    (err) => {
      assert.match(err.message, /duplicate canonical key 'codex:documents@primary:documents'/);
      assert.ok(err.message.includes(a), 'the first source path is not named');
      assert.ok(err.message.includes(b), 'the second source path is not named');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Task 1.3 -- policy resolution and the accountable inventory
// ---------------------------------------------------------------------------

/** Discovery plus config over the same fixture, resolved. */
function resolveFixture({ configText = baseConfig(), extra = {}, roots: given = null } = {}) {
  const roots = given ?? fixtureRepo(extra);
  const discovery = discoverWith(roots);
  return { discovery, inventory: resolveInventory({ config: loadConfig(configText), discovery }) };
}

test('a selected discovery is recorded as shown, with the page and group it prints on', () => {
  // Mutation killed: `shown` entries are dropped once the page model has taken
  // them, so the inventory records a page's contents as omitted.
  const { inventory } = resolveFixture();
  const orient = inventory.entries.find((entry) => entry.key === 'claude:orient');
  assert.equal(orient.disposition, 'shown');
  assert.equal(orient.page, 'A1');
  assert.equal(orient.group, 'start');
});

test('every family member is recorded as grouped and keeps its representative', () => {
  // Mutation killed: grouping stores only the printed family name and discards the
  // member list. The members then vanish from the accounting entirely.
  const configText = baseConfig({
    selected: [],
    families: [{
      key: 'claude:context-family', page: 'A1', group: 'start',
      summary: 'context family', members: ['claude:orient', 'claude:brief'],
    }],
  });
  const { inventory } = resolveFixture({
    configText,
    extra: { 'skills/brief/SKILL.md': skill('brief', 'Terse answers.') },
  });
  for (const key of ['claude:orient', 'claude:brief']) {
    const entry = inventory.entries.find((e) => e.key === key);
    assert.equal(entry.disposition, 'grouped');
    assert.equal(entry.family, 'claude:context-family');
  }
  assert.deepEqual(inventory.families[0].members, ['claude:brief', 'claude:orient']);
});

test('a discovery no policy mentions is recorded as omitted with a non-empty reason', () => {
  // Mutation killed: the resolver filters unselected entries out before building
  // the inventory. `brief` then does not appear at all, which is indistinguishable
  // from never having been installed.
  const { inventory } = resolveFixture({ extra: { 'skills/brief/SKILL.md': skill('brief', 'Terse answers.') } });
  const brief = inventory.entries.find((entry) => entry.key === 'claude:brief');
  assert.equal(brief.disposition, 'omitted');
  assert.equal(typeof brief.reason, 'string');
  assert.notEqual(brief.reason.trim(), '');
});

test('a configured key discovery cannot resolve is a hard error naming that key', () => {
  // Mutation killed: an unresolved selection is downgraded to an omission. The
  // page then quietly loses a row the editor believed they had placed.
  const configText = baseConfig({
    selected: [{ key: 'claude:vanished', page: 'A1', group: 'start', summary: 'Gone.' }],
  });
  assert.throws(
    () => resolveFixture({ configText }),
    /selected\[0\] names 'claude:vanished', which discovery did not find/,
  );
});

test('one discovery cannot receive two dispositions', () => {
  // Mutation killed: the last classification silently wins. `orient` is then both
  // printed and recorded as omitted, and the counts no longer add up to what was
  // discovered.
  //
  // The config loader refuses this first, so the resolver is exercised directly
  // with a config object that bypasses it -- a guard that only ever runs behind
  // another guard is a guard nobody has tested.
  const config = {
    source: 'test',
    profiles: { alpha: { summary: 'Choose this for alpha things.', adds: 'One extra step.', rule: 'One rule.' } },
    selected: [{ key: 'claude:orient', page: 'A1', group: 'start', summary: 'Use when starting.', members: [] }],
    families: [],
    omitted: [{ key: 'claude:orient', reason: 'Also omitted, somehow.' }],
  };
  const discovery = discoverWith(fixtureRepo());
  assert.throws(
    () => resolveInventory({ config, discovery }),
    /'claude:orient' would be recorded as both shown and omitted/,
  );
});

test('frozen discoveries and configuration produce byte-identical inventory JSON', () => {
  // Mutation killed: an unsorted Map iteration or a `new Date()` stamp enters the
  // output. Byte equality is the assertion because a deepEqual would accept both.
  const roots = fixtureRepo({ 'skills/brief/SKILL.md': skill('brief', 'Terse answers.') });
  const first = serializeInventory(resolveFixture({ roots }).inventory);
  const second = serializeInventory(resolveFixture({ roots }).inventory);
  assert.equal(first, second);
  assert.equal(first.endsWith('}\n'), true);
});

test('adding a profile with no configured summary fails, naming that profile', () => {
  // Mutation killed: profile coverage compares against a hard-coded count, or
  // ignores additions entirely. A NINTH fixture profile is added rather than an
  // existing one changed -- changing one leaves a count-based mutant passing.
  const roots = fixtureRepo({ 'profiles/ninth/profile.md': profileMd('ninth') });
  assert.throws(
    () => resolveFixture({ roots }),
    (err) => {
      assert.match(err.message, /profiles\/ has 1 profile\(s\) with no summary/);
      assert.match(err.message, /ninth/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Additive, not regressions: these pin the frontmatter reader's contract so the
// discovery tests above are reading what they think they are reading.
// ---------------------------------------------------------------------------

test('the frontmatter reader takes only name and description, and refuses a repeated key', () => {
  assert.deepEqual(
    readFrontmatter('---\nname: orient\ndescription: Brief.\nallowed-tools:\n  - Bash\n---\nbody\n'),
    { name: 'orient', description: 'Brief.' },
  );
  assert.equal(readFrontmatter('# no frontmatter\n'), null);
  assert.equal(readFrontmatter('---\ndescription: nameless\n---\n'), null);
  assert.throws(() => readFrontmatter('---\nname: a\nname: b\n---\n'), /declares 'name' twice/);
});
