import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, existsSync, writeFileSync, renameSync, readdirSync, linkSync,
  mkdirSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import {
  installSkills, registerReportGate, registerAttributionGate, recordCheckout,
  GATES_SENTINEL, GATE_INSTALLED_NAME, ATTRIBUTION_GATE_INSTALLED_NAME, main,
  installedSkillDir, removalCommand,
} from '../scripts/install-skills.mjs';
// The marker vocabulary is imported from the lib rather than re-exported through the
// script: task 1.0 extracted it precisely so the writer, the checker and the tests read
// one definition.
import { CHECKOUT_MARKER_OPEN, CHECKOUT_MARKER_CLOSE } from '../scripts/lib/checkout-marker.mjs';
import { writeAtomically } from '../scripts/lib/atomic-write.mjs';
import { EXIT_CODES } from '../scripts/lib/cli.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// --- the plugin tree (ADR 0002 as amended 2026-09-02) -----------------------

const MANIFEST = '{ "name": "daftplate", "version": "0.0.0", "description": "d" }\n';
/** A checkout in the shape the loader wants: the manifest beside skills/. */
const pluginSource = (files = {}) => makeRepo({ '.claude-plugin/plugin.json': MANIFEST, ...files });
const skillFile = (name) => `---\nname: ${name}\n---\nbody\n`;

test('installSkills copies every skill into one plugin tree, not 22 siblings', () => {
  const source = pluginSource({
    'skills/new-project/SKILL.md': skillFile('new-project'),
    'skills/orient/SKILL.md': skillFile('orient'),
  });
  const target = emptyDir();

  const result = installSkills(source, target);

  assert.deepEqual(result.installed, ['new-project', 'orient']);
  assert.equal(result.root, join(target, 'daftplate'));
  assert.match(readFileSync(join(target, 'daftplate', 'skills', 'new-project', 'SKILL.md'), 'utf8'), /name: new-project/);
  // The mutant this kills is "revert to per-skill sibling copies": under that
  // change every assertion above still passes except this one.
  assert.equal(existsSync(join(target, 'new-project')), false);
  assert.equal(existsSync(join(target, 'orient')), false);
});

test('installSkills writes the manifest, without which the tree loads as nothing', () => {
  // Measured 2026-09-02: a directory of SKILL.md files with no
  // .claude-plugin/plugin.json is not a plugin, and `--plugin-dir` loads none of
  // it. The copy would look complete and be inert.
  const source = pluginSource({ 'skills/orient/SKILL.md': skillFile('orient') });
  const target = emptyDir();

  installSkills(source, target);

  assert.equal(readFileSync(join(target, 'daftplate', '.claude-plugin', 'plugin.json'), 'utf8'), MANIFEST);
});

test('installSkills throws when the checkout has no plugin manifest', () => {
  const source = makeRepo({ 'skills/orient/SKILL.md': skillFile('orient') });
  assert.throws(() => installSkills(source, emptyDir()), /no \.claude-plugin/);
});

test('installSkills overwrites an existing installed copy without deleting it first', () => {
  // ADR 0002's no-delete rule, restated against the plugin tree. The subtree is
  // daftplate's own now, which strengthens the case for copying over the top
  // rather than weakening it: a stale file here is daftplate's stale file.
  const source = pluginSource({ 'skills/new-project/SKILL.md': 'new\n' });
  const target = makeRepo({
    'daftplate/skills/new-project/SKILL.md': 'stale\n',
    'daftplate/skills/new-project/keep-me.md': 'unrelated file\n',
  });

  installSkills(source, target);

  assert.equal(readFileSync(join(target, 'daftplate', 'skills', 'new-project', 'SKILL.md'), 'utf8'), 'new\n');
  assert.equal(existsSync(join(target, 'daftplate', 'skills', 'new-project', 'keep-me.md')), true);
});

test('installSkills in dry-run mode writes nothing', () => {
  const source = pluginSource({ 'skills/new-project/SKILL.md': 'body\n' });
  const target = emptyDir();

  const result = installSkills(source, target, { dryRun: true });

  assert.deepEqual(result.installed, ['new-project']);
  assert.deepEqual(readdirSync(target), []);
});

test('installSkills skips a directory with no SKILL.md', () => {
  const source = pluginSource({ 'skills/notes/readme.md': 'x\n' });
  const target = emptyDir();

  const result = installSkills(source, target);

  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.skipped, ['notes']);
  assert.equal(existsSync(join(target, 'daftplate', 'skills', 'notes')), false);
});

test('installSkills throws when there is no skills/ directory', () => {
  assert.throws(() => installSkills(makeRepo({ 'README.md': 'x\n' }), emptyDir()), /no skills\/ directory/);
});

// --- decided behaviour 1: the removal report names only what it verified ----

test('the removal report names a loose directory it verified is a skill of that name', () => {
  const source = pluginSource({
    'skills/orient/SKILL.md': skillFile('orient'),
    'skills/handoff/SKILL.md': skillFile('handoff'),
  });
  const target = makeRepo({
    'orient/SKILL.md': skillFile('orient'),
    'handoff/SKILL.md': skillFile('handoff'),
  });

  const result = installSkills(source, target);

  assert.deepEqual(result.shadowed, [join(target, 'handoff'), join(target, 'orient')].sort());
});

test('the removal report skips a same-named directory that is not that skill', () => {
  // The named mutant: "the removal report names a directory it did not verify is
  // daftplate's". Three neighbours share a name with a daftplate skill and not
  // one of them is one — a bare directory, a directory of unrelated files, and a
  // SKILL.md declaring a different name (which is how a third-party skill
  // reachable under an aliased directory would look).
  const source = pluginSource({
    'skills/orient/SKILL.md': skillFile('orient'),
    'skills/handoff/SKILL.md': skillFile('handoff'),
    'skills/crit/SKILL.md': skillFile('crit'),
    'skills/audit/SKILL.md': skillFile('audit'),
  });
  const target = makeRepo({
    'orient/notes.md': 'somebody else\n',
    'handoff/SKILL.md': '---\nname: someone-elses-handoff\n---\nbody\n',
    'audit/SKILL.md': skillFile('audit'),
  });
  mkdirSync(join(target, 'crit'), { recursive: true });      // a bare directory, no SKILL.md

  const result = installSkills(source, target);

  assert.deepEqual(result.shadowed, [join(target, 'audit')]);
  assert.equal(result.shadowed.some((p) => p.endsWith('orient')), false, 'no SKILL.md is not a skill');
  assert.equal(result.shadowed.some((p) => p.endsWith('handoff')), false, 'a different declared name is a different skill');
  assert.equal(result.shadowed.some((p) => p.endsWith('crit')), false, 'an empty directory is not a skill');
});

test('a shadowed loose skill is reported but never removed', () => {
  const source = pluginSource({ 'skills/orient/SKILL.md': skillFile('orient') });
  const target = makeRepo({ 'orient/SKILL.md': skillFile('orient'), 'orient/extra.md': 'x\n' });

  installSkills(source, target);

  assert.equal(existsSync(join(target, 'orient', 'SKILL.md')), true);
  assert.equal(existsSync(join(target, 'orient', 'extra.md')), true);
});

