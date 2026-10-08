// The generation step of the delegated-fix loop: how the agent is invoked, what
// it is allowed to be invoked with, and what it is allowed to reach while it runs.
//
// Phase 3 of docs/designs/2026-08-27-plan-delegated-fix-loop.md, for #193 (FORGE-259).
// It invokes an agent inside a worktree Phase 2 created. It publishes nothing —
// that is Phase 4 — and it does not enable the feature: ADR 0008's Consequences
// gate enablement on an owner-held act, and nothing here performs one.
//
// Two things carry this file.
//
// **The isolation is a git and `gh` configuration, not an environment scrubbed of
// GitHub variables.** The plan first said "an environment scrubbed of every
// GitHub credential" and Phase 1 measured that wrong:
// docs/designs/relay-probes/results-2026-08-27-publication-boundary.md, P2-iso.
// Re-measured 2026-08-27 from this repository, every GitHub variable removed from
// the environment and nothing else changed, `git ls-remote origin` listed refs.
// The credential does not arrive through the environment at all — it arrives
// through `~/.gitconfig`'s URL-scoped `credential.https://github.com.helper`,
// which shells out to `gh`, and through the system config's Git Credential
// Manager. A run isolated the naive way pushes `main` successfully while its
// operator believes it holds no credential. So the boundary is
// `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` pointed at a file this module wrote
// (P2-iso-b) plus a redirected `GH_CONFIG_DIR` (P3b). The environment edits below
// are declared defence in depth and are never counted as the boundary.
//
// **And no configuration is trusted to have worked.** `verifyIsolation` makes a
// live authenticated call and requires a refusal, with a control proving the same
// call authenticates ambiently — because a refusal on a machine with no network
// is not evidence of anything. Repository-local config is read after the global
// file this module writes, so a local helper would still apply and no assertion
// over the environment or over this module's own output would see it. The live
// call is the only check that does.
//
// **Both mechanisms are asked, every run.** Until `#304 (FORGE-350)` only the
// `git` half was: `git ls-remote` exercises the config redirect and nothing
// exercised `GH_CONFIG_DIR`, so that half rested on one measurement taken at P3b
// on 2026-08-27 plus the belief the redirect was still applied. The asymmetry was
// invisible at the call site and it was the wrong way round — `gh` is the half
// reaching the outbound publication capability — and a regression that dropped
// the redirect left every test green. `verifyIsolation` now runs both halves and
// names which one failed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute, normalize } from 'node:path';
import {
  runsRoot, agentRoot, assertRunIdAgent, containedIn, OUTCOME_REPORTED,
} from './worktree.mjs';

/** The one permission mode ADR 0008 row 1 permits an unattended run. Not a
 *  parameter: a mode a caller can choose is a mode a caller can choose wrong. */
export const PERMISSION_MODE = 'acceptEdits';

/** The strings ADR 0008 row 1 forbids, held here as needles for the refusal below
 *  and appearing nowhere else in this file. Row 1 is a rule with an audit trail
 *  behind it and not a mechanism — the ADR says so — so `assertInvocationSafe` is
 *  what makes a violation legible rather than deniable. */
export const FORBIDDEN_FLAGS = ['--dangerously-skip-permissions'];
export const FORBIDDEN_MODES = ['bypassPermissions'];

/**
 * GitHub variables removed from the run's environment.
 *
 * **Defence in depth, and never the boundary** — the spec's own idiom (D1, *The
 * residue*), kept in the name so a later reader cannot mistake the register.
 * Every one of these was already absent in the P2 re-measurement that
 * authenticated anyway.
 *
 * They are unset rather than set to an unusable value. The spec offers poisoning
 * `GH_TOKEN` as defence in depth and this declines it for a reason worth
 * recording: an unset variable and a poisoned one are equally bypassable by a run
 * that means to bypass them, and a poisoned one makes every refusal read as *bad
 * credentials*, which an operator cannot tell from a real credential that has
 * expired. An absent credential says what it is.
 */
export const DEFENCE_IN_DEPTH_UNSET = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
  'GIT_ASKPASS', 'SSH_ASKPASS', 'GH_HOST',
];

