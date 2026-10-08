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

**Exceptions — two, both at the repository root.**

1. **Canonical files, enumerated.** UPPERCASE is reserved for the small set GitHub and the wider ecosystem treat specially: `README.md`, `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CLAUDE.md` / `AGENTS.md`. The list is closed.

2. **Ecosystem tool files, by shape.** A root file whose name is an uppercase letter, then lowercase letters or digits, then a lowercase `file` — optionally followed by a lowercase-kebab variant suffix. `Dockerfile`, `Dockerfile.prod`, `Makefile`. These are not style choices: Docker looks up that exact name and finds no default without `-f`, so renaming one to satisfy a naming rule breaks the build. The rule is a shape rather than a list because an enumeration is wrong again the next time a convention appears.

   The shape is deliberately narrower than "extensionless TitleCase", which would also admit a stray `Readme` beside a correct `README.md`. `DockerFile` and `Dockerfile.Prod` are violations. The cost, stated rather than hidden: an accidental `Readmefile` passes.

Nothing else gets uppercase names — no `ARCHITECTURE.md`, no `TODOS.md`, no `Logo/`. Architecture docs are `docs/architecture.md`.

**Slugs:** 2–5 words, hyphenated, no dates in branch names, no issue titles pasted verbatim. **A branch slug is prefixed with its issue number** — `fix/42-registry-cap`, not `fix/registry-cap` — so the branch is traceable without opening it. This used to read "optional but encouraged", which contradicted the non-negotiable gate requiring `type/N-slug`; §4 now says how it is enforced.

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

### 2.2 CI supply chain

Everything a workflow pulls in is code that runs with the job's credentials. Both
rules below are enforced mechanically by `checkWorkflows` in
`scripts/verify-templates.mjs`, over every workflow the daftplate repo ships.

1. **Every `uses:` is pinned to a full 40-character commit SHA**, with a trailing
   `# vX.Y.Z` comment naming the release. `@v4` is a tag, and a tag is a mutable
   pointer the action's owner — or anyone who compromises them — can repoint at
   different code after the pin was reviewed. The comment is not decoration: the
   SHA alone tells a reader nothing, and Dependabot rewrites the comment when it
   bumps the pin.
2. **Anything downloaded is verified against a digest committed in the workflow
   file, before it is executed or extracted.** Two failure modes, both real:
   piping a download straight into `tar` or `bash` makes the bytes never a file,
   so nothing *can* check them; and fetching the project's own checksums file
   from the same release at the same moment verifies nothing, because whoever
   can alter the artifact can alter the checksums beside it. The trust anchor
   has to be a literal that a human reviewed in a diff. Bumping the version and
   bumping the digest are one commit, never two.

**Least privilege alongside them.** Every job declares `permissions: contents:
read` unless it demonstrably needs more, and every `actions/checkout` sets
`persist-credentials: false`. Checkout writes `GITHUB_TOKEN` into `.git/config`
by default, which leaves the repo credential in reach of every later step —
including, in the case above, a third-party binary the job just downloaded.

### 2.3 Baseline security controls

This subsection sits under a heading that says "Required root files" because §2.1 and §2.2 already hold this repo's security rules, and splitting the cluster across two top-level sections would be worse than an imperfect heading.

**Cyber Essentials assesses an organisation's devices, networks and cloud-service accounts. None of its five controls can be met by a standards document, and this section does not claim otherwise.** What follows are *repository analogues* of three of them, written as rules a repo can satisfy. **Firewalls and Malware protection have no repository expression at all** and are named here so nobody reads three-fifths of a scheme as the whole of it — which is the failure §5.1 exists to name, one level up.

**1. Secure configuration.** §2.1 covers secret protection in three layers and the `.example` twin pattern; §2.2 covers CI least privilege. Added here: **no default or shared credential appears in any shipped config file.**

**2. Security update management.**

- **Dependabot alerts are enabled on every repo with a GitHub remote.** Alerts and `dependabot.yml` version updates are different mechanisms: alerts run off the dependency graph and involve that file not at all.
- `dependabot.yml` **declares an ecosystem entry for every package manager the repo actually uses.** A repo with a `package.json` and no `npm` entry is a violation. A repo with no manifest adds no entry — an entry naming an absent manifest is itself a defect, and it trains people to ignore Dependabot.
- Security updates the vendor rates **high or critical are applied within 14 days of the vendor releasing the update** — the vendor's release, not the advisory's publication. Where a vendor supplies no severity, high or critical means a **CVSS v3 base score of 7.0 or above**.
- Software past **end of life is removed** from the repo's supported set. Segregation is the mechanism by which removal from scope is achieved, not an equal alternative that lets end-of-life software stay.

