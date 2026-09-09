import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo } from './helpers/make-repo.mjs';
import { dependabotEntry } from './helpers/dependabot.mjs';
import { walkFiles } from '../scripts/lib/fs.mjs';
import {
  REQUIRED_BASE_FILES, REQUIRED_PROFILE_FILES, ROADMAP_VALUES,
  parseProfileMeta, metaValueIssues, checkBase, checkProfiles, checkWorkflows,
  workflowFiles, verifyTemplates,
} from '../scripts/verify-templates.mjs';
import { PRODUCER_CHECKOUT_MARKERS } from '../scripts/setup-repo.mjs';

const PROFILE_MD = [
  '# Profile: x',
  '',
  '## Metadata',
  '',
  '```profile',
  'verify: npm run build',
  'test: npm test',
  'deploy: /land-and-deploy',
  'docs-subdirs: designs, adr',
  'roadmap: optional',
  '```',
  '',
].join('\n');

/** A complete base layer, keyed relative to the templates root. */
const base = () => Object.fromEntries(
  REQUIRED_BASE_FILES.map((rel) => [
    `base/${rel}`,
    rel.endsWith('CLAUDE.md')
      ? '# CLAUDE.md\n<!-- profile:constraints -->\n<!-- profile:routing -->\n<!-- profile:context -->\n'
      : '# content\n',
  ]),
);

/** A complete profile, keyed relative to the templates root. */
const profile = (name) => ({
  [`profiles/${name}/profile.md`]: PROFILE_MD,
  [`profiles/${name}/claude-md-fragment.md`]: '## Repo-specific constraints\n\n1. Thing.\n',
  [`profiles/${name}/skill-routing.md`]: '## Pipeline\n\nx\n\n## Off\n\ny\n',
  [`profiles/${name}/context-rules.md`]: '## Context budget\n\nx\n\n## Subagent defaults\n\ny\n',
});

test('parseProfileMeta reads every required key and splits docs-subdirs', () => {
  assert.deepEqual(parseProfileMeta(PROFILE_MD), {
    verify: 'npm run build',
    test: 'npm test',
    deploy: '/land-and-deploy',
    docsSubdirs: ['designs', 'adr'],
    roadmap: 'optional',
  });
});

test('parseProfileMeta returns null when the block is missing', () => {
  assert.equal(parseProfileMeta('# Profile: x\n\nno block here\n'), null);
});

test('checkBase passes on a complete base layer', () => {
  assert.deepEqual(checkBase(makeRepo(base())), []);
});

test('checkBase reports a missing base file', () => {
  const files = base();
  delete files['base/files/docs/architecture.md'];
  const violations = checkBase(makeRepo(files));
  assert.deepEqual(violations.map((v) => v.path), ['base/files/docs/architecture.md']);
  assert.equal(violations[0].rule, 'base-files');
});

test('checkBase reports an empty base file', () => {
  const violations = checkBase(makeRepo({ ...base(), 'base/files/LICENSE': '   \n' }));
  assert.deepEqual(violations.map((v) => v.rule), ['base-empty']);
});

test('checkBase requires every profile marker in the base CLAUDE.md', () => {
  const files = { ...base(), 'base/files/CLAUDE.md': '# CLAUDE.md\n<!-- profile:constraints -->\n' };
  assert.deepEqual(checkBase(makeRepo(files)).map((v) => v.message).sort(), [
    'base CLAUDE.md is missing marker <!-- profile:context -->',
    'base CLAUDE.md is missing marker <!-- profile:routing -->',
  ]);
});

test('checkProfiles passes on complete profiles', () => {
  assert.deepEqual(checkProfiles(makeRepo({ ...profile('gas-webapp'), ...profile('web-app') })), []);
});

test('checkProfiles reports missing files per profile', () => {
  const files = profile('gas-webapp');
  delete files['profiles/gas-webapp/context-rules.md'];
  assert.deepEqual(checkProfiles(makeRepo(files)).map((v) => v.path), ['profiles/gas-webapp/context-rules.md']);
});

test('checkProfiles requires the declared headings', () => {
  const files = { ...profile('web-app'), 'profiles/web-app/skill-routing.md': '## Pipeline\n\nx\n' };
  assert.deepEqual(checkProfiles(makeRepo(files)).map((v) => v.message), [
    'profiles/web-app/skill-routing.md is missing heading "## Off"',
  ]);
});

test('checkProfiles requires a parseable metadata block', () => {
  const files = { ...profile('web-app'), 'profiles/web-app/profile.md': '# Profile: web-app\n\nprose only\n' };
  assert.deepEqual(checkProfiles(makeRepo(files)).map((v) => v.rule), ['profile-metadata']);
});

// --- the `roadmap:` meta key (plan D1/D7) ---------------------------------
//
// The key exists to make "app-profile repo" a fact each profile states about
// itself rather than a term repo-standards §6.6 leaves undefined. These tests
// pin both halves: that a profile omitting it is rejected, and that a value
// outside the two-item set is rejected rather than quietly defaulted.

test('parseProfileMeta rejects a block that omits roadmap', () => {
  assert.equal(parseProfileMeta(PROFILE_MD.replace('roadmap: optional\n', '')), null);
});

test('checkProfiles rejects a profile whose meta block omits roadmap', () => {
  const files = { ...profile('web-app') };
  files['profiles/web-app/profile.md'] = PROFILE_MD.replace('roadmap: optional\n', '');
  const violations = checkProfiles(makeRepo(files));

  assert.deepEqual(violations.map((v) => v.rule), ['profile-metadata']);
  assert.match(violations[0].message, /roadmap/);
});