test('main reports the shadowed copies as a migration requirement, not a tidy-up', () => {
  // The measurement is what fixes this wording: on a shared bare name the LOOSE
  // skill wins, so until these are gone the install has not taken effect. A
  // report that merely suggested tidying would be describing a different fact.
  const source = pluginSource({
    'engineering-standards/claude-md-global.md': '<!-- x -->\n\n## Non-negotiable gates\n',
    'skills/orient/SKILL.md': skillFile('orient'),
  });
  const home = emptyDir();
  const target = join(home, 'skills');
  mkdirSync(join(target, 'orient'), { recursive: true });
  writeFileSync(join(target, 'orient', 'SKILL.md'), skillFile('orient'), 'utf8');
  const errs = [];

  const code = main(['node', 'install-skills.mjs', '--target', target],
    { cwd: source, sourceRoot: source, claudeDir: home, log: () => {}, logError: (l) => errs.push(l) });

  const text = errs.join('\n');
  assert.equal(code, 0);
  assert.match(text, /migration required: 1 loose skill/);
  assert.match(text, /wins the bare name/);
  assert.match(text, /rm -rf .*orient/);
  assert.equal(existsSync(join(target, 'orient', 'SKILL.md')), true, 'reporting is not removing');
  assert.equal(existsSync(join(target, 'daftplate', 'skills', 'orient', 'SKILL.md')), true);
});

// --- decided behaviour 2: refuse while a skill sits at the plugin root ------

test('installSkills refuses to write while a loose skill occupies the plugin root', () => {
  // The rider Phase 1 found: a loose `daftplate` skill installs to exactly the
  // path the plugin tree occupies. The installer may not remove it, so it does
  // not write at all. The named mutant is writing the tree anyway and leaving a
  // stray SKILL.md at the plugin root.
  const source = pluginSource({
    'skills/daftplate/SKILL.md': skillFile('daftplate'),
    'skills/orient/SKILL.md': skillFile('orient'),
  });
  const target = makeRepo({ 'daftplate/SKILL.md': skillFile('daftplate') });

  const result = installSkills(source, target);

  assert.equal(result.refused, join(target, 'daftplate', 'SKILL.md'));
  assert.deepEqual(result.installed, []);
  assert.equal(existsSync(join(target, 'daftplate', '.claude-plugin')), false, 'nothing was written');
  assert.equal(existsSync(join(target, 'daftplate', 'skills')), false, 'nothing was written');
  // A refusal is not a delete: the file that caused it is still there.
  assert.equal(existsSync(join(target, 'daftplate', 'SKILL.md')), true);
});

test('the refusal is self-clearing — remove the file and the same call installs', () => {
  const source = pluginSource({
    'skills/daftplate/SKILL.md': skillFile('daftplate'),
    'skills/orient/SKILL.md': skillFile('orient'),
  });
  const target = makeRepo({ 'daftplate/SKILL.md': skillFile('daftplate') });

  assert.notEqual(installSkills(source, target).refused, null);
  rmSync(join(target, 'daftplate', 'SKILL.md'));
  const after = installSkills(source, target);

  assert.equal(after.refused, null);
  assert.deepEqual(after.installed, ['daftplate', 'orient']);
  assert.equal(existsSync(join(target, 'daftplate', 'skills', 'daftplate', 'SKILL.md')), true);
  assert.equal(existsSync(join(target, 'daftplate', 'SKILL.md')), false);
});

test('the refusal names every blocker in one command, so one paste clears it', () => {
  const source = pluginSource({
    'skills/daftplate/SKILL.md': skillFile('daftplate'),
    'skills/orient/SKILL.md': skillFile('orient'),
  });
  const target = makeRepo({
    'daftplate/SKILL.md': skillFile('daftplate'),
    'orient/SKILL.md': skillFile('orient'),
  });

  const result = installSkills(source, target);

  assert.deepEqual(result.shadowed, [join(target, 'orient')]);
  assert.match(removalCommand([result.refused, ...result.shadowed]), /daftplate\/SKILL\.md".*"?.*orient/);
});