**Enforcement, stated plainly.** This is prose, plus whatever `setup-repo --remote` enabled the last time a human pointed it at a repo. That is an opt-in step, not something scaffolding fires, so **the rule outruns its enforcement here**. A `verify-repo` ecosystem-coverage check is the next layer and is deliberately deferred rather than implied.

**3. User access control.** **MFA is required on GitHub and on any host holding deploy credentials.** §2.2 covers CI least privilege. Branch protection on `main` is required by the §9 checklist — with the tier caveat `docs/architecture.md` records: protection and rulesets return 403 on a private repo on the free plan, which is not a permissions problem and is not offered in the Settings UI either. Where the plan forbids it, the substitute is a required CI check plus a stated intent to enable protection on visibility change, written the way §2.1 layer 2 writes its substitute.

Cyber Essentials' user access control additionally covers, **among other requirements**, unique per-user accounts, an account-creation approval process, authenticating users before granting access, removing accounts no longer required, removing special access privileges when no longer required, separate admin accounts used only for admin tasks, and password policy. **A repository standard governs none of them.** The words "among other requirements" are deliberate: naming a closed set of five would reproduce the partial-coverage failure at a smaller scale.

**Not covered, by name:** Firewalls, Malware protection, and the whole of the user-access-control list above. This section is not a conformance claim and no certification is being pursued.

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
│   ├── records/          # Durable output of a skill, namespaced per skill (§6.3)
│   └── *.md              # Guides: setup, troubleshooting, runbooks
├── .github/
│   ├── ISSUE_TEMPLATE/   # bug-report.yml, feature-request.yml
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── workflows/        # CI/CD
├── README.md · LICENSE · CHANGELOG.md · CLAUDE.md · .gitignore
```

Rules of thumb:

- `docs/` is flat except for `designs/`, `adr/` and `records/`. Don't create `docs/bugs/`, `docs/fixes/`, `docs/plans/`, `docs/tests/` — each of those has a proper home (§6). A profile's `docs-subdirs` adds to those three; it never replaces them.
- **One further exception, opt-in and never a default: a stable *content class* whose flattening would make the namespace misleading.** Business or market material, or small reader-facing example files, are the cases this exists for. Three conditions, all required: the directory names a durable class of content rather than a stage of work; the repo declares it explicitly through `docs-subdirs` or `--docs-subdirs=`, so nothing is blessed by convention; and the repo records the local reason in an ADR. **This is not a loophole for `bugs/`, `fixes/` or `plans/`** — those name where work *is*, not what content *is*, and they stay prohibited however they are declared. Nothing is added to the global defaults: a class that has earned an exception in one repo has earned it in one repo.
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

**The full form is `type/N-slug`**, where `N` is the GitHub issue number with no leading zero: `fix/62-scaffold-dest-guard`. The number is what makes the PR-to-issue link visible before a PR body exists — and on the §6.5.1 board variant, where GitHub and Linear sequences drift, the branch name is the one place the GitHub number is unambiguous.

**Enforced by a pre-push hook**, installed by `setup-repo` alongside the gitleaks pre-commit hook. It reads the push's ref lines from stdin rather than the current branch, because a push can target a differently named remote ref or a branch that is not checked out. It refuses a direct push to `main` or `master`, ignores tags and deletions, and rejects the whole push if any one ref is misnamed.

The escape hatch is `DAFTPLATE_ALLOW_NONSTANDARD_BRANCH=1 git push`, for one push, and it prints a line on stderr saying it fired. It is named rather than silent for a reason that applies to every gate: one with no exit gets deleted wholesale the first time it is wrong, and then nothing is enforced at all.

An existing repository picks the hook up by re-running `setup-repo`; `--check` reports it missing without installing it.

**Commits — Conventional Commits:** `type(scope)?: imperative summary` in lowercase, ≤72 chars, body optional but required when the *why* isn't obvious.

```
fix(sync): cap capture_registry writes at 8KB

