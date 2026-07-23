# Setup guide

Get the tools working, install the skills, and confirm both are correct — this covers `daftplate` itself, not a repo it scaffolds.

## Prerequisites

| Tool | For | Install |
|---|---|---|
| `node` ≥ 20 | Runs every script in `scripts/`; `npm test` uses the built-in `node:test` runner | [nodejs.org](https://nodejs.org) or your platform's package manager |
| `git` | Version control for this repo and everything it scaffolds | [git-scm.com](https://git-scm.com) |
| `gh` (GitHub CLI) | Issues, PRs, releases — the workflow in `engineering-standards/repo-standards.md` assumes it | [cli.github.com](https://cli.github.com) |
| `gitleaks` | Secret scanning — the pre-commit hook required by repo-standards §2.1 | `winget install Gitleaks.Gitleaks` (Windows) or [gitleaks.io](https://github.com/gitleaks/gitleaks#installing) |
| `clasp` | Only needed for the `gas-webapp` profile — pushes and deploys Google Apps Script projects | `npm install -g @google/clasp`, then `clasp login` |

Check versions:

```
node --version   # >=20
git --version
gh --version
gitleaks version
```

## Install the skills

`skills/<name>/SKILL.md` in this repo is the source of truth for every user-level skill (ADR 0002). `scripts/install-skills.mjs` copies each skill directory into `~/.claude/skills/<name>/`:

```
node scripts/install-skills.mjs
```

This copies over the top of whatever is already in `~/.claude/skills/` — it never deletes. That directory holds every other skill you use, so an unguarded delete keyed on this repo's contents would be an unacceptable blast radius (ADR 0002). A file removed from a skill's source here lingers in the installed copy until removed by hand; that's accepted, deliberately, over the alternative.

Useful flags:

```
node scripts/install-skills.mjs --dry-run          # list what would be installed, change nothing
node scripts/install-skills.mjs --target <dir>      # install somewhere other than ~/.claude/skills
```

Output names each installed skill:

```
installed 9 skill(s) to C:\Users\you\.claude\skills: brief, code-map, gas-deploy, handoff, new-project, orient, ...
```

A skill directory without a `SKILL.md` is skipped and reported on stderr — that's a malformed skill, not a failure of the installer.

Editing the installed copy under `~/.claude/skills/` instead of the source in this repo's `skills/` is a bug: your change is silently overwritten on the next install.

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
