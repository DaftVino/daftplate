#!/usr/bin/env node
// Per-repo bootstrap: installs the gitleaks pre-commit hook and checks prerequisites.
// Detects tools; never installs them. --remote applies the GitHub-side settings
// the repo's plan and visibility allow, and reports the rest with the reason.
// Usage: node scripts/setup-repo.mjs <repo> [--check] [--force]
import { existsSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { violation, reportViolations, runCli } from './lib/cli.mjs';
import { TOOLCHAIN } from './lib/toolchain.mjs';
import { commandExists } from './lib/probe.mjs';
import { advisory, inspect, resolveProfile } from './check-machine.mjs';

// Derived, never declared: scripts/lib/toolchain.mjs is the one source of truth
// for what this machine is expected to have. The filter is `blocksScripts` and
// not `tier` — restic and codex are `required` (a machine of yours is
// misconfigured without them) yet nothing in this repo breaks when they are
// absent, and blocking repo bootstrap on a backup tool would be wrong.
export const PREREQUISITES = TOOLCHAIN.filter((t) => t.blocksScripts);

// `gh project` needs a scope the default login does not grant.
export const GH_SCOPES = [
  { scope: 'project', why: 'create and query the repo project board (repo-standards §6.5)', fix: 'gh auth refresh -s project' },
];

// gitleaks 8.19 replaced `detect`/`protect` with `git`/`dir`; 8.30 removed them.
// `--staged` is the documented pre-commit form.
// The staged-path predicate for the vendored-standards half. Anchored at the
// repository ROOT — `^engineering-standards$` or `^engineering-standards/` — so a
// file merely *mentioning* the words, or a nested directory that happens to share
// the name, is not refused. `git diff --cached --name-only` emits root-relative
// paths with forward slashes on every platform, which is what makes one pattern
// enough.
export const VENDORED_STANDARDS_PATTERN = '^engineering-standards(/|$)';

// The one checkout where `engineering-standards/` is NOT a vendored copy: the one
// that produces the others. ADR 0001 makes the standards canonical *in daftplate*,
// so a rule reading "the directory is tracked here" is wrong in exactly the repo
// the rule is written from — and it was, live: this guard failed daftplate's own
// CI run 32719928626 on the branch that introduced it.
//
// Matched by SHAPE and not by repository name or remote URL. A name is renameable
// and a remote is a fork away from wrong, while a checkout that carries the layer
// tree scaffold() composes from IS the producer, whatever it is called. Both
// markers are required: `profiles/` alone is a plausible directory in an ordinary
// repo, and `base/files/` alone is the layout of a half-copied template.
//
// The stated cost, recorded rather than hidden: a repo that vendors the standards
// AND happens to hold both `base/files/` and `profiles/` is not refused. That is
// the same trade the root-name rule makes for `Readmefile` — a shape rule buys a
// boundary that survives the next convention, and pays for it at the edge.
//
// Exported so the hook, the CI workflow and their tests read one list.
export const PRODUCER_CHECKOUT_MARKERS = ['base/files', 'profiles'];

// Two refusals in one hook, because setup already manages this file and a second
// pre-commit hook would have to fight it for the slot.
//
// The vendored half exists because ADR 0001 makes the standards canonical in the
// daftplate checkout, and a copy anywhere else goes stale silently — measured,
// one such copy was 13,019 bytes against a canonical 29,091, less than half the
// current standard, while carrying a CLAUDE.md pointer that resolved to it. An
// agent reads the frozen text and reports success against rules that moved.
//
// It REFUSES and never deletes. CLAUDE.md #5 is absolute, and a hook that removed
// a directory the operator staged would be destroying work to enforce a
// documentation rule.
const HOOK = [
  '#!/bin/sh',
  '# Installed by daftplate scripts/setup-repo.mjs — blocks commits containing secrets,',
  '# and refuses a vendored copy of the engineering standards (ADR 0001).',
  `if [ -d ${PRODUCER_CHECKOUT_MARKERS[0]} ] && [ -d ${PRODUCER_CHECKOUT_MARKERS[1]} ]; then`,
  '  # The daftplate checkout itself: engineering-standards/ here is the canonical',
  '  # source the pointer resolves to, not a copy of it (ADR 0001).',
  '  vendored=""',
  'else',
  '  vendored=$(git diff --cached --name-only --diff-filter=ACMR \\',
  `    | grep -E '${'^engineering-standards(/|$)'}' || true)`,
  'fi',
  'if [ -n "$vendored" ]; then',
  '  echo "refusing to commit a vendored copy of engineering-standards/:" >&2',
  '  echo "$vendored" | sed "s/^/  /" >&2',
  '  echo "" >&2',
  '  echo "The standards are canonical in the daftplate checkout (ADR 0001). A copy here" >&2',
  '  echo "goes stale silently, and an agent reading it reports success against old rules." >&2',
  '  echo "Keep the CLAUDE.md pointer and docs/quick-ref-workflow.md instead." >&2',
  '  echo "" >&2',
  '  echo "Review the copy and remove it yourself — this hook never deletes anything." >&2',
  '  exit 1',
  'fi',
  'command -v gitleaks >/dev/null 2>&1 || {',
  '  echo "gitleaks not on PATH — install it (winget install Gitleaks.Gitleaks) or remove this hook" >&2',
  '  exit 1',
  '}',
  'gitleaks git --staged --redact --no-banner || exit 1',
  '',
].join('\n');

// Re-exported: it lived here first and other modules import it from here.
export { commandExists };

export function ghScopes() {
  const result = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
  return result.status === 0 ? `${result.stdout}${result.stderr}` : '';
}

/** Default runner. Injected in tests so nothing here ever touches the network.
 *  `cwd` matters: `gh repo view` resolves the slug from the working directory's
 *  git remote, and the repo under setup is frequently not the process cwd. */
export const ghRun = (args, cwd, input) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', cwd, input });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export function ghJson(args, run = ghRun) {
  const { status, stdout } = run(args);
  if (status !== 0) return null;
  try { return JSON.parse(stdout); } catch { return null; }
}