PropertiesService silently truncates past 9KB; leave headroom.
Fixes #42
```

Types match branch prefixes plus `perf`, `style`, `ci`. Breaking changes get `!` (`feat!:`) and a `BREAKING CHANGE:` footer.

**PRs:** every change to `main` goes through a PR, even solo — the PR is the review checkpoint for AI-generated work and the permanent record of what changed and why. Squash-merge so `main` history stays one-commit-per-change. PR description links its issue (`Fixes #42`) and its design doc if one exists.

**Branch off `main`, never off another branch.** A stacked branch breaks the moment its parent squash-merges: the parent's commits collapse into one new commit, so from the child every one of them still reads as unmerged, and `git rebase main` replays the whole parent feature on top of itself. The recovery is `git rebase --onto main <parent-tip-before-merge> <child>`, which replays only the child's own commits — run it as soon as the parent lands, before anything else builds on the child. When two agent sessions need to work at once, both branch from `main` and one resolves a merge conflict later; that cost is small and predictable, and the stacking trap is neither.

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
- **A release is not done until all four artifacts exist.** Bumping the version constant and writing the changelog entry is half a release; the tag and the GitHub Release are the half that makes it findable. Treat `chore(release): vX.Y.Z` as the *start* of the release, not the end.

### 5.1 How this is enforced

Stating the rule is not enforcing it. Measured 2026-07-28: two consecutive releases in this repo's own toolchain shipped with a changelog entry, a version bump, and no tag — a three-day gap nothing detected, because §5 was prose and no check read it. Enforcement is layered, and each layer names what it catches:

1. **Release procedure.** Whatever cuts your release must create all four artifacts in one sequence. **`/ship` does not tag** — it says "the final commit gets the version tag", meaning the version string in the commit message, and never runs `git tag` or `gh release create`. Read that as a known gap and tag by hand after it, or the release stops at half-done exactly the way it did here.
2. **Publish gate (fail-closed).** A repo with a public export refuses to publish a changelog whose released versions are not all tagged: publishing is where an untagged release stops being a local oversight and becomes a public claim. In this repo that is `scripts/publish.mjs` — `untaggedReleases()` is a pure check over changelog text and a tag list, so the rule is testable without a git call. A dry run reports the gap and is not refused, because it copies nothing and refusing it would break the inspection a dry run exists for.
3. **Periodic sweep.** A commit-time gate cannot work: between the release commit and the tag push the tag legitimately does not exist, so the check would false-fire or need a grace period. The invariant is *"a released version is traceable"* — a state converged to within minutes, not a property of a single commit. Detect drift with a periodic cross-repo scan rather than a blocking hook, which is also the only layer that reaches repos never scaffolded from a template.

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

**Size budgets.** A design doc stays ≤ ~15KB; past that it splits into a parent contract and per-phase children. Specs are written only for work scheduled within the next two slices — no spec ahead of demand. Generated artifacts (code maps and similar) ship as an index plus shards small enough to read whole. Any doc whose guidance includes "read in slices, never whole" is over budget by definition; split it. **Lifecycle:** superseded planning docs move to `docs/archive/`, which `/orient` and reading-order rules skip. Corrections of the do-not-revert class are extracted into a single always-read `docs/designs/hard-won-constraints.md` (≤ ~4KB) rather than living inside the handoff logs that discovered them.

### 6.3 Decisions → `docs/adr/`

An ADR records a decision and its rationale so future-you (or an agent) doesn't re-litigate it. File: `docs/adr/NNNN-slug.md`, lightweight MADR format ([template](templates/adr.md)): Status / Context / Decision / Consequences, one page max.

Write one when a decision is expensive to reverse, constrains future work, or you've already argued about it twice. Expect 2–5 per repo per year. ADRs are never edited after acceptance — a reversal is a *new* ADR that supersedes the old one (update the old one's Status line only).

**Records → `docs/records/<skill>/`.** When a skill produces a durable artefact that is neither a plan nor a decision — the transcript and falsifiers of an expensive review, say — it goes in `docs/records/<skill-name>/YYYY-MM-DD-slug.md`, namespaced by the skill that wrote it. `/deliberate` writes `docs/records/deliberate/`. The namespace is what keeps this from becoming a second `docs/misc/`: a directory with no owning skill does not belong here. `records/` is universal — allowed in every repo whatever its profile, and a profile's `docs-subdirs` adds to it rather than replacing it. An ADR still owns the *decision*; the record owns the argument that produced it, so a record without a corresponding ADR or issue is a transcript nobody will act on.

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

### 6.5.1 Variant: boards on Linear

