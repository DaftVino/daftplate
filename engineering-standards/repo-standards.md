# Repository Standards

Canonical reference for how James M. Baker's repositories are organized, named, branched, and documented. Quick-reference one-pagers: [naming](quick-ref-naming.md) · [workflow](quick-ref-workflow.md) · [repo template](quick-ref-repo-template.md).

**Audience:** James M. Baker and any AI agent working in one of these repos. When this document and habit disagree, this document wins. When a repo needs to deviate, record the deviation in an ADR (§6.3) — never deviate silently.

---

## 1. Naming conventions

One rule covers almost everything: **lowercase-kebab-case**. If you are about to name something and it isn't in the exceptions table below, use lowercase-kebab.

| Thing | Convention | Example |
|---|---|---|
| Repository | `lowercase-kebab` | `my-webapp` |
| Folder | `lowercase-kebab` | `docs/`, `assets/logo/` |
| Doc / config file | `lowercase-kebab.md` | `setup-guide.md`, `provider-notes.md` |
| Source file | Follow the language/platform norm | `Code.js` (Apps Script), `utils.js` |
| Branch | `type/short-slug` | `fix/capture-registry-cap` |
| Git tag | `vMAJOR.MINOR.PATCH` | `v2.0.5` |
| Design doc | `YYYY-MM-DD-slug.md` | `2026-07-01-fix-registry-cap.md` |
| ADR | `NNNN-slug.md` | `0003-use-properties-service.md` |

**Exceptions — canonical root files only.** UPPERCASE is reserved for the small set of files GitHub and the wider ecosystem treat specially: `README.md`, `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CLAUDE.md` / `AGENTS.md`. Nothing else in the repo gets uppercase names — no `ARCHITECTURE.md`, no `Logo/`. Architecture docs are `docs/architecture.md`.

**Slugs:** 2–5 words, hyphenated, no dates in branch names, no issue titles pasted verbatim. Optional but encouraged: prefix branch slug with the issue number (`fix/42-registry-cap`) so the branch is traceable without opening it.

## 2. Required root files

Every repo has these, and only these, at root besides source/config that must live there (e.g. `appsscript.json`, `package.json`):

| File | Purpose | Required |
|---|---|---|
| `README.md` | What it is, tech stack, install, usage, links into `docs/` | Always |
| `LICENSE` | MIT unless there's a reason otherwise; `Copyright (c) YEAR James M. Baker` (§2.1) | Always |
| `CHANGELOG.md` | Keep-a-Changelog format, one entry per released version | Always |
| `.gitignore` | Language/platform appropriate | Always |
| `CLAUDE.md` | AI agent entry point (§7) | Always |
| `CONTRIBUTING.md` | Only if outside contributions are expected | Public-facing repos |
| `SECURITY.md` | Only if the project handles credentials or user data | When applicable |
| `*.example` files | Template for every gitignored local config (`.env.example`, `.clasp.json.example`) | When applicable |

Anything else that reads like documentation goes in `docs/`. A root-level `api-key-setup-readme.md` is a violation — it belongs at `docs/api-key-setup.md`.

### 2.1 Identity and secrets

**Attribution:** LICENSE copyright line is `Copyright (c) YEAR James M. Baker`. Git identity is real-name (`git config --global user.name "James M. Baker"`) with GitHub's noreply email (`git config --global user.email "<user>@users.noreply.github.com"`). Enable both GitHub email privacy settings: *Keep my email addresses private* and *Block command line pushes that expose my email*.

**Secret protection — three layers, all required in every repo:**

1. **gitleaks pre-commit hook** — catches secrets locally, before they reach history at all. Install gitleaks (`winget install Gitleaks.Gitleaks`), then add a `.git/hooks/pre-commit` running `gitleaks git --staged`. Note: gitleaks 8.19 replaced `detect`/`protect` with `git`/`dir`, and 8.30 removed the old names — `gitleaks protect --staged` no longer runs.
2. **Server-side scanning** — one of the following, never neither:
   - **GitHub secret scanning + push protection** (Settings → Code security). Blocks offending pushes outright. Free on public repos; on private repos it needs GitHub Advanced Security, so it is unavailable on the free tier.
   - **A `secrets` CI job** running gitleaks over the full history, for repos where the above is unavailable. It cannot block a push, but paired with a branch rule requiring the check to pass, it keeps secrets out of `main`. This is a required substitute, not an optional extra: the pre-commit hook is local-only and `--no-verify` walks straight past it.
3. **`.example` pattern** — every gitignored config with secrets gets a committed sanitized `*.example` twin. No real key ever appears in a tracked file.