/**
 * The account plan for a repository's owner, or null when it is not knowable.
 *
 * `repos/{slug}` does NOT carry it. Verified against the raw live payload on
 * 2026-08-23: there is no `plan` key on the repository and none on its embedded
 * `owner` either. (`gh api ... --jq '{plan}'` reports `null`, which is jq
 * synthesizing a missing key and reads as if the field were merely empty.)
 * The old code read `repo.plan?.name ?? 'free'`, so `PAID_PLANS` was unreachable
 * and every repository classified as free — a Pro account included, which meant
 * `--remote` silently dropped branch protection while stating that GitHub does
 * not offer it. The tests mocked `plan: { name: 'free' }` onto a repository
 * payload in five places and so certified the fiction.
 *
 * The plan lives on the ACCOUNT, and which account endpoint answers depends on
 * the owner type. For a user it is only ever knowable for the *authenticated*
 * user — `api user` reports whoever holds the token, so accepting its plan for a
 * repository owned by somebody else would hand a stranger's repo this machine's
 * tier. The logins must match.
 *
 * **Null is a third state, not a synonym for free.** Measured the same day: an
 * organization the caller does not administer omits the key entirely, because
 * plan data needs membership and scope. Unknown is therefore ordinary,
 * not exceptional, and it is treated as *possibly paid* — a wrong `free` is
 * silent and self-confirming, while a wrong `pro` is one 403 that `applyRemote`
 * already reports.
 */
function accountPlan(owner, run) {
  const login = owner?.login;
  if (typeof login !== 'string' || login === '') return null;

  if (owner.type === 'Organization') {
    return ghJson(['api', `orgs/${login}`], run)?.plan?.name ?? null;
  }
  if (owner.type === 'User') {
    const me = ghJson(['api', 'user'], run);
    return me?.login === login ? me?.plan?.name ?? null : null;
  }
  return null;
}

export function probeRemote(slug, run = ghRun) {
  const repo = ghJson(['api', `repos/${slug}`], run);
  if (!repo) return { slug, private: true, plan: null, reachable: false };
  return {
    slug,
    private: Boolean(repo.private),
    plan: accountPlan(repo.owner, run),
    reachable: true,
  };
}

// The tier matrix, established empirically on 2026-07-22 against DaftVino/daftplate:
// branch protection and rulesets are 403 on private+free — not a permissions
// problem, and not something a human can toggle in Settings either. Secret
// scanning on a private repo needs Advanced Security, which Pro does not include.
// repo-standards §2.1 layer 2 names the substitute: the `secrets` CI job.
// Unavailable ONLY on an explicit free plan — the paid tiers are pro, team and
// enterprise, and every one of them is protectable, so the comparison is against
// the single blocking value rather than an allowlist of the others. A null plan
// means the tier could not be determined and the setting is attempted; see
// accountPlan() for why unknown leans paid rather than free.
const planBlocksProtection = (plan) => plan === 'free';

