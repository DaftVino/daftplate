// The machine toolchain manifest — one source of truth for every developer tool
// this workspace expects, and the only place an install string is written.
//
// Nothing here installs anything. `scripts/setup-repo.mjs` reads it to derive the
// prerequisites it blocks on; `docs/setup-guide.md` carries the same list as prose
// for the case where no checkout exists yet.
//
// It is `.mjs` rather than `.json` so the tier rationale can live beside the entry
// it justifies. Every `url`, `author`, `installer` and `install` string below was
// verified against upstream and the relevant registry on 2026-07-27 — `winget
// search --exact`, `winget show`, `npm view`, `gh extension search` — never from
// recall. A wrong install id in a public repo is a paper cut for every reader.
//
// Entry shape:
//   command       probed on PATH
//   name          display name
//   tier          'required' | 'recommended'
//   blocksScripts do daftplate's own scripts fail without it?
//   why           one clause, shown next to the install command
//   installer     'winget' | 'npm' | 'gh-extension'
//   install       the command a human runs; must match `installer` (see INSTALLERS)
//   url           credit — the upstream project, which is the authority on itself
//   author        credit
//   profiles      optional: restrict to these project types
//   versionArgs   optional: how to probe it, when `--version` is not the answer
//
// `versionArgs` exists because the probe form is a per-tool fact and treating it
// as a universal one was a real false negative: `restic --version` exits 1 with
// "unknown flag: --version", so check-machine reported an installed restic as
// missing and the machine could never pass. Omit it wherever `--version` works,
// which is everywhere else — a default restated on every entry stops being a
// default and starts being twelve places to get it wrong.
//
// `tier` means "a machine of yours is misconfigured without it", NOT "a script
// breaks". The distinction is deliberate: restic is `required` because nothing
// currently backs up what matters, and a definition keyed on script breakage would
// have filed it next to fzf. `blocksScripts` carries that narrower fact, and it is
// what setup-repo.mjs filters on, so repo bootstrap keeps checking exactly the four
// tools it checked before this file existed.
//
// There is deliberately no `license` field. A public repo asserting licence facts
// about third-party projects — presence-checked here but never correctness-checked
// anywhere — is an unverified public claim. `url` credits upstream and lets it be
// the authority on its own terms.
import { violation } from './cli.mjs';

export const TIERS = ['required', 'recommended'];

// installer -> the prefix its `install` string must begin with. A table rather
// than a loosened assertion: adding an installer means adding a rule here, which
// is a visible decision, instead of relaxing the check for everyone.
export const INSTALLERS = {
  winget: 'winget install ',
  npm: 'npm install -g ',
  'gh-extension': 'gh extension install ',
};

export const REQUIRED_FIELDS = [
  'command', 'name', 'tier', 'blocksScripts', 'why', 'installer', 'install', 'url', 'author',
];

