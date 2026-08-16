import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import { installSkills, registerReportGate, recordCheckout, GATES_SENTINEL, main } from '../scripts/install-skills.mjs';
// The marker vocabulary is imported from the lib rather than re-exported through the
// script: task 1.0 extracted it precisely so the writer, the checker and the tests read
// one definition.
import { CHECKOUT_MARKER_OPEN, CHECKOUT_MARKER_CLOSE } from '../scripts/lib/checkout-marker.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

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
  const source = makeRepo({ 'skills/demo/SKILL.md': '---\nname: demo\n---\nbody\n' });
  const errs = [];

  const code = main(['node', 'install-skills.mjs', '--target', join(dir, 'skills')],
    { cwd: source, sourceRoot: source, claudeDir: dir, log: () => {}, logError: (l) => errs.push(l) });

  assert.equal(code, 0);
  assert.equal(errs.some((l) => /checkout NOT recorded/.test(l)), true);
  assert.equal(existsSync(join(dir, 'skills', 'demo', 'SKILL.md')), true);  // skills still installed
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