test('#274 (FORGE-335) — main REFUSES with a non-zero code, and still records the checkout and the gates', () => {
  const source = pluginSource({
    'engineering-standards/claude-md-global.md': '<!-- x -->\n\n## Non-negotiable gates\n',
    'skills/daftplate/SKILL.md': skillFile('daftplate'),
  });
  const home = emptyDir();
  const target = join(home, 'skills');
  mkdirSync(join(target, 'daftplate'), { recursive: true });
  writeFileSync(join(target, 'daftplate', 'SKILL.md'), skillFile('daftplate'), 'utf8');
  const errs = [];

  const code = main(['node', 'install-skills.mjs', '--target', target],
    { cwd: source, sourceRoot: source, claudeDir: home, log: () => {}, logError: (l) => errs.push(l) });

  const text = errs.join('\n');
  // This asserted `code === 0` until #274 (FORGE-335), which is the whole defect:
  // the process exited SUCCESS having installed nothing, and a shipped test
  // pinned it — so anyone reading the suite would conclude the exit code was
  // deliberate, and fixing it would look like breaking a passing test.
  assert.equal(code, EXIT_CODES.REFUSED,
    'an install that refused and copied nothing reported success');
  assert.notEqual(code, 0);
  assert.match(text, /skills NOT installed/);
  assert.match(text, /plugin's own root/);
  assert.match(text, /rm -rf/);
  assert.equal(existsSync(join(target, 'daftplate', '.claude-plugin')), false);
  // The install refused; the work that did not depend on it still happened. That
  // is why the refusal is carried to the end rather than returned where it is
  // found: a partial success is the honest outcome and an idempotent rerun
  // converges, so abandoning work that would have succeeded helps nobody.
  assert.match(readFileSync(join(home, 'CLAUDE.md'), 'utf8'), /daftplate:checkout/);
});

test('#274 (FORGE-335) — a successful install still exits 0', () => {
  // AC 2, and the half a mutant returning REFUSED unconditionally would break.
  const source = pluginSource({
    'engineering-standards/claude-md-global.md': '<!-- x -->\n\n## Non-negotiable gates\n',
    'skills/orient/SKILL.md': skillFile('orient'),
  });
  const home = emptyDir();

  const code = main(['node', 'install-skills.mjs', '--target', join(home, 'skills')],
    { cwd: source, sourceRoot: source, claudeDir: home, log: () => {}, logError: () => {} });

  assert.equal(code, 0);
});

test('#274 (FORGE-335) — a source tree with no skills is not a refusal, and still exits 0', () => {
  // The distinction the new code has to keep. D5: the public export ships
  // scripts/ and withholds skills/ (ADR 0002), so installSkills() throws there —
  // and that is not a refusal. Nothing is in the way and there is nothing for an
  // operator to move, so `REFUSED` would send its reader looking for a directory
  // to remove that does not exist. Only the loose-skill branch sets it.
  const source = makeRepo({ '.claude-plugin/plugin.json': MANIFEST });
  const home = emptyDir();
  const errs = [];

  const code = main(['node', 'install-skills.mjs', '--target', join(home, 'skills')],
    { cwd: source, sourceRoot: source, claudeDir: home, log: () => {}, logError: (l) => errs.push(l) });

  assert.match(errs.join('\n'), /skills not installed/);
  assert.equal(code, 0, 'an export with no skills/ was reported as a refusal an operator could act on');
});

test('#274 (FORGE-335) — a broken checkout is a failed install, and independent work still runs', () => {
  // F4: the old catch gave the public export's deliberately absent skills/ and
  // every genuine install failure the same exit 0. Put a second obstruction at
  // the plugin root as well as omitting the manifest: both facts are true, but
  // the checkout cannot load anything even after the owner moves their file.
  // Failure therefore wins over refusal, while the owner's file survives and
  // the gates and checkout record still get their independent attempts.
  const source = makeRepo({
    'engineering-standards/claude-md-global.md': '<!-- x -->\n\n## Non-negotiable gates\n',
    'skills/daftplate/SKILL.md': skillFile('daftplate'),
    'skills/crit/scripts/report-gate.mjs': '// report gate\n',
    'scripts/attribution-gate.mjs': '// attribution gate\n',
  });
  const home = emptyDir();
  const target = join(home, 'skills');
  mkdirSync(join(target, 'daftplate'), { recursive: true });
  writeFileSync(join(target, 'daftplate', 'SKILL.md'), skillFile('daftplate'), 'utf8');
  const errs = [];

  const code = main(['node', 'install-skills.mjs', '--target', target],
    { sourceRoot: source, claudeDir: home, log: () => {}, logError: (line) => errs.push(line) });

  assert.equal(code, EXIT_CODES.INSTALL_FAILED,
    'a checkout with skills but no plugin manifest reported a successful install');
  assert.notEqual(code, EXIT_CODES.REFUSED,
    'a broken checkout was described as a user-owned obstruction');
  assert.match(errs.join('\n'), /skills not installed/);
  assert.equal(readFileSync(join(target, 'daftplate', 'SKILL.md'), 'utf8'), skillFile('daftplate'));
  assert.equal(readFileSync(join(home, GATE_INSTALLED_NAME), 'utf8'), '// report gate\n');
  assert.equal(readFileSync(join(home, ATTRIBUTION_GATE_INSTALLED_NAME), 'utf8'), '// attribution gate\n');
  assert.match(readFileSync(join(home, 'CLAUDE.md'), 'utf8'), /daftplate:checkout/);
});

test('#274 (FORGE-335) — a copy error is a failed install, and independent work still runs', () => {
  // The manifest check above proves a known validation throw. This reaches the
  // copy loop instead: a file at the plugin directory boundary makes cpSync
  // throw after the invocation was accepted. The native error text and code are
  // deliberately not asserted; neither is the protocol by which main decides
  // whether automation saw a failed install.
  const source = pluginSource({
    'engineering-standards/claude-md-global.md': '<!-- x -->\n\n## Non-negotiable gates\n',
    'skills/orient/SKILL.md': skillFile('orient'),
    'skills/crit/scripts/report-gate.mjs': '// report gate\n',
    'scripts/attribution-gate.mjs': '// attribution gate\n',
  });
  const home = emptyDir();
  const target = join(home, 'skills');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'daftplate'), 'somebody else owns this file\n', 'utf8');
  const errs = [];

  const code = main(['node', 'install-skills.mjs', '--target', target],
    { sourceRoot: source, claudeDir: home, log: () => {}, logError: (line) => errs.push(line) });

  assert.equal(code, EXIT_CODES.INSTALL_FAILED,
    'a cpSync error reported a successful install');
  assert.match(errs.join('\n'), /skills not installed/);
  assert.equal(readFileSync(join(target, 'daftplate'), 'utf8'), 'somebody else owns this file\n');
  assert.equal(readFileSync(join(home, GATE_INSTALLED_NAME), 'utf8'), '// report gate\n');
  assert.equal(readFileSync(join(home, ATTRIBUTION_GATE_INSTALLED_NAME), 'utf8'), '// attribution gate\n');
  assert.match(readFileSync(join(home, 'CLAUDE.md'), 'utf8'), /daftplate:checkout/);
});

test('#274 (FORGE-335) — the refusal code is the shared vocabulary, not a private number', () => {
  // The issue asks for EXIT_CODES rather than a literal, and which code is part
  // of the work. GATED was rejected: its docstring binds it to an agent CLI
  // blocked by ADR 0008's enablement conditions, and an installer exiting 3 sends
  // its reader to look for enablement conditions that have nothing to do with the
  // directory in their way. REFUSED is its own number for the reason GATED and
  // NO_DRIVER are two numbers rather than one.
  assert.equal(EXIT_CODES.REFUSED, 6);
  for (const [name, code] of Object.entries(EXIT_CODES)) {
    if (name === 'REFUSED') continue;
    assert.notEqual(code, EXIT_CODES.REFUSED, `REFUSED shares its number with ${name}`);
  }
  assert.notEqual(EXIT_CODES.REFUSED, 0);
  assert.notEqual(EXIT_CODES.REFUSED, 1);
});

test('#274 (FORGE-335) — the failed-install code is named once and distinct from every other outcome', () => {
  // `1` already means a completed check found violations, and this file's old
  // usage return does not make that ambiguity a useful precedent. A copy that
  // threw part-way through is neither completed work nor a deliberate refusal,
  // so automation gets a code whose name says which retry or repair it needs.
  assert.equal(EXIT_CODES.INSTALL_FAILED, 7);
  for (const [name, code] of Object.entries(EXIT_CODES)) {
    if (name === 'INSTALL_FAILED') continue;
    assert.notEqual(code, EXIT_CODES.INSTALL_FAILED, `INSTALL_FAILED shares its number with ${name}`);
  }
  assert.notEqual(EXIT_CODES.INSTALL_FAILED, 0);
  assert.notEqual(EXIT_CODES.INSTALL_FAILED, 1);
});

// --- consumers resolve either shape while the migration is half-done --------

test('installedSkillDir finds the plugin copy, the loose copy, or neither', () => {
  const root = makeRepo({
    'daftplate/skills/orient/SKILL.md': skillFile('orient'),
    'handoff/SKILL.md': skillFile('handoff'),
    'notaskill/readme.md': 'x\n',
  });

  assert.equal(installedSkillDir(root, 'orient'), join(root, 'daftplate', 'skills', 'orient'));
  assert.equal(installedSkillDir(root, 'handoff'), join(root, 'handoff'));
  assert.equal(installedSkillDir(root, 'notaskill'), null);
  assert.equal(installedSkillDir(root, 'absent'), null);
});