A repo may move its board from GitHub Projects to Linear when phased work with real dependencies, milestone structure, or cross-repo visibility outgrows Projects. The precedent and full rationale is recorded in the ADR of the repo that piloted the variant; a repo adopting it records its own ADR pointing there.

The three §6.5 anchors transpose, not lapse: one Linear Project per repository, never cross-repo; the GitHub issue stays canonical for *existence* while Linear is canonical for *state*; and no-draft-cards becomes *nothing tracked may live only in a Linear document or project description*. On top of them: **creation is always GitHub** (`gh issue create` from templates — on the free plan, Linear→GitHub creation sync works for exactly one repo, so a GitHub-creation process is the only one every repo can copy; keep that sync off even where it would work). Issues are **dressed in Linear by the `/dress` step** (ADR 0014): project from the `Board:` line; priority (Urgent/High/Medium = P1/P2/P3 of rule 6; Low = parked) from the issue template's dropdown or from the filer, never invented; milestone and blocking relations when the caller knows them, otherwise reported as needing a human. It finds the Linear issue through the sync's own linkback comment and confirms the issue's GitHub attachment before it writes, waits a bounded three minutes for the sync, and reads back what it set. It **skips cleanly on every other repo**: where the `Board:` line does not name Linear, there is no output, no network call and no prompt. It runs in-session with the session's Linear tools, so no repository holds a key; `/handoff` and `standards-change` call it, and a user-level reminder hook prompts it after a `gh issue create`. **The 24h rule is the backstop**, for when the step could not run — a sync slower than its wait, no session, nobody to ask: an issue still undressed 24h after filing is the variant failing. **Milestones mirror the repo's ROADMAP sections**, per §6.6. **Done requires evidence attached as a comment** (§6.6's ladder), and PRs close via `Fixes #N` with the GitHub number — identifier sequences drift and are never computed from each other. Known bounds, watched at the repo's weekly triage: 250-issue sync ceiling (close-and-archive before ~200), 10MB attachment sync limit (large artifacts go in the repo, linked from the issue).

**Name an issue `<short>-<N>` — the repository's short name, a hyphen, and the GitHub number, as in `daftplate-357` — wherever a human will read the prose and act on it** (ADR 0014). The short name is the link text of the project link on the `ROADMAP.md` `Board:` line: one Linear project per repository makes it unique across the workspace, and it is the name the reader meets on the board. In scope: PR bodies, review comments naming follow-up work, issue bodies and comments, handoff notes, session prompts, status reports — **chat status reports to the operator included**, since that is where the next decision gets made — and commit bodies. A commit body squash-merged onto `main` (§4) is the one surface a bare reference can never be repaired on later. The form applies **per reference, not per document**: every mention carries it, not the first. It replaces the pair `#N (FORGE-M)`, which named an issue twice and still did not say where it lived — `#N` resolves against whatever repository the reader is standing in, and measured 2026-08-22 in this workspace, `#130` in one repository is `FORGE-224` while `#130` in another is `FORGE-223`; `FORGE-M` is unique and names no repository at all. A **pull request** takes the same form: issues and pull requests share GitHub's counter, and `/issues/N` redirects to the pull request. **Another repository's issue** is `<its-short>-<N>` when that repository is on this variant and `owner/repo#N` when it is not. **The Linear key never appears in prose.** It stays the board's own handle for the issue, reached from the GitHub issue's first comment, which the sync posts as a link to the board. The two numbers can never be made to agree — a Linear key is the team key plus Linear's own sequence, neither of which can be set, and GitHub numbers issues and pull requests from one counter — so the written form is built from the GitHub number, which is canonical for existence, and neither number is ever computed from the other. The form needs nothing from the sync, so prose written in the same breath as `gh issue create` uses it too. It is **plain text on GitHub**: custom autolink references would link it and are not offered on the free plan; where a repository's plan offers them, configure the prefix on that repository and never on a public export, whose issues are different issues. The **`Fixes #N` footer and the commit summary line are untouched**: the footer is machine-parsed and stays the bare GitHub number, §4.1 already bans issue references from the summary, and this clause reaches body prose only. **Prose written before ADR 0014 is legacy** and is read as written — `#N (FORGE-M)` there is the GitHub number and a board handle — never rewritten; the files a session reads as instructions (`CLAUDE.md`, the scaffolded quick-ref, the roadmap) carry the new form. **Nothing checks it yet.** Only two of those surfaces have any committed form (a PR body, a `## Handoff log` entry), and a partial check nobody reads as partial becomes evidence the convention holds everywhere — so this is the fifth clause here carried by convention, beside creation-is-GitHub, the 24h dressing rule, milestones mirroring the roadmap, and Done requiring evidence. The clause that follows is the section's sixth and the only one with any enforcement at all, and it is partial — which §6.6.1 states rather than leaving to be discovered.