test('checkProfiles rejects a roadmap value outside the two classifications', () => {
  const files = { ...profile('web-app') };
  files['profiles/web-app/profile.md'] = PROFILE_MD.replace('roadmap: optional', 'roadmap: yes');
  const violations = checkProfiles(makeRepo(files));

  assert.deepEqual(violations.map((v) => v.rule), ['profile-metadata-roadmap-value']);
  // The message names the allowed values, because "invalid" alone leaves the
  // author guessing at a set they cannot see from the profile.md they are editing.
  for (const value of ROADMAP_VALUES) assert.match(violations[0].message, new RegExp(value));
});

for (const value of ['required', 'optional']) {
  test(`checkProfiles accepts roadmap: ${value}`, () => {
    const files = { ...profile('web-app') };
    files['profiles/web-app/profile.md'] = PROFILE_MD.replace('roadmap: optional', `roadmap: ${value}`);
    assert.deepEqual(checkProfiles(makeRepo(files)), []);
  });
}

// The rule has to reach the CLI's own entry point, not only checkProfiles: a
// fixture tree that is complete except for the key is the shape the exit
// criterion names, and `node scripts/verify-templates.mjs` composes the checks.
test('verifyTemplates rejects an otherwise-complete tree whose profile omits roadmap', () => {
  const files = { ...base(), ...profile('web-app') };
  files['profiles/web-app/profile.md'] = PROFILE_MD.replace('roadmap: optional\n', '');
  const violations = verifyTemplates(makeRepo(files));

  assert.deepEqual(violations.map((v) => v.rule), ['profile-metadata']);
  assert.match(violations[0].message, /roadmap/);
});

// D1's classification table, pinned. The checker proves every profile declares
// SOMETHING valid; only this proves it declares the right thing. The test applied
// is "does anyone outside this repo depend on it shipping" — which is why
// `userscript` is required despite having no deploy step, and why `deploy:` was
// rejected as a proxy for the classification.
test('the eight shipped profiles carry the classifications D1 decided', () => {
  const declared = Object.fromEntries(
    readdirSync(join(REPO_ROOT, 'profiles'))
      .map((name) => [
        name,
        parseProfileMeta(readFileSync(join(REPO_ROOT, 'profiles', name, 'profile.md'), 'utf8')).roadmap,
      ]),
  );

  assert.deepEqual(declared, {
    'app-monolith': 'required',
    'content-library': 'optional',
    'design-vault': 'optional',
    'gas-webapp': 'required',
    'local-tool': 'optional',
    'office-automation': 'optional',
    userscript: 'required',
    'web-app': 'required',
  });
});

test('checkProfiles rejects a non-kebab profile name', () => {
  assert.ok(checkProfiles(makeRepo(profile('GasWebapp'))).some((v) => v.rule === 'profile-naming'));
});

test('checkProfiles rejects a files-override entry that replaces nothing in base', () => {
  const files = {
    ...base(),
    ...profile('web-app'),
    'profiles/web-app/files-override/docs/nothing-in-base.md': '# x\n',
  };
  assert.deepEqual(checkProfiles(makeRepo(files)).map((v) => v.rule), ['override-unnecessary']);
});

test('verifyTemplates reports a missing base layer', () => {
  assert.ok(verifyTemplates(makeRepo(profile('web-app'))).some((v) => v.rule === 'base-files'));
});

test('REQUIRED_PROFILE_FILES is the documented four-file contract', () => {
  assert.deepEqual(REQUIRED_PROFILE_FILES, [
    'profile.md', 'claude-md-fragment.md', 'skill-routing.md', 'context-rules.md',
  ]);
});

test('REQUIRED_BASE_FILES includes the orient hook probe', () => {
  assert.equal(REQUIRED_BASE_FILES.includes('files/dot-claude/orient-hook.mjs'), true);
});

test('the base settings.json registers a SessionStart hook that runs the probe', () => {
  const settings = JSON.parse(
    readFileSync(new URL('../base/files/dot-claude/settings.json', import.meta.url), 'utf8'),
  );
  const commands = settings.hooks.SessionStart
    .flatMap((matcher) => matcher.hooks)
    .map((hook) => hook.command);

  assert.equal(commands.some((c) => c.includes('orient-hook.mjs')), true);
});

test('the hook command is absolute, not relative to an assumed working directory', () => {
  const settings = JSON.parse(
    readFileSync(new URL('../base/files/dot-claude/settings.json', import.meta.url), 'utf8'),
  );
  const command = settings.hooks.SessionStart
    .flatMap((matcher) => matcher.hooks)
    .map((hook) => hook.command)
    .find((c) => c.includes('orient-hook.mjs'));

  assert.match(command, /\$CLAUDE_PROJECT_DIR/);
  assert.equal(/(^|\s)node\s+["']?\.\//.test(command), false, 'hook path must not be relative');
});

test('REQUIRED_BASE_FILES includes the question gate', () => {
  assert.equal(REQUIRED_BASE_FILES.includes('files/dot-claude/question-gate.mjs'), true);
});

test('the base settings.json registers the question gate as a PreToolUse hook', () => {
  const settings = JSON.parse(
    readFileSync(new URL('../base/files/dot-claude/settings.json', import.meta.url), 'utf8'),
  );
  const commands = settings.hooks.PreToolUse
    .flatMap((matcher) => matcher.hooks)
    .map((hook) => hook.command);

  assert.equal(commands.some((c) => c.includes('question-gate.mjs')), true);
  assert.equal(commands.every((c) => c.includes('$CLAUDE_PROJECT_DIR')), true);
});

test('metaValueIssues rejects a metadata value containing an unresolved token', () => {
  const meta = { verify: 'node --check <PROJECT_NAME>.js', test: 'npm test', deploy: 'n/a', docsSubdirs: ['designs'], roadmap: 'required' };
  const issues = metaValueIssues(meta, 'profiles/x/profile.md');

  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'profile-metadata-token');
  assert.match(issues[0].message, /<PROJECT_NAME>/);
  assert.match(issues[0].message, /is not substituted a second time/);
});

test('metaValueIssues rejects the node --test <dir> form, which runs nothing', () => {
  const meta = { verify: 'npm run build', test: 'node --test tests/', deploy: 'n/a', docsSubdirs: ['designs'], roadmap: 'required' };
  const issues = metaValueIssues(meta, 'profiles/x/profile.md');

  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'profile-metadata-test-form');
  assert.match(issues[0].message, /npm test/);
});