A private repo that later goes public gains free secret scanning at that moment — but its history is already published by then, so layer 2 has to have been doing its job all along.

If a secret does land in history: **rotate the credential first** (treat it as burned — scrubbing history is cleanup, not remediation), then rewrite history only if the repo is public.

## 3. Canonical folder structure

Minimal template. Create folders only when there is content for them — empty scaffolding is noise.

```
repo-name/
├── src/                  # Source code (or platform equivalent; Apps Script may keep Code.js at root)
├── tests/                # Test code. Tests are code, never markdown notes.
├── scripts/              # Dev/build/verify tooling (local-verify.js, deploy helpers)
├── assets/               # Images, logos, static media
├── docs/
│   ├── architecture.md   # How the system works (living doc, kept current)
│   ├── designs/          # Fix/feature plans, written BEFORE the work (§6.2)
│   ├── adr/              # Architecture Decision Records (§6.3)
│   └── *.md              # Guides: setup, troubleshooting, runbooks
├── .github/
│   ├── ISSUE_TEMPLATE/   # bug-report.yml, feature-request.yml
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── workflows/        # CI/CD
├── README.md · LICENSE · CHANGELOG.md · CLAUDE.md · .gitignore
```

Rules of thumb:

- `docs/` is flat except for `designs/` and `adr/`. Don't create `docs/bugs/`, `docs/fixes/`, `docs/plans/`, `docs/tests/` — each of those has a proper home (§6).
- One concept, one file. A troubleshooting guide and a setup guide are two files, not sections of a mega-doc.
- Media goes in `assets/`, not a capitalized `Logo/` at root.

## 4. Branching and commits (GitHub Flow)

`main` is always releasable. All work happens on short-lived branches off `main`, merged back via PR, branch deleted after merge. No `develop`, no long-lived release branches.

**Branch types:**

| Prefix | Use |
|---|---|
| `feat/` | New functionality |
| `fix/` | Bug fix |
| `docs/` | Documentation only |
| `refactor/` | Code change, no behavior change |
| `chore/` | Tooling, deps, config, CI |
| `test/` | Adding or fixing tests only |

**Commits — Conventional Commits:** `type(scope)?: imperative summary` in lowercase, ≤72 chars, body optional but required when the *why* isn't obvious.

```
fix(sync): cap capture_registry writes at 8KB

PropertiesService silently truncates past 9KB; leave headroom.
Fixes #42
```

Types match branch prefixes plus `perf`, `style`, `ci`. Breaking changes get `!` (`feat!:`) and a `BREAKING CHANGE:` footer.

**PRs:** every change to `main` goes through a PR, even solo — the PR is the review checkpoint for AI-generated work and the permanent record of what changed and why. Squash-merge so `main` history stays one-commit-per-change. PR description links its issue (`Fixes #42`) and its design doc if one exists.

### 4.1 The summary formula

Every commit summary, branch slug, and PR title fills the same five slots. The summary names **what the change does to the code**, in the vocabulary of the codebase — not the intention behind it.

```
type(scope): verb object [qualifier]
```

| Slot | Rule | Example |
|---|---|---|
| `type` | The fixed set above, plus `perf`, `style`, `ci`. Lowercase, required. | `chore` |
| `(scope)` | The module, file, or subsystem **as the repo already names it**. Omit when the change is repo-wide — never invent one to fill the slot. | `(sync)` |
| `verb` | Imperative present tense, naming the operation performed on the code. Required. | `add` |
| `object` | The thing changed, in words from the diff: a path, identifier, flag, or symbol. Required. | `.claude/settings.json` |
| `qualifier` | Optional `to…` / `for…` / `on…` / `when…` clause. Include **only** when the object alone is ambiguous. | `to run the orient hook` |

Worked example:

```
chore: add .claude/settings.json to run the orient hook
─────  ─── ───────────────────── ────────────────────────
type   verb        object              qualifier
```

**Issue references are a footer, never part of the summary.** `Fixes #42` goes on its own line in the body. The `(#12)` visible on `main` is appended by GitHub at squash-merge — never type it yourself.

**Branch slugs** compress `verb object` to kebab and drop the qualifier: `chore/add-claude-settings`, `refactor/extract-walk-files`.

**Verb menu.** Reach for one of these before inventing a verb; if none fits, the commit is probably doing two things.

| Operation | Verbs |
|---|---|
| Creates something that did not exist | `add`, `introduce` |
| Deletes something | `remove`, `drop` |
| Relocates with no behaviour change | `move`, `extract`, `inline`, `rename` |
| Swaps one implementation for another | `replace`, `switch` |
| Connects pieces that already exist | `wire`, `register`, `expose` |
| Constrains or hardens behaviour | `cap`, `guard`, `retry`, `skip`, `escape`, `debounce` |
| Corrects wrong behaviour | `fix`, `correct` |