**Never write a closing keyword adjacent to an issue number except as an actual footer.** GitHub's auto-close parser ignores code spans, block quotes and negation — a body saying a footer *would have been wrong* still closes the issue, and a sentence warning about the trap springs it. To write about one, break the token: put the keyword and the number in separate spans joined by an explicit `+`, or name the issue alone and describe the keyword in words. This reaches every surface in the paragraph above, and it is the one clause here whose violation is **silent** — no CI signal, no review comment, no diff, and at review the rendered body shows a code span rather than a footer. It selects for the issues that can least afford it: you only write carefully about a footer when there is a reason to be careful. Measured twice in this workspace, both times launch-pad prose copied verbatim into a PR body, the second closing a `human-only` row that blocked a deploy. Recorded as **ADR 0012**, which also carries the falsifier: if GitHub ships parser behaviour exempting code spans or block quotes, the clause narrows to unformatted prose — the current behaviour was observed directly rather than read from documentation. **This one is checked, on one surface of several**: `skills/continuum/scripts/validate-prompt.mjs` refuses it in the launch pad, which is where both occurrences entered; §6.6.1 records what that check does not reach.

Creating the project needs the `project` scope on the `gh` token: `gh auth refresh -s project`.

### 6.6 Evidence: what "done" means

Every claim of completeness names a rung on this ladder: `specified → unit-tested → persisted → wired → real-provider-proven → journey-accepted → beta-ready`. A handoff note, issue closure, or plan that says "complete" without naming the rung is malformed. Closing an issue at `journey-accepted` or above requires the evidence attached as a comment — a test run, a command transcript, a screenshot of the real journey; green unit tests alone close nothing above `unit-tested`.

**An app-profile repo keeps a ROADMAP.md at root.** Which repos those are is not a judgement call: a repo is app-profile when the profile that produced it declares `roadmap: required` in the fenced ` ```profile ` block of `profiles/<type>/profile.md` — `app-monolith`, `web-app`, `gas-webapp` and `userscript`. The test the classification applies is *does anyone outside this repo depend on it shipping*, which is why `userscript` is in the list despite having no deploy step and why the existing `deploy:` key was rejected as a proxy for it. The other four profiles declare `roadmap: optional`; a profile declaring neither is a violation `verify-templates` reports, and a value other than those two is a violation rather than a default.

The template is `base/files/ROADMAP.md` and it ships to **every** scaffolded repo. The meta key governs the requirement to keep one, not the copy: under `optional`, deleting the file is a correct first act; under `required`, it is the repo's only live state document.

Its shape. `## Now` and `## Next` are tables of `Item | Closes when | Rung`, where the rung is one of the seven above and the middle cell names the evidence that closes the row, never the activity that fills it. `## Now` holds at most five rows. `## Later` is a horizon, `## Parked` is what was deliberately dropped, `## Standing decisions` holds the rulings a reader must not relitigate — the ADRs in force, the doc of record, and each accepted deviation from this document — and `## Standing gates` holds the duties that never close — dependency alerts triaged, secrets rotated, a restore actually performed, access reviewed — each row naming its cadence and the date it was last verified, because a gate with no date is a claim and not evidence, which is the argument this section already makes about closing an issue without naming a rung. Exactly one line beginning `Board:` survives: the template carries both the §6.5 GitHub Projects form and the §6.5.1 Linear form and instructs the adopter to delete the other, because reading the two side by side at the moment the file is open is how the split gets taught. No `Updated:` line and no owner column — `git log -1 -- ROADMAP.md` and `git blame` answer both and cannot go stale, which a hand-stamped date always does. No size or estimate column: §6.5 rule 8 bans it on the board, and a roadmap that reintroduces it puts the two surfaces back into disagreement.