test('metaValueIssues passes a clean block', () => {
  const meta = { verify: 'npm run build', test: 'npm test', deploy: '/land-and-deploy', docsSubdirs: ['designs'], roadmap: 'required' };

  assert.deepEqual(metaValueIssues(meta, 'profiles/x/profile.md'), []);
});

// A4 (D9): the loop runs over verify, test and deploy but only verify is fed a
// bad value in the planned tests, so a typo in the key list would ship silently.
test('metaValueIssues catches an unresolved token in the test key', () => {
  const meta = { verify: 'npm test', test: 'npm run <PROJECT_NAME>', deploy: 'n/a', docsSubdirs: ['designs'], roadmap: 'required' };
  const issues = metaValueIssues(meta, 'profiles/x/profile.md');

  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'profile-metadata-token');
  assert.match(issues[0].message, /^test contains/);
});

test('metaValueIssues catches an unresolved token in the deploy key', () => {
  const meta = { verify: 'npm test', test: 'npm test', deploy: 'ship <PROJECT_NAME>', docsSubdirs: ['designs'], roadmap: 'required' };
  const issues = metaValueIssues(meta, 'profiles/x/profile.md');

  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'profile-metadata-token');
  assert.match(issues[0].message, /^deploy contains/);
});

// A2 (D12): metadata must not name a script the profile does not ship.
test('metaValueIssues flags a metadata value naming a script the profile does not ship', () => {
  const root = makeRepo({ 'profiles/x/profile.md': PROFILE_MD });
  const meta = { verify: 'node scripts/local-verify.mjs', test: 'npm test', deploy: 'n/a', docsSubdirs: ['designs'], roadmap: 'required' };
  const issues = metaValueIssues(meta, 'profiles/x/profile.md', join(root, 'profiles', 'x'));

  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'profile-metadata-missing-script');
  assert.match(issues[0].message, /scripts\/local-verify\.mjs/);
});

test('metaValueIssues accepts a script the profile actually ships', () => {
  const root = makeRepo({
    'profiles/x/profile.md': PROFILE_MD,
    'profiles/x/files/scripts/local-verify.mjs': '// stub\n',
  });
  const meta = { verify: 'node scripts/local-verify.mjs', test: 'npm test', deploy: 'n/a', docsSubdirs: ['designs'], roadmap: 'required' };

  assert.deepEqual(metaValueIssues(meta, 'profiles/x/profile.md', join(root, 'profiles', 'x')), []);
});

// A3 (D8): prove the rule reaches profiles through the real checkProfiles path,
// not only when metaValueIssues is called directly — dropping the wiring line
// must turn a test red.
test('checkProfiles surfaces a bad test: value through the real call path', () => {
  const files = profile('x');
  files['profiles/x/profile.md'] = PROFILE_MD.replace('test: npm test', 'test: node --test tests/');
  const root = makeRepo({ ...base(), ...files });

  const rules = checkProfiles(root).map((v) => v.rule);

  assert.ok(rules.includes('profile-metadata-test-form'), `got: ${rules.join(', ')}`);
});

// ---------------------------------------------------------------------------
// checkWorkflows (H1a / spec 04 D4) — supply-chain lint over workflow YAML.
// ---------------------------------------------------------------------------

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const BASE_CI = 'base/files/dot-github/workflows/ci.yml';

/** One workflow file, pinned-clean unless a test varies a part of it. */
const workflow = ({ uses = `actions/checkout@${SHA}   # v4.4.0`, env = [], run = [] } = {}) => [
  'name: ci',
  '',
  'jobs:',
  '  job:',
  '    runs-on: ubuntu-latest',
  ...(env.length ? ['    env:', ...env.map((line) => `      ${line}`)] : []),
  '    steps:',
  `      - uses: ${uses}`,
  ...(run.length ? ['      - name: Step', '        run: |', ...run.map((line) => `          ${line}`)] : []),
  '',
].join('\n');

const rulesFor = (files) => checkWorkflows(makeRepo(files)).map((v) => v.rule);

test('checkWorkflows passes on a workflow pinned to a 40-hex SHA with a version comment', () => {
  assert.deepEqual(checkWorkflows(makeRepo({ [BASE_CI]: workflow() })), []);
});

test('checkWorkflows rejects a floating major tag and names the file', () => {
  const violations = checkWorkflows(makeRepo({ [BASE_CI]: workflow({ uses: 'actions/checkout@v4' }) }));

  assert.deepEqual(violations.map((v) => v.rule), ['workflow-unpinned-action']);
  assert.equal(violations[0].path, BASE_CI);
  assert.match(violations[0].message, /actions\/checkout@v4/);
});

test('checkWorkflows rejects a branch reference', () => {
  assert.deepEqual(rulesFor({ [BASE_CI]: workflow({ uses: 'actions/checkout@main' }) }), ['workflow-unpinned-action']);
});

// `git rev-parse --short` is the reflexive thing to paste, and an abbreviated
// SHA is not a pin: it can become ambiguous as the repo grows.
test('checkWorkflows rejects an abbreviated SHA', () => {
  assert.deepEqual(rulesFor({ [BASE_CI]: workflow({ uses: 'actions/checkout@a1b2c3d   # v4.4.0' }) }), ['workflow-unpinned-action']);
});