test('installedSkillDir prefers the plugin copy when both shapes are present', () => {
  // The state every machine occupies between installing and removing. The plugin
  // copy is the one this installer wrote, so it is the one to report.
  const root = makeRepo({
    'daftplate/skills/orient/SKILL.md': skillFile('orient'),
    'orient/SKILL.md': skillFile('orient'),
  });

  assert.equal(installedSkillDir(root, 'orient'), join(root, 'daftplate', 'skills', 'orient'));
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

// --- recording the daftplate checkout path in ~/.claude/CLAUDE.md (#98) ---

// D2: recordCheckout reads the global template out of the checkout it is given,
// so every case that has to CREATE the file seeds a source repo carrying it.
const sourceWithTemplate = () => makeRepo({
  'engineering-standards/claude-md-global.md': '<!-- Install at ~/.claude/CLAUDE.md. -->\n\n3. **Never commit to `main`.**\n',
});

test('recordCheckout seeds an absent ~/.claude/CLAUDE.md from the global template, gates included', () => {
  const dir = emptyDir();
  const result = recordCheckout(sourceWithTemplate(), dir);
  const text = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');

  assert.equal(result.action, 'created');
  assert.match(text, new RegExp(CHECKOUT_MARKER_OPEN));
  // The load-bearing half (ADR 0001:25): the created file carries the gates.
  // A marker-only file passes every other assertion here and is exactly the
  // outcome D2 was reversed to prevent.
  assert.match(text, /Never commit to `main`/);
});

test('recordCheckout refuses when the global template is missing rather than writing a thin file', () => {
  // The public export ships claude-md-global.md, but a partial checkout must
  // fail loudly instead of silently producing the gate-less file D2 rejects.
  const result = recordCheckout(makeRepo({ 'README.md': 'x\n' }), emptyDir());
  assert.equal(result.action, 'refused');
  assert.match(result.reason, /claude-md-global\.md/);
});

test('recordCheckout adds the block to a file that has none, reporting added not created', () => {
  // 'added' is a distinct action from 'created' and needs its own case, or the
  // status is unfalsifiable and could be wired to either branch.
  const dir = emptyDir();
  writeFileSync(join(dir, 'CLAUDE.md'), '# My gates\n', 'utf8');
  assert.equal(recordCheckout('X:/Projects/daftplate', dir).action, 'added');
});

test('recordCheckout is idempotent — a second run rewrites nothing', () => {
  // The plan wrote this against an empty claudeDir with a bare path as the source,
  // which D2 refuses (no template) — the same fixture-versus-D2 contradiction the
  // phase 0 handoff logged for task 1.2. Seeded from a real source instead.
  const dir = emptyDir();
  const source = sourceWithTemplate();
  recordCheckout(source, dir);
  const first = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');

  const second = recordCheckout(source, dir);

  assert.equal(second.action, 'current');
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), first);
});

test('recordCheckout appends to an existing file without touching the prose around it', () => {
  const dir = emptyDir();
  const prose = '# My gates\n\nNever write attribution footers.\n';
  writeFileSync(join(dir, 'CLAUDE.md'), prose, 'utf8');

  recordCheckout('X:/Projects/daftplate', dir);

  const text = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
  assert.equal(text.startsWith(prose), true);
  assert.equal(text.includes(CHECKOUT_MARKER_OPEN), true);
});

test('recordCheckout appends cleanly to a file with no trailing newline', () => {
  // Off-by-one on the separator is the likeliest way the block lands glued to
  // the user's last line, which no other assertion here would catch.
  const dir = emptyDir();
  writeFileSync(join(dir, 'CLAUDE.md'), '# My gates', 'utf8');
  recordCheckout('X:/Projects/daftplate', dir);
  assert.match(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'),
    new RegExp(`# My gates\\n\\n?${CHECKOUT_MARKER_OPEN}`));
});

test('recordCheckout rewrites the block in place when the path changed, and reports the old one', () => {
  // Two real source trees rather than the plan's two bare paths, for the same
  // D2 reason as the idempotency case above.
  const dir = emptyDir();
  const first = sourceWithTemplate();
  const second = sourceWithTemplate();
  recordCheckout(first, dir);
  writeFileSync(join(dir, 'CLAUDE.md'),
    `${readFileSync(join(dir, 'CLAUDE.md'), 'utf8')}\ntrailing user prose\n`, 'utf8');

  const result = recordCheckout(second, dir);
  const text = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');

  assert.equal(result.action, 'updated');
  assert.equal(result.previous, first);
  assert.equal(text.includes(first), false);
  assert.match(text, /trailing user prose/);          // prose after the block survives
  assert.equal(text.match(/daftplate:checkout -->/g).length, 2);   // exactly one block
});

test('recordCheckout refuses a malformed marker span rather than guessing its bounds', () => {
  // Per D7: an unclosed, duplicated or reordered span is not daftplate's to
  // rewrite. Rewriting it would delete user text this code did not create,
  // which CLAUDE.md #5 forbids.
  const dir = emptyDir();
  writeFileSync(join(dir, 'CLAUDE.md'),
    `${CHECKOUT_MARKER_OPEN}\nuser text, no closing marker\n`, 'utf8');

  const result = recordCheckout('X:/Projects/daftplate', dir);

  assert.equal(result.action, 'refused');
  assert.match(result.reason, /marker/);
  assert.match(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), /user text, no closing marker/);
});

test('recordCheckout retries a blocked rename and then refuses, leaving the file intact', () => {
  // Cell 7. Measured on Windows 2026-08-16: renameSync over a file with an open
  // read handle throws EPERM. Injected rather than reproduced with a real
  // handle so the test is deterministic and runs on POSIX too, where the OS
  // would never produce this.
  const dir = emptyDir();
  writeFileSync(join(dir, 'CLAUDE.md'), '# My gates\n', 'utf8');
  let attempts = 0;
  const rename = () => { attempts += 1; const e = new Error('busy'); e.code = 'EPERM'; throw e; };

  const result = recordCheckout(sourceWithTemplate(), dir, { rename });

  assert.equal(result.action, 'refused');
  assert.match(result.reason, /open in another process/);
  assert.equal(attempts, 3);                                        // retried, not one-shot
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), '# My gates\n');   // untouched
});

test('recordCheckout succeeds when a retried rename clears', () => {
  const dir = emptyDir();
  writeFileSync(join(dir, 'CLAUDE.md'), '# My gates\n', 'utf8');
  let attempts = 0;
  const rename = (from, to) => {
    attempts += 1;
    if (attempts < 2) { const e = new Error('busy'); e.code = 'EPERM'; throw e; }
    renameSync(from, to);
  };

  assert.equal(recordCheckout(sourceWithTemplate(), dir, { rename }).action, 'added');
  assert.match(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), /daftplate:checkout/);
});

test('recordCheckout creates ~/.claude/ when the directory itself is absent', () => {
  // Fresh machine. Every other test here uses emptyDir(), which already exists,
  // so without this case the mkdir is never exercised — and per D5 a public
  // export user may be the first code ever to touch .claude/.
  const parent = emptyDir();
  const claudeDir = join(parent, '.claude');          // deliberately not created
  assert.equal(recordCheckout(sourceWithTemplate(), claudeDir).action, 'created');
  assert.equal(existsSync(join(claudeDir, 'CLAUDE.md')), true);
});

test('recordCheckout reports gates missing from a file that has none, and does not inject them', () => {
  // D2: measured on this machine, ~/.claude/CLAUDE.md exists with ZERO of the
  // template's gates, so the seeding path never fires and this is the case that
  // actually applies in the field.
  const dir = emptyDir();
  const prose = '# My own notes\n\nNothing about gates here.\n';
  writeFileSync(join(dir, 'CLAUDE.md'), prose, 'utf8');

  const result = recordCheckout(sourceWithTemplate(), dir);

  assert.equal(result.action, 'added');
  assert.equal(result.gatesPresent, false);
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8').includes(GATES_SENTINEL), false);
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8').startsWith(prose), true);
});

