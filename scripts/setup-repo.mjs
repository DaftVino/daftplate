#!/usr/bin/env node
// Per-repo bootstrap: installs the gitleaks pre-commit hook and checks prerequisites.
// Detects tools; never installs them. --remote applies the GitHub-side settings
// the repo's plan and visibility allow, and reports the rest with the reason.
// Usage: node scripts/setup-repo.mjs <repo> [--check] [--force]
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { violation, reportViolations, runCli } from './lib/cli.mjs';

export const PREREQUISITES = [
  { command: 'git', why: 'version control', install: 'winget install Git.Git' },
  { command: 'gh', why: 'issues, PRs, releases', install: 'winget install GitHub.cli' },
  { command: 'node', why: 'the scripts in this repo', install: 'winget install OpenJS.NodeJS.LTS' },
  { command: 'gitleaks', why: 'pre-commit secret scanning (repo-standards §2.1)', install: 'winget install Gitleaks.Gitleaks' },
];

// `gh project` needs a scope the default login does not grant.
export const GH_SCOPES = [
  { scope: 'project', why: 'create and query the repo project board (repo-standards §6.5)', fix: 'gh auth refresh -s project' },
];

// gitleaks 8.19 replaced `detect`/`protect` with `git`/`dir`; 8.30 removed them.
// `--staged` is the documented pre-commit form.
const HOOK = [
  '#!/bin/sh',
  '# Installed by daftplate scripts/setup-repo.mjs — blocks commits containing secrets.',
  'command -v gitleaks >/dev/null 2>&1 || {',
  '  echo "gitleaks not on PATH — install it (winget install Gitleaks.Gitleaks) or remove this hook" >&2',
  '  exit 1',
  '}',
  'gitleaks git --staged --redact --no-banner || exit 1',
  '',
].join('\n');

export function commandExists(command) {
  return spawnSync(command, ['--version'], { shell: true, stdio: 'ignore' }).status === 0;
}

export function ghScopes() {
  const result = spawnSync('gh', ['auth', 'status'], { shell: true, encoding: 'utf8' });
  return result.status === 0 ? `${result.stdout}${result.stderr}` : '';
}

/** Default runner. Injected in tests so nothing here ever touches the network.
 *  `cwd` matters: `gh repo view` resolves the slug from the working directory's
 *  git remote, and the repo under setup is frequently not the process cwd. */
export const ghRun = (args, cwd) => {
  const r = spawnSync('gh', args, { shell: true, encoding: 'utf8', cwd });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export function ghJson(args, run = ghRun) {
  const { status, stdout } = run(args);
  if (status !== 0) return null;
  try { return JSON.parse(stdout); } catch { return null; }
}

export function probeRemote(slug, run = ghRun) {
  const repo = ghJson(['api', `repos/${slug}`], run);
  if (!repo) return { slug, private: true, plan: 'free', reachable: false };
  return {
    slug,
    private: Boolean(repo.private),
    plan: repo.plan?.name ?? 'free',
    reachable: true,
  };
}

// The tier matrix, established empirically on 2026-07-22 against DaftVino/daftplate:
// branch protection and rulesets are 403 on private+free — not a permissions
// problem, and not something a human can toggle in Settings either. Secret
// scanning on a private repo needs Advanced Security, which Pro does not include.
// repo-standards §2.1 layer 2 names the substitute: the `secrets` CI job.
const PAID_PLANS = new Set(['pro', 'team', 'enterprise']);

export function remoteSettings(probe) {
  const unreachable = {
    available: false,
    reason: `${probe.slug} is not reachable — check the remote and \`gh auth status\``,
    unblock: 'create the remote, or run without --remote',
  };
  const ok = { available: true, reason: '', unblock: '' };

  const protectable = !probe.private || PAID_PLANS.has(probe.plan);
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

// One gh invocation per setting. Each is idempotent: re-running --remote on an
// already-configured repo re-asserts the same state rather than toggling it.
const REMOTE_CALLS = {
  'delete-branch-on-merge': (slug) => [
    'api', '--method', 'PATCH', `repos/${slug}`, '-f', 'delete_branch_on_merge=true',
  ],
  'branch-protection': (slug) => [
    'api', '--method', 'PUT', `repos/${slug}/branches/main/protection`,
    '-F', 'required_pull_request_reviews[required_approving_review_count]=0',
    '-F', 'required_status_checks[strict]=true',
    '-f', 'required_status_checks[contexts][]=test',
    '-f', 'required_status_checks[contexts][]=secrets',
    // enforce_admins=true, deliberately. repo-standards §9.7 says "require a PR
    // (even solo)", and on a repo whose only member is an admin, exempting
    // admins means the rule binds nobody while --remote still reports it
    // applied. The escape hatch is printed in the report below.
    '-F', 'enforce_admins=true',
    '-F', 'restrictions=null',
  ],
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
    const { status, stderr } = run(REMOTE_CALLS[setting.id](probe.slug));
    return status === 0
      ? { id: setting.id, label: setting.label, status: 'applied', detail: '' }
      : { id: setting.id, label: setting.label, status: 'failed', detail: stderr.trim() };
  });
}