test('checkWorkflows accepts a local ./ action reference', () => {
  assert.deepEqual(checkWorkflows(makeRepo({ [BASE_CI]: workflow({ uses: './.github/actions/thing' }) })), []);
});

test('checkWorkflows rejects a SHA-pinned uses: with no version comment', () => {
  const violations = checkWorkflows(makeRepo({ [BASE_CI]: workflow({ uses: `actions/checkout@${SHA}` }) }));

  assert.deepEqual(violations.map((v) => v.rule), ['workflow-missing-version-comment']);
});

test('checkWorkflows accepts a docker reference pinned to a full sha256 digest', () => {
  const uses = `docker://ghcr.io/org/tool@sha256:${DIGEST}   # v1.0.0`;
  assert.deepEqual(checkWorkflows(makeRepo({ [BASE_CI]: workflow({ uses }) })), []);
});

// The docker exemption is only worth having if the digest has to be a digest.
test('checkWorkflows rejects a docker reference whose sha256 digest is truncated', () => {
  const uses = 'docker://ghcr.io/org/tool@sha256:abc123   # v1.0.0';
  assert.deepEqual(rulesFor({ [BASE_CI]: workflow({ uses }) }), ['workflow-unpinned-action']);
});

test('checkWorkflows rejects curl piped into an extractor', () => {
  const rules = rulesFor({
    [BASE_CI]: workflow({
      env: [`TOOL_SHA256: ${DIGEST}`],
      run: ['echo "${TOOL_SHA256}"', 'curl -sSL "$url" | tar -xz tool'],
    }),
  });

  assert.deepEqual(rules, ['workflow-piped-download']);
});

test('checkWorkflows rejects curl piped into a shell', () => {
  const rules = rulesFor({
    [BASE_CI]: workflow({
      env: [`TOOL_SHA256: ${DIGEST}`],
      run: ['echo "${TOOL_SHA256}"', 'curl -sSL "$url" | bash'],
    }),
  });

  assert.deepEqual(rules, ['workflow-piped-download']);
});

test('checkWorkflows rejects a download with no committed digest to verify it against', () => {
  const rules = rulesFor({
    [BASE_CI]: workflow({ run: ['curl -sSLf -o tool.tgz "$url"', 'tar -xzf tool.tgz'] }),
  });

  assert.deepEqual(rules, ['workflow-unverified-download']);
});

// The rule enforces D3's trust anchor, not its vocabulary. Fetching the
// checksums file from the same release over the same channel verifies nothing —
// whoever can alter the tarball can alter the checksums beside it — so a block
// that says `sha256sum -c` without a committed literal is still a violation.
test('checkWorkflows rejects a checksum fetched alongside the artifact it checks', () => {
  const rules = rulesFor({
    [BASE_CI]: workflow({
      run: [
        'curl -sSLf -o tool.tgz "$url"',
        'curl -sSLf -o checksums.txt "$checksums_url"',
        'sha256sum -c checksums.txt',
      ],
    }),
  });

  assert.deepEqual(rules, ['workflow-unverified-download']);
});

test('checkWorkflows accepts a download verified against a committed 64-hex env digest', () => {
  const violations = checkWorkflows(makeRepo({
    [BASE_CI]: workflow({
      env: [`TOOL_SHA256: ${DIGEST}`],
      run: [
        'curl -sSLf -o tool.tgz "$url"',
        'echo "${TOOL_SHA256}  tool.tgz" | sha256sum -c -',
        'tar -xzf tool.tgz tool',
      ],
    }),
  }));

  assert.deepEqual(violations, []);
});

// A truncated or malformed literal is not an anchor, so it must not satisfy the
// rule just by being named `..._SHA256`.
test('checkWorkflows does not accept a malformed env digest as a trust anchor', () => {
  const rules = rulesFor({
    [BASE_CI]: workflow({
      env: ['TOOL_SHA256: b1b2b3b4'],
      run: ['curl -sSLf -o tool.tgz "$url"', 'echo "${TOOL_SHA256}  tool.tgz" | sha256sum -c -'],
    }),
  });

  assert.deepEqual(rules, ['workflow-unverified-download']);
});

test('checkWorkflows returns [] when the root has no workflow directory at all', () => {
  assert.deepEqual(checkWorkflows(makeRepo({ 'README.md': '# x\n' })), []);
});

test('checkWorkflows scans workflows a profile adds', () => {
  const rel = 'profiles/design-vault/files/dot-github/workflows/vault.yml';
  const violations = checkWorkflows(makeRepo({ [rel]: workflow({ uses: 'actions/checkout@v4' }) }));

  assert.deepEqual(violations.map((v) => v.path), [rel]);
});

// files-override/ is the one mechanism designed to replace a base file, so it is
// exactly where hardening would get quietly reverted. No profile overrides a
// workflow today; the glob covers it anyway.
test('checkWorkflows scans workflows a profile overrides', () => {
  const rel = 'profiles/web-app/files-override/dot-github/workflows/ci.yml';
  const violations = checkWorkflows(makeRepo({ [rel]: workflow({ uses: 'actions/checkout@v4' }) }));

  assert.deepEqual(violations.map((v) => v.path), [rel]);
});

test("checkWorkflows scans this repo's own live workflows, not only templates", () => {
  const rel = '.github/workflows/ci.yml';
  const violations = checkWorkflows(makeRepo({ [rel]: workflow({ uses: 'actions/checkout@v4' }) }));

  assert.deepEqual(violations.map((v) => v.path), [rel]);
});

test('verifyTemplates reports workflow violations', () => {
  const root = makeRepo({ ...base(), ...profile('web-app'), [BASE_CI]: workflow({ uses: 'actions/checkout@v4' }) });

  assert.ok(verifyTemplates(root).some((v) => v.rule === 'workflow-unpinned-action'));
});