test('recordCheckout reports gates present when the file carries the sentinel', () => {
  // The true half of the same report. Without it, gatesPresent could be hard-wired
  // to false and every other assertion here would still pass.
  const dir = emptyDir();
  writeFileSync(join(dir, 'CLAUDE.md'), `# Mine\n\n${GATES_SENTINEL}\n\n1. **No code before a failing test.**\n`, 'utf8');

  assert.equal(recordCheckout('X:/Projects/daftplate', dir).gatesPresent, true);
});

test('a block whose path line was edited away is rewritten in place and reported as updated', () => {
  // findCheckoutSpan returns ok with path: null here — the delimiters are sound, the
  // body is not. The region is daftplate's own by construction, so it is rewritten;
  // reporting that as 'added' would say a block was appended when one was replaced.
  const dir = emptyDir();
  writeFileSync(join(dir, 'CLAUDE.md'),
    `# gates\n\n${CHECKOUT_MARKER_OPEN}\nsomeone deleted the path line\n${CHECKOUT_MARKER_CLOSE}\n`, 'utf8');

  const result = recordCheckout('X:/Projects/daftplate', dir);
  const text = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');

  assert.equal(result.action, 'updated');
  assert.equal(result.previous, null);
  assert.match(text, /Local `daftplate` checkout/);
  assert.equal(text.match(/daftplate:checkout -->/g).length, 2, 'still exactly one block');
});

test('a malformed span in the template blames the template, not the file being created', () => {
  // The created path reads the span out of claude-md-global.md, so naming the target
  // sends the user to a file that does not exist yet.
  const source = makeRepo({
    'engineering-standards/claude-md-global.md': `# gates\n\n${CHECKOUT_MARKER_OPEN}\nno closing marker\n`,
  });

  const result = recordCheckout(source, emptyDir());

  assert.equal(result.action, 'refused');
  assert.match(result.reason, /claude-md-global\.md/);
});

test('recordCheckout honours --dry-run and writes nothing', () => {
  const dir = emptyDir();
  const result = recordCheckout(sourceWithTemplate(), dir, { dryRun: true });
  assert.equal(existsSync(join(dir, 'CLAUDE.md')), false);
  assert.equal(result.action, 'created');
});

test('recordCheckout leaves no temp file behind when the rename fails', () => {
  const dir = emptyDir();
  writeFileSync(join(dir, 'CLAUDE.md'), '# My gates\n', 'utf8');
  const rename = () => { const e = new Error('busy'); e.code = 'EPERM'; throw e; };

  recordCheckout(sourceWithTemplate(), dir, { rename });

  assert.deepEqual(readdirSync(dir), ['CLAUDE.md']);   // no daftplate debris
});

test('a non-EPERM rename error propagates rather than being retried into a refusal', () => {
  const dir = emptyDir();
  writeFileSync(join(dir, 'CLAUDE.md'), '# My gates\n', 'utf8');
  let attempts = 0;
  const rename = () => { attempts += 1; const e = new Error('no space'); e.code = 'ENOSPC'; throw e; };

  assert.throws(() => recordCheckout(sourceWithTemplate(), dir, { rename }), /no space/);
  assert.equal(attempts, 1);          // not retried — only EPERM is a contention signal
});

// --- main(): the install survives what it cannot do (D5, D8, task 1.2/1.2b) ---

test('main records the checkout even in an export with no skills/ directory', () => {
  // The public daftplate export withholds skills/ (ADR 0002) while shipping
  // scripts/ AND engineering-standards/, so this is the shape a stranger's
  // clone actually has.
  const source = sourceWithTemplate();      // has the template, has no skills/
  const dir = emptyDir();
  const lines = [];

  const code = main(['node', 'install-skills.mjs', '--target', join(dir, 'skills')],
    { cwd: source, sourceRoot: source, claudeDir: dir, log: (l) => lines.push(l), logError: (l) => lines.push(l) });

  assert.equal(code, 0);
  assert.match(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), /daftplate:checkout/);
  assert.equal(lines.some((l) => /no skills\/ directory/.test(l)), true);
});

test('--target does not relocate the global CLAUDE.md', () => {
  // main() derived the Claude dir as dirname(target) (install-skills.mjs:82, :88),
  // so `--target D:/scratch/skills` would write the marker to D:/scratch/CLAUDE.md —
  // a file no agent ever reads. --target relocates SKILLS; the global file is
  // machine-level and must not follow it.
  const source = makeRepo({ 'skills/demo/SKILL.md': '---\nname: demo\n---\nbody\n' });
  const home = emptyDir();
  const elsewhere = emptyDir();

  main(['node', 'install-skills.mjs', '--target', join(elsewhere, 'skills')],
    { cwd: source, sourceRoot: ROOT, claudeDir: home, log: () => {}, logError: () => {} });

  assert.equal(existsSync(join(home, 'CLAUDE.md')), true);
  assert.equal(existsSync(join(elsewhere, 'CLAUDE.md')), false);
});

test('main records the checkout containing the script, not the directory it was run from', () => {
  // D8: main() passed process.cwd() (install-skills.mjs:84, :88), so running this
  // script from inside another repo recorded THAT repo — and D6 would then
  // correctly call the record unresolvable while the real fault was the cwd.
  const elsewhere = makeRepo({ 'skills/demo/SKILL.md': '---\nname: demo\n---\nbody\n' });
  const home = emptyDir();

  main(['node', 'install-skills.mjs', '--target', join(home, 'skills')],
    { cwd: elsewhere, claudeDir: home, log: () => {}, logError: () => {} });

  const text = readFileSync(join(home, 'CLAUDE.md'), 'utf8');
  assert.equal(text.includes(elsewhere), false);
  assert.equal(text.includes(ROOT.replace(/[\\/]$/, '')), true);
});

test('--target with no directory after it refuses rather than installing somewhere else', () => {
  // It used to print "would install 15 skill(s) to undefined" and then die on an
  // uncaught TypeError from dirname(undefined). Ignoring the flag the way
  // resolveProfile ignores a valueless --profile is wrong here: a profile is
  // additive information, a target is where files get copied, and silently using
  // the default writes to a directory the user did not name.
  const home = emptyDir();
  const errs = [];

  const code = main(['node', 'install-skills.mjs', '--target'],
    { cwd: makeRepo({ 'skills/demo/SKILL.md': 'x\n' }), claudeDir: home, log: () => {}, logError: (l) => errs.push(l) });

  assert.equal(code, 1);
  assert.equal(errs.some((l) => /--target needs a directory/.test(l)), true);
  assert.deepEqual(readdirSync(home), [], 'nothing was installed and nothing was recorded');
});

test('--target followed by another flag is not read as a directory named --dry-run', () => {
  const home = emptyDir();
  const code = main(['node', 'install-skills.mjs', '--target', '--dry-run'],
    { cwd: makeRepo({ 'skills/demo/SKILL.md': 'x\n' }), claudeDir: home, log: () => {}, logError: () => {} });

  assert.equal(code, 1);
  assert.deepEqual(readdirSync(home), []);
});

