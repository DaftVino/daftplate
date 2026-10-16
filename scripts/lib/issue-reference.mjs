// How the agent fleet names an issue in the prose it generates (§6.5.1, ADR 0015).
//
// On a Linear-variant repo an issue is named by its Linear key, `<teamKey>-<M>`,
// read from the linkback comment Linear's sync posts on the GitHub issue. Until
// that comment exists the issue has no key, so it is named by its GitHub URL
// followed by `(pending Linear sync)`. On every other repo it is `#N`, exactly as
// before. The `Fixes #N` footer is not prose and never comes through here.
//
// One module for the three writers (the publisher, the invoker's report and the
// brief), because publish-run.mjs imports agent-invoke.mjs and the two could not
// share the rule any other way.
//
// The linkback parse is a second copy of skills/dress/scripts/board.mjs's
// `linearKeyFromComments`. It cannot be imported: `skills/` is withheld from the
// public export that ships `scripts/`. tests/board-parity.test.mjs holds the two
// to one answer.
//
// Never computes a key from the GitHub number. The two sequences drift.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { linearBoard, SHORT_NAME } from '../check-roadmap.mjs';

/** The author Linear's GitHub integration posts its linkback comment as. */
export const LINKBACK_AUTHOR = 'linear-code[bot]';

/** The context a repo with no Linear board gets: nothing to name but `#N`. */
const NOT_LINEAR = Object.freeze({ linear: false, teamKey: null, shortName: null, key: null, repo: null });

/** The Linear key from the linkback comment, or null. Only Linear's own bot is
 *  believed: a person pasting a board link names an issue, not necessarily this
 *  one's twin. `comments` is the REST shape, `user.login` and `body`. */
export function linkbackKey(comments, teamKey) {
  if (!Array.isArray(comments) || !teamKey) return null;
  const re = new RegExp(`linear\\.app/[^/\\s]+/issue/(${teamKey}-\\d+)\\b`);
  for (const c of comments) {
    if (c?.user?.login !== LINKBACK_AUTHOR) continue;
    const m = re.exec(c.body ?? '');
    if (m) return m[1];
  }
  return null;
}

/** What the repo's ROADMAP.md `Board:` line says, read with no network call. A
 *  Linear board counts only when its project link text is a slug and its team key
 *  parses, the same bar check-roadmap holds it to. */
export function boardContext(repoRoot) {
  const path = join(String(repoRoot ?? ''), 'ROADMAP.md');
  if (!repoRoot || !existsSync(path)) return NOT_LINEAR;
  const board = linearBoard(readFileSync(path, 'utf8'));
  if (!board?.teamKey || !board.shortName || !SHORT_NAME.test(board.shortName)) return NOT_LINEAR;
  return { linear: true, teamKey: board.teamKey, shortName: board.shortName, key: null, repo: null };
}

/**
 * The board, plus this issue's Linear key and the repository, read through the
 * caller's `gh(args, cwd) → { status, stdout }`. Read once per run, by the runner:
 * the publisher's `gh` is allowlisted to two commands and may not make these calls.
 * A `gh` failure leaves the key or repo null, which names the issue as pending
 * rather than failing a run over its own prose.
 */
export function linearContext(repoRoot, issueNumber, gh) {
  const ctx = boardContext(repoRoot);
  if (!ctx.linear || typeof gh !== 'function') return ctx;
  let repo = null;
  let key = null;
  try {
    const r = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], repoRoot);
    if (r?.status === 0) repo = String(r.stdout ?? '').trim() || null;
    const c = gh(['api', `repos/{owner}/{repo}/issues/${issueNumber}/comments`], repoRoot);
    if (c?.status === 0) key = linkbackKey(JSON.parse(c.stdout), ctx.teamKey);
  } catch {
    // Unreadable is pending, not fatal: see above.
  }
  return { ...ctx, key, repo };
}

/** The issue's name in generated prose: the key, the pending URL, or `#N`. */
export function issueReference(issue, ctx = null) {
  if (!ctx?.linear) return `#${issue}`;
  if (ctx.key) return ctx.key;
  return ctx.repo
    ? `https://github.com/${ctx.repo}/issues/${issue} (pending Linear sync)`
    : `issue ${issue} (pending Linear sync)`;
}