// ---------------------------------------------------------------------------
// The repo as shipped. These run against the real files, so a reversion in any
// workflow — template, profile or live — turns them red without anyone
// remembering to extend a hardcoded list.
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const realWorkflows = () => workflowFiles(REPO_ROOT);
const readWorkflow = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('workflowFiles finds every workflow this repo ships', () => {
  assert.deepEqual(realWorkflows().sort(), [
    '.github/workflows/ci.yml',
    'base/files/dot-github/workflows/ci.yml',
    'profiles/content-library/files/dot-github/workflows/library.yml',
    'profiles/design-vault/files/dot-github/workflows/vault.yml',
  ]);
});

test('the repo as shipped has no template violations', () => {
  assert.deepEqual(verifyTemplates(REPO_ROOT), []);
});

// The digest has to be checked before tar touches the bytes; both strings merely
// being present is what the old pipe-to-tar form would also satisfy.
test('the secrets job verifies the gitleaks digest before extracting it', () => {
  for (const rel of realWorkflows().filter((f) => f.endsWith('ci.yml'))) {
    const text = readWorkflow(rel);
    const verify = text.indexOf('sha256sum -c');
    const extract = text.indexOf('tar -x');

    assert.notEqual(verify, -1, `${rel}: no checksum verification`);
    assert.notEqual(extract, -1, `${rel}: no extraction`);
    assert.ok(verify < extract, `${rel}: extracts at ${extract} before verifying at ${verify}`);
  }
});

// checkout persists GITHUB_TOKEN into .git/config by default, which puts the
// repo credential in reach of anything the job then runs — the gitleaks binary
// included. Every job here is read-only, so neither is needed.
test('every checkout in every workflow refuses to persist credentials', () => {
  for (const rel of realWorkflows()) {
    const text = readWorkflow(rel);
    const checkouts = text.match(/actions\/checkout@/g) ?? [];
    const refusals = text.match(/persist-credentials:\s*false/g) ?? [];

    assert.ok(checkouts.length > 0, `${rel}: expected at least one checkout`);
    assert.equal(refusals.length, checkouts.length, `${rel}: ${checkouts.length} checkout(s), ${refusals.length} refusal(s)`);
  }
});

test('every job in every workflow declares read-only permissions', () => {
  for (const rel of realWorkflows()) {
    const text = readWorkflow(rel);
    const jobs = text.match(/^\s+runs-on:/gm) ?? [];
    const grants = text.match(/^\s+permissions:\n\s+contents: read$/gm) ?? [];

    assert.equal(grants.length, jobs.length, `${rel}: ${jobs.length} job(s), ${grants.length} read-only grant(s)`);
  }
});

// ---------------------------------------------------------------------------
// H1b — Dependabot in the base layer (D2) and the template/live drift guard (D5).
// ---------------------------------------------------------------------------

const normalize = (text) => text.replace(/\r\n/g, '\n');

test('REQUIRED_BASE_FILES includes the Dependabot config', () => {
  assert.equal(REQUIRED_BASE_FILES.includes('files/dot-github/dependabot.yml'), true);
});

test('checkBase reports the Dependabot config when the base layer drops it', () => {
  const files = base();
  delete files['base/files/dot-github/dependabot.yml'];
  const violations = checkBase(makeRepo(files));

  assert.deepEqual(violations.map((v) => v.path), ['base/files/dot-github/dependabot.yml']);
  assert.equal(violations[0].rule, 'base-files');
});

// D5. This repo dogfoods its own template, and the two copies are hand-maintained
// with nothing generating either. The invariant is what makes this repo a live
// test of what it ships; it should fail loudly the day someone hardens one copy
// and forgets the other, which is the most likely way a workflow change gets
// half-applied.
//
// The repair direction is deliberately live -> template, not the reverse.
// Dependabot only scans `.github/workflows/`, so it can only ever bump the live
// file; copying template -> live would silently revert a reviewed security bump.
// If these two are ever meant to diverge, delete this test in the same PR and
// say why.
test('the base CI template and this repo\'s live CI stay identical', () => {
  const template = normalize(readFileSync(join(REPO_ROOT, 'base/files/dot-github/workflows/ci.yml'), 'utf8'));
  const live = normalize(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));

  assert.equal(
    live,
    template,
    'base/files/dot-github/workflows/ci.yml and .github/workflows/ci.yml have drifted. '
    + 'Repair by copying the LIVE file over the TEMPLATE, never the other way: Dependabot '
    + 'can only bump the live copy, and copying template -> live reverts that bump.',
  );
});