test('a refused checkout is reported on stderr and does not fail the install', () => {
  // 1.2b: the skills genuinely installed, so reporting failure for work that
  // succeeded would be a false report. check-machine.mjs (phase 2) is what
  // notices the missing record.
  const dir = emptyDir();
  writeFileSync(join(dir, 'CLAUDE.md'), `${CHECKOUT_MARKER_OPEN}\nbroken\n`, 'utf8');
  const source = pluginSource({ 'skills/demo/SKILL.md': '---\nname: demo\n---\nbody\n' });
  const errs = [];

  const code = main(['node', 'install-skills.mjs', '--target', join(dir, 'skills')],
    { cwd: source, sourceRoot: source, claudeDir: dir, log: () => {}, logError: (l) => errs.push(l) });

  assert.equal(code, 0);
  assert.equal(errs.some((l) => /checkout NOT recorded/.test(l)), true);
  // Still installed, at the plugin path the 2026-09-02 amendment moved it to.
  assert.equal(existsSync(join(dir, 'skills', 'daftplate', 'skills', 'demo', 'SKILL.md')), true);
});

// --- task 1.3: the shipped template carries the slot ---

test('the global CLAUDE.md template carries the checkout marker so a hand-install has the slot', () => {
  const text = readFileSync(join(ROOT, 'engineering-standards', 'claude-md-global.md'), 'utf8');
  assert.equal(text.includes(CHECKOUT_MARKER_OPEN), true);
  assert.equal(text.includes(CHECKOUT_MARKER_CLOSE), true);
});

test('the gates sentinel resolves against the shipped template', () => {
  // gatesPresent is decided by one constant. If the template stops carrying it,
  // every install on earth reports gates missing — so the two are pinned together.
  const text = readFileSync(join(ROOT, 'engineering-standards', 'claude-md-global.md'), 'utf8');
  assert.equal(text.includes(GATES_SENTINEL), true);
});

// ---------------------------------------------------------------------------
// The shared atomic writer (Phase 3, Task 3.0). Lifted out of this file rather
// than reimplemented, so both callers get the same staging, mode, retry and
// cleanup rules. Its tests stay here because this is where it was paid for.
// ---------------------------------------------------------------------------

const eperm = () => Object.assign(new Error('busy'), { code: 'EPERM' });

test('writeAtomically supports an arbitrary target basename in its own directory', () => {
  const root = emptyDir();
  const target = join(root, '.daftplate.json');

  const refusal = writeAtomically(target, '{"schema":2}\n', { replace: false });

  assert.equal(refusal, null);
  assert.equal(readFileSync(target, 'utf8'), '{"schema":2}\n');
  assert.deepEqual(readdirSync(root), ['.daftplate.json']);
});

test('writeAtomically retries EPERM three times and never falls back to a plain write', () => {
  const root = emptyDir();
  const target = join(root, 'settings.json');
  writeFileSync(target, 'old\n', 'utf8');
  let attempts = 0;

  const refusal = writeAtomically(target, 'new\n', {
    rename: () => { attempts += 1; throw eperm(); },
  });

  assert.equal(attempts, 3);
  assert.match(refusal, /open in another process/i);
  assert.equal(readFileSync(target, 'utf8'), 'old\n');
  assert.deepEqual(readdirSync(root), ['settings.json']);
});

test('writeAtomically propagates non-EPERM rename errors after exact cleanup', () => {
  const root = emptyDir();
  const target = join(root, 'CLAUDE.md');

  assert.throws(
    () => writeAtomically(target, 'new\n', {
      rename: () => { throw Object.assign(new Error('cross-volume'), { code: 'EXDEV' }); },
    }),
    /cross-volume/,
  );
  assert.equal(existsSync(target), false);
  assert.deepEqual(readdirSync(root), []);
});

test('writeAtomically stages in a private directory, not beside the target', () => {
  // Pins the mkdtemp reason recorded where this routine used to live: two
  // concurrent writers to two different targets in one directory must not share
  // a staging path. A basename-derived temp name in the target directory would
  // reintroduce exactly that collision.
  const root = emptyDir();
  const seen = [];
  const capture = (from) => { seen.push(from); throw eperm(); };

  writeAtomically(join(root, 'a.json'), '{}\n', { rename: capture });
  writeAtomically(join(root, 'b.json'), '{}\n', { rename: capture });

  // Deduplicated because each write retries the publisher three times on EPERM,
  // so a staging path legitimately repeats within one write. The count is asserted
  // rather than only the uniqueness: on an implementation that never stages, seen
  // is empty and every other assertion here holds vacuously.
  const staged = [...new Set(seen)];
  assert.equal(staged.length, 2, 'two writes, two distinct staging paths');
  for (const from of staged) assert.notEqual(dirname(from), root);
  assert.deepEqual(readdirSync(root), []);
});

test('writeAtomically create-only mode refuses an existing final path', () => {
  const root = emptyDir();
  const target = join(root, '.daftplate.json');
  writeFileSync(target, 'winner\n', 'utf8');

  const refusal = writeAtomically(target, 'loser\n', { replace: false });

  assert.match(refusal, /already exists|appeared/i);
  assert.equal(readFileSync(target, 'utf8'), 'winner\n');
});

test('create-only publication refuses a target that appears after staging', () => {
  // The race a checked rename cannot observe: the rival lands between the
  // existence check and publication. The seam is the publisher itself, so
  // nothing passes by checking earlier.
  const root = emptyDir();
  const target = join(root, '.daftplate.json');

  const refusal = writeAtomically(target, '{"loser":true}\n', {
    replace: false,
    link: (from, to) => {
      writeFileSync(to, '{"winner":true}\n', 'utf8');   // rival wins the race
      linkSync(from, to);                               // must now throw EEXIST
    },
  });

  assert.match(refusal, /already exists|appeared/i);
  assert.equal(readFileSync(target, 'utf8'), '{"winner":true}\n');
  assert.deepEqual(readdirSync(root), ['.daftplate.json']);
});

test('create-only publication refuses rather than falling back without hard links', () => {
  const root = emptyDir();
  const target = join(root, '.daftplate.json');

  const refusal = writeAtomically(target, '{"schema":2}\n', {
    replace: false,
    link: () => { throw Object.assign(new Error('nope'), { code: 'ENOTSUP' }); },
  });

  assert.match(refusal, /hard link/i);
  assert.equal(existsSync(target), false);
  assert.deepEqual(readdirSync(root), []);
});

test('writeAtomically leaves no staging directory in the target, on every exit it has', () => {
  // #217 (FORGE-277). Every assertion above pins the residue guarantee as a side
  // effect of an exact-contents check on a directory that happened to be empty --
  // and between them they cover three of the four exits. The one they miss is the
  // one nearly every caller takes: a successful replace by rename, where the temp
  // file is carried out of staging by the rename itself and the only thing left to
  // remove is the directory. A cleanup that ran only when the temp file survived
  // would leak on that path alone and the whole suite stayed green under it.
  //
  // Scoped to the directory the call under test was given, because that is where
  // mkdtemp puts staging. Nothing here reads the process-wide temp root, so a
  // concurrent run leaving debris there cannot make this pass or fail.
  const root = emptyDir();
  const residue = () => readdirSync(root).filter((name) => name.startsWith('.daftplate-'));

  writeFileSync(join(root, 'settings.json'), 'old\n', 'utf8');
  assert.equal(writeAtomically(join(root, 'settings.json'), 'new\n'), null);
  assert.deepEqual(residue(), [], 'after a successful replace by rename');

  assert.equal(writeAtomically(join(root, '.daftplate.json'), '{}\n', { replace: false }), null);
  assert.deepEqual(residue(), [], 'after a successful create by hard link');

  assert.match(
    writeAtomically(join(root, 'settings.json'), 'newer\n', { rename: () => { throw eperm(); } }),
    /open in another process/i,
  );
  assert.deepEqual(residue(), [], 'after a publication that returned a refusal');

  assert.throws(
    () => writeAtomically(join(root, 'settings.json'), 'newer\n', {
      rename: () => { throw Object.assign(new Error('cross-volume'), { code: 'EXDEV' }); },
    }),
    /cross-volume/,
  );
  assert.deepEqual(residue(), [], 'after a publication that threw through the finally block');

  // The filter alone would be satisfied by an implementation that never staged, so
  // the contents are pinned exactly and the surviving bytes are the first write's.
  assert.deepEqual(readdirSync(root).sort(), ['.daftplate.json', 'settings.json']);
  assert.equal(readFileSync(join(root, 'settings.json'), 'utf8'), 'new\n');
});