/** Refusal reasons, exported so a caller branches on one rather than on prose. */
export const INVOKE_REFUSALS = {
  NO_ISSUE_BODY: 'no-issue-body',
  NO_ACCEPTANCE_CRITERIA: 'no-acceptance-criteria',
  DOCUMENT_MISSING: 'named-document-missing',
  DOCUMENT_OUTSIDE_WORKTREE: 'named-document-outside-worktree',
  DOCUMENT_HAS_NO_CRITERIA: 'named-document-has-no-criteria',
  NOT_ISOLATED: 'isolation-refused',
  ISOLATION_INCONCLUSIVE: 'isolation-inconclusive',
  ANONYMOUS_REMOTE: 'isolation-anonymous-remote',
  // The `gh` half gets its own two rather than sharing the `git` half's, so an
  // operator learns *which* mechanism failed instead of being told the run holds
  // a credential and left to guess where it arrives from. `#304 (FORGE-350)`.
  GH_NOT_ISOLATED: 'isolation-gh-refused',
  GH_INCONCLUSIVE: 'isolation-gh-inconclusive',
};

// ---------------------------------------------------------------------------
// The invocation guard — ADR 0008 rows 1 and 2, asserted over argv
// ---------------------------------------------------------------------------

/**
 * Refuse an argv that disables the working-directory boundary.
 *
 * Every element is scanned, the prompt included. A prompt is an argv element like
 * any other, and a prompt naming the flag is a run asking the agent to pass it —
 * which under `acceptEdits`, where Bash is auto-accepted, it can. The false
 * positive is a prompt that discusses the flag; refusing that is the safe
 * direction and is pinned by a test rather than left to be discovered.
 *
 * It also pins the two positive halves of rows 1 and 2, because "no bypass flag"
 * is satisfied by an argv with no permission mode at all: exactly one
 * `--permission-mode`, whose value is `acceptEdits`, and no `--add-dir`.
 */
export function assertInvocationSafe(argv) {
  const args = [...argv].map(String);
  const needles = [...FORBIDDEN_FLAGS, ...FORBIDDEN_MODES];
  for (const arg of args) {
    for (const needle of needles) {
      if (arg.toLowerCase().includes(needle.toLowerCase())) {
        throw new Error(
          `refused: an unattended run may never carry ${needle} (ADR 0008 row 1) — found in ${JSON.stringify(arg)}`,
        );
      }
    }
    if (arg === '--add-dir' || arg.startsWith('--add-dir=')) {
      throw new Error('refused: --add-dir widens the boundary ADR 0008 row 2 sets by choosing cwd');
    }
  }
  const modes = args.reduce((at, arg, i) => {
    if (arg === '--permission-mode') return [...at, args[i + 1]];
    if (arg.startsWith('--permission-mode=')) return [...at, arg.slice('--permission-mode='.length)];
    return at;
  }, []);
  if (modes.length !== 1) {
    throw new Error(`refused: expected exactly one --permission-mode, found ${modes.length}`);
  }
  if (modes[0] !== PERMISSION_MODE) {
    throw new Error(`refused: --permission-mode must be ${PERMISSION_MODE} (ADR 0008 row 1), not ${modes[0]}`);
  }
  return args;
}

/**
 * The argv and options an unattended run is invoked with.
 *
 * `--permission-mode acceptEdits`, the worktree as `cwd`, and no `--add-dir`
 * (ADR 0008 rows 1, 2 and 10). `extraArgs` exists so a caller — Phase 5's
 * `--settings` and `--agent` surface, named in the plan — has a seam, and so the
 * guard has something to refuse; it is passed through `assertInvocationSafe` with
 * everything else rather than trusted.
 */
export function buildInvocation({ worktree, prompt, env, extraArgs = [] }) {
  if (!worktree) throw new Error('refused: an unattended run needs its own worktree as cwd (ADR 0008 row 10)');
  const args = [
    '--print',
    '--permission-mode', PERMISSION_MODE,
    ...extraArgs.map(String),
    String(prompt ?? ''),
  ];
  assertInvocationSafe(args);
  return { command: 'claude', args, options: { cwd: worktree, env } };
}

/** The default agent runner. Injected as `opts.spawn`, the way worktree.mjs takes
 *  `opts.git`, so a test observes the argv that was really handed to the spawn
 *  rather than the argv some code said it would build. */