Session handoffs go to issue comments. Standalone remaining-work docs are forbidden — they multiply, go stale, and get read anyway. Exactly one launch-pad file is permitted, at `docs/designs/next-session-prompt.md`: `/continuum` writes it, the session that picks it up deletes it, and it must validate clean against `skills/continuum/scripts/validate-prompt.mjs` with the branch, issue and path context supplied — **as its reader will stand, not as its writer did.** Every rule in that validator is time-invariant except the branch check, and the launch pad is the one artifact written on a feature branch and read after that branch has merged and been deleted. Supplying the writing branch certifies a line that is true for one commit and false from the merge onward, which is how the first such file rotted; supply the branch the next session will actually be on, normally the repo's default. A second such file, or one that fails validation, is a violation. Plans in `docs/designs/` still follow §6.2; the ROADMAP is state, not planning.

Repos with a product surface also declare a **charter** (target user, the wedge, the promise, non-goals) — in the ROADMAP's own `## Charter` section, which the template ships, or in an ADR — and `writing-plans` must cite the charter line a plan serves. A plan serving no line is rejected at review, which is the moment scope creep becomes visible instead of retrospective.

### 6.6.1 What is not checked

A rule nobody reads as partial becomes evidence that it holds everywhere, which is worse than an admitted convention because it stops anyone looking for the gap. §6.5.1 carries five such clauses for that reason, and a sixth — the closing-keyword clause — that is checked on one surface of the seven it reaches, which is the same failure wearing a green tick unless the gap is stated; the list below carries eight.

A ROADMAP check establishes, each over a complete surface: that the file exists wherever the manifest's profile declares `roadmap: required`; that `## Now` and `## Next` are both present; that each is followed by a table headed `Item | Closes when | Rung`; that every body row's third cell is exactly one backticked rung from the seven-item ladder; that no body row's "Closes when" cell is empty; that exactly one `Board:` line survives; and, under `required`, that no `<placeholder>` and no shipped example row remain.

It establishes none of the following, which are carried by convention:

- **The five-row cap on `## Now`.** The number is a per-repo judgement, and a check would harden a default nobody chose.
- **`Last verified` freshness in `## Standing gates`.** Checkable in principle, but the cadences are per-row prose; a check that parsed some of them and not others is the partial kind this section forbids.
- **The presence of `## Charter`.** It is scoped above to repos with a product surface, and nothing in a repo states whether it has one.
- **Whether a rung is honest.** A check proves a rung was named. It cannot prove it was earned, and this is the most important of the five: a green check here is evidence of a well-formed roadmap, never of a true one.
- **Deletion of the launch-pad file on pickup.** §6.6 requires it and nothing checks it; the file's validity is checked, its removal is not.
- **Whether a closing keyword sits beside an issue number anywhere but the launch pad.** §6.5.1's clause reaches PR bodies, commit messages, review comments, issue bodies and status reports; `validate-prompt.mjs` reaches `docs/designs/next-session-prompt.md` and nothing else, because that is the only one of those surfaces that is a file in a repository. It is named here rather than counted as coverage: this is precisely the partial check this section exists to declare, and it earns its place because **both recorded occurrences entered through the launch pad** — prose written there and copied into a PR body. A repo-side guard over all of `docs/` was weighed and rejected: keyword-adjacent numbers are legitimate in frozen design docs and in the daftplate-managed `docs/quick-ref-workflow.md`, so such a guard is vacuous or a carve-out for the single file that already has one. The check is also **one-sided by construction** — it refuses the dangerous form and cannot certify that a sanctioned `+`-joined form means what its author intended.
- **Whether a *qualified* `owner/repo#N` in the launch pad is this repo's own issue.** The validator refuses the unslashed third spelling — `daftplate#152`, `post-#123` — because no §6.5.1 form puts a bare prefix before a `#`, and the third one silently emptied the staleness check. It does not refuse the qualified form and cannot: told nothing about which repository it is validating for, `DaftVino/daftkit#3` and the working repo's own qualified spelling are the same shape to it, so a prompt naming its own issues fully qualified still passes `issue-closed` unread. Supplying that identity was weighed and rejected rather than deferred — the working repo's name differs from `DaftVino/daftplate`, which is a real, separate public export, so name-matching would exempt the spelling a person would plausibly mistype and catch only one nobody writes.
- **Whether an issue filed outside a session is dressed.** `/dress` runs in a Claude session, with that session's Linear tools. `/handoff` and `standards-change` call it, and a user-level `PostToolUse` hook reminds the session after a `gh issue create`. Nothing reaches an issue filed in the GitHub web UI, from another machine, or from a session where `install-skills` never registered the hook. The 24h backstop is the only control there. The reminder's own reach is narrower than "every filing", too. Its `if` filter, `Bash(gh issue create*)`, was measured on 2026-10-07 to match `gh issue create` as any subcommand of a compound command. It did not match the phrase inside a quoted `echo` argument, but it **did** match it inside a heredoc body. That is a false start, and the hook's own check absorbs it: it strips heredoc bodies and quoted strings, and requires the bare issue URL `gh issue create` prints. Both were added after a live false reminder. So a `gh issue create` issued *by a script* the command runs (the `standards-change` outbox, for one) is invisible to it, which is why that skill calls `/dress` itself. And it reminds without dressing, because a hook has no Linear tools.

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

