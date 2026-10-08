# Workflow guide

Day-to-day usage: when to invoke what, and why the pieces are shaped this way. This assumes `daftplate` is already set up (see `setup-guide.md`) and covers working in a repo it scaffolds, not `daftplate` itself.

## Starting a new project

`/new-project` composes `base/` with one `profiles/<type>/` overlay into a fresh repo at `x:\Projects\<name>`. Given a type, a kebab-case name, and a 2–3 line summary, it runs `scripts/scaffold.mjs`, which applies both layers, fills every `<TOKEN>`, injects the profile's `CLAUDE.md` fragments, and writes `.daftplate.json` — the record of which profile and daftplate version produced the repo, with a per-file digest that `/sync-standards` later reads to detect drift. A clean scaffold exits 0; a nonzero exit prints each violation (an unfilled placeholder, or a file both layers tried to write) with the fix, and the fix is always to correct the template and rerun, never to hand-patch the output.

After scaffolding, the skill reads back the generated `CLAUDE.md` (the one check nothing automated can replace), initializes git, runs `scripts/setup-repo.mjs` to install the gitleaks pre-commit hook and verify `git`/`gh`/`node`/`gitleaks` are on `PATH`, optionally creates the GitHub remote and a single per-repo project board, and reports the `repo-standards.md` §9 checklist with each item marked done or needs-human.

## The daily session loop

Sessions in a scaffolded repo follow `/orient` → work → `/handoff`, and the loop exists because context is a hard budget, not a soft inconvenience: an assistant that reads too much before it starts working, or leaves no trace of what it learned before the session ends, forces the next session to rediscover the same ground at full cost.

`/orient` runs at session start (or after a `/clear`) and produces a working brief in under 15k tokens: it reads `CLAUDE.md`, checks `.daftplate.json` for the repo's profile, reads `docs/code-map.md`'s headers (not bodies) for shape rather than content, pulls the newest `CHANGELOG.md` entry, `git status`/`git log`, up to five open issues via `gh issue list`, and the `## Handoff log` tail of the newest design doc. It skips itself when the incoming task is concrete and self-contained — orientation is a bet that only pays off on open-ended or resumed work — and it stops after the brief; it never starts work or proposes a plan.

You then work the task. Before a planned `/clear`, or at the end of a phase, `/handoff` writes a dated `###` entry into the active plan document's `## Handoff log` — never a new file, never `todo.md` — covering the branch and merged commits, what shipped, what the plan got wrong (marked **do not revert**), what was discovered, what remains open, and the next phase with its files-to-read manifest. It also runs gstack `/context-save` for a machine-restorable snapshot, then commits the handoff note itself, even if nothing else is ready to commit — an uncommitted handoff note is not a handoff. Orient makes phase entry cheap; handoff makes phase exit clean. Together they're what keeps the ≤150k-token budget honest across a project that spans many sessions.

## Planning with context budgets

Every implementation plan is phased, and each phase must be independently executable in a fresh session within roughly 150k tokens of context. A plan uses `engineering-standards/templates/implementation-plan.md`, whose **phase manifest** table is required — a plan missing it fails `/plan-eng-review` outright.

Each phase row states its files-to-read with approximate sizes; estimated context is `sum(files-to-read) + 3× that for working churn`. When that estimate exceeds ~150k, the phase splits at a real seam — a different toolchain, a different repo, a dependency boundary — never by shaving the ceiling. Large files are read through `docs/code-map.md` slices or an Explore subagent, never wholesale; this is the same discipline `/orient` enforces at session start. Every phase ends with a handoff note appended to the plan document, so the next phase's session starts already oriented instead of re-reading the whole plan.

Plans go through `/plan-eng-review` before any code is written; riskier or more visible changes add `/plan-ceo-review`, `/plan-design-review`, or `/plan-devex-review` as relevant, or `/autoplan` for all of them at once.

## Tracking issues on a Linear board

Most repos track work on a GitHub Project and refer to an issue as `#N`. A repo can instead keep its board in Linear; the single `Board:` line in `ROADMAP.md` says which system it uses (repo-standards §6.5.1). Issues are still created in GitHub, but their written identifier and post-filing workflow change.

**One name per issue.** Refer to an issue as `<short>-<N>`, as in `daftplate-357`, wherever a person will read it: pull-request bodies, comments, handoff notes, commit bodies and chat. `<short>` is the project link text on the `Board:` line, and `N` is the GitHub number. Pull requests use the same form because GitHub draws issue and pull-request numbers from one sequence. Do not put the Linear key in prose or compute either number from the other. Keep the machine-parsed closing footer as `Fixes #N`.

**Dress each new issue.** The sync initially creates the Linear issue without a project or priority. `/dress <N>` waits up to three minutes for the sync's linkback comment — the GitHub comment that links to the Linear issue — then confirms the GitHub attachment. It sets a missing project from the `Board:` line and a missing priority from the issue template, or asks you, before reading the values back. It never overwrites values somebody already set. `/handoff` dresses issues filed during the session, `standards-change` dresses issues created by a flush, and a reminder follows an interactive `gh issue create`. If dressing cannot finish, the issue remains subject to the 24-hour triage backstop. On a repo without a Linear `Board:` line, `/dress` produces no output, makes no network request and asks no question.