function defaultSpawn(command, args, options) {
  const r = spawnSync(command, args, { ...options, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/** Spawn the agent. The guard runs here too, and not only in `buildInvocation`,
 *  because an invocation object is a plain object and anything may have edited it
 *  between the two. This is the last line before the process exists. */
export function spawnAgent(invocation, opts = {}) {
  assertInvocationSafe(invocation.args);
  const spawn = opts.spawn ?? defaultSpawn;
  return spawn(invocation.command, invocation.args, invocation.options);
}

// ---------------------------------------------------------------------------
// The isolation — a git and gh configuration
// ---------------------------------------------------------------------------

/** Where a run's isolated configuration lives: beside the worktree under the runs
 *  root, never inside it. Inside, the agent could edit it — `acceptEdits` writes
 *  freely within `cwd` — and could then commit it. */
export function isolationPaths(repoRoot, runId, opts = {}) {
  assertRunIdAgent(runId, opts);
  const dir = join(agentRoot(repoRoot, opts), 'isolation', runId);
  return { dir, gitconfig: join(dir, 'gitconfig'), ghConfigDir: join(dir, 'gh'), empty: join(dir, 'empty') };
}

function gitOf(opts) {
  return opts.git ?? ((args, cwd) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  });
}

/**
 * Write the run's isolated git and `gh` configuration and return its paths.
 *
 * The isolated global config carries the ambient `user.name` and `user.email` and
 * nothing else. Copying the identity is the spec's decision, not this module's —
 * D1 adopted a construction with **no separate identity** — and it is needed
 * because a global config with no `user.*` makes every commit in the worktree
 * fail, which would look like the fixer being broken rather than isolated.
 *
 * It carries no credential helper. `credential.helper =` is written empty anyway,
 * as a declaration a reader of the file can see; it is not what does the work,
 * because with the system config pointed at an empty file there is no helper list
 * left to reset.
 */
export function writeIsolation({ repoRoot, runId }, opts = {}) {
  const paths = isolationPaths(repoRoot, runId, opts);
  mkdirSync(paths.dir, { recursive: true });
  mkdirSync(paths.ghConfigDir, { recursive: true });
  writeFileSync(paths.empty, '', 'utf8');

  const git = gitOf(opts);
  const read = (key) => {
    const r = git(['-C', resolve(repoRoot), 'config', '--get', key]);
    return r.status === 0 ? r.stdout.trim() : '';
  };
  const name = opts.identity?.name ?? read('user.name');
  const email = opts.identity?.email ?? read('user.email');

  const lines = [
    `# Written by scripts/lib/agent-invoke.mjs for run ${runId}. Not a user file.`,
    '# It carries an identity and no credential: the run publishes nothing (D1).',
    '[user]',
    ...(name ? [`\tname = ${name}`] : []),
    ...(email ? [`\temail = ${email}`] : []),
    '[credential]',
    '\thelper =',
    '',
  ];
  writeFileSync(paths.gitconfig, lines.join('\n'), 'utf8');
  return { ...paths, identity: { name, email } };
}

/**
 * The environment an isolated run is spawned with.
 *
 * The two lines that are the boundary are `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`
 * and `GH_CONFIG_DIR`. Everything else is either prompt suppression — so a
 * refusal is a refusal rather than a hang against a credential dialog — or the
 * defence-in-depth unset, which Phase 1 measured insufficient on its own.
 *
 * P2-iso-a's construction — `-c credential.helper= -c credential.https://…helper=`
 * — is deliberately not used, and the reason is a fact about what is being
 * isolated. `-c` binds one `git` invocation. The thing isolated here is a *child
 * agent* that runs its own git commands, and no flag on the spawn reaches those.
 * Only configuration carried in the environment generalizes to a process that has
 * not been written yet, which is what P2-iso-b is.
 */
export function isolatedEnv(paths, base = process.env) {
  const env = { ...base };
  for (const key of DEFENCE_IN_DEPTH_UNSET) delete env[key];
  env.GIT_CONFIG_GLOBAL = paths.gitconfig;
  env.GIT_CONFIG_SYSTEM = paths.empty;
  env.GH_CONFIG_DIR = paths.ghConfigDir;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  return env;
}

/** How a live call's outcome reads. Ordered so a network failure is never
 *  mistaken for an authentication refusal: on a machine with no route to GitHub
 *  every call fails, and counting that as isolation would pass this module's
 *  central assertion on a disconnected laptop. */
const NETWORK_FAILURE = /could not resolve host|failed to connect|connection (refused|timed out|reset)|network is unreachable|timed out/i;
const AUTH_REFUSAL = /could not read username|authentication failed|invalid username or password|terminal prompts disabled|not logged (in)?to any github|gh auth login|no credential|401|bad credentials/i;

/**
 * Anything token-shaped, replaced before a live call's output is kept.
 *
 * `gh auth status` prints its token already masked — measured on `gh` 2.96.0,
 * `Token: gho_****…` — and `gh auth token`, which prints it whole, is never
 * called here. `git` is different: an `unable to access` failure repeats its
 * remote URL verbatim, including a credential embedded in that URL. Neither
 * detail has a path out of the isolation verdict today: `closeRunRecord` reads
 * only `generation?.agent?.status`, while `formatUnderspecifiedReport` receives
 * the refusal `reason`, not a call's `detail`. This therefore closes the same
 * future hazard `#304 (FORGE-350)` meant to close, not a leak that is currently
 * persisted or published.
 *
 * The replacement belongs in `classifyLiveCall`, the one function that turns
 * child output into retained detail. Putting it in an individual probe instead
 * leaves its symmetric neighbor — or a third probe added later — dependent on a
 * caller remembering an invariant the classifier can hold once for all of them.
 */
const TOKEN_SHAPED = /gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}/g;
export function redactTokens(text) {
  return String(text ?? '').replace(TOKEN_SHAPED, '[redacted]');
}

export function classifyLiveCall({ status, stdout = '', stderr = '' }) {
  if (status === 0) return { verdict: 'authenticated' };
  const text = redactTokens(`${stderr}\n${stdout}`);
  if (NETWORK_FAILURE.test(text)) return { verdict: 'inconclusive', detail: text.trim().slice(0, 300) };
  if (AUTH_REFUSAL.test(text)) return { verdict: 'refused', detail: text.trim().slice(0, 300) };
  return { verdict: 'inconclusive', detail: text.trim().slice(0, 300) };
}

/**
 * Is this remote readable without any credential at all?
 *
 * Asked with the **ambient** credential, which the runner holds and the run does
 * not, because it is a question about the repository rather than about the run.
 */
function defaultRemoteVisibility(cwd) {
  const r = spawnSync('gh', ['repo', 'view', '--json', 'isPrivate', '-q', '.isPrivate'], {
    cwd, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  if (r.status !== 0) return 'unknown';
  const answer = (r.stdout ?? '').trim();
  if (answer === 'true') return 'private';
  if (answer === 'false') return 'public';
  return 'unknown';
}

/**
 * The `git` half: is the run's own configuration refused by the remote?
 *
 * `git ls-remote` reads and writes nothing, and it is the call Phase 1 measured.
 * The **control** is the same call under the ambient environment: if that does
 * not authenticate, this machine cannot tell isolation from a broken network, and
 * the standing is `inconclusive` rather than a pass. An assertion that treats
 * every failure as a refusal is the assertion that would have passed while the
 * run could still push `main`, one layer up from the environment mistake Phase 1
 * caught.
 *
 * **`ls-remote` is evidence only against a remote that is not readable
 * anonymously**, and this is the second way the check could quietly prove
 * nothing. Phase 1 measured a private repository, where a successful read means a
 * credential was used. Against a public one — which the daftplate export itself
 * is — the same read succeeds for every process on earth, so its success is not a
 * leak and its refusal would not be isolation. That case stands as `unsettled`
 * rather than certified or raised as an alarm: the honest answer is that this
 * call cannot settle the question here.
 */
function verifyGitHalf({ cwd, env, remote, timeout }, opts) {
  const call = opts.lsRemote ?? ((useEnv) => {
    const r = spawnSync('git', ['ls-remote', '--heads', remote], {
      cwd, env: useEnv, encoding: 'utf8', timeout, windowsHide: true,
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  });

  const control = classifyLiveCall(call(opts.controlEnv ?? process.env));
  if (control.verdict !== 'authenticated') {
    return {
      standing: 'inconclusive', control,
      message: 'the control `git ls-remote` did not authenticate, so a refusal here proves nothing',
    };
  }
  const isolated = classifyLiveCall(call(env));
  if (isolated.verdict === 'refused') return { standing: 'isolated', control, call: isolated };
  if (isolated.verdict === 'authenticated') {
    const visibility = (opts.remoteVisibility ?? defaultRemoteVisibility)(cwd);
    if (visibility === 'public') {
      return {
        standing: 'unsettled', control, call: isolated, visibility,
        message: 'this remote is readable without a credential, so ls-remote cannot tell isolation from anonymity here',
      };
    }
    return {
      standing: 'leaking', control, call: isolated, visibility,
      message: 'the run authenticated against the remote — it holds a credential and must not be invoked',
    };
  }
  return {
    standing: 'inconclusive', control, call: isolated,
    message: 'the isolated `git ls-remote` failed for a reason that is not an authentication refusal',
  };
}

/**
 * The `gh` half: is the run's redirected `GH_CONFIG_DIR` actually unauthenticated?
 *
 * Nothing asked this at runtime until `#304 (FORGE-350)`. The `gh` half rested on
 * one measurement taken at P3b on 2026-08-27 plus the belief that the redirect was
 * still applied, while the `git` half was re-proved every run — an asymmetry that
 * was invisible at the call site, and the wrong way round: `gh` is the half that
 * reaches the outbound publication capability, since `gh gist create <path>` puts
 * file contents on `gist.github.com` with no branch, no push and no pull request.
 * A regression that dropped or misspelled `GH_CONFIG_DIR` left every test green,
 * because `ls-remote` is refused by the git config isolation regardless and
 * nothing else asked.
 *
 * `gh auth status` is read-only, prints no unmasked secret, and distinguishes
 * authenticated from not by exit status. **`gh auth token` is never called**: it
 * prints the credential whole, and a probe that reads a token to prove a token is
 * absent is a probe that has to be trusted with the thing it is checking for.
 *
 * The control is the same call under the ambient environment, for the `git` half's
 * reason and one more of its own: on a machine with no `gh` on `PATH` the isolated
 * call fails for every run, and counting that as isolation would certify a
 * redirect nobody applied. That is `inconclusive`, not a pass.
 *
 * **The `anonymous-remote` escape hatch has no analogue here and is deliberately
 * not copied across.** `ls-remote` needs it because a public remote answers
 * everyone; `gh auth status` reads the local configuration and does not depend on
 * repository visibility at all, so there is no third outcome to report.
 */
function verifyGhHalf({ cwd, env, timeout }, opts) {
  const call = opts.ghAuth ?? ((useEnv) => {
    const r = spawnSync('gh', ['auth', 'status'], {
      cwd, env: useEnv, encoding: 'utf8', timeout, windowsHide: true,
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  });
  const classify = (useEnv) => classifyLiveCall(call(useEnv));

  const control = classify(opts.controlEnv ?? process.env);
  if (control.verdict !== 'authenticated') {
    return {
      standing: 'inconclusive', control,
      message: 'the control `gh auth status` did not authenticate, so a refusal here proves nothing',
    };
  }
  const isolated = classify(env);
  if (isolated.verdict === 'refused') return { standing: 'isolated', control, call: isolated };
  if (isolated.verdict === 'authenticated') {
    return {
      standing: 'leaking', control, call: isolated,
      message: 'the run\'s `gh` is logged in — GH_CONFIG_DIR is not redirecting and the run reaches `gh gist create`',
    };
  }
  return {
    standing: 'inconclusive', control, call: isolated,
    message: 'the isolated `gh auth status` failed for a reason that is not an authentication refusal',
  };
}

/**
 * Make a live authenticated call from the run's own configuration for **each**
 * half of the isolation and require both to be refused. AC 4, and the assertion
 * the plan says may not be softened.
 *
 * **The isolation is two mechanisms and this asks both, every time.** Short
 * circuiting on the `git` half would be the smaller change and every existing
 * test would keep passing untouched, but on a checkout whose remote answers
 * anonymously the `git` half settles nothing — so the run would be refused
 * `anonymous-remote` having never asked the `gh` question, and an operator would
 * learn nothing about the half that actually reaches publication. Both halves run;
 * neither result is discarded; `ok` requires both to stand `isolated`.
 *
 * **The refusal names which half failed**, in `half` and in the reason itself,
 * because an operator told only *the run holds a credential* is not told where it
 * comes from and cannot go and look. When both halves fail the `gh` half is
 * reported, for the reason it is checked at all: it is the one reaching the
 * outbound publication capability. Both standings are returned either way.
 */
export function verifyIsolation({ cwd, env, remote = 'origin', timeout = 45_000 }, opts = {}) {
  const git = verifyGitHalf({ cwd, env, remote, timeout }, opts);
  const gh = verifyGhHalf({ cwd, env, timeout }, opts);
  const halves = { git, gh };

  if (git.standing === 'isolated' && gh.standing === 'isolated') {
    return {
      ok: true, isolated: true, ...halves,
      // Kept under their Phase 3 names as well: `runGeneration` and the run
      // records written since then read these, and a rename here would be a
      // second change riding on a fix.
      control: git.control, isolated_call: git.call,
    };
  }

  // Severity, not call order. An alarm outranks a question, and between two
  // alarms the publication half is the one named.
  const refusal = [
    gh.standing === 'leaking' && [INVOKE_REFUSALS.GH_NOT_ISOLATED, 'gh', gh],
    git.standing === 'leaking' && [INVOKE_REFUSALS.NOT_ISOLATED, 'git', git],
    gh.standing === 'inconclusive' && [INVOKE_REFUSALS.GH_INCONCLUSIVE, 'gh', gh],
    git.standing === 'unsettled' && [INVOKE_REFUSALS.ANONYMOUS_REMOTE, 'git', git],
    git.standing === 'inconclusive' && [INVOKE_REFUSALS.ISOLATION_INCONCLUSIVE, 'git', git],
  ].find(Boolean);
  const [reason, half, failed] = refusal;

  return {
    ok: false, isolated: false, reason, half, ...halves,
    ...(failed.visibility ? { visibility: failed.visibility } : {}),
    message: failed.message,
    control: git.control, isolated_call: git.call,
  };
}

// ---------------------------------------------------------------------------
// Step 3 — sourcing the acceptance criteria, and failing closed
// ---------------------------------------------------------------------------

const HEADING = /^\s{0,3}(?:#{1,6}\s*|\*\*)acceptance criteria\b/i;
// #194 (FORGE-260) D7. This must close on every shape `HEADING` opens on. It
// closed on `#` only, and the asymmetry was the whole bug: a criteria list
// running into `**Out of scope**` never terminated, so the out-of-scope bullets
// were handed to `agent-brief.mjs` and became an unattended run's instructions.
//
// A heading is a line that OPENS with the marker. `- **the thing** stops working`
// opens with the bullet, so an emphatic criterion is still a criterion — the
// over-match that would otherwise silently shorten every emphatic list, which is
// a quieter failure than the one being fixed.
const NEXT_HEADING = /^\s{0,3}(?:#{1,6}\s|\*\*)/;
const ITEM = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.+?)\s*$/;
const DOCUMENT = /(?:^|[\s`(<])((?:[\w.-]+\/)*[\w.-]+\.md)(?=[\s`)>,.;]|$)/g;

/** The list items under an `Acceptance criteria` heading, or []. Fenced regions
 *  are skipped: a fence in an issue body is quoted material, and a criteria list
 *  inside one is an example of a list rather than this issue's list. */
export function extractCriteria(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const criteria = [];
  let fenced = false;
  let inSection = false;
  for (const line of lines) {
    if (/^\s{0,3}(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (HEADING.test(line)) { inSection = true; continue; }
    if (!inSection) continue;
    if (NEXT_HEADING.test(line)) break;
    const item = line.match(ITEM);
    if (item) { criteria.push(item[1]); continue; }

    // **A wrapped criterion is one criterion.** This used to keep the first line and
    // drop the rest, so every criterion that wrapped reached the run cut off
    // mid-clause — `#320 (FORGE-358)`, reported by a run about its own brief after
    // five runs were briefed on half-sentences and none refused, because from inside
    // the run the list looked complete.
    //
    // A continuation is an indented, non-empty line following an item. The three ends
    // are already above: the next item, the next heading, and the section's end. A
    // blank line ends it too — the alternative, joining across blanks, swallows the
    // prose that follows a list, and briefing a run on words nobody wrote as a
    // criterion is worse than truncating one.
    //
    // Indentation is what distinguishes a continuation from a flush-left paragraph
    // that merely follows. Markdown requires it for a lazy continuation to belong to
    // the item, and so does this.
    // Nothing to continue, a blank line, or a flush-left line: not a continuation.
    // A blank is skipped rather than ending the section, so an item written as two
    // indented paragraphs stays one criterion.
    if (!criteria.length || !line.trim() || !/^\s/.test(line)) continue;
    criteria[criteria.length - 1] += ` ${line.trim()}`;
  }
  return criteria;
}

/** Every `.md` path the text names, in order, deduplicated. */
export function namedDocuments(text) {
  return [...new Set([...String(text ?? '').matchAll(DOCUMENT)].map((m) => m[1]))];
}

/**
 * Source the acceptance criteria from the issue body or a document it names, and
 * fail closed when it cannot. Step 3 of the loop, and the hook AC 3 hangs on.
 *
 * It is built in this phase rather than in Phase 6 for the plan's reason: built
 * last, the negative case gets designed last, and the negative case is the most
 * likely real-world outcome.
 *
 * A named document is resolved **inside the worktree and nowhere else**. A body
 * naming `../../.ssh/notes.md` is refused rather than read — worktree.mjs's
 * `containedIn` is boundary-aware and is reused here rather than re-argued.
 */
export function sourceAcceptanceCriteria(issue, opts = {}) {
  const body = issue?.body ?? '';
  if (!body.trim()) return { ok: false, reason: INVOKE_REFUSALS.NO_ISSUE_BODY, looked: [] };

  const fromBody = extractCriteria(body);
  if (fromBody.length) return { ok: true, source: 'issue-body', criteria: fromBody, looked: ['the issue body'] };

  const looked = ['the issue body'];
  const worktree = opts.worktree;
  for (const rel of namedDocuments(body)) {
    if (!worktree) break;
    if (isAbsolute(rel)) {
      return { ok: false, reason: INVOKE_REFUSALS.DOCUMENT_OUTSIDE_WORKTREE, document: rel, looked };
    }
    const full = resolve(worktree, normalize(rel));
    if (!containedIn(worktree, full)) {
      return { ok: false, reason: INVOKE_REFUSALS.DOCUMENT_OUTSIDE_WORKTREE, document: rel, looked };
    }
    looked.push(rel);
    if (!existsSync(full)) {
      return { ok: false, reason: INVOKE_REFUSALS.DOCUMENT_MISSING, document: rel, looked };
    }
    const fromDoc = extractCriteria(readFileSync(full, 'utf8'));
    if (fromDoc.length) return { ok: true, source: 'document', document: rel, criteria: fromDoc, looked };
    return { ok: false, reason: INVOKE_REFUSALS.DOCUMENT_HAS_NO_CRITERIA, document: rel, looked };
  }
  return { ok: false, reason: INVOKE_REFUSALS.NO_ACCEPTANCE_CRITERIA, looked };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const WHY = {
  [INVOKE_REFUSALS.NO_ISSUE_BODY]: 'the issue has no body at all',
  [INVOKE_REFUSALS.NO_ACCEPTANCE_CRITERIA]:
    'the issue body carries no `Acceptance criteria` section and names no document that could',
  [INVOKE_REFUSALS.DOCUMENT_MISSING]: 'the document the issue names is not in this repository',
  [INVOKE_REFUSALS.DOCUMENT_OUTSIDE_WORKTREE]: 'the document the issue names resolves outside the run\'s worktree',
  [INVOKE_REFUSALS.DOCUMENT_HAS_NO_CRITERIA]: 'the document the issue names carries no `Acceptance criteria` section',
  [INVOKE_REFUSALS.NOT_ISOLATED]: 'the run authenticated against the remote, so it holds a credential it must not hold',
  [INVOKE_REFUSALS.ISOLATION_INCONCLUSIVE]: 'the run\'s isolation could not be verified against a live call',
  [INVOKE_REFUSALS.ANONYMOUS_REMOTE]: 'the remote answers without a credential, so the live call settles nothing here',
  [INVOKE_REFUSALS.GH_NOT_ISOLATED]:
    'the run\'s `gh` is logged in, so `GH_CONFIG_DIR` is not redirecting and the run reaches the publication capability',
  [INVOKE_REFUSALS.GH_INCONCLUSIVE]: 'the run\'s `gh` isolation could not be verified against a live call',
};

/**
 * The report a refused run files. Nothing publishes it here — Phase 4 owns every
 * outbound call — so this returns a string and writes nothing.
 *
 * **The issue is named `<short>-<N>` on a Linear-variant repo, `#N` elsewhere**
 * (§6.5.1, ADR 0014), the same rule as publish-run.mjs's `issueReference`. The Linear key
 * never appears, and neither number is ever computed from the other.
 *
 * **It ends at its last substantive line.** No attribution footer, no trailer, no
 * session URL. Phase 4 assembles bodies for `--body-file`, which walks straight
 * past the hook that reads `tool_input.command`, so the property is pinned here
 * where the string is built rather than where it is sent.
 */
export function formatUnderspecifiedReport({ issue, shortName = null, reason, document = null, looked = [], runId = null }) {
  // Inline rather than imported: publish-run.mjs imports this module, and its
  // `issueReference` is the same one line.
  const ref = shortName ? `${shortName}-${issue}` : `#${issue}`;
  const lines = [
    `No acceptance criteria could be sourced for ${ref}, so this run implemented`,
    'nothing, pushed no branch and opened no pull request.',
    '',
    `- refusal: \`${reason}\``,
    `- because: ${WHY[reason] ?? reason}`,
    ...(document ? [`- document named: \`${document}\``] : []),
    ...(looked.length ? [`- looked in: ${looked.map((l) => (l.includes(' ') ? l : `\`${l}\``)).join(', ')}`] : []),
    ...(runId ? [`- run: \`${runId}\``] : []),
    '',
    'Step 3 of the delegated-fix loop fails closed: a run that cannot state the',
    'acceptance criteria before implementing does not guess at them. This is the',
    'spec\'s most likely real-world outcome and is a refusal rather than a failure.',
    '',
    'Add an `## Acceptance criteria` section to the issue, or name a document in',
    'this repository that carries one, and delegate it again.',
  ];
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// The generation step
// ---------------------------------------------------------------------------

/**
 * Source the criteria, verify the isolation, invoke the agent. Any of the three
 * failing stops the run with a report and nothing published.
 *
 * **Criteria are sourced before the isolation is verified**, which looks like the
 * wrong order for a safety gate and is not: a run refused at step 3 invokes
 * nothing, so no unverified process ever exists. Ordering it this way makes the
 * underspecified case — AC 3, the likeliest outcome — decidable without a
 * network, which keeps its test honest on a machine that has none.
 *
 * The result names `branch: null` on every refusal. Phase 4 pushes what this
 * step names, so a refusal naming no branch is a refusal that cannot be published
 * by a later step reading the field optimistically.
 */
export function runGeneration({ repoRoot, runId, issue, worktree, branch, shortName = null, prompt, extraArgs = [] }, opts = {}) {
  const sourced = sourceAcceptanceCriteria(issue, { worktree });
  if (!sourced.ok) {
    return {
      ok: false,
      reason: sourced.reason,
      invoked: false,
      branch: null,
      published: false,
      outcome: OUTCOME_REPORTED,
      report: formatUnderspecifiedReport({
        issue: issue?.number, shortName, reason: sourced.reason,
        document: sourced.document ?? null, looked: sourced.looked ?? [], runId,
      }),
    };
  }

  const paths = opts.isolation ?? writeIsolation({ repoRoot, runId }, opts);
  const env = isolatedEnv(paths, opts.baseEnv ?? process.env);
  const verified = verifyIsolation({ cwd: worktree, env }, opts);
  if (!verified.ok) {
    return {
      ok: false,
      reason: verified.reason,
      invoked: false,
      branch: null,
      published: false,
      outcome: OUTCOME_REPORTED,
      isolation: verified,
      report: formatUnderspecifiedReport({
        issue: issue?.number,
        shortName,
        reason: verified.reason,
        looked: ['a live `git ls-remote`', 'a live `gh auth status`'],
        runId,
      }),
    };
  }

  const invocation = buildInvocation({ worktree, prompt, env, extraArgs });
  const result = spawnAgent(invocation, opts);
  return {
    ok: result.status === 0,
    invoked: true,
    branch,
    published: false,
    criteria: sourced.criteria,
    criteriaSource: sourced.source,
    argv: invocation.args,
    isolation: verified,
    agent: { status: result.status, stdout: result.stdout, stderr: result.stderr },
  };
}
