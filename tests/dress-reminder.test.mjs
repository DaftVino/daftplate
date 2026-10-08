// scripts/dress-reminder.mjs — the PostToolUse(Bash) reminder that follows a
// `gh issue create` on a Linear-variant repo (repo-standards §6.5.1, ADR 0014).
//
// It is the only thing that reaches a bare `gh issue create` — freehand, or from
// gstack's /spec, which this repo does not own — so it is what makes dressing
// more than a CLAUDE.md sentence there. It reminds; it never blocks, and on a repo
// that is not on the Linear variant it says nothing at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reminderFor, linearShortName, repoRoot } from '../scripts/dress-reminder.mjs';
import { tempDir } from './helpers/make-repo.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'dress-reminder.mjs');
// Inline rather than read from tests/fixtures/: this test ships in the public
// export, which withholds that directory. The same two shapes the parity test's
// fixtures carry.
const LINEAR = [
  'Board: issues are created in GitHub and managed in Linear (ADR 0006) — the',
  '[daftplate](https://linear.app/x/project/daftplate-1) project,',
  'team `FORGE`.',
  '',
  '## Now',
  '',
].join('\n');
const GITHUB = ['Board: the GitHub Project for this repository.', '', '## Now', ''].join('\n');

const filed = (command, stdout = 'https://github.com/o/r/issues/380\n') => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  tool_response: { stdout, stderr: '', interrupted: false, isImage: false },
});

// --- the decision -------------------------------------------------------------

test('a gh issue create on a Linear board names the issue and the command to run', () => {
  const text = reminderFor(filed('gh issue create --title x --body-file b.md'), LINEAR);
  assert.match(text, /`\/dress 380`/);
  assert.match(text, /daftplate-380/, 'the reminder names the issue in the repo\'s own form');
});

test('a compound command still reminds, because the filter is not the decision', () => {
  // `cd x && gh issue create` may not match the `if` filter's prefix. The script's
  // own check is what holds whichever way the filter is configured.
  assert.notEqual(reminderFor(filed('cd repo && gh issue create --title x'), LINEAR), null);
});

test('with no issue URL in the output, nothing was filed, so it stays silent', () => {
  // Measured live on 2026-10-07: `gh issue create --help` fired the first version
  // of this hook, which announced an issue that did not exist.
  assert.equal(reminderFor(filed('gh issue create --help', 'Create an issue on GitHub.\n'), LINEAR), null);
  assert.equal(reminderFor(filed('gh issue create --title x', ''), LINEAR), null);
});

test('it is silent on a GitHub board, with no board, and with no roadmap', () => {
  assert.equal(reminderFor(filed('gh issue create'), GITHUB), null);
  assert.equal(reminderFor(filed('gh issue create'), '# Roadmap\n\n## Now\n'), null);
  assert.equal(reminderFor(filed('gh issue create'), null), null);
});

test('prose about filing an issue, in a heredoc or a quoted argument, is not a filing', () => {
  // Measured live on 2026-10-07: an evidence comment posted with
  // `gh issue comment 373 --body-file x.md`, whose heredoc body mentioned
  // `gh issue create`, started this hook (the `if` filter reads heredoc bodies),
  // and the comment URL then passed for an issue URL.
  const heredoc = [
    "cat > body.md <<'XEOF'",
    'It fires for `gh issue create` alone.',
    'XEOF',
    'gh issue comment 373 --body-file body.md',
  ].join('\n');
  const commentUrl = 'https://github.com/o/r/issues/373#issuecomment-1234567890\n';
  assert.equal(reminderFor(filed(heredoc, commentUrl), LINEAR), null);
  assert.equal(reminderFor(filed(heredoc, 'https://github.com/o/r/issues/373\n'), LINEAR), null, 'the heredoc body was matched');
  assert.equal(reminderFor(filed('git commit -m "run gh issue create next"'), LINEAR), null, 'a quoted argument was matched');
  // And a real filing after a heredoc still reminds.
  assert.notEqual(reminderFor(filed(`${heredoc}\ngh issue create --body-file body.md`), LINEAR), null);
});

test('only a bare issue URL on its own line counts as a filing', () => {
  assert.equal(reminderFor(filed('gh issue create', 'see https://github.com/o/r/issues/380 for it\n'), LINEAR), null);
  assert.equal(reminderFor(filed('gh issue create', 'https://github.com/o/r/issues/380#issuecomment-1\n'), LINEAR), null);
  assert.match(reminderFor(filed('gh issue create', 'Creating issue in o/r\n\nhttps://github.com/o/r/issues/380\n'), LINEAR), /\/dress 380/);
});

test('it is silent for anything that is not filing an issue', () => {
  for (const command of ['gh issue list', 'gh issue view 380', 'gh pr create --fill', 'echo gh issue', 'git commit -m "gh issue creates"']) {
    assert.equal(reminderFor(filed(command), LINEAR), null, `reminded for: ${command}`);
  }
  assert.equal(reminderFor({ ...filed('gh issue create'), tool_name: 'Write' }, LINEAR), null);
  assert.equal(reminderFor(undefined, LINEAR), null);
});

// --- the process: what the harness actually receives -------------------------

function run(payload, cwd) {
  return spawnSync(process.execPath, [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload), cwd, encoding: 'utf8',
  });
}

function repo(roadmap) {
  const dir = tempDir('dress-reminder-');
  mkdirSync(join(dir, '.git'));
  if (roadmap) writeFileSync(join(dir, 'ROADMAP.md'), roadmap);
  return dir;
}

test('on a Linear repo the hook emits PostToolUse additionalContext and exits 0', () => {
  const dir = repo(LINEAR);
  const out = run({ ...filed('gh issue create'), cwd: dir }, dir);
  assert.equal(out.status, 0);
  const json = JSON.parse(out.stdout);
  assert.equal(json.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(json.hookSpecificOutput.additionalContext, /\/dress 380/);
});

test('the hook finds the roadmap from the payload\'s cwd, even in a subdirectory', () => {
  // Plan review C2: a hook's cwd can be anywhere below the root.
  const dir = repo(LINEAR);
  const sub = join(dir, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  assert.equal(repoRoot(sub), dir);
  const out = run({ ...filed('gh issue create'), cwd: sub }, sub);
  assert.match(out.stdout, /additionalContext/);
});

test('on a GitHub repo, or a payload it cannot read, the hook prints nothing and exits 0', () => {
  const dir = repo(GITHUB);
  const gh = run({ ...filed('gh issue create'), cwd: dir }, dir);
  assert.equal(gh.status, 0);
  assert.equal(gh.stdout, '');
  const junk = run('{not json', dir);
  assert.equal(junk.status, 0, 'a hook must never fail the call it follows');
  assert.equal(junk.stdout, '');
});

test('linearShortName reads the same Board: line the other parsers do', () => {
  assert.equal(linearShortName(LINEAR), 'daftplate');
  assert.equal(linearShortName(GITHUB), null);
});
