# Setup guide

Get the tools working, install the skills, and confirm both are correct — this covers `daftplate` itself, not a repo it scaffolds.

## The machine checklist

`scripts/lib/toolchain.mjs` is the single source of truth for this list, and the only
place an install string is written. The tables below are that manifest as prose,
because this page is the only interface that exists in the case the list is for: a new
machine, no checkout, nothing installed. `git` and `node` come first because
everything after them — including the checker at the bottom of this section — needs
both before it can run at all.

Install commands are winget, which is what this workspace runs on. On another
platform use your package manager, and treat each linked project as the authority on
its own install instructions.

### Required

A machine of yours is misconfigured without these. `tier` means exactly that, and not
"a script breaks" — `restic` is required because nothing else backs up what matters,
which has nothing to do with this repo running. The narrower fact lives in the
manifest's `blocksScripts`, which is what `setup-repo.mjs` filters on, and it is true
of the first four only.

| Tool | For | Install |
|---|---|---|
| [Git](https://git-scm.com/) | version control — and cloning this repo, which everything below depends on | `winget install Git.Git` |
| [Node.js](https://nodejs.org/) ≥ 20 | every script in `scripts/`; `npm test` uses the built-in `node:test` runner | `winget install OpenJS.NodeJS.LTS` |
| [GitHub CLI](https://cli.github.com/) | issues, PRs, releases — the workflow in `engineering-standards/repo-standards.md` assumes it | `winget install GitHub.cli` |
| [gitleaks](https://github.com/gitleaks/gitleaks) | pre-commit secret scanning, required by repo-standards §2.1 | `winget install Gitleaks.Gitleaks` |
| [restic](https://github.com/restic/restic) | backups — nothing currently backs up what matters | `winget install restic.restic` |
| [Codex CLI](https://github.com/openai/codex) | the disagreeing second opinion in `/review` and `/deliberate` | `npm install -g @openai/codex` |

### Recommended

Absent, these cost you convenience rather than correctness. Nothing here changes an
exit code.

| Tool | For | Install |
|---|---|---|
| [ripgrep](https://github.com/BurntSushi/ripgrep) | the search both agents and editors lean on | `winget install BurntSushi.ripgrep.MSVC` |
| [fzf](https://github.com/junegunn/fzf) | fuzzy history and file picking in the shell | `winget install junegunn.fzf` |
| [Bitwarden CLI](https://bitwarden.com/help/cli/) | secrets out of committed files — use `op` instead if a 1Password subscription already exists | `winget install Bitwarden.CLI` |

### Per profile

Only needed if you work on a repo of that type, and the checker stays quiet about them
otherwise.

| Profile | Tool | For | Install |
|---|---|---|---|
| `gas-webapp` | [clasp](https://github.com/google/clasp) | push and deploy Apps Script projects | `npm install -g @google/clasp`, then `clasp login` |
| `web-app` | [Wrangler](https://github.com/cloudflare/workers-sdk) | deploy to Cloudflare Workers and Pages | `npm install -g wrangler` |

### For the desk guides only

These two are prerequisites of one command, `npm run desk-guides`, and of nothing
else. They are deliberately **not** in `scripts/check-machine.mjs`: a `tier` there
means "a machine of yours is misconfigured without this", and that is untrue for
someone who cloned the public export to scaffold a repo. Skip both unless you are
regenerating the printable cork-board guides.

| Tool | For | Install |
|---|---|---|
| Microsoft Edge or Google Chrome | measuring real page geometry, and printing HTML to PDF | Edge ships with Windows; otherwise install either browser |
| [Poppler](https://poppler.freedesktop.org/) (`pdfinfo`, `pdftoppm`) | reopening each PDF to confirm one Letter-landscape page, and rendering PNG previews | Windows: `winget install oschwartz10612.Poppler` · macOS: `brew install poppler` · Linux: `sudo apt install poppler-utils` |

The generator probes for them itself and refuses with the install command above
when either is missing. It never installs anything. On Windows, reopen the shell
after installing Poppler so the new `PATH` is picked up.

### Check the machine

Once `node` and a checkout exist, stop reading tables and let the second pass do it:

```
node scripts/check-machine.mjs
```

It probes each entry on `PATH`, prints what is missing with the install command and
the upstream credit, and exits non-zero **only** on a missing `required` tool — so it
is safe in CI. It detects and never installs, and it keeps no state of its own: no
snapshot, no ignore list, nothing to go stale.

```
node scripts/check-machine.mjs --profile gas-webapp   # add that profile's tools
node scripts/check-machine.mjs --json                 # same verdict, machine-readable
```

Inside a scaffolded repo the profile is read from its `.daftplate.json`, so the bare
run already knows. Installed a developer tool recently? Add it to
`scripts/lib/toolchain.mjs` — the tables above are checked against it by `npm test`,
so the two cannot drift apart silently.

## Install the skills

`skills/<name>/SKILL.md` in this repo is the source of truth for every user-level skill (ADR 0002). `scripts/install-skills.mjs` installs the whole checkout as **one plugin** at `~/.claude/skills/daftplate/`, holding the plugin manifest and a `skills/<name>/` directory per skill — one owned subtree rather than a loose skill directory per name:

```
node scripts/install-skills.mjs
```

This copies over the top of whatever is already in `~/.claude/skills/daftplate/` — it never deletes. Its parent, `~/.claude/skills/`, holds every other skill you use, so an unguarded delete keyed on this repo's contents would be an unacceptable blast radius (ADR 0002); the installer names any loose leftover directory it recognises and prints a removal command rather than running one. A file removed from a skill's source here lingers in the installed copy until removed by hand; that's accepted, deliberately, over the alternative.

**Every input comes from the checkout containing the script**, so invoking it by path from anywhere works and is correct: `node X:/Projects/daftplate/scripts/install-skills.mjs` installs *daftplate's* skills and gate, not those of whatever repo you happen to be standing in. `cd`ing here first is still fine; it is no longer load-bearing. `--target` controls destinations only.

Useful flags:

```
node scripts/install-skills.mjs --dry-run          # list what would be installed, change nothing
node scripts/install-skills.mjs --target <dir>      # install somewhere other than ~/.claude/skills
```

Output names each installed skill:

```
installed 22 skill(s) as the daftplate plugin at C:\Users\you\.claude\skills\daftplate: agent-fixer, agent-hunter, anchor, audit, brief, code-map, ...
```

### Record where this checkout lives

The same command writes the path of *this* checkout into `~/.claude/CLAUDE.md`. That is
not cosmetic: every repo daftplate scaffolds gets a CLAUDE.md pointing at
`engineering-standards/repo-standards.md` here rather than a copy of it (ADR 0001), and
on a machine that never recorded the path, the pointer resolves to nothing. Copying the
standards into the repo instead is the failure this prevents, and it has already
happened five times.

The block it writes, and rewrites in place on every later run:

```
<!-- daftplate:checkout -->
Local `daftplate` checkout: `X:\Projects\daftplate`.
`engineering-standards/repo-standards.md` is canonical there and is never copied out (ADR 0001).
<!-- /daftplate:checkout -->
```

Three things worth knowing before you read the output:

- **The path recorded is the checkout containing the script**, not the directory you ran
  it from, so `node X:/Projects/daftplate/scripts/install-skills.mjs` from anywhere
  records `X:/Projects/daftplate`.
- **On the public daftplate export it prints `skills not installed: … has no skills/
  directory` and records the path anyway.** That export deliberately withholds `skills/`
  (they ship in daftkit, ADR 0002), so the complaint is expected and the run is not a
  failure — the line after it is the one that matters.
- **It never edits prose it did not write.** If `~/.claude/CLAUDE.md` does not exist it
  is created from `engineering-standards/claude-md-global.md`, gates included; if it
  exists without those gates you get told to merge them by hand, and nothing is
  injected. A marker block it cannot bound — duplicated, unclosed or reordered — is
  refused and left alone, with the reason printed.

`node scripts/check-machine.mjs` reports the record afterwards: whether a path is
recorded, whether it resolves to a real daftplate checkout, and how far behind its
upstream it is. A vendored copy of the standards inside some other repo does not count
as a checkout there, which is the whole point of checking.

A skill directory without a `SKILL.md` is skipped and reported on stderr — that's a malformed skill, not a failure of the installer.

Editing the installed copy under `~/.claude/skills/` instead of the source in this repo's `skills/` is a bug: your change is silently overwritten on the next install.

## Bootstrap a repository

`setup-repo` is per-repo, not per-machine, and it installs **two** git hooks:

```
node scripts/setup-repo.mjs <repo>
```

- a **pre-commit** hook running `gitleaks git --staged`, per repo-standards §2.1 layer 1;
- a **pre-push** hook enforcing `type/N-slug` branch names, per §4, which also refuses a direct push to `main`.

Neither is overwritten if something is already at that path — pass `--force` to replace one deliberately. `--check` is doctor mode: it reports either hook missing and **installs nothing**.

**Existing repositories need to re-run it.** A repo bootstrapped before the branch hook existed has only the pre-commit hook; `setup-repo` adds the second one without touching the first.

The branch hook's one-push escape hatch is `DAFTPLATE_ALLOW_NONSTANDARD_BRANCH=1 git push`, and it prints a line on stderr when it fires.

### Removing a vendored copy of the standards

The pre-commit hook refuses a staged `engineering-standards/` path, and the base CI workflow refuses a tracked one — `--no-verify` walks past a local hook, so the merge barrier has to exist server-side too. Both **refuse and neither deletes**: CLAUDE.md #5 is absolute, and a tool that removed a directory to enforce a documentation rule would be destroying work.

Removing an existing copy is a human job, and the two cases differ:

- **Tracked** — read the copy's unique lines first and confirm none is wanted, then `git rm -r engineering-standards/` in an ordinary reviewed PR, add the `CLAUDE.md` pointer and `docs/quick-ref-workflow.md`, and keep the removal free of unrelated cleanup.
- **Untracked** — confirm you are in the exact checkout you think you are, inventory the directory, then remove exactly `engineering-standards/` yourself.

**Do not add a `.gitignore` rule for it.** An ignored copy stays on disk, never shows up in `git status`, and still misleads an agent that reads it as current — which is how one repo's stale copy survived long enough to be less than half the length of the real standard. The friction of a visible copy is the point; the barriers above stop it being *tracked* without hiding a local one.

## Verify the install

Two independent checks — one for the scripts, one for the templates:

```
npm test
```

Runs the tooling test suite (`node --test`). A clean run ends with a summary showing all tests passing and zero failures.

```
node scripts/verify-templates.mjs .
```

Verifies the `base/` layer and every `profiles/<type>/` overlay are complete and well-formed — required files present and non-empty, profile metadata parses, no `files-override/` entry that doesn't actually override a base file. A clean result prints:

```
clean
```

Any problem instead prints one `rule: path — message` line per violation to stderr, a count to stdout, and exits non-zero — run it again after fixing before trusting the install.

## Agent surface

Which agents are installed is part of setting up a machine, so the settled
configuration is recorded here rather than left to be rediscovered.

- **Claude Code** — implementation, planning, refactoring, documentation.
- **Codex** — cross-model review and the disagreeing second opinion. Not a co-author.
  On the manifest as `required` for that reason: a review pipeline with one model in
  it is not a review pipeline.
- **GitHub Copilot: not part of this setup.** It was, and the reasoning for dropping
  it is worth keeping. Its allowance is metered rather than flat, so it is not the
  free-at-the-margin surface it was argued to be; and the half that justified it —
  automatic code review on pull requests — is delivered as a repository ruleset,
  which GitHub refuses on a private repo on the free plan. What remained was
  autocomplete at a price. Nothing here depends on it.
- **MCP servers: none.** One earns a place only when a capability has no CLI, needs a
  persistent connection, or needs schema discovery an agent cannot infer. Adding one
  takes a one-paragraph ADR naming the use case, why a CLI is insufficient, what
  credential it holds and where, whether it is global or project-scoped, and who
  removes it if it goes unused for 30 days. Default to project-scoped. Cost is part of
  the reason: MCP tool schemas consume context on **every** request.
- **Deliberately not added:** Cursor, Cline, Roo Code, Continue, Kilo Code, fabric,
  OpenClaw. A fifth prompt library with its own key and its own spend works against
  the standing decision to keep the agent surface small enough to reason about.

### Review routing

Codex is the review pass — the reader whose job is to disagree, and the reason it
is `required` rather than `recommended` on the checklist above. A full
`/deliberate` panel is for genuinely irreversible decisions; one reviewer told to
refute is the default, and it has measured better criticism per token.

`node scripts/setup-repo.mjs <repo> --remote` still applies what GitHub will
accept — delete-branch-on-merge everywhere, branch protection and secret scanning
where the repo's visibility and plan allow — and reports the rest as unavailable
with the reason and the unblock, rather than failing.

## The statusline (optional)

`workspace/statusline.ps1` is a vendored, pure-PowerShell Claude Code statusline for Windows. One line, six fields:

```
model | context-window | context-used% | cost | in/out tokens | agents
```

Example: `O48 | 245k | 37% | $1.82 | 183k/63k | 2 agents`

It reads the status-line JSON Claude Code pipes to stdin, makes no network calls, and consumes no API tokens. Absent fields are omitted rather than shown as placeholders — no `"unknown"`, `"n/a"`, or doubled separators when something drops out.

### Wiring it up

Add a `statusLine` entry to Claude Code's `settings.json` (global `~/.claude/settings.json` or a project's `.claude/settings.json`) that runs the script with `pwsh`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "pwsh -File \"C:/Projects/daftplate/workspace/statusline.ps1\""
  }
}
```

Use the absolute path to wherever this repo lives on disk. Requires PowerShell 5.1+ (`pwsh` on modern Windows, or `powershell.exe` if you don't have PowerShell 7 installed — adjust the command accordingly).

### Configuration

All configuration is environment variables, read once at start with sensible defaults — nothing needs to be set to get useful output. The full set:

| Variable | Default | Meaning |
|---|---|---|
| `SL_MODEL_NAME_LEN` | `1` | Characters of the model family name to show (`1` → `O`, `3` → `Opu`) |
| `SL_MODEL_SHOW_MINOR` | `1` | Include the minor version number (`1` → `O48`, `0` → `O4`) |
| `SL_MODEL_MINOR_SEP` | *(empty)* | Separator before the minor version (`""` → `O48`, `"."` → `O4.8`) |
| `SL_CTX_SIZE_UNIT` | `tokens` | Context-window size display: `tokens` (rounds to nearest k) or `thousands` (treats the raw value as already-in-thousands) |
| `SL_TOKENS_INCLUDE_CACHE` | `1` | Whether the input-token count in the in/out segment includes cache write + cache read tokens |
| `SL_COST_EST_MARK` | `~` | Prefix marking a calculated (not Claude-Code-reported) cost estimate |
| `SL_USE_CCUSAGE` | `0` | `1` enables `ccusage` as a last-resort cost source if installed and no cost is otherwise available |
| `SL_TRANSCRIPT_TTL` | `5` | Seconds the per-session token cache (in `%TEMP%`) stays valid before the transcript is re-parsed |
| `SL_DEBUG` | `0` | `1` writes diagnostic lines to stderr (model parse, token totals, cost source) |

Set any of these in the environment before launching Claude Code, e.g. in PowerShell:

```
$env:SL_MODEL_NAME_LEN = '3'
$env:SL_USE_CCUSAGE = '1'
```

### Cost sourcing

Cost is resolved in priority order: (1) Claude Code's own `cost.total_cost_usd` if present, shown plain (`$1.82`); (2) calculated from summed session tokens against a built-in per-family pricing table, marked with `SL_COST_EST_MARK` (`~$1.82`); (3) `ccusage`, only if `SL_USE_CCUSAGE=1` and the `ccusage` binary is on `PATH` — an optional external fallback, not a dependency of the script; (4) omitted entirely if none of the above resolve.

No secrets are read or required — the script only ever consumes the statusline JSON on stdin and, optionally, the local transcript file it points at.
