import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import { installSkills, registerReportGate } from '../scripts/install-skills.mjs';

test('installSkills copies every skill directory into the target', () => {
  const source = makeRepo({
    'skills/new-project/SKILL.md': '---\nname: new-project\n---\nbody\n',
    'skills/orient/SKILL.md': '---\nname: orient\n---\nbody\n',
  });
  const target = emptyDir();

  const result = installSkills(source, target);

  assert.deepEqual(result.installed, ['new-project', 'orient']);
  assert.match(readFileSync(join(target, 'new-project', 'SKILL.md'), 'utf8'), /name: new-project/);
});

test('installSkills overwrites an existing installed copy without deleting it first', () => {
  const source = makeRepo({ 'skills/new-project/SKILL.md': 'new\n' });
  const target = makeRepo({
    'new-project/SKILL.md': 'stale\n',
    'new-project/keep-me.md': 'unrelated file\n',
  });

  installSkills(source, target);

  assert.equal(readFileSync(join(target, 'new-project', 'SKILL.md'), 'utf8'), 'new\n');
  assert.equal(existsSync(join(target, 'new-project', 'keep-me.md')), true);
});

test('installSkills in dry-run mode writes nothing', () => {
  const source = makeRepo({ 'skills/new-project/SKILL.md': 'body\n' });
  const target = emptyDir();

  const result = installSkills(source, target, { dryRun: true });

  assert.deepEqual(result.installed, ['new-project']);
  assert.equal(existsSync(join(target, 'new-project')), false);
});

test('installSkills skips a directory with no SKILL.md', () => {
  const source = makeRepo({ 'skills/notes/readme.md': 'x\n' });
  assert.deepEqual(installSkills(source, emptyDir()), { installed: [], skipped: ['notes'] });
});

test('installSkills throws when there is no skills/ directory', () => {
  assert.throws(() => installSkills(makeRepo({ 'README.md': 'x\n' }), emptyDir()), /no skills\/ directory/);
});

// --- the /crit report gate, registered user-level (ADR 0002's reasoning) ---

const GATE = 'export const x = 1;\n';
const withGate = (extra = {}) => makeRepo({
  'skills/crit/SKILL.md': '---\nname: crit\n---\nbody\n',
  'skills/crit/scripts/report-gate.mjs': GATE,
  ...extra,
});
const settingsOf = (dir) => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
const gateCommands = (settings) => (settings.hooks?.Stop ?? [])
  .flatMap((group) => group.hooks ?? [])
  .map((h) => h.command)
  .filter((c) => c?.includes('crit-report-gate.mjs'));

test('registerReportGate copies the hook and registers it on Stop', () => {
  const claudeDir = emptyDir();
  const result = registerReportGate(withGate(), claudeDir);

  assert.equal(result.skipped, null);
  assert.equal(result.registered, true);
  assert.equal(readFileSync(join(claudeDir, 'crit-report-gate.mjs'), 'utf8'), GATE);
  assert.deepEqual(gateCommands(settingsOf(claudeDir)).length, 1);
});

test('registerReportGate is idempotent — a second run adds no second entry', () => {
  const claudeDir = emptyDir();
  const source = withGate();

  registerReportGate(source, claudeDir);
  const second = registerReportGate(source, claudeDir);

  assert.equal(second.registered, false, 'the second run reports it was already registered');
  assert.equal(gateCommands(settingsOf(claudeDir)).length, 1);
});

test('registerReportGate keeps every hook and setting already in the file', () => {
  const existingStop = { hooks: [{ type: 'command', command: 'powershell -NoProfile -Command "beep"' }] };
  const claudeDir = makeRepo({
    'settings.json': `${JSON.stringify({
      model: 'opus[1m]',
      hooks: { Stop: [existingStop], SessionStart: [{ hooks: [{ type: 'command', command: 'chime' }] }] },
      permissions: { allow: ['Bash(npm test)'] },
    }, null, 2)}\n`,
  });

  registerReportGate(withGate(), claudeDir);
  const settings = settingsOf(claudeDir);

  assert.equal(settings.model, 'opus[1m]');
  assert.deepEqual(settings.permissions.allow, ['Bash(npm test)']);
  assert.deepEqual(settings.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'chime' }] }]);
  assert.deepEqual(settings.hooks.Stop[0], existingStop, 'the user\'s own Stop hook is untouched and still first');
  assert.equal(gateCommands(settings).length, 1);
});

test('registerReportGate refuses to overwrite a settings.json it cannot parse', () => {
  const claudeDir = makeRepo({ 'settings.json': '{ not json' });

  const result = registerReportGate(withGate(), claudeDir);

  assert.match(result.skipped, /could not be parsed/);
  assert.equal(readFileSync(join(claudeDir, 'settings.json'), 'utf8'), '{ not json', 'a config it cannot read is a config it must not write');
});

test('registerReportGate in dry-run mode writes nothing', () => {
  const claudeDir = emptyDir();

  const result = registerReportGate(withGate(), claudeDir, { dryRun: true });

  assert.equal(result.registered, true, 'it still reports what it would do');
  assert.equal(existsSync(join(claudeDir, 'settings.json')), false);
  assert.equal(existsSync(join(claudeDir, 'crit-report-gate.mjs')), false);
});

// Phase 2c: a hook and the skill it enforces ship together. No skill, no hook.
test('registerReportGate skips when the source ships no gate', () => {
  const result = registerReportGate(makeRepo({ 'skills/orient/SKILL.md': 'o\n' }), emptyDir());

  assert.match(result.skipped, /report-gate\.mjs/);
  assert.equal(result.registered, false);
});
