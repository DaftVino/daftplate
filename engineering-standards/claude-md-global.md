# CLAUDE.md — Global Instructions

<!-- Install at ~/.claude/CLAUDE.md. Applies to every project. Per-repo CLAUDE.md files add project-specific constraints and commands; they never override the gates below. -->

You are working with James M. Baker: solo developer, AI-heavy workflow, VS Code + Claude Code. Conventions are defined in the `engineering-standards` repo (`repo-standards.md`); the skill pipeline is defined in `coding-workflow.md`. When those documents and habit disagree, the documents win.

<!-- daftplate:checkout -->
Local `daftplate` checkout: `<DAFTPLATE_CHECKOUT>`.
`engineering-standards/repo-standards.md` is canonical there and is never copied out (ADR 0001).
<!-- /daftplate:checkout -->

<!-- The block above is filled in by `node scripts/install-skills.mjs`, which rewrites it in
     place on every run. Left unfilled, the placeholder is visibly a placeholder — every
     scaffolded repo points at the standards through this line, so a wrong path here dangles
     everywhere at once. Edit the path by hand only if you are not running that script. -->

## Non-negotiable gates

These are hard rules. If a request would violate one, stop and say which gate blocks it — do not work around it silently.

1. **No code before a failing test.** `test-driven-development` (superpowers) governs all implementation, including one-liners. Code written before a failing test exists gets deleted and restarted.
2. **No implementation before an approved plan** for non-trivial work (multi-PR, persisted-data changes, risky, or agent-executed). Plan must pass `/plan-eng-review` — the one required review gate.
3. **Never commit to `main`.** Branch `type/N-slug` off main, Conventional Commits, PR with `Fixes #N`, squash-merge, delete branch.
4. **Artifacts go to their canonical home.** Bugs → GitHub Issues (`gh issue …`). Plans/design docs → `docs/designs/YYYY-MM-DD-slug.md`. Lasting decisions → `docs/adr/NNNN-slug.md`. Fixes → PRs. Tests → `tests/`. Never create stray markdown notes, `todo.md`, or `docs/bugs/`.
5. **Never commit secrets.** Real keys live only in gitignored files with committed `*.example` twins. A leaked secret means immediate disclosure + rotation — scrubbing history is cleanup, not remediation.
6. **Check `docs/adr/` before proposing architectural changes.** Conflicting proposals must explicitly supersede the ADR, not bypass it.
7. **One closer per repo.** Versioned product → gstack `/ship`. Quick worktree task → superpowers `finishing-a-development-branch`. Never both on the same branch.

## The pipeline

Default path for any non-trivial change. Stages marked ★ are required; others scale with risk.

| Stage | Lead skill | Notes |
|---|---|---|
| Brainstorm | superpowers `brainstorming` | `/office-hours` ONLY for market-validation questions. Save the resulting design doc to `docs/designs/YYYY-MM-DD-slug.md`. |
| Plan | superpowers `writing-plans` | Use `templates/implementation-plan.md`; the phase manifest is required. `/spec` instead when a filed GitHub issue or fresh-agent worktree is the goal. |
| Plan review ★ | gstack `/plan-eng-review` | Add `/plan-ceo-review`, `/plan-design-review`, `/plan-devex-review` as relevant, or `/autoplan` for all. |
| Isolate | superpowers `using-git-worktrees` | After plan approval, before any code. |
| Implement ★ | superpowers `test-driven-development` | + `subagent-driven-development` (parallel) or `executing-plans` (batched). `requesting-code-review` fires between tasks. |
| Security | gstack `/cso` | Daily mode routinely; comprehensive monthly. |
| Live QA | gstack `/qa` / `/qa-only` | Different axis from TDD — run for anything with a UI. |
| Final review | gstack `/review` + `/codex` (challenge) | Do NOT also run `requesting-code-review` here — it already ran mid-flight. |
| Close ★ | `/ship` or `finishing-a-development-branch` | Per gate 7. `/ship` bumps VERSION + CHANGELOG; release still needs its `vX.Y.Z` tag. |
| Deploy | `/land-and-deploy` → `/canary` | |
| Wrap up | `/learn`; `/revise-claude-md` if anything non-obvious was discovered | `/retro` weekly. |

**Shortcuts:** Bug fix → `/investigate` (root cause first, no exceptions) → TDD regression test → `requesting-code-review` → `/qa-only` → close. Small change → TDD → `requesting-code-review` → close; skipping planning is correct ONLY here.

## Context budgets — the ≤150k rule

Every implementation plan is phased. Each phase must be independently
executable in a fresh session within ~150k tokens of context.

1. Each phase begins with an explicit **files-to-read manifest** with
   approximate sizes, and ends with a handoff note appended to the plan
   document.
2. Estimate context as `sum(files-to-read) + 3× that for working churn`. If the
   estimate exceeds ~150k, split the phase at a real seam — a different
   toolchain, a different repository, or a dependency boundary. Do not shave
   the ceiling.
3. Large files are read through `docs/code-map.md` slices or an Explore
   subagent, never wholesale. `/orient` at session start and `/handoff` at
   session end are what make phase entry cheap and phase exit clean.
4. Plans use `engineering-standards/templates/implementation-plan.md`. A plan
   without its phase manifest table fails `/plan-eng-review`.

## Routing corrections (override any per-repo routing that disagrees)

- Product ideas / "I want to build X" → `brainstorming`, not `/office-hours`.
- Debugging → `/investigate`, never both it and superpowers' debugging skill.
- Mid-flight review → `requesting-code-review`; pre-ship review → `/review`. Never both in the same pass.

## Conventions (summary — full detail in repo-standards.md)

- Naming: lowercase-kebab for repos, folders, docs, branch slugs. UPPERCASE only for canonical root files.
- Commits: `type(scope): verb object [qualifier]`, ≤72 chars; body when the why isn't obvious; `Fixes #N` as a footer, never in the summary.
- The verb names an operation and the object is a path or identifier from the diff. Two tests, both required: could a reader predict the diff from the summary, and does every word carry information? Intentions (`dogfood`), effort (`improve`, `clean up`), and filler (`various`) fail. Terms of art are fine when precise. Same formula for branch slugs and PR titles. Full detail: repo-standards.md §4.1–4.2.
- Releases: SemVer. CHANGELOG entry + annotated `vX.Y.Z` tag + GitHub Release, always together.
- LICENSE: MIT, `Copyright (c) YEAR James M. Baker`.

## CLAUDE.md hygiene

- End of any session with a non-obvious discovery: run `/revise-claude-md` (or `#` mid-session).
- Personal preferences go in `.claude.local.md` (gitignored), never the shared CLAUDE.md.
- Per-repo CLAUDE.md files stay under ~60 lines: project summary, commands, repo-specific constraints, pointer to standards. Workflow rules live HERE, not there.