### 4.2 The two tests

A summary ships only if it passes both.

1. **Predictable** — could a reader who has not seen this branch predict the diff from the summary alone?
2. **Every word earns its place** — is there a word that could be deleted without losing information?

Test 2 is what rules out gibberish. Three categories fail it: **intentions** (`dogfood`, `make it work`, `finalize`), **effort** (`improve`, `clean up`, `tweak`, `polish`), and **filler** (`various`, `some`, `stuff`, `properly`, `as needed`). None of them name an operation or an object, so none of them survive a `git log --grep` six months later.

Industry terms of art are fine — they fail nothing when they *are* the precise word. `test: bake off code-map against rg on the 775KB userscript` passes both tests: `bake off` is the operation, and the object is named.

| Rejected | Why | Write |
|---|---|---|
| `chore: dogfood the orient SessionStart hook #12` | intention, no object edited, `#12` belongs in a footer | `chore: add .claude/settings.json to run the orient hook` |
| `fix: improve sync reliability` | effort, unpredictable diff | `fix(sync): retry capture writes on 429` |
| `refactor: clean up the walker` | effort, vague object | `refactor: move walkFiles into scripts/lib/fs.mjs` |
| `feat: various parser updates` | filler, plural object | split into one commit per change |

The *why* goes in the body, where there is room to be precise about it.

## 5. Versioning and releases

- **SemVer:** MAJOR = breaking, MINOR = new features, PATCH = fixes.
- Every released version gets: a `CHANGELOG.md` entry (Keep-a-Changelog: Added/Changed/Fixed/Removed), an annotated git tag `vX.Y.Z`, and a GitHub Release created from that tag (`gh release create vX.Y.Z --notes-from-tag` or paste the changelog section).
- The version displayed in the app must come from one source of truth per repo (a constant or `package.json`), bumped in the release commit: `chore(release): v2.0.6`.
- A changelog entry with no matching tag is a violation — the tag is what makes the version traceable.

## 6. Tracking taxonomy: where things live

The core decision rule:

> **Needs to be tracked and closed?** → GitHub Issue.
> **Explains how you'll build/fix something, before building?** → `docs/designs/`.
> **Records a lasting, hard-to-reverse decision?** → `docs/adr/`.
> **Everything else** → the PR description.

Issues and milestones are surfaced for work on the repo's GitHub Project board (§6.5), which is a view over them and never a separate store.

### 6.1 Bugs → GitHub Issues

All bug reports live in GitHub Issues, created from the `bug-report.yml` template (repro steps, expected vs. actual, environment, report ID if applicable). Investigation notes go as **comments on the issue** as you dig — not separate files. Label minimally: `bug`, `enhancement`, `blocked` cover most needs.

The fix is a PR whose description says `Fixes #N`, which closes the issue on merge. AI agents interact via `gh` CLI: `gh issue list`, `gh issue view N`, `gh issue create`, `gh issue comment N`.

### 6.2 Plans → `docs/designs/`

A design doc is a **work plan written before the work**. File: `docs/designs/YYYY-MM-DD-slug.md`, from the [design-doc template](templates/design-doc.md). It links the issue(s) it addresses; the PR links back to it.

**When to write one — any of:** the fix spans multiple PRs or systems; it changes persisted data shape (also run the migrate skill); it's risky enough that you want the approach reviewed before code exists; an AI agent will execute it and needs unambiguous instructions. **When not to:** the plan fits in a PR description. Most fixes need no design doc.

Design docs are point-in-time artifacts — they go stale by design and are never updated after implementation (append a one-line `Outcome:` note at most). Lasting knowledge gets promoted to `docs/architecture.md` or an ADR.

### 6.3 Decisions → `docs/adr/`

An ADR records a decision and its rationale so future-you (or an agent) doesn't re-litigate it. File: `docs/adr/NNNN-slug.md`, lightweight MADR format ([template](templates/adr.md)): Status / Context / Decision / Consequences, one page max.

Write one when a decision is expensive to reverse, constrains future work, or you've already argued about it twice. Expect 2–5 per repo per year. ADRs are never edited after acceptance — a reversal is a *new* ADR that supersedes the old one (update the old one's Status line only).

### 6.4 What is deliberately NOT a document

- **Fixes** are PRs. There is no `fixes/` folder anywhere.
- **Tests** are code in `tests/`, delivered in the same PR as the fix. A test plan, if ever needed, is a section of the design doc.
- **Task lists / todos** are issues (or checklists inside one issue). Not `todo.md`. Tracked on the repo's project board (§6.5).