## 10. Executing with agents

**Vertical slices, not parallel surfaces.** Product work is built as sequenced vertical slices — each proving one user journey end-to-end at `real-provider-proven` or better — never as parallel waves of product surfaces. Parallel agents are permitted *within* a slice after its contract freezes: one schema/API owner, non-overlapping file ownership, an independent review agent, and a journey agent that runs the real flow before merge. Work-in-progress caps at one product slice plus one infra/security slice.

**Model routing.** Mechanical, high-volume work goes to the cheap tier; judgment, review, and security-sensitive work to the strong tier; the default shape is one strong reviewer over N cheap generators. Per-machine capabilities and limits (sandbox constraints, argv/timeout ceilings, account usage caps) are recorded in a durable environment-notes doc in the repo that discovered them and mirrored to `hard-won-constraints.md` — never only in a session prompt.

**Session brief contract.** Every agent brief states: outcome, the user journey it serves, allowed files, forbidden files/domains, existing interfaces, non-goals, database/rollback requirements, required tests (unit / integration / live / cross-tenant as applicable), and the evidence to return. No deploy or push unless explicitly authorized.

## 11. HTML conformance

**The target is the WHATWG HTML Living Standard**, measured with the [W3C Nu Html Checker](https://validator.w3.org/nu/). It is deliberately not "HTML5": W3C and WHATWG signed a memorandum of understanding in May 2019 under which the WHATWG Living Standard became the single version of HTML, and the W3C HTML5 Recommendation was retired and is no longer maintained. A standard that named the retired Recommendation would be pointing at a frozen document. Naming the checker separately is the point — WHATWG owns the specification, and W3C still ships the instrument.

**What is measured is served output, never source.** In every profile that emits HTML, the source is not HTML: `gas-webapp` templates carry Apps Script `<?= ?>` scriptlets, and `web-app` and `app-monolith` hold framework components. A validator pointed at source files therefore reports success over files it never parsed, which is worse than no check at all.

| Profile | Can a gate exist? | Why |
|---|---|---|
| `gas-webapp` | No | Templates are not HTML, and there is no build step — the output exists only once Apps Script renders it |
| `web-app` | In principle | Its `verify` metadata runs a build, so the built output is validatable; routes needing a server are not |
| `app-monolith` | In principle | Same — a build exists, and server-rendered routes are out of reach of a static check |
| `userscript` | No, by definition | It emits no HTML of its own. The host site's DOM belongs to a third party, and validating it reports their bugs as ours |

Neither "in principle" row names a framework or an output directory, because neither profile fixes one: `web-app` names one static-first framework and then explicitly permits any equivalent, and `app-monolith` says only "a browser client in the same repo". The claim rests on their `verify` metadata, which is real, and on nothing else.

**The baseline, wherever HTML exists at all.** Cheap, profile-independent, and checkable by reading:

- `<!DOCTYPE html>` first, before anything else
- `<meta charset="utf-8">` inside the first 1024 bytes
- a `lang` attribute on `<html>`
- unique `id` values within a document
- escaped `&` and `<` in text and attribute values

**Stating the rule is not enforcing it.** This section is prose. Only the two build-carrying profiles could hold a real gate, and even there it would cover built pages and not server-rendered routes. The cost of building one is concrete rather than vague: §2.2 requires any binary a workflow downloads to be pinned to a digest committed in the workflow, which is a permanent maintenance obligation; calling the hosted `validator.w3.org/nu` API from CI sends built pages to a third party on every push and makes CI depend on someone else's uptime; and a Node validator package is unavailable, since daftplate's scripts carry no dependencies. Enforcement is a separate decision with a separate cost, and this paragraph is the handoff to it, not a promise made here.

### 11.1 Accessibility

Markup validity and accessibility are different claims: a page can validate perfectly against the Living Standard and still be unusable with a screen reader. §11 covers validity; this covers use.

**The target is WCAG 2.2 Level AA**, named with the version, because "WCAG AA" unqualified has meant three different criteria sets since 2008. WCAG 2.2 has **86 success criteria** — 61 in 2.0, plus 17 in 2.1, plus 9 in 2.2, minus the removed 4.1.1 Parsing. Of the nine added in 2.2, **six are Level A or AA**: 2.4.11 Focus Not Obscured (Minimum) AA, 2.5.7 Dragging Movements AA, 2.5.8 Target Size (Minimum) AA, 3.2.6 Consistent Help A, 3.3.7 Redundant Entry A, and 3.3.8 Accessible Authentication (Minimum) AA. The other three are AAA, so for an AA target the delta from 2.1 is six, not nine.

**Four profiles serve a UI and all four are in scope**: `web-app`, `app-monolith`, `gas-webapp`, and `userscript` **with a narrowed obligation**. A userscript injects into a page it does not own, so it is accountable for the accessibility of *what it adds* — its own controls, its focus handling, its announcements — and not for the host page. Narrowed, never excluded.

**The baseline.** Four of these six map to Level A or AA criteria; two are house practice AA does not require, and the difference is marked rather than blurred:

| Item | Status |
|---|---|
| Text contrast at least `4.5:1`, or 3:1 for large text and UI components | AA — 1.4.3, 1.4.11 |
| Every interactive element keyboard-operable with a `visible focus indicator` | A/AA — 2.1.1, 2.4.7 |
| Alt text on meaningful images, `empty alt` on decorative ones | A — 1.1.1 |
| Form controls with `programmatic labels` | A — 1.3.1, 3.3.2, and 4.1.2 Name, Role, Value |
| Exactly `one h1`, no skipped heading levels | **House practice** — no A/AA criterion requires it |
| `landmark elements` over `<div>` soup | **House practice** — 1.3.1 concerns programmatic structure, not landmarks specifically |

**AA is the conformance target.** The two house-practice items are additional and never override a success criterion; where they appear to conflict, the criterion is what a reviewer cites.

**Stating the rule is not enforcing it.** This section is prose, and no automated run establishes conformance: a checker cannot evaluate whether alt text is *accurate*, whether focus order is *sensible*, or whether a control's accessible name matches its visible label in *meaning*. A green automated run is not conformance. **daftplate's scaffolding ships no accessibility checker** — its own scripts carry no dependencies — which is a fact about this repository and not advice to scaffolded repos, which have builds and are free to install one.

**Two of the four fragments carry a pointer to this section and two do not**, and the reason is mechanical rather than an oversight: `verify-repo.mjs` caps a composed `CLAUDE.md` at 60 lines, and measured before this edit, `app-monolith` and `userscript` already compose to 59. Adding a line would put them at exactly the cap, so any later fragment edit breaks scaffolding for two profiles. A fragment is a router hint; the rule lives here, and those two profiles take their obligation from this document alone.

## 12. Regression test authenticity

A test that executes the changed code has proved that it ran. It has not proved that it would have failed before the fix, and those are different claims. A regression test that cannot fail is coverage, not evidence.

**Every regression test records four things**, in the plan or the PR that introduces it:

1. **The claim** — the behaviour the test asserts, stated as a property rather than as "it works".
2. **The mutation** — a concrete change to the production code, or a known-bad implementation, that reintroduces the bug. Named specifically enough that someone else could apply it.
3. **The observable** — the exact difference the assertion must distinguish between the fixed code and the mutated code.
4. **`Observed red:`** — evidence that the focused test was seen failing with that mutation applied, before the fix was accepted.

**Weaker checks do not establish a stronger claim.** Coverage, "it executed", "it did not throw", "the result is not `undefined`", and type-only assertions each prove less than they appear to. The concrete case: if the mutation returns `null` and the assertion only rejects `undefined`, the assertion accepts the mutant and the test does not prove the claim. Compare exact values or exact bytes.

**The cost is real and is the mechanism.** Every regression carries a small red-run burden, and a purely additive or documentation-only test needs an explicit note that it is *not* a regression test. That friction is what stops a passing test being accepted merely because it touched the changed lines.

**What this does not claim.** Nothing here is sound static analysis, and a sufficiently subtle tautology survives it. The narrower promise is that a test body and a concrete counterfactual are no longer omitted by design.