export function checkPrerequisites(resolve = commandExists, scopes = ghScopes) {
  const violations = PREREQUISITES
    .filter((p) => !resolve(p.command))
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

function hookPath(repoDir) {
  return join(repoDir, '.git', 'hooks', 'pre-commit');
}

export function installGitleaksHook(repoDir, opts = {}) {
  if (!existsSync(join(repoDir, '.git', 'hooks'))) return 'no-git-dir';
  const path = hookPath(repoDir);
  if (existsSync(path) && !opts.force) return 'present';
  writeFileSync(path, HOOK, 'utf8');
  chmodSync(path, 0o755);   // no-op on NTFS, required on POSIX
  return 'installed';
}

export function checkRepoSetup(repoDir, opts = {}) {
  const violations = checkPrerequisites(opts.resolve, opts.scopes);
  const path = hookPath(repoDir);
  const installed = existsSync(path) && readFileSync(path, 'utf8').includes('gitleaks git --staged');
  if (!installed) {
    violations.push(violation(
      'pre-commit-hook',
      '.git/hooks/pre-commit',
      'no gitleaks pre-commit hook — run without --check to install it',
    ));
  }
  return violations;
}

export function setupRepo(repoDir, opts = {}) {
  const hook = installGitleaksHook(repoDir, opts);
  return { hook, violations: checkRepoSetup(repoDir, opts) };
}

function main(argv, run = ghRun) {
  const args = argv.slice(2);
  const repo = args.find((a) => !a.startsWith('--'));
  if (!repo) {
    console.error('usage: node scripts/setup-repo.mjs <repo> [--check] [--force] [--remote [--dry-run]]');
    return 2;
  }
  if (args.includes('--check')) return reportViolations(checkRepoSetup(repo));

  if (args.includes('--remote')) {
    // Resolve the slug from the target repo's remote, not the process cwd.
    const inRepo = (a) => run(a, repo);
    const slug = ghJson(['repo', 'view', '--json', 'nameWithOwner'], inRepo)?.nameWithOwner;
    if (!slug) {
      console.error('no GitHub remote found for this repo — create one first, or run without --remote');
      return 1;
    }
    const results = applyRemote(probeRemote(slug, inRepo), {
      run: inRepo,
      dryRun: args.includes('--dry-run'),
    });

    for (const group of ['applied', 'skipped', 'failed', 'unavailable']) {
      const rows = results.filter((r) => r.status === group);
      if (!rows.length) continue;
      console.log(`\n${group}`);
      for (const r of rows) console.log(`  ${r.label}${r.detail ? `\n    -> ${r.detail}` : ''}`);
    }
    if (results.some((r) => r.id === 'branch-protection' && r.status === 'applied')) {
      console.log('\nbranch protection now applies to admins too (repo-standards §9.7, "even solo").');
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

  const { hook, violations } = setupRepo(repo, { force: args.includes('--force') });
  const note = {
    installed: 'pre-commit hook installed',
    present: 'pre-commit hook already present (use --force to replace)',
    'no-git-dir': 'no .git/hooks — run git init first',
  }[hook];
  console.log(note);
  return reportViolations(violations);
}

export { main };
runCli(import.meta.url, main);
