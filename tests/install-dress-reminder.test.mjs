// install-skills: registering the /dress reminder (repo-standards §6.5.1, ADR 0014).
//
// Three properties, each an owner ruling or a review finding:
//   - it is a PostToolUse(Bash) hook carrying `if: Bash(gh issue create*)`, so the
//     process never starts for the vast majority of Bash calls (D6);
//   - it is registered only when /dress is in the checkout, because the public
//     daftplate export ships scripts/ but not skills/ (D9);
//   - it only ever adds, like the two gates registered beside it.
//
// Kept apart from tests/install-skills.test.mjs, which is 60K and read in slices.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import {
  registerDressReminder, registerAttributionGate,
  DRESS_REMINDER_INSTALLED_NAME, DRESS_REMINDER_IF, ATTRIBUTION_GATE_INSTALLED_NAME,
} from '../scripts/install-skills.mjs';

const MANIFEST = '{"name":"daftplate","version":"0.0.0"}\n';
const checkout = (extra = {}) => makeRepo({
  '.claude-plugin/plugin.json': MANIFEST,
  'scripts/dress-reminder.mjs': '// dress reminder\n',
  'scripts/attribution-gate.mjs': '// attribution gate\n',
  'skills/dress/SKILL.md': '---\nname: dress\ndescription: x\n---\n',
  ...extra,
});
const settingsOf = (home) => JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
const mine = (home) => (settingsOf(home).hooks?.PostToolUse ?? [])
  .flatMap((g) => g.hooks.map((h) => ({ ...h, matcher: g.matcher })))
  .filter((h) => h.command.includes(DRESS_REMINDER_INSTALLED_NAME));

test('the reminder registers on PostToolUse, matched to Bash, with the if filter', () => {
  const home = emptyDir();
  const result = registerDressReminder(checkout(), home);
  assert.equal(result.registered, true);
  assert.equal(readFileSync(join(home, DRESS_REMINDER_INSTALLED_NAME), 'utf8'), '// dress reminder\n');
  const [hook] = mine(home);
  assert.equal(hook.matcher, 'Bash');
  assert.equal(hook.type, 'command');
  assert.equal(hook.if, 'Bash(gh issue create*)');
  assert.equal(DRESS_REMINDER_IF, 'Bash(gh issue create*)');
});

test('it is idempotent, and leaves the user\'s own PostToolUse groups in place', () => {
  const theirs = { hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node "C:/theirs.mjs"' }] }] } };
  const home = makeRepo({ 'settings.json': `${JSON.stringify(theirs, null, 2)}\n` });
  const source = checkout();
  assert.equal(registerDressReminder(source, home).registered, true);
  assert.equal(registerDressReminder(source, home).registered, false);
  assert.equal(mine(home).length, 1);
  assert.deepEqual(settingsOf(home).hooks.PostToolUse[0], theirs.hooks.PostToolUse[0]);
});

test('with no skills/dress in the checkout — the public export\'s shape — nothing is registered or copied', () => {
  const home = emptyDir();
  const source = makeRepo({
    '.claude-plugin/plugin.json': MANIFEST,
    'scripts/dress-reminder.mjs': '// dress reminder\n',
  });
  const result = registerDressReminder(source, home);
  assert.equal(result.registered, false);
  assert.match(result.skipped, /skills.dress.SKILL\.md is not in this checkout/);
  assert.equal(existsSync(join(home, DRESS_REMINDER_INSTALLED_NAME)), false);
  assert.equal(existsSync(join(home, 'settings.json')), false);
});

test('the attribution gate is still written without an if field', () => {
  // The filter is the reminder's alone. The gate must see every Bash call: a
  // footer can ride in any command, which is the whole reason it exists.
  const home = emptyDir();
  registerAttributionGate(checkout(), home);
  const gate = settingsOf(home).hooks.PreToolUse.flatMap((g) => g.hooks)
    .find((h) => h.command.includes(ATTRIBUTION_GATE_INSTALLED_NAME));
  assert.equal('if' in gate, false);
});