### 6.5 Boards → GitHub Projects

Tasks are tracked on a GitHub Project. The rules exist so the board stays a *view* of reality rather than a second, competing copy of it.

1. **One project per repo. Never cross-repo.** A project belongs to exactly one repository. Work that spans repos is an issue in each, linked by URL — never one card claiming to cover both.
2. **The issue is canonical; the project is a view.** Every card is backed by a real issue. Where a card and its issue disagree, the issue wins.
3. **No draft items.** Draft cards are invisible to `gh issue list`, which means they are invisible to every AI agent working in the repo. Convert on creation, or do not create it.
4. **Phases are Milestones, not project fields.** Milestones are native to issues, report completion percentage, and survive the project being deleted. A milestone closes only when every issue in it is closed.
5. **Type mirrors the commit vocabulary** — `feat`, `fix`, `docs`, `refactor`, `chore`, `test` (§4). One vocabulary across branch prefix, commit type, and issue type; nothing needs translating.
6. **Priority mirrors the review vocabulary** — `P1` blocks the release, `P2` lands the same branch, `P3` is a follow-up. The same scale the review skills emit, so findings drop straight onto the board.
7. **Status: Backlog → Ready → In progress → In review → Done.** Movement is automated (auto-add on issue open, auto-move to Done on close). Manual dragging is a smell: it means the issue and the board have diverged.
8. **No estimate or size fields.** Effort estimation carries little signal when the executor is an agent, and an unused field is a field that lies.

Creating the project needs the `project` scope on the `gh` token: `gh auth refresh -s project`.

## 7. AI agent integration

Every repo's `CLAUDE.md` (from `base/files/CLAUDE.md`, applied by `/new-project`) covers: what the project is (2–3 lines), pointers to `docs/architecture.md` and this standards document, repo-specific commands (verify, test, deploy), and repo-specific constraints. It states the standing rules for agents:

1. Bugs and tasks are in GitHub Issues — read them with `gh issue view N` before starting work.
2. Non-trivial work requires a design doc in `docs/designs/` before implementation.
3. Branch, commit, and PR conventions per §4. Never commit directly to `main`.
4. Check `docs/adr/` before proposing architectural changes; a conflicting proposal must supersede the ADR explicitly.

Keep `CLAUDE.md` short (< ~60 lines). It is a router, not a manual — detail lives in `docs/` where humans read it too.

## 8. Migrating existing notes into this system

Existing ad-hoc bug files are usually a **fused artifact**: bug report + investigation notes + partial fix plan in one file. Split them along the §6 seams. Worked example, using a hypothetical `registry-cap-bug.md`:

| Content in the old file | Destination |
|---|---|
| "Captures silently stop saving past ~20 connections" + repro steps | **Issue body** — `gh issue create` from the bug-report template |
| "Dug in: PropertiesService truncates at 9KB, our registry hit 9.1KB" | **Issue comment** — investigation record |
| "Plan: chunk the registry across N properties, migrate existing data" | **Design doc** — `docs/designs/2026-07-01-chunk-capture-registry.md`, links the issue (multi-step + data migration ⇒ earns a design doc) |
| "We should stop using a single shared property for this pattern" | **ADR** — `docs/adr/0004-chunked-property-storage.md`, if you want the rule to outlive this fix |

Then delete the original file. If the fix is small enough that the "plan" is two sentences, skip the design doc — the plan goes in the issue and then the PR description.

Migration checklist per file: (1) create the issue, (2) move investigation to comments, (3) create design doc only if it meets §6.2 criteria, (4) extract any lasting decision to an ADR, (5) delete the source file, (6) do the fix on a `fix/N-slug` branch with `Fixes #N`.

## 9. New repo checklist

1. Name: `lowercase-kebab`, noun-first, no filler (`my-webapp`, not `My-Web-App`).
2. Create root files (§2) and `.github/ISSUE_TEMPLATE/bug-report.yml` + PR template from [templates/](templates/). LICENSE copyright: `James M. Baker`.
3. Enable secret scanning + push protection (Settings → Code security) and install the gitleaks pre-commit hook (§2.1).
4. `/new-project` assembles `CLAUDE.md` from `base/files/CLAUDE.md` plus the profile fragments; fill in the project summary if scaffolding by hand.
5. Create `docs/` with `architecture.md` stub; add `designs/` and `adr/` when first needed.
6. First ADR (`0001-…`) if the repo embodies a non-obvious platform choice.
7. Branch protection on `main`: require PR (even solo).
8. Tag `v0.1.0` at first working state; start `CHANGELOG.md`.