export function remoteSettings(probe) {
  const unreachable = {
    available: false,
    reason: `${probe.slug} is not reachable — check the remote and \`gh auth status\``,
    unblock: 'create the remote, or run without --remote',
  };
  const ok = { available: true, reason: '', unblock: '' };

  const protectable = !probe.private || !planBlocksProtection(probe.plan);
  const scannable = !probe.private;

  return [
    {
      id: 'delete-branch-on-merge',
      label: 'delete head branches after merge',
      ...(probe.reachable ? ok : unreachable),
    },
    {
      id: 'branch-protection',
      label: 'require a PR and passing checks on main (repo-standards §9.7)',
      ...(!probe.reachable ? unreachable : protectable ? ok : {
        available: false,
        reason: 'unavailable on a private repo on the free plan — the API returns 403, and the Settings UI does not offer it either',
        unblock: 'upgrade to GitHub Pro, or make the repository public',
      }),
    },
    {
      // Alerts only. Automated security fixes are a DIFFERENT decision: they let
      // Dependabot open PRs into the repo unprompted, which sits badly against
      // this repo's recorded position that Dependabot exists so a human reads the
      // diff — and every Dependabot PR here currently arrives red, because the
      // live-vs-template ci.yml equality test fails under enforce_admins. Turning
      // fixes on would guarantee a stream of red PRs needing intervention.
      //
      // No `available: false` branch is invented. There is no known plan or
      // visibility gate on this endpoint, so a real 403 lands on the existing
      // `failed` path and surfaces stderr — which is correct per this file's own
      // distinction: a structural impossibility is not an error, a failed call is.
      // Inventing an availability predicate with no gate to key it on would let
      // two implementers produce two incompatible shapes and both pass.
      id: 'dependabot-alerts',
      label: 'Dependabot vulnerability alerts (repo-standards §2.3)',
      ...(probe.reachable ? ok : unreachable),
    },
    {
      id: 'secret-scanning',
      label: 'secret scanning + push protection (repo-standards §2.1 layer 2)',
      ...(!probe.reachable ? unreachable : scannable ? ok : {
        available: false,
        reason: 'private repos need GitHub Advanced Security, which Pro does not include',
        unblock: 'make the repository public — the `secrets` CI job is the required substitute until then',
      }),
    },
  ];
}