export const TOOLCHAIN = [
  // --- required, and daftplate's own scripts fail without them ---------------
  // These four are exactly what setup-repo.mjs checked before the manifest
  // existed. Their `why` and `install` strings are unchanged so the violation
  // text a user sees is byte-identical.
  {
    command: 'git',
    name: 'Git',
    tier: 'required',
    blocksScripts: true,
    why: 'version control',
    installer: 'winget',
    install: 'winget install Git.Git',
    url: 'https://git-scm.com/',
    author: 'The Git Development Community',
  },
  {
    command: 'gh',
    name: 'GitHub CLI',
    tier: 'required',
    blocksScripts: true,
    why: 'issues, PRs, releases',
    installer: 'winget',
    install: 'winget install GitHub.cli',
    url: 'https://cli.github.com/',
    author: 'GitHub',
  },
  {
    command: 'node',
    name: 'Node.js',
    tier: 'required',
    blocksScripts: true,
    why: 'the scripts in this repo',
    installer: 'winget',
    install: 'winget install OpenJS.NodeJS.LTS',
    url: 'https://nodejs.org/',
    author: 'OpenJS Foundation',
  },
  {
    command: 'gitleaks',
    name: 'gitleaks',
    tier: 'required',
    blocksScripts: true,
    why: 'pre-commit secret scanning (repo-standards §2.1)',
    installer: 'winget',
    install: 'winget install Gitleaks.Gitleaks',
    url: 'https://github.com/gitleaks/gitleaks',
    author: 'Zachary Rice',
  },

  // --- required, but nothing in this repo breaks without them ---------------
  {
    command: 'restic',
    name: 'restic',
    tier: 'required',
    blocksScripts: false,
    why: 'backups — nothing currently backs up what matters (audit §5.6/A3)',
    installer: 'winget',
    install: 'winget install restic.restic',
    url: 'https://github.com/restic/restic',
    author: 'Alexander Neumann',
    // The only entry that does not answer `--version`. Verified against restic
    // 0.19.1 on 2026-07-27: `restic --version` exits 1 with "unknown flag:
    // --version"; `restic version` exits 0.
    versionArgs: ['version'],
  },
  {
    command: 'codex',
    name: 'Codex CLI',
    tier: 'required',
    blocksScripts: false,
    why: 'the disagreeing second opinion in /review and /deliberate (audit §6.2)',
    installer: 'npm',
    install: 'npm install -g @openai/codex',
    url: 'https://github.com/openai/codex',
    author: 'OpenAI',
  },

  // --- recommended -----------------------------------------------------------
  {
    command: 'rg',
    name: 'ripgrep',
    tier: 'recommended',
    blocksScripts: false,
    why: 'the search both agents and editors lean on',
    installer: 'winget',
    install: 'winget install BurntSushi.ripgrep.MSVC',
    url: 'https://github.com/BurntSushi/ripgrep',
    author: 'Andrew Gallant',
  },
  {
    command: 'fzf',
    name: 'fzf',
    tier: 'recommended',
    blocksScripts: false,
    why: 'fuzzy history and file picking in the shell',
    installer: 'winget',
    install: 'winget install junegunn.fzf',
    url: 'https://github.com/junegunn/fzf',
    author: 'Junegunn Choi',
  },
  {
    command: 'bw',
    name: 'Bitwarden CLI',
    tier: 'recommended',
    blocksScripts: false,
    why: 'secrets out of committed files (audit G8) — use `op` instead if a 1Password subscription already exists',
    installer: 'winget',
    install: 'winget install Bitwarden.CLI',
    url: 'https://bitwarden.com/help/cli/',
    author: 'Bitwarden',
  },
  // Copilot was here — `gh copilot` in the design, then `@github/copilot` once
  // T1 found the gh extension archived upstream. Dropped 2026-07-27 by the
  // owner's assessment of the product, after the plan it belonged to was
  // withdrawn: on a metered allowance it reads as expensive autocomplete, and
  // the automatic-review half it was justified by is unavailable on a private
  // repo on the free plan anyway. See docs/designs/2026-07-27-m1-copilot-code-review.md.

  // --- profile-restricted ----------------------------------------------------
  // Reported only under `--profile <name>`, or inside a repo whose
  // .daftplate.json names that profile. This is how a deploy tool stays on the
  // list without nagging every machine. `recommended` rather than `required`
  // deliberately: the design's table gave these their own row group and named
  // no tier, and electing `required` would invent a non-zero exit the design
  // never asked for.
  {
    command: 'clasp',
    name: 'clasp',
    tier: 'recommended',
    blocksScripts: false,
    why: 'push and deploy Apps Script projects',
    installer: 'npm',
    install: 'npm install -g @google/clasp',
    url: 'https://github.com/google/clasp',
    author: 'Google',
    profiles: ['gas-webapp'],
  },
  {
    command: 'wrangler',
    name: 'Wrangler',
    tier: 'recommended',
    blocksScripts: false,
    why: 'deploy to Cloudflare Workers and Pages',
    installer: 'npm',
    install: 'npm install -g wrangler',
    url: 'https://github.com/cloudflare/workers-sdk',
    author: 'Cloudflare',
    profiles: ['web-app'],
  },
];

/** Pure shape check over an entry list. Exported so the test can drive it with
 *  deliberately broken entries — a loop of assertions over TOOLCHAIN alone only
 *  proves today's data is fine, never that a future omission is caught. */
export function validateToolchain(entries = TOOLCHAIN) {
  const violations = [];
  const seen = new Set();

  entries.forEach((entry, i) => {
    const at = entry?.command ?? `entry ${i}`;
    const fail = (message) => violations.push(violation('toolchain', at, message));

    if (!entry || typeof entry !== 'object') {
      fail('not an object');
      return;
    }
    for (const field of REQUIRED_FIELDS) {
      if (!(field in entry)) fail(`missing \`${field}\``);
      else if (field !== 'blocksScripts' && !entry[field]) fail(`\`${field}\` is empty`);
    }
    if ('license' in entry) fail('carries a `license` field — third-party licence facts are not asserted here');
    if (typeof entry.blocksScripts !== 'boolean') fail('`blocksScripts` must be a boolean');
    if (!TIERS.includes(entry.tier)) fail(`tier \`${entry.tier}\` is not one of ${TIERS.join(', ')}`);

    const prefix = INSTALLERS[entry.installer];
    if (prefix === undefined) fail(`installer \`${entry.installer}\` is not one of ${Object.keys(INSTALLERS).join(', ')}`);
    else if (typeof entry.install !== 'string' || !entry.install.startsWith(prefix)) {
      fail(`install string does not start with \`${prefix}\` as its \`${entry.installer}\` installer requires`);
    }

    if (typeof entry.url !== 'string' || !entry.url.startsWith('https://')) fail('url must be https');

    if ('profiles' in entry) {
      const ok = Array.isArray(entry.profiles)
        && entry.profiles.length > 0
        && entry.profiles.every((p) => typeof p === 'string' && p);
      if (!ok) fail('`profiles`, when present, must be a non-empty array of profile names');
    }

    if ('versionArgs' in entry) {
      const ok = Array.isArray(entry.versionArgs)
        && entry.versionArgs.length > 0
        && entry.versionArgs.every((a) => typeof a === 'string' && a);
      if (!ok) fail('`versionArgs`, when present, must be a non-empty array of arguments');
    }

    if (typeof entry.command === 'string' && entry.command) {
      if (seen.has(entry.command)) fail('duplicate command');
      seen.add(entry.command);
    }
  });

  return violations;
}

/** Entries a run should report. Unrestricted entries always; a restricted entry
 *  only when one of its profiles is active. */
export function toolsFor(profile, entries = TOOLCHAIN) {
  return entries.filter((t) => !t.profiles || (profile && t.profiles.includes(profile)));
}