## Shipping

Work happens on a short-lived branch off `main` (`type/short-slug`, matching the Conventional Commits type), never committed to directly. Commits follow `type(scope): verb object [qualifier]` — lowercase, imperative, the object named from the diff, an optional qualifier only when the object alone is ambiguous, and `Fixes #N` as a footer rather than part of the summary. A summary has to pass two tests: a reader who hasn't seen the branch could predict the diff from it alone, and no word in it could be deleted without losing information — which is what rules out intention words (`dogfood`), effort words (`improve`, `clean up`), and filler (`various`, `properly`).

Every change to `main` goes through a PR, even solo work, squash-merged so `main` stays one commit per change. CI must be green before merge. The harness does not merge PRs — a human does; that's a deliberate stop in the pipeline, not a missing feature. Which review and deploy skills run before that PR lands depends on the repo's profile — see the pipeline table below.

### Cutting a release — `/ship` does not tag

A release is four artifacts (repo-standards §5): a changelog entry, a bumped version constant, an **annotated git tag** `vX.Y.Z`, and a **GitHub Release** made from that tag. `/ship` produces the first two and stops.

This is worth stating plainly because `/ship` reads as though it handles the rest. Its step 15 says *"only the final commit (VERSION + CHANGELOG) gets the version tag"* — where "version tag" means the version string inside the commit message. It never runs `git tag` or `gh release create`. Following it to the letter leaves a changelog entry with no tag behind it, which §5 calls a violation, and it happened twice here before anything noticed.

So after `/ship`, by hand:

```
git tag -a vX.Y.Z <release-commit> -m "vX.Y.Z — <the changelog headline>"
git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z — <headline>" --notes-from-tag
```

`gh release create` rejects `--notes-from-tag` together with `--repo`; run it from inside the repo instead.

In a repo with a public export, `scripts/publish.mjs` refuses a real publish whose changelog names a version with no matching tag, so a forgotten tag stops the release rather than shipping a claim nobody can trace. A `--dry-run` reports the same gap as a warning and still runs — it copies nothing, so there is nothing to protect.

## Per-profile pipelines

Each profile's `skill-routing.md` defines a `## Pipeline` — the skill chain a change in that profile runs through before it ships — and a `## Off` list of skills that don't apply and why. All eight share the same spine (`brainstorming` → `writing-plans` → `/plan-eng-review` → `test-driven-development` → `/review` → `/ship`); the differences are what gets added or removed around it.

| Profile | Pipeline shape | Notably off |
|---|---|---|
| `gas-webapp` | Adds `using-git-worktrees`, deploys via `/gas-deploy` to `/dev`, then `/qa` before review; `/design-review` only when the change touches the UI. | `/land-and-deploy`, `/canary`, `/benchmark` — `clasp` is the only deploy path and there's no local perf harness. |
| `web-app` | The heaviest pipeline: `/design-consultation` for new surfaces, both `/plan-eng-review` and `/plan-design-review`, TDD alongside `/design-html`, then `/design-review` → `/qa` → full ship and deploy through `/land-and-deploy` → `/canary`. | `/gas-deploy` — wrong platform. |
| `app-monolith` | Adds `using-git-worktrees` and an `architecture-audit` pre-ship step unique to this profile, then ships and deploys via `/land-and-deploy`. Five repo-scoped architecture skills surface by description as needed. | `/gas-deploy`, `/canary` — wrong platform for a self-hosted service until a deploy target exists. |
| `local-tool` | The base spine, unmodified. | Deploy skills, the design family, `/qa`, and `/browse` — a terminal interface has no UI to QA or deploy. |
| `userscript` | Adds `/code-map` when the file grows, ahead of review. | Deploy skills (releases are a tag plus a raw file URL); `/qa`/`/browse` (QA is manual, in a real browser, signed into a real third-party account). |
| `design-vault` | `/design-consultation` for new surfaces, `writing-plans` only across multiple buckets, straight to `/review` → `/ship`. | `test-driven-development` (nothing executes); `/ship`'s test gate specifically (its changelog/version/PR mechanics stay on — `verify:` runs `validate-vault.mjs`, checking structure, not behavior); all deploy skills. |
| `content-library` | `writing-plans` only across multiple categories, then `/review` → `/ship`. | Same shape as `design-vault`: no TDD (nothing to test beyond the upstream-maintained validator), no `/qa` or deploy skills; `/ship`'s changelog/version/PR mechanics stay on, `verify:` runs the index validator. |
| `office-automation` | `writing-plans` across more than one workbook, then a VBA export (`scripts/export-vba.ps1`) and `/review` over the `vba/` diff before `/ship`. | `test-driven-development` (no runner, Excel can't run headless in CI — verification is the export plus a manual workbook run recorded in the PR); `/qa`, `/browse`, the design family; all deploy skills (the workbook ships by being opened, not deployed). |