// --- main(): every input comes from the checkout, not the invocation dir (#103) ---

test('main installs the skills and gate from the checkout, not the directory it was run from', () => {
  // Two independent mutations to kill: reverting installSkills()'s argument to cwd
  // installs the decoy, and reverting registerReportGate()'s argument installs the
  // wrong gate bytes. Both assertions are exact, so a null or empty result fails.
  const source = pluginSource({
    'engineering-standards/claude-md-global.md': '<!-- Install at ~/.claude/CLAUDE.md. -->\n\n3. **Never commit to `main`.**\n',
    'skills/from-checkout/SKILL.md': '---\nname: from-checkout\n---\nbody\n',
    'skills/crit/scripts/report-gate.mjs': '// the checkout gate\n',
  });
  const elsewhere = pluginSource({
    'skills/decoy/SKILL.md': '---\nname: decoy\n---\nbody\n',
    'skills/crit/scripts/report-gate.mjs': '// the decoy gate\n',
  });
  const home = emptyDir();

  main(['node', 'install-skills.mjs', '--target', join(home, 'skills')],
    { cwd: elsewhere, sourceRoot: source, claudeDir: home, log: () => {}, logError: () => {} });

  const tree = join(home, 'skills', 'daftplate', 'skills');
  assert.equal(existsSync(join(tree, 'from-checkout', 'SKILL.md')), true);
  assert.equal(existsSync(join(tree, 'decoy')), false);
  assert.equal(readFileSync(join(home, GATE_INSTALLED_NAME), 'utf8'), '// the checkout gate\n');

  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  const commands = settings.hooks.Stop.flatMap((g) => g.hooks).map((h) => h.command);
  assert.equal(commands.some((c) => c.includes(GATE_INSTALLED_NAME)), true);
  // The checkout recorded is the source fixture, not the invocation directory.
  assert.equal(readFileSync(join(home, 'CLAUDE.md'), 'utf8').includes(source), true);
  assert.equal(readFileSync(join(home, 'CLAUDE.md'), 'utf8').includes(elsewhere), false);
});

test('registerReportGate leaves the original settings intact when atomic publication is refused', () => {
  // #102: the write was a plain writeFileSync. settings.json holds every hook the
  // user has configured, so a torn write disables all of them AND leaves JSON the
  // parse-or-bail above then refuses to touch again.
  const original = `${JSON.stringify({
    model: 'opus',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node "C:/somebody/else.mjs"' }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: 'node "C:/a/guard.mjs"' }] }],
    },
  }, null, 2)}\n`;
  const home = makeRepo({ 'settings.json': original });
  const source = makeRepo({ 'skills/crit/scripts/report-gate.mjs': '// gate\n' });

  const result = registerReportGate(source, home, {
    rename: () => { const e = new Error('locked'); e.code = 'EPERM'; throw e; },
  });

  assert.equal(result.registered, false);
  assert.match(result.skipped, /is open in another process, so it was left untouched/);
  assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), original);
  assert.deepEqual(
    JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')),
    JSON.parse(original),
  );
  // No plain-write fallback slipped the hook in behind the refusal.
  assert.equal(readFileSync(join(home, 'settings.json'), 'utf8').includes(GATE_INSTALLED_NAME), false);
});

// --- the attribution gate, on PreToolUse(Bash) (#57) -------------------------

const gateSources = (extra = {}) => pluginSource({
  'skills/crit/scripts/report-gate.mjs': '// report gate\n',
  'scripts/attribution-gate.mjs': '// attribution gate\n',
  ...extra,
});

test('registerAttributionGate appends a Bash PreToolUse group without disturbing settings', () => {
  const existing = {
    model: 'opus',
    hooks: {
      PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node "C:/theirs.mjs"' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node "C:/also-theirs.mjs"' }] }],
    },
  };
  const home = makeRepo({ 'settings.json': `${JSON.stringify(existing, null, 2)}\n` });

  const result = registerAttributionGate(gateSources(), home);
  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));

  assert.equal(result.registered, true);
  assert.equal(readFileSync(join(home, ATTRIBUTION_GATE_INSTALLED_NAME), 'utf8'), '// attribution gate\n');
  assert.equal(settings.model, 'opus');
  // The user's own group keeps its place at the head, byte-semantically intact.
  assert.deepEqual(settings.hooks.PreToolUse[0], existing.hooks.PreToolUse[0]);
  assert.deepEqual(settings.hooks.Stop, existing.hooks.Stop);
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(settings.hooks.PreToolUse[1].matcher, 'Bash');
  assert.equal(
    settings.hooks.PreToolUse[1].hooks[0].command.includes(ATTRIBUTION_GATE_INSTALLED_NAME),
    true,
  );
});

test('registerAttributionGate is idempotent', () => {
  const home = emptyDir();
  const source = gateSources();

  assert.equal(registerAttributionGate(source, home).registered, true);
  const second = registerAttributionGate(source, home);

  assert.equal(second.registered, false);
  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  const mine = settings.hooks.PreToolUse
    .flatMap((g) => g.hooks)
    .filter((h) => h.command.includes(ATTRIBUTION_GATE_INSTALLED_NAME));
  assert.equal(mine.length, 1);
});

test('registerAttributionGate refuses malformed settings byte-for-byte, copying nothing', () => {
  // A gate on disk that no event references is debris, so the refusal happens
  // before the copy rather than after it.
  const broken = '{ "hooks": { "PreToolUse": [ }\n';
  const home = makeRepo({ 'settings.json': broken });

  const result = registerAttributionGate(gateSources(), home);

  assert.equal(result.registered, false);
  assert.match(result.skipped, /could not be parsed; nothing was changed/);
  assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), broken);
  assert.equal(existsSync(join(home, ATTRIBUTION_GATE_INSTALLED_NAME)), false);
});

