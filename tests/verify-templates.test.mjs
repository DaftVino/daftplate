import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo } from './helpers/make-repo.mjs';
import {
  REQUIRED_BASE_FILES, REQUIRED_PROFILE_FILES,
  parseProfileMeta, metaValueIssues, checkBase, checkProfiles, verifyTemplates,
} from '../scripts/verify-templates.mjs';

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
  const meta = { verify: 'node --check <PROJECT_NAME>.js', test: 'npm test', deploy: 'n/a', docsSubdirs: ['designs'] };
  const issues = metaValueIssues(meta, 'profiles/x/profile.md');

  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'profile-metadata-token');
  assert.match(issues[0].message, /<PROJECT_NAME>/);
  assert.match(issues[0].message, /is not substituted a second time/);
});

test('metaValueIssues rejects the node --test <dir> form, which runs nothing', () => {
  const meta = { verify: 'npm run build', test: 'node --test tests/', deploy: 'n/a', docsSubdirs: ['designs'] };
  const issues = metaValueIssues(meta, 'profiles/x/profile.md');

  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'profile-metadata-test-form');
  assert.match(issues[0].message, /npm test/);
});

test('metaValueIssues passes a clean block', () => {
  const meta = { verify: 'npm run build', test: 'npm test', deploy: '/land-and-deploy', docsSubdirs: ['designs'] };

  assert.deepEqual(metaValueIssues(meta, 'profiles/x/profile.md'), []);
});

// A4 (D9): the loop runs over verify, test and deploy but only verify is fed a
// bad value in the planned tests, so a typo in the key list would ship silently.
test('metaValueIssues catches an unresolved token in the test key', () => {
  const meta = { verify: 'npm test', test: 'npm run <PROJECT_NAME>', deploy: 'n/a', docsSubdirs: ['designs'] };
  const issues = metaValueIssues(meta, 'profiles/x/profile.md');

  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'profile-metadata-token');
  assert.match(issues[0].message, /^test contains/);
});

test('metaValueIssues catches an unresolved token in the deploy key', () => {
  const meta = { verify: 'npm test', test: 'npm test', deploy: 'ship <PROJECT_NAME>', docsSubdirs: ['designs'] };
  const issues = metaValueIssues(meta, 'profiles/x/profile.md');

  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'profile-metadata-token');
  assert.match(issues[0].message, /^deploy contains/);
});

// A2 (D12): metadata must not name a script the profile does not ship.
test('metaValueIssues flags a metadata value naming a script the profile does not ship', () => {
  const root = makeRepo({ 'profiles/x/profile.md': PROFILE_MD });
  const meta = { verify: 'node scripts/local-verify.mjs', test: 'npm test', deploy: 'n/a', docsSubdirs: ['designs'] };
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
  const meta = { verify: 'node scripts/local-verify.mjs', test: 'npm test', deploy: 'n/a', docsSubdirs: ['designs'] };

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
