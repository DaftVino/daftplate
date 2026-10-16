// How the agent fleet names an issue in generated prose (§6.5.1, ADR 0015).
// FORGE-504, plan Phase 4. The spec's three rows, plus the cases the rows
// imply: the board read with no network, and the key read through the runner's
// `gh` and never computed. The team is ACME so nothing passes only for FORGE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  issueReference, boardContext, linearContext, linkbackKey, LINKBACK_AUTHOR,
} from '../scripts/lib/issue-reference.mjs';
import { tempDir } from './helpers/make-repo.mjs';

const ACME_ROADMAP = [
  'Board: issues are created in GitHub and managed in Linear (ADR 0003) — the',
  '[acme](https://linear.app/acme-corp/project/acme-1) project, team `ACME`.',
  '',
  '## Now',
  '',
].join('\n');

function repoWith(roadmap) {
  const dir = tempDir('issue-ref-');
  if (roadmap !== null) writeFileSync(join(dir, 'ROADMAP.md'), roadmap);
  return dir;
}

const linkback = (key) => ({ user: { login: LINKBACK_AUTHOR }, body: `[${key}](https://linear.app/acme-corp/issue/${key}/t)` });

// --- the spec's three rows ---------------------------------------------------

test('row 1 — a Linear board with a key names the issue by the key alone', () => {
  assert.equal(issueReference(17, { linear: true, key: 'ACME-17', repo: 'acme-corp/widgets' }), 'ACME-17');
});

test('row 2 — a Linear board with no key yet names the issue by its URL, marked pending', () => {
  assert.equal(issueReference(17, { linear: true, key: null, repo: 'acme-corp/widgets' }),
    'https://github.com/acme-corp/widgets/issues/17 (pending Linear sync)');
  // With no repository either, still never a bare number.
  assert.equal(issueReference(17, { linear: true, key: null, repo: null }), 'issue 17 (pending Linear sync)');
});

test('row 3 — off a Linear board it is #N, and a key is ignored', () => {
  assert.equal(issueReference(17), '#17');
  assert.equal(issueReference(17, { linear: false, key: 'ACME-17', repo: 'acme-corp/widgets' }), '#17');
});

// --- where the context comes from ---------------------------------------------

test('boardContext reads a Linear board, and only one with a slug and a team key', () => {
  assert.deepEqual(boardContext(repoWith(ACME_ROADMAP)),
    { linear: true, teamKey: 'ACME', shortName: 'acme', key: null, repo: null });
  for (const roadmap of [
    'Board: the GitHub Project for this repository.\n',
    ACME_ROADMAP.replace('[acme]', '[Acme Corp]'),
    ACME_ROADMAP.replace(', team `ACME`', ''),
    null,
  ]) {
    assert.equal(boardContext(repoWith(roadmap)).linear, false, String(roadmap).slice(0, 40));
  }
});

test('linearContext reads the key from the bot linkback, never from the number', () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'repo') return { status: 0, stdout: 'acme-corp/widgets\n' };
    return { status: 0, stdout: JSON.stringify([
      { user: { login: 'someone' }, body: 'https://linear.app/acme-corp/issue/ACME-99/x' },
      linkback('ACME-512'),
    ]) };
  };
  const ctx = linearContext(repoWith(ACME_ROADMAP), 17, gh);
  assert.equal(ctx.key, 'ACME-512', 'a person\'s link was believed, or the number was used');
  assert.equal(ctx.repo, 'acme-corp/widgets');
  assert.ok(calls.includes('api repos/{owner}/{repo}/issues/17/comments'));
});

test('linearContext with gh failing leaves the issue pending, and does not throw', () => {
  const failing = () => ({ status: 1, stdout: '' });
  const ctx = linearContext(repoWith(ACME_ROADMAP), 17, failing);
  assert.equal(ctx.linear, true);
  assert.equal(ctx.key, null);
  assert.equal(issueReference(17, ctx), 'issue 17 (pending Linear sync)');
  const throwing = () => { throw new Error('gh not found'); };
  assert.equal(linearContext(repoWith(ACME_ROADMAP), 17, throwing).key, null);
});

test('linearContext off a Linear board makes no gh call at all', () => {
  // Counted rather than thrown: a throw would be swallowed as "gh failed".
  const calls = [];
  const gh = (args) => { calls.push(args.join(' ')); return { status: 0, stdout: '[]' }; };
  assert.equal(linearContext(repoWith('Board: the GitHub Project for this repository.\n'), 17, gh).linear, false);
  assert.equal(linearContext(repoWith(null), 17, gh).linear, false);
  assert.deepEqual(calls, [], 'a gh call was made for a repo with no Linear board');
});

test('linkbackKey takes the board\'s team key, so another team\'s key is not this issue\'s', () => {
  assert.equal(linkbackKey([linkback('ACME-5')], 'ACME'), 'ACME-5');
  assert.equal(linkbackKey([linkback('ACME-5')], 'LIN'), null);
});