test('main installs and registers both gates from the same checkout', () => {
  const source = gateSources({
    'engineering-standards/claude-md-global.md': '<!-- Install at ~/.claude/CLAUDE.md. -->\n\n3. **Never commit to `main`.**\n',
    'skills/real/SKILL.md': '---\nname: real\n---\nbody\n',
  });
  const elsewhere = makeRepo({
    'skills/crit/scripts/report-gate.mjs': '// decoy report gate\n',
    'scripts/attribution-gate.mjs': '// decoy attribution gate\n',
  });
  const home = emptyDir();

  main(['node', 'install-skills.mjs', '--target', join(home, 'skills')],
    { cwd: elsewhere, sourceRoot: source, claudeDir: home, log: () => {}, logError: () => {} });

  assert.equal(readFileSync(join(home, GATE_INSTALLED_NAME), 'utf8'), '// report gate\n');
  assert.equal(readFileSync(join(home, ATTRIBUTION_GATE_INSTALLED_NAME), 'utf8'), '// attribution gate\n');

  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  const on = (event) => settings.hooks[event].flatMap((g) => g.hooks).map((h) => h.command);
  // Two events, not one: registering both under a single event would pass a
  // presence check and fire the wrong gate at the wrong moment.
  assert.equal(on('Stop').some((c) => c.includes(GATE_INSTALLED_NAME)), true);
  assert.equal(on('PreToolUse').some((c) => c.includes(ATTRIBUTION_GATE_INSTALLED_NAME)), true);
  assert.equal(on('Stop').some((c) => c.includes(ATTRIBUTION_GATE_INSTALLED_NAME)), false);
});

// ---------------------------------------------------------------------------
// #273 (FORGE-334) — a CRLF SKILL.md silently stops being a skill
// ---------------------------------------------------------------------------

/** The same skill file an editor on this platform writes by default. Every line
 *  ending is CRLF, which is the only difference from `skillFile`. */
const crlfSkillFile = (name) => skillFile(name).replace(/\n/g, '\r\n');

test('#273 (FORGE-334) — a CRLF loose skill still shadows the plugin copy, and the report says so', () => {
  // The harm, at the surface that shows it. `declaredSkillName` gates
  // `shadowedLooseSkills`, which is what tells an owner that a loose directory is
  // still winning the bare name — "until these are gone /<name> still fires the
  // OLD copy and this install has not taken effect", in the code's own words.
  //
  // A CRLF-authored `SKILL.md` begins `---\r\n`, so the exact-LF `startsWith`
  // returned null, the directory was not recognised as a skill at all, and the
  // migration line never printed. Not an error, not a skip: silence, on the one
  // path whose whole job is to break that silence.
  //
  // Asserted through what the CLI prints rather than through the returned array,
  // because a shadow nobody was told about is a shadow that does not exist as far
  // as the owner is concerned.
  const source = pluginSource({ 'skills/orient/SKILL.md': skillFile('orient') });
  const home = emptyDir();
  const target = join(home, 'skills');
  mkdirSync(join(target, 'orient'), { recursive: true });
  writeFileSync(join(target, 'orient', 'SKILL.md'), crlfSkillFile('orient'), 'utf8');

  const errs = [];
  main(['node', 'install-skills.mjs', '--target', target],
    { cwd: source, sourceRoot: source, claudeDir: home, log: () => {}, logError: (l) => errs.push(l) });

  const text = errs.join('\n');
  assert.match(text, /migration required: 1 loose skill/,
    'a CRLF-authored loose skill was not recognised, so nothing told the owner it still wins the name');
  assert.match(text, /still fires the OLD copy/);
});

test('#273 (FORGE-334) — LF still resolves, and a file with no frontmatter still does not', () => {
  // AC 2 and AC 3. The fix must not buy CRLF by loosening what counts as
  // frontmatter: a file that simply has none is still not a skill, and a
  // directory holding one is not named in a removal command.
  const source = pluginSource({
    'skills/orient/SKILL.md': skillFile('orient'),
    'skills/handoff/SKILL.md': skillFile('handoff'),
    'skills/notaskill/SKILL.md': skillFile('notaskill'),
  });
  const home = emptyDir();
  const target = join(home, 'skills');

  // One LF loose skill, one CRLF loose skill, and one directory whose SKILL.md
  // carries no frontmatter at all.
  mkdirSync(join(target, 'orient'), { recursive: true });
  writeFileSync(join(target, 'orient', 'SKILL.md'), skillFile('orient'), 'utf8');
  mkdirSync(join(target, 'handoff'), { recursive: true });
  writeFileSync(join(target, 'handoff', 'SKILL.md'), crlfSkillFile('handoff'), 'utf8');
  mkdirSync(join(target, 'notaskill'), { recursive: true });
  writeFileSync(join(target, 'notaskill', 'SKILL.md'), 'no frontmatter here\nname: notaskill\n', 'utf8');

  const errs = [];
  main(['node', 'install-skills.mjs', '--target', target],
    { cwd: source, sourceRoot: source, claudeDir: home, log: () => {}, logError: (l) => errs.push(l) });

  const text = errs.join('\n');
  assert.match(text, /migration required: 2 loose skill/,
    'the LF and CRLF loose skills were not both counted');
  const removal = text.split('\n').find((l) => l.includes('rm -rf')) ?? '';
  assert.match(removal, /orient/);
  assert.match(removal, /handoff/);
  assert.doesNotMatch(removal, /notaskill/,
    'a directory whose SKILL.md has no frontmatter was put into a removal command');
});

test('#273 (FORGE-334) — a truncated frontmatter fence is still not a skill, in either ending', () => {
  // The open fence is what changed; the close is what stops a whole file being
  // read as frontmatter. Both endings are asserted, so a fix that made the opener
  // tolerant while leaving the closer exact-LF is visible here rather than in a
  // report nobody can explain.
  const source = pluginSource({ 'skills/orient/SKILL.md': skillFile('orient') });
  const home = emptyDir();
  const target = join(home, 'skills');
  mkdirSync(join(target, 'orient'), { recursive: true });
  writeFileSync(join(target, 'orient', 'SKILL.md'), '---\r\nname: orient\r\n', 'utf8');

  const errs = [];
  main(['node', 'install-skills.mjs', '--target', target],
    { cwd: source, sourceRoot: source, claudeDir: home, log: () => {}, logError: (l) => errs.push(l) });

  assert.doesNotMatch(errs.join('\n'), /migration required/,
    'a SKILL.md whose frontmatter never closes was accepted as a skill');
});

test('#273 (FORGE-334) — frontmatter must open the file, not merely appear in it', () => {
  // The anchor is load-bearing for more than tidiness: `declaredSkillName` takes
  // the opener's LENGTH as the slice base, which is only the same as its position
  // because the match is anchored at 0. Measured — with the `^` removed,
  // `x\n---\nname: orient\n---\n` resolves to `orient`, so a README with a
  // horizontal rule and a `name:` line below it becomes a skill and lands in a
  // removal command. That mutant survived until this test existed.
  const source = pluginSource({ 'skills/orient/SKILL.md': skillFile('orient') });
  const home = emptyDir();
  const target = join(home, 'skills');
  mkdirSync(join(target, 'orient'), { recursive: true });
  writeFileSync(join(target, 'orient', 'SKILL.md'), 'x\n---\nname: orient\n---\n', 'utf8');

  const errs = [];
  main(['node', 'install-skills.mjs', '--target', target],
    { cwd: source, sourceRoot: source, claudeDir: home, log: () => {}, logError: (l) => errs.push(l) });

  assert.doesNotMatch(errs.join('\n'), /migration required/,
    'frontmatter found below the first line was accepted, so any file with a rule in it is a skill');
});