// H1a resolved each action's SHA once and reused it across every workflow file,
// because nothing here runs vault.yml or library.yml: a transposed character in a
// profile workflow surfaces in a downstream scaffold, not in this repo's CI. That
// invariant had no enforcement, and it broke silently the first time Dependabot
// ran. The bot only scans `.github/workflows/`, the drift test above compares only
// the ci.yml pair, and the four workflow lint rules check each file in isolation --
// so vault.yml and library.yml sat three major versions behind while every check
// stayed green.
//
// The file list is discovered via workflowFiles(), never hardcoded, so a fifth
// workflow is held to this rule the day it is added.
test('every workflow file pins the same SHA for a given action', () => {
  const USES = /^\s*(?:-\s+)?uses:\s*([\w.-]+\/[\w./-]+)@([0-9a-f]{40})[^\S\n]*(#.*)?$/;
  const pins = new Map();

  for (const rel of workflowFiles(REPO_ROOT)) {
    for (const line of readFileSync(join(REPO_ROOT, rel), 'utf8').split(/\r?\n/)) {
      const match = line.match(USES);
      if (!match) continue;
      const [, action, sha, comment] = match;
      const pin = `${sha} ${(comment ?? '').trim()}`;
      if (!pins.has(action)) pins.set(action, new Map());
      const seen = pins.get(action);
      if (!seen.has(pin)) seen.set(pin, []);
      seen.get(pin).push(rel);
    }
  }

  assert.equal(pins.size > 0, true, 'no pinned actions found -- the regex or the discovery is broken');

  // Every inconsistent action is reported in one failure, not just the first.
  // Bumping two actions at once is the normal case, and fixing one to discover
  // the next on a re-run is how a half-finished propagation gets committed.
  const mismatched = [...pins].filter(([, seen]) => seen.size > 1);
  if (mismatched.length) {
    const detail = mismatched.map(([action, seen]) => `${action} is pinned ${seen.size} ways:\n`
      + [...seen].map(([pin, files]) => `  ${pin}\n    ${files.join('\n    ')}`).join('\n')).join('\n\n');
    assert.fail(
      `${mismatched.length} action(s) disagree across this repo's workflow files:\n${detail}\n`
      + 'Resolve each SHA once and use it everywhere. Dependabot can only bump '
      + '.github/workflows/, so the profile templates are updated by hand in the same PR.',
    );
  }
});

test('the base Dependabot template and this repo\'s live config stay identical', () => {
  const template = normalize(readFileSync(join(REPO_ROOT, 'base/files/dot-github/dependabot.yml'), 'utf8'));
  const live = normalize(readFileSync(join(REPO_ROOT, '.github/dependabot.yml'), 'utf8'));

  assert.equal(live, template, 'base/files/dot-github/dependabot.yml and .github/dependabot.yml have drifted');
});

// daftplate dogfoods its own base layer: every file base/files/dot-github/ ships
// has a live counterpart under .github/. Nothing checked that, and it was already
// false -- ISSUE_TEMPLATE/feature-request.yml shipped to every scaffolded repo
// while this repo filed its own enhancement issues with no template at all.
//
// Discovered rather than listed, for exactly that reason: the two pairs that were
// pinned were pinned by hand, one test each, and the third pair was missed because
// nobody wrote its test. A walk holds the next file added to the tree on the day
// it lands.
//
// Content repair here is TEMPLATE -> LIVE: the base layer is the source of truth
// and the live copy is the dogfood. The two files in INVERTED_REPAIR are the
// exception and are compared by the dedicated tests above, because Dependabot can
// only bump the live copy -- so copying template -> live would revert a reviewed
// security bump. They are still held to the existence check; only their content
// comparison lives elsewhere.
const INVERTED_REPAIR = new Set(['workflows/ci.yml', 'dependabot.yml']);

test('this repo mirrors every file the base dot-github layer ships', () => {
  const templateRoot = join(REPO_ROOT, 'base/files/dot-github');
  const shipped = walkFiles(templateRoot).filter((e) => !e.isDir).map((e) => e.rel).sort();

  assert.ok(shipped.length > 0, 'walked base/files/dot-github and found no files -- the walk is broken, not the tree');

  const missing = [];
  const drifted = [];
  for (const rel of shipped) {
    const livePath = join(REPO_ROOT, '.github', rel);
    if (!existsSync(livePath)) {
      missing.push(rel);
      continue;
    }
    if (INVERTED_REPAIR.has(rel)) continue;
    const template = normalize(readFileSync(join(templateRoot, rel), 'utf8'));
    if (normalize(readFileSync(livePath, 'utf8')) !== template) drifted.push(rel);
  }

  assert.deepEqual(
    { missing, drifted },
    { missing: [], drifted: [] },
    'base/files/dot-github/ and .github/ have diverged. Repair by copying the TEMPLATE '
    + 'over the LIVE file: the base layer is the source of truth for these. '
    + `The one exception is ${[...INVERTED_REPAIR].join(' and ')}, repaired live -> template.`,
  );
});


// `github-actions` is the ecosystem that understands SHA pins: it rewrites the
// hash and the trailing `# vX.Y.Z` comment together, which is why D1 made that
// comment mandatory rather than decorative.
test('the Dependabot config schedules github-actions updates in that same entry', () => {
  const text = readFileSync(join(REPO_ROOT, '.github/dependabot.yml'), 'utf8');
  assert.match(text, /^version: 2$/m);

  const entry = dependabotEntry(text, 'github-actions');
  assert.ok(entry, 'no github-actions entry in updates:');
  assert.match(entry, /^\s+directory:\s*['"]?\/['"]?\s*$/m);
  assert.match(entry, /^\s+schedule:\s*$/m);
  assert.match(entry, /^\s+interval:\s*['"]?weekly['"]?\s*$/m);
});

// The extractor is the load-bearing part of the test above, so it gets its own
// proof: the mutation that motivated it must not be readable as a scheduled
// github-actions entry.
test('dependabotEntry does not borrow a schedule from a neighbouring ecosystem', () => {
  const mutated = [
    'version: 2',
    'updates:',
    '  - package-ecosystem: github-actions',
    '    directory: /',
    '  - package-ecosystem: npm',
    '    directory: /',
    '    schedule:',
    '      interval: weekly',
    '',
  ].join('\n');

  const entry = dependabotEntry(mutated, 'github-actions');
  assert.ok(entry, 'the entry itself is still present');
  assert.equal(/interval:/.test(entry), false, 'the npm schedule must not leak into the actions entry');
});

// --- the Node runtime is resolved, never pinned (#117) -----------------------

/** A workflow with a setup-node step, parameterised so each mutation is one edit. */
const nodeWorkflow = ({
  resolver = true,
  id = 'node-version',
  command = 'node scripts/resolve-node-version.mjs >> "$GITHUB_OUTPUT"',
  version = '${{ steps.node-version.outputs.node-version }}',
  resolverAfter = false,
} = {}) => {
  const resolverStep = [
    '      - name: Resolve the Node version this repository declares',
    `        id: ${id}`,
    `        run: ${command}`,
  ];
  const setupStep = [
    `      - uses: actions/setup-node@${SHA}   # v7.0.0`,
    '        with:',
    `          node-version: ${version}`,
  ];
  return [
    'name: ci', '', 'jobs:', '  job:', '    runs-on: ubuntu-latest', '    steps:',
    ...(resolver && !resolverAfter ? resolverStep : []),
    ...setupStep,
    ...(resolver && resolverAfter ? resolverStep : []),
    '',
  ].join('\n');
};

test('a canonical resolver/setup-node pair is accepted', () => {
  assert.deepEqual(rulesFor({ [BASE_CI]: nodeWorkflow() }), []);
});

test('a literal node-version is rejected', () => {
  // The original defect: '20', four months past end of life, in four files.
  for (const version of ["'20'", '"24"', '20', 'lts/*']) {
    const rules = rulesFor({ [BASE_CI]: nodeWorkflow({ version }) });
    assert.equal(rules.includes('workflow-static-node-version'), true, `accepted ${version}`);
  }
});

test('a setup-node with no resolver step at all is rejected', () => {
  const rules = rulesFor({ [BASE_CI]: nodeWorkflow({ resolver: false, version: "'20'" }) });
  assert.equal(rules.includes('workflow-missing-node-resolver'), true);
});

test('a resolver placed after setup-node is rejected', () => {
  // Order is the whole contract: the output does not exist yet when setup-node
  // reads it, and the step would silently receive an empty string.
  const rules = rulesFor({ [BASE_CI]: nodeWorkflow({ resolverAfter: true }) });
  assert.equal(rules.includes('workflow-missing-node-resolver'), true);
});

test('a resolver whose output nothing consumes is rejected', () => {
  // A step that runs and changes nothing reads as compliance at a glance.
  const rules = rulesFor({
    [BASE_CI]: nodeWorkflow({ version: '${{ steps.something-else.outputs.node-version }}' }),
  });
  assert.equal(rules.includes('workflow-unused-node-resolver'), true);
});

test('a renamed step id or a different command is rejected', () => {
  assert.equal(
    rulesFor({ [BASE_CI]: nodeWorkflow({ id: 'node' }) }).includes('workflow-missing-node-resolver'),
    true,
  );
  assert.equal(
    rulesFor({ [BASE_CI]: nodeWorkflow({ command: 'echo node-version=24 >> "$GITHUB_OUTPUT"' }) })
      .includes('workflow-missing-node-resolver'),
    true,
  );
});

test('every workflow this repo actually ships resolves its Node version', () => {
  // The live assertion, not a fixture one: the four real files are the thing
  // #117 was filed about, and a fixture-only test would pass with them unfixed.
  const root = fileURLToPath(new URL('..', import.meta.url));
  const shipped = checkWorkflows(root).filter((v) => v.rule.includes('node'));
  assert.deepEqual(shipped, []);

  for (const rel of [
    '.github/workflows/ci.yml',
    'base/files/dot-github/workflows/ci.yml',
    'profiles/content-library/files/dot-github/workflows/library.yml',
    'profiles/design-vault/files/dot-github/workflows/vault.yml',
  ]) {
    const text = readFileSync(join(root, rel), 'utf8');
    assert.match(text, /scripts\/resolve-node-version\.mjs/, `${rel} does not resolve`);
    assert.doesNotMatch(text, /node-version: '\d/, `${rel} still pins a literal`);
  }
});

test('daftplate declares the runtime its own CI will now resolve', () => {
  // Fixing the templates while this repo still declared >=20 would leave the
  // source repo asserting the dead version it just stopped shipping.
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=24 <25');
  assert.equal('dependencies' in pkg, false);
  assert.equal('devDependencies' in pkg, false);
});

// --- the base CI installs locked dependencies before testing (#113) ----------

test('the base CI template installs before it tests, guarded by a lockfile', () => {
  // The template went straight from setup-node to `npm test --if-present` with
  // no install anywhere, which is correct for a dependency-free repo and
  // silently fatal for one with dependencies: the suite fails with
  // MODULE_NOT_FOUND, which reads as a broken test file rather than a missing
  // install. It took a red CI run on a real PR to spot.
  for (const rel of ['base/files/dot-github/workflows/ci.yml', '.github/workflows/ci.yml']) {
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const install = text.indexOf('npm ci');
    const testStep = text.indexOf('npm test --if-present');

    assert.notEqual(install, -1, `${rel} has no npm ci step`);
    assert.notEqual(testStep, -1, `${rel} lost its test step`);
    // Order, not mere presence: an install after the test step installs nothing
    // that the test could have used.
    assert.ok(install < testStep, `${rel} installs after it tests`);
    // Guarded, so a dependency-free repo is not broken to fix a repo with
    // dependencies. An unconditional npm ci fails outright with no lockfile.
    assert.match(text, /if \[ -f package-lock\.json \]; then/);
  }
});

test('the install guard preserves the no-lockfile path and the pinned contract', () => {
  const text = readFileSync(join(REPO_ROOT, 'base/files/dot-github/workflows/ci.yml'), 'utf8');

  assert.match(text, /No package-lock\.json — nothing to install\./);
  // The security contract §2.2 requires is untouched by this addition.
  assert.match(text, /persist-credentials: false/);
  assert.match(text, /permissions:[\s\S]{0,20}contents: read/);
  // Every action still pinned to a full 40-hex SHA — checkWorkflows enforces
  // this repo-wide, and this asserts the addition did not disturb it here.
  for (const line of text.split(/\r?\n/).filter((l) => l.includes('uses:'))) {
    assert.match(line, /@[0-9a-f]{40}\b/, `unpinned action: ${line.trim()}`);
  }
});

test('the base CI refuses a tracked engineering-standards copy', () => {
  // The pre-commit hook is local and --no-verify walks past it, so the merge
  // barrier has to exist server-side too. Same anchored predicate, so the two
  // cannot drift into disagreeing about what a vendored copy is.
  for (const rel of ['base/files/dot-github/workflows/ci.yml', '.github/workflows/ci.yml']) {
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
    assert.match(text, /Refuse a vendored copy of the engineering standards/);
    assert.match(text, /git ls-files --error-unmatch engineering-standards/);
    assert.match(text, /ADR 0001/);
    // Refuses; never deletes.
    assert.doesNotMatch(text, /git rm|rm -rf/);
  }
});

test('the vendored guard runs before the test step, not after it', () => {
  const text = readFileSync(join(REPO_ROOT, 'base/files/dot-github/workflows/ci.yml'), 'utf8');
  const guard = text.indexOf('Refuse a vendored copy');
  const testStep = text.indexOf('npm test --if-present');
  assert.ok(guard !== -1 && testStep !== -1);
  assert.ok(guard < testStep, 'the vendored guard runs after the tests');
});

// --- the vendored guard, executed rather than pattern-matched -----------------
//
// The three tests above read the workflow as text. Text is what let the guard
// ship refusing the one repository it was written in: every string assertion
// passed while `test` failed on every run (CI run 32719928626). So the guard's
// own shell body is extracted from the shipped workflow and RUN, against this
// checkout and against fixtures — the only form that can distinguish "the step
// is present" from "the step is right".
//
// `sh` is already a hard prerequisite of this suite: tests/setup-repo.test.mjs
// drives a `#!/bin/sh` hook through `git hook run`. Nothing new is required.

/** The `run:` body of the vendored-standards step, dedented to a runnable script. */
function vendoredGuardScript(rel = '.github/workflows/ci.yml') {
  const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('Refuse a vendored copy of the engineering standards'));
  assert.notEqual(start, -1, `${rel} has no vendored-standards step`);
  assert.match(lines[start + 1], /run: \|/, `${rel}'s guard is not a literal run block`);
  const body = [];
  for (const line of lines.slice(start + 2)) {
    // The block ends at the first line indented less than its contents.
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    body.push(line.replace(/^ {10}/, ''));
  }
  assert.ok(body.length > 3, `${rel}'s guard body did not extract`);
  return body.join('\n');
}

const runGuard = (script, cwd) => spawnSync('sh', ['-c', script], { cwd, encoding: 'utf8' });

/** A git repo with the given files tracked. */
function trackedRepo(files) {
  const dir = makeRepo(files);
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-b', 'main');
  git('add', '-A');
  return dir;
}

test('the vendored guard passes in the checkout that owns the standards', () => {
  // The defect this closes, stated as a property: daftplate tracks
  // engineering-standards/ because ADR 0001 makes it canonical HERE, so the
  // guard must exit 0 in this repository. It exited 1, on every run, from the
  // commit that introduced it until this one.
  //
  // Asserted against the live workflow and the template both, because the two
  // are byte-identical by contract and a fix applied to one is not a fix.
  for (const rel of ['.github/workflows/ci.yml', 'base/files/dot-github/workflows/ci.yml']) {
    const r = runGuard(vendoredGuardScript(rel), REPO_ROOT);
    assert.equal(r.status, 0, `${rel} refuses this repository: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /is tracked here/);
  }
});

test('the vendored guard still refuses a consumer repo that vendors the standards', () => {
  // The exemption must not have been bought by disabling the rule. A repo with
  // neither producer marker and a tracked copy is the case the guard exists for.
  const dir = trackedRepo({
    'README.md': '# consumer\n',
    'engineering-standards/repo-standards.md': '# a frozen copy\n',
  });

  const r = runGuard(vendoredGuardScript(), dir);

  assert.equal(r.status, 1, 'a vendored copy was accepted');
  assert.match(r.stderr, /engineering-standards\/ is tracked here/);
  assert.match(r.stderr, /ADR 0001/);
});

test('both producer markers are required, and neither alone exempts a repo', () => {
  // `profiles/` alone is an ordinary directory name and `base/files/` alone is
  // the shape of a half-copied template. Each is tested on its own, because a
  // guard written with `||` instead of `&&` passes the pair test above and
  // hands the exemption to any repo holding either one.
  for (const marker of ['base/files', 'profiles']) {
    const dir = trackedRepo({
      'README.md': '# consumer\n',
      [`${marker}/placeholder.md`]: '# not the producer\n',
      'engineering-standards/repo-standards.md': '# a frozen copy\n',
    });

    const r = runGuard(vendoredGuardScript(), dir);

    assert.equal(r.status, 1, `${marker}/ alone exempted a consumer repo`);
    assert.match(r.stderr, /engineering-standards\/ is tracked here/);
  }
});

test('the guard exempts by shape, and the shape is the one the hook uses', () => {
  // One list, read by the hook, the workflow and both their tests. The commit
  // that added the guard claimed the hook and CI "cannot drift"; that claim is
  // only true if something checks the marker names too, not just the pattern.
  for (const rel of ['.github/workflows/ci.yml', 'base/files/dot-github/workflows/ci.yml']) {
    const script = vendoredGuardScript(rel);
    for (const marker of PRODUCER_CHECKOUT_MARKERS) {
      // A literal substring, not a built regex. The first draft of this line was
      // `new RegExp(`\[ -d ${marker} \]`)`, where the escapes collapse in a
      // template literal and leave `[ -d base/files ]` — a character class that
      // matches any one of those characters, so it passed against a guard testing
      // `base/layers`. Caught by applying the rename mutation, which is the whole
      // argument of §12.
      assert.ok(
        script.includes(`[ -d ${marker} ]`),
        `${rel} does not test for ${marker}`,
      );
    }
  }
});