// A required status-check context is a CI job id — a two-space-indented `<id>:`
// under `jobs:` in a workflow file. Require only the contexts the repo actually
// ships: a repo with no matching workflow (e.g. the skills-only daftkit export)
// would otherwise have its `main` require a check that never reports, blocking
// every PR forever — with enforce_admins on, unrecoverably.
//
// `candidates` is the other half of that guard, and the load-bearing half. This
// FILTERS a hardcoded allowlist rather than discovering job ids, and the sole
// call site passes no override, so a new job added to any workflow — a linter, a
// staleness check, a CodeQL scan — can never become a required check by being
// written. Widening this list removes a protection whoever widens it will not
// know exists: a job that is required but does not report on every repo tier
// deadlocks `main` in exactly the way the paragraph above describes. Add an id
// here only alongside proof that the job reports on a private free-plan repo.
export function availableCheckContexts(repoDir, candidates = ['test', 'secrets']) {
  const dir = join(repoDir, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  const text = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
  return candidates.filter((ctx) => new RegExp(`^  ${ctx}:`, 'm').test(text));
}

// One gh invocation per setting. Each is idempotent: re-running --remote on an
// already-configured repo re-asserts the same state rather than toggling it.
export const REMOTE_CALLS = {
  // PUT repos/{slug}/vulnerability-alerts, 204 on success, admin-scoped. This is
  // a DIFFERENT endpoint from the automated-security-fixes path the changelog
  // once measured as `{"enabled":false}`, and that measurement does not transfer:
  // it was a GET, on one repo, under one owner, at one moment, and a 200 on a
  // read implies nothing about a write on another path.
  //
  // Caveat worth stating rather than relying on: on a private repo, alerts run
  // off the dependency graph, which this endpoint does not toggle. Enabling
  // alerts where the graph is off produces nothing.
  //
  // Measured 2026-08-24 on this repository, private, no paid plan: the PUT
  // returned 204, the GET then returned 204 (enabled), and the graph was already
  // live — `dependency-graph/sbom` listed the two pinned actions plus the repo
  // itself, and `dependabot/alerts?state=open` returned `[]` where it had
  // returned `403 Dependabot alerts are disabled` an hour earlier. One repo, one
  // moment, one plan; it does not generalise to every tier, but it does retire
  // the assumption that this needs Advanced Security.
  'dependabot-alerts': (slug) => [
    'api', '--method', 'PUT', `repos/${slug}/vulnerability-alerts`,
  ],
  'delete-branch-on-merge': (slug) => [
    'api', '--method', 'PATCH', `repos/${slug}`, '-f', 'delete_branch_on_merge=true',
  ],
  'branch-protection': (slug, opts = {}) => {
    const contexts = opts.contexts ?? [];
    const args = [
      'api', '--method', 'PUT', `repos/${slug}/branches/main/protection`,
      '-F', 'required_pull_request_reviews[required_approving_review_count]=0',
    ];
    if (contexts.length) {
      args.push('-F', 'required_status_checks[strict]=true');
      for (const ctx of contexts) args.push('-f', `required_status_checks[contexts][]=${ctx}`);
    } else {
      // No CI job produces a check here — require the PR, not a phantom check.
      args.push('-F', 'required_status_checks=null');
    }
    // enforce_admins=true, deliberately. repo-standards §9.7 says "require a PR
    // (even solo)", and on a repo whose only member is an admin, exempting
    // admins means the rule binds nobody while --remote still reports it
    // applied. The escape hatch is printed in the report below.
    args.push('-F', 'enforce_admins=true', '-F', 'restrictions=null');
    return args;
  },
  'secret-scanning': (slug) => [
    'api', '--method', 'PATCH', `repos/${slug}`,
    '-f', 'security_and_analysis[secret_scanning][status]=enabled',
    '-f', 'security_and_analysis[secret_scanning_push_protection][status]=enabled',
  ],
};

export function applyRemote(probe, opts = {}) {
  const run = opts.run ?? ghRun;

  return remoteSettings(probe).map((setting) => {
    if (!setting.available) {
      return {
        id: setting.id,
        label: setting.label,
        status: 'unavailable',
        detail: `${setting.reason}. Unblock: ${setting.unblock}`,
      };
    }
    if (opts.dryRun) {
      return { id: setting.id, label: setting.label, status: 'skipped', detail: 'dry run' };
    }
    const { status, stderr } = run(REMOTE_CALLS[setting.id](probe.slug, opts));
    return status === 0
      ? { id: setting.id, label: setting.label, status: 'applied', detail: '' }
      : { id: setting.id, label: setting.label, status: 'failed', detail: stderr.trim() };
  });
}

export function checkPrerequisites(resolve = commandExists, scopes = ghScopes) {
  const violations = PREREQUISITES
    .filter((p) => !resolve(p.command, p.versionArgs))
    .map((p) => violation('prerequisite', p.command, `not on PATH — needed for ${p.why}. Install: ${p.install}`));

  if (resolve('gh')) {
    const status = scopes();
    for (const s of GH_SCOPES) {
      if (status && !status.includes(`'${s.scope}'`)) {
        violations.push(violation('gh-scope', s.scope, `gh token lacks the ${s.scope} scope — needed to ${s.why}. Fix: ${s.fix}`));
      }
    }
  }
  return violations;
}

function hookPath(repoDir, name = 'pre-commit') {
  return join(repoDir, '.git', 'hooks', name);
}

export function installGitleaksHook(repoDir, opts = {}) {
  if (!existsSync(join(repoDir, '.git', 'hooks'))) return 'no-git-dir';
  const path = hookPath(repoDir);
  if (existsSync(path) && !opts.force) return 'present';
  writeFileSync(path, HOOK, 'utf8');
  chmodSync(path, 0o755);   // no-op on NTFS, required on POSIX
  return 'installed';
}

/** The one-push escape hatch. Named, not silent: a gate with no exit gets
 *  disabled wholesale the first time it is wrong, and then nothing is enforced. */
export const BRANCH_BYPASS_ENV = 'DAFTPLATE_ALLOW_NONSTANDARD_BRANCH';

/** The substring `checkRepoSetup()` recognizes as our hook rather than someone
 *  else's pre-push. Distinctive enough not to collide, stable enough to grep. */
export const BRANCH_HOOK_SIGNATURE = 'daftplate branch-name gate';

// Gate 3 of claude-md-global.md is `type/N-slug`, and nothing enforced it —
// `test/routing-resolution-guard` and `fix/sync-standards-robustness` both
// shipped without their numbers. The number is what makes the PR-to-issue link
// visible before a PR body exists, which matters more here than elsewhere
// because GitHub and Linear issue sequences drift, so the branch name is the one
// place the GitHub number is unambiguous.
//
// pre-push, not pre-commit: the name is settled by then and the check is cheap,
// and a commit-time gate would fire on every commit of a branch already named.
//
// It reads STDIN rather than `git branch --show-current`. Git feeds pre-push one
// line per ref as `<local ref> <local sha> <remote ref> <remote sha>`, and the
// destination is the remote ref — a push can target a differently named remote
// branch, or push a branch that is not the one checked out, and a current-branch
// check sees neither.
//
// POSIX sh and git only: this file lands in repos daftplate does not control and
// must not assume bash, node, or anything on PATH beyond git itself.
const BRANCH_HOOK = [
  '#!/bin/sh',
  `# Installed by daftplate scripts/setup-repo.mjs — ${BRANCH_HOOK_SIGNATURE}.`,
  '# Refuses a push whose destination branch is not type/N-slug (repo-standards §4).',
  'status=0',
  '',
  'while read -r local_ref local_sha remote_ref remote_sha; do',
  '  # A deletion carries the all-zero local sha and has no name to check.',
  '  case "$local_sha" in *[!0]*) ;; *) continue ;; esac',
  '  # Tags are not branches. Releases and cleanup must not be blocked by a',
  '  # branch-naming rule that says nothing about them.',
  '  case "$remote_ref" in refs/heads/*) ;; *) continue ;; esac',
  '  branch=${remote_ref#refs/heads/}',
  '',
  '  case "$branch" in',
  '    main|master)',
  '      echo "refusing to push directly to $branch — branch type/N-slug off main and open a PR" >&2',
  '      status=1',
  '      continue',
  '      ;;',
  '  esac',
  '',
  '  # type/N-slug: a lowercase type, an issue number with no leading zero, and a',
  '  # lowercase-kebab slug. One slash exactly — grep -E has no lazy quantifiers,',
  '  # so the slug pattern excludes / rather than relying on greediness.',
  '  if ! printf %s "$branch" | grep -Eq \'^[a-z]+/[1-9][0-9]*-[a-z0-9]+(-[a-z0-9]+)*$\'; then',
  '    echo "refusing to push $branch — branch names must be type/N-slug, e.g. fix/62-scaffold-dest-guard" >&2',
  '    echo "  rename it:  git branch -m <type>/<issue>-<slug>" >&2',
  `    echo "  or push it anyway once:  ${BRANCH_BYPASS_ENV}=1 git push" >&2`,
  '    status=1',
  '  fi',
  'done',
  '',
  `if [ "$status" -ne 0 ] && [ -n "\${${BRANCH_BYPASS_ENV}}" ]; then`,
  `  echo "${BRANCH_BYPASS_ENV} is set — pushing a non-standard branch name anyway" >&2`,
  '  exit 0',
  'fi',
  'exit $status',
  '',
].join('\n');

export function installBranchNameHook(repoDir, opts = {}) {
  if (!existsSync(join(repoDir, '.git', 'hooks'))) return 'no-git-dir';
  const path = hookPath(repoDir, 'pre-push');
  if (existsSync(path) && !opts.force) return 'present';
  // LF explicitly: Git for Windows runs hooks through sh, and a CRLF shebang
  // line fails with a bare "not found" that names nothing useful.
  writeFileSync(path, BRANCH_HOOK, 'utf8');
  chmodSync(path, 0o755);
  return 'installed';
}

export function checkRepoSetup(repoDir, opts = {}) {
  const violations = checkPrerequisites(opts.resolve, opts.scopes);

  const commitHook = hookPath(repoDir);
  const commitInstalled = existsSync(commitHook)
    && readFileSync(commitHook, 'utf8').includes('gitleaks git --staged');
  if (!commitInstalled) {
    violations.push(violation(
      'pre-commit-hook',
      '.git/hooks/pre-commit',
      'no gitleaks pre-commit hook — run without --check to install it',
    ));
  }

  // Reported, never installed by doctor mode: --check is a diagnosis and must
  // not write, which is why this reads rather than repairs.
  const pushHook = hookPath(repoDir, 'pre-push');
  const pushInstalled = existsSync(pushHook)
    && readFileSync(pushHook, 'utf8').includes(BRANCH_HOOK_SIGNATURE);
  if (!pushInstalled) {
    violations.push(violation(
      'pre-push-hook',
      '.git/hooks/pre-push',
      'no daftplate branch-name pre-push hook — run without --check to install it',
    ));
  }

  return violations;
}

export function setupRepo(repoDir, opts = {}) {
  const hook = installGitleaksHook(repoDir, opts);
  // A separate key: `hook` is the pre-commit result and callers read it.
  const branchHook = installBranchNameHook(repoDir, opts);
  return { hook, branchHook, violations: checkRepoSetup(repoDir, opts) };
}

function main(argv, run = ghRun, opts = {}) {
  const args = argv.slice(2);
  const repo = args.find((a) => !a.startsWith('--'));
  if (!repo) {
    console.error('usage: node scripts/setup-repo.mjs <repo> [--check] [--force] [--remote [--dry-run]]');
    return 2;
  }
  if (args.includes('--check')) return reportViolations(checkRepoSetup(repo));

  if (args.includes('--remote')) {
    // Resolve the slug from the target repo's remote, not the process cwd.
    // Arity matters: a forwarder that drops trailing arguments silently changes
    // the call it forwards, which cost this file a real defect once already.
    const inRepo = (a, _cwd, input) => run(a, repo, input);
    const slug = ghJson(['repo', 'view', '--json', 'nameWithOwner'], inRepo)?.nameWithOwner;
    if (!slug) {
      console.error('no GitHub remote found for this repo — create one first, or run without --remote');
      return 1;
    }
    const contexts = availableCheckContexts(repo);
    const results = applyRemote(probeRemote(slug, inRepo), {
      run: inRepo,
      dryRun: args.includes('--dry-run'),
      contexts,
    });

    for (const group of ['applied', 'skipped', 'failed', 'unavailable']) {
      const rows = results.filter((r) => r.status === group);
      if (!rows.length) continue;
      console.log(`\n${group}`);
      for (const r of rows) console.log(`  ${r.label}${r.detail ? `\n    -> ${r.detail}` : ''}`);
    }
    if (results.some((r) => r.id === 'branch-protection' && r.status === 'applied')) {
      console.log('\nbranch protection now applies to admins too (repo-standards §9.7, "even solo").');
      console.log(contexts.length
        ? `Required status checks on main: ${contexts.join(', ')}.`
        : 'No status checks required on main — this repo ships no workflows, so main requires a PR only.');
      console.log('Emergency unprotect, if main is broken and a PR cannot land:');
      console.log(`  gh api --method DELETE repos/${slug}/branches/main/protection`);
      console.log('Re-apply by running this command again.');
    }
    if (results.some((r) => r.status === 'unavailable')) {
      console.log('\nsubstitute in force: the `secrets` CI job runs gitleaks over full history');
      console.log('(repo-standards §2.1 layer 2 — required wherever server-side scanning is unavailable)');
    }
    // A structural impossibility is not an error. A failed call is.
    return results.some((r) => r.status === 'failed') ? 1 : 0;
  }

  const { hook, branchHook, violations } = setupRepo(repo, {
    force: args.includes('--force'),
    resolve: opts.resolve,
    scopes: opts.scopes,
  });
  const note = (kind) => ({
    installed: `${kind} hook installed`,
    present: `${kind} hook already present (use --force to replace)`,
    'no-git-dir': 'no .git/hooks — run git init first',
  });
  console.log(note('pre-commit')[hook]);
  // Reported independently. Neither hook's outcome changes the other's, and
  // neither changes the exit code, which stays governed by prerequisites.
  console.log(note('branch-name pre-push')[branchHook]);

  // One advisory line, printed before the violations so it cannot bury them and
  // never contributing to the exit code. This is the recurring trigger the panel
  // picked: setup-repo already runs once per new repo, so the manifest gets
  // looked at without anyone having to remember a separate command. The repo's
  // own .daftplate.json supplies the profile, so a gas-webapp repo hears about
  // clasp and nothing else does.
  const advice = advisory(inspect({
    probe: opts.resolve ?? commandExists,
    profile: resolveProfile(args, repo),
  }));
  if (advice) console.log(advice);

  return reportViolations(violations);
}

export { main };
runCli(import.meta.url, main);
